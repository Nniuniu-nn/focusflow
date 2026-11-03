import { api } from './api.js';
import { moveAfter, moveBefore, moveBy } from './task-order.js';
import { MODE_LABEL } from './timer-core.js';
import { escapeHtml, formatDuration, formatTime, todayKey } from './util.js';
import * as timer from './timer.js';
import { reportError, toast } from './ui.js';

/**
 * 今日看板：左侧任务清单，右侧计时器 + 今日时间轴 + 汇总。
 *
 * 定位是「装配层 / 胶水」：它只负责发起请求、把响应喂给渲染函数，
 * 以及把 UI 上的操作转成对 api / timer 的调用。
 *
 * 明确不做的几件事：
 * - 不做任何计时数学，全部委托给 timer.js → timer-core.js；
 * - 不读写 localStorage（那是 timer.js / nav.js 的职责）；
 * - 不构造图表配置（统计页才用 charts.js）。
 *
 * 「今天」这个日期只在模块加载时算一次并冻结。看板不是长驻页面，
 * 用户翻到第二天本来就会刷新，没必要为跨零点做实时检测。
 */

const date = todayKey();
let tasks = [];

/**
 * 看板入口，由 index.html 的顶层脚本调用。
 *
 * 顺序有讲究：先 await initTimer()，因为计时器在初始化时会把上次
 * 未提交的 outbox 冲掉；冲掉时会派发 focusflow:session-recorded，
 * 而下面的监听器必须在它之前挂好 —— 否则先冲后挂，那批记录带来的
 * 番茄数变化就没人刷新了。因此这里「先 init、再挂监听、最后 refresh」。
 *
 * @returns {Promise<void>}
 */
export async function initBoard() {
  // 计时器要先起来：它负责把上次未提交的 Session 冲掉
  await timer.initTimer();

  wireForm();
  // 计时器状态变化（暂停/切模式/换绑定任务）都要重新高亮当前任务
  timer.subscribe(() => highlightActiveTask());
  // outbox 冲刷成功说明服务端多了一条 Session，番茄数/时间轴要跟着变
  window.addEventListener('focusflow:session-recorded', () => {
    void refresh();
  });
  // 从后台切回来时也刷新一下（可能已经跨过零点或别的标签页写了数据）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });

  await refresh();
}

/**
 * 拉取三块数据并整体重绘。三块互不依赖，所以用 Promise.all 并发。
 *
 * 副作用：改写 #task-list / #timeline / #summary 三处 innerHTML。
 * 失败时统一交给 reportError（401 已在 api.js 层跳转，这里不会重复提示）。
 *
 * @returns {Promise<void>}
 */
async function refresh() {
  try {
    const [taskList, sessions, summary] = await Promise.all([
      api.listTasks(date),
      api.listSessions(date),
      api.summary(date),
    ]);

    tasks = taskList;
    renderTasks();
    renderTimeline(sessions);
    renderSummary(summary);
  } catch (error) {
    reportError(error);
  }
}

// ── 任务清单 ────────────────────────────────────────────

/** 绑定「新建任务」表单的提交，成功后清空输入并整体刷新 */
function wireForm() {
  const form = document.querySelector('#task-form');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const titleInput = form.querySelector('[name="title"]');
    const estimateInput = form.querySelector('[name="estimate"]');
    const title = titleInput.value.trim();
    if (!title) return;

    const estimatedPomodoros = Number(estimateInput.value) || 1;

    try {
      await api.createTask({ title, date, estimatedPomodoros });
      titleInput.value = '';
      estimateInput.value = '1';
      titleInput.focus();
      await refresh();
    } catch (error) {
      reportError(error);
    }
  });
}

/**
 * 整块重绘任务列表。列表内容由定时器和事件委托驱动变化，
 * 逐节点增删容易和状态不一致，索性每次都重建 innerHTML。
 */
function renderTasks() {
  const list = document.querySelector('#task-list');
  if (!list) return;

  if (tasks.length === 0) {
    list.innerHTML = '<li class="empty">今天还没有任务，在上面添加一个吧</li>';
    highlightActiveTask();
    return;
  }

  list.innerHTML = tasks.map(taskTemplate).join('');
  highlightActiveTask();
}

/**
 * 单条任务的 HTML 片段。
 *
 * 用户输入（标题、备注）一律经 escapeHtml —— 这段字符串直接进 innerHTML，
 * 不转义就是一个存储型 XSS。data-action 属性供事件委托识别操作类型。
 *
 * @param {object} task - 后端返回的任务对象
 * @returns {string} `<li>` 片段
 */
function taskTemplate(task) {
  const done = task.status === 'done';
  const progress = `${task.completedPomodoros}/${task.estimatedPomodoros}`;

  return `
    <li class="task-item" data-id="${task.id}" data-status="${done ? 'done' : task.status}">
      <span class="task-drag" draggable="true" role="button" tabindex="0"
            aria-label="拖动排序，也可按 Alt+方向上/下键调整" title="拖动排序（Alt+↑/↓）">⠿</span>
      <input class="task-check" type="checkbox" ${done ? 'checked' : ''}
             aria-label="标记完成" data-action="toggle" />
      <div class="task-body">
        <div class="task-title" data-action="bind" title="点击绑定到计时器">${escapeHtml(task.title)}</div>
        <div class="task-meta">
          <span>🍅 ${progress}</span>
          ${task.note ? `<span>${escapeHtml(task.note)}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        <button class="icon" data-action="delete" title="删除">✕</button>
      </div>
    </li>
  `;
}

/**
 * 任务卡片的点击委托（绑定/解绑任务、删除）。
 *
 * 挂在 document 而不是列表节点上：列表会被 renderTasks 整体重建，
 * 挂在节点上的监听会随旧节点一起被丢弃；委托到 document 则天然存活。
 * 之所以在 document 上而不是 #task-list 上，是为了不依赖该容器一直存在。
 */
document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const item = target.closest('.task-item');
  if (!item) return;

  const id = item.dataset.id;
  const action = target.dataset.action;
  if (!id || !action) return;

  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) return;

  if (action === 'bind') {
    if (timer.getState()?.taskId === id) {
      timer.setTask(null);
      toast('已取消绑定');
    } else {
      timer.setTask(id);
      toast(`已绑定「${task.title}」`);
    }
    return;
  }

  if (action === 'delete') {
    try {
      await api.deleteTask(id);
      if (timer.getState()?.taskId === id) timer.setTask(null);
      await refresh();
    } catch (error) {
      reportError(error);
    }
  }
});

/**
 * 任务「完成」复选框的 change 委托。
 *
 * 失败时把复选框状态翻回去：UI 已经被浏览器切成新值，
 * 若请求失败仍不回滚，界面就和服务端不一致了。
 */
document.addEventListener('change', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.dataset.action !== 'toggle') return;

  const item = target.closest('.task-item');
  const id = item?.dataset.id;
  if (!id) return;

  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) return;

  const nextStatus = target.checked ? 'done' : 'todo';
  try {
    await api.updateTask(id, { status: nextStatus });
    await refresh();
  } catch (error) {
    reportError(error);
    target.checked = !target.checked;
  }
});

// ── 拖拽排序 ────────────────────────────────────────────

/**
 * 拖拽状态。dragId 非空表示正在拖；dropTarget 是当前落点。
 * 四个独立的拖拽事件（start / over / drop / end）必须共享同一份进行中的状态，
 * 所以放在模块级而不是某个事件回调的闭包里。
 */
let dragId = null;
let dropTarget = null;
let reordering = false;

function clearDropIndicators() {
  for (const item of document.querySelectorAll('.task-item[data-drop]')) {
    delete item.dataset.drop;
  }
}

function endDrag() {
  dragId = null;
  dropTarget = null;
  clearDropIndicators();
  for (const item of document.querySelectorAll('.task-item.dragging')) {
    item.classList.remove('dragging');
  }
}

function taskItem(id) {
  return document.querySelector(`.task-item[data-id="${CSS.escape(id)}"]`);
}

function focusTaskHandle(id) {
  taskItem(id)?.querySelector('.task-drag')?.focus();
}

/**
 * 把新顺序提交给服务端。
 *
 * 先乐观改内存和 DOM，让卡片立刻落到用户松手的位置；请求成功后用服务端返回的
 * 权威列表覆盖，失败则回滚到 previous 并报错。这样拖拽手感是即时的，同时不会
 * 出现「界面已换位、后端没记住」的静默不一致。
 *
 * reordering 是并发闸门：请求还没回来时再次拖拽/按键会直接忽略，避免两个重排
 * 请求互相覆盖 order。
 */
async function persistOrder(nextIds, focusId) {
  if (reordering) return;
  reordering = true;

  const previous = tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  tasks = nextIds.map((id) => byId.get(id)).filter(Boolean);
  renderTasks();

  try {
    tasks = await api.reorderTasks(date, nextIds);
    renderTasks();
  } catch (error) {
    tasks = previous;
    renderTasks();
    reportError(error);
  } finally {
    reordering = false;
    if (focusId) focusTaskHandle(focusId);
  }
}

document.addEventListener('dragstart', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const handle = target.closest('.task-drag');
  const item = handle?.closest('.task-item');
  const id = item?.dataset.id;
  if (!handle || !item || !id) return;

  dragId = id;
  dropTarget = null;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', id);
  // 拖影用整张卡片，而不是小小的手柄
  event.dataTransfer.setDragImage(item, 16, 16);
  // 等拖影捕获后再降透明度，否则拖影本身也会变淡
  requestAnimationFrame(() => item.classList.add('dragging'));
});

document.addEventListener('dragover', (event) => {
  if (!dragId) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const item = target.closest('.task-item');
  clearDropIndicators();

  // 拖到自己身上或列表外：不显示落点，也不允许 drop
  if (!item || item.dataset.id === dragId) {
    dropTarget = null;
    return;
  }

  event.preventDefault();
  const rect = item.getBoundingClientRect();
  const placeAfter = event.clientY > rect.top + rect.height / 2;
  item.dataset.drop = placeAfter ? 'after' : 'before';
  dropTarget = { id: item.dataset.id, placeAfter };
});

document.addEventListener('drop', async (event) => {
  if (!dragId || !dropTarget) return;
  event.preventDefault();

  const activeId = dragId;
  const { id: targetId, placeAfter } = dropTarget;
  endDrag();

  const currentIds = tasks.map((task) => task.id);
  const nextIds = placeAfter
    ? moveAfter(currentIds, activeId, targetId)
    : moveBefore(currentIds, activeId, targetId);

  if (nextIds.every((id, index) => id === currentIds[index])) return;
  await persistOrder(nextIds, activeId);
});

document.addEventListener('dragend', endDrag);

/**
 * 键盘排序：手柄聚焦时 Alt+↑/↓ 上移/下移一位。
 *
 * 拖拽是鼠标专属交互，键盘用户没法用；这条路径让排序同样可达。
 * preventDefault 拦住 Alt+↓ 在部分浏览器里的滚动行为。
 */
document.addEventListener('keydown', async (event) => {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest('.task-drag')) return;

  event.preventDefault();
  const id = target.closest('.task-item')?.dataset.id;
  if (!id) return;

  const currentIds = tasks.map((task) => task.id);
  const nextIds = moveBy(currentIds, id, event.key === 'ArrowUp' ? -1 : 1);
  if (nextIds.every((value, index) => value === currentIds[index])) return;
  await persistOrder(nextIds, id);
});

/**
 * 把「正在专注的任务」高亮出来。
 *
 * 只改 dataset.active 交给 CSS 渲染，避免在这里直接操作样式类。
 * 计时器每次 emit 都会调它，所以要足够廉价。
 */
function highlightActiveTask() {
  const activeId = timer.getState()?.taskId ?? null;
  for (const item of document.querySelectorAll('.task-item')) {
    item.dataset.active = String(item.dataset.id === activeId);
  }
}

// ── 今日时间轴 ──────────────────────────────────────────

/**
 * 今日时间轴：把当天每条 Session 渲染成一行。
 *
 * 已绑定任务的段优先显示任务标题，否则退回到模式名（专注/短休息/长休息）；
 * 任务可能已被删除，所以用 tasks.find 的结果可能为 undefined，这里要兜底。
 * 时间由 formatTime(new Date(...)) 按浏览器本地时区格式化，
 * 所以时间轴上的位置和用户直觉一致。
 *
 * @param {object[]} sessions - 当天 Session 列表，按后端排序
 */
function renderTimeline(sessions) {
  const host = document.querySelector('#timeline');
  if (!host) return;

  if (sessions.length === 0) {
    host.innerHTML = '<p class="empty">今天还没有专注记录</p>';
    return;
  }

  host.innerHTML = sessions
    .map((session) => {
      const label = MODE_LABEL[session.type] ?? session.type;
      const minutes = Math.round(session.duration / 60);
      const name = tasks.find((task) => task.id === session.taskId)?.title;
      return `
        <div class="timeline-row">
          <span class="timeline-time">${formatTime(session.startAt)}</span>
          <span class="timeline-bar" data-type="${session.type}"></span>
          <span class="timeline-label">
            <b>${escapeHtml(name ?? label)}</b>
            <span>${minutes} 分</span>
          </span>
        </div>
      `;
    })
    .join('');
}

// ── 今日汇总 ────────────────────────────────────────────

/**
 * 今日汇总三块数字：专注总时长、完成番茄数、任务完成进度。
 * 数据来自 /stats/summary，服务端已按用户时区切好当日边界。
 *
 * @param {object} summary - { focusSeconds, pomodoros, tasksDone, tasksTotal }
 */
function renderSummary(summary) {
  const host = document.querySelector('#summary');
  if (!host) return;

  host.innerHTML = `
    <div class="stat">
      <div class="stat-value">${formatDuration(summary.focusSeconds)}</div>
      <div class="stat-label">专注总时长</div>
    </div>
    <div class="stat">
      <div class="stat-value">${summary.pomodoros}</div>
      <div class="stat-label">完成番茄数</div>
    </div>
    <div class="stat">
      <div class="stat-value">${summary.tasksDone}/${summary.tasksTotal}</div>
      <div class="stat-label">已完成任务</div>
    </div>
  `;
}
