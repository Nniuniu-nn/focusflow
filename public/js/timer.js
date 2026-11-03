import { api } from './api.js';
import { STORAGE_KEYS, readJson, writeJson } from './util.js';
import * as core from './timer-core.js';

const MODE_LABEL = core.MODE_LABEL;

/** 进度条颜色直接按模式查表，别用字符串替换拼 CSS 变量名 */
const MODE_COLOR_VAR = {
  [core.MODE.FOCUS]: 'var(--focus)',
  [core.MODE.SHORT_BREAK]: 'var(--short-break)',
  [core.MODE.LONG_BREAK]: 'var(--long-break)',
};

/**
 * 计时器的「不纯外壳」：负责 DOM、localStorage、通知、document.title。
 * 所有时间数学都在 timer-core.js 里，这一层不做任何时间累加。
 *
 * ★ 铁律 ★ setInterval 只用来「重绘」。每次重绘都从 Date.now() 重新算剩余时间。
 *   正因为如此，标签页被浏览器节流甚至暂停都不影响准确性 ——
 *   下一次 tick 会直接按时间戳落到正确的值上。
 */

// 250ms 一次的重绘频率：人眼对秒级跳变已经够用，再密只是白烧 CPU，
// 再稀会在切换模式的瞬间显得卡顿。注意它只影响「什么时候重画」，
// 不影响「画出来是多少」—— 数值一律由时间戳差算出。
const TICK_INTERVAL_MS = 250;

/** 计时偏好，initTimer 时拉取；只作 core 各函数的入参，改它不重算当前段 */
let settings = null;
/** 当前计时状态（timer-core 的数据结构），所有变更都经 core 产生新对象 */
let state = null;
/** setInterval 句柄，stopTimer 用它停表 */
let intervalId = null;
/** 状态变化订阅者集合，用于通知看板高亮/刷新 */
const listeners = new Set();

/** 缓存的 DOM 引用，避免每 250ms 都 querySelector 一遍 */
let dom = {};

/**
 * 订阅状态变化（任务列表靠它高亮「正在专注的任务」）。
 *
 * @param {(state: object) => void} listener
 * @returns {() => void} 取消订阅函数
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(state);
}

export function getState() {
  return state;
}

/**
 * 看板加载时的初始化：拉设置 → 恢复本地状态 → 对账 → 冲刷 outbox → 起表。
 *
 * 副作用：写 localStorage、可能发 createSession 请求、修改 DOM、启动 interval。
 * 顺序不能乱：必须先 await getSettings()，因为 reviveState 和 reconcileOnLoad
 * 都要拿 settings 算各模式时长；对账产生的补记段必须先进 outbox，
 * 再统一 flush，才不会漏。
 *
 * @returns {Promise<void>}
 */
export async function initTimer() {
  settings = await api.getSettings();

  // 1. 从 localStorage 恢复
  state = core.reviveState(readJson(STORAGE_KEYS.TIMER, null), settings);

  // 2. 对账：如果关机/关页面期间这段已经超时，只补记一段并停在暂停态
  const reconciled = core.reconcileOnLoad(state, settings, Date.now());
  state = reconciled.state;
  if (reconciled.commit) {
    enqueueCommit(reconciled.commit);
  }
  persist();

  // 3. 先把积压的待提交记录冲掉（上次刷新可能正卡在提交途中）
  await flushOutbox();

  cacheDom();
  wireControls();

  // 从后台切回前台时立刻按时间戳重算一次，避免看到过期数字
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render();
  });

  intervalId = setInterval(tick, TICK_INTERVAL_MS);
  render();
  emit();
}

/**
 * 让看板把「正在专注的任务」绑到计时器上。
 * 传 null 表示解绑。只影响后续完成的段，已在跑的段不补记也不追溯。
 */
export function setTask(taskId) {
  state = core.setTask(state, taskId);
  persist();
  render();
  emit();
}

/**
 * 开始 / 暂停。同一个按钮两种语义，由当前是否在跑决定。
 * 顺带申请通知权限：浏览器要求权限申请必须由用户手势触发，
 * 「第一次点开始」是唯一的自然时机。
 */
export function toggle() {
  // 浏览器要求通知权限必须由用户手势触发，第一次点开始时申请最自然
  requestNotificationPermission();

  state = core.isRunning(state) ? core.pause(state, Date.now()) : core.start(state, Date.now());
  persist();
  render();
  emit();
}

/** 把当前段清零重来（模式不变），丢弃这一段已流逝的时间，不写 Session */
export function reset() {
  state = core.reset(state, Date.now());
  persist();
  render();
  emit();
}

/** 跳过当前段直接进入下一段。跳过的段不写 Session、不计入番茄数 */
export function skip() {
  state = core.skip(state, settings, Date.now()).state;
  persist();
  render();
  emit();
}

/** 设置变更后调用：新设置从「下一段」开始生效，当前段不变 */
export function updateSettings(nextSettings) {
  settings = nextSettings;
}

// ── 内部实现 ──────────────────────────────────────────────

/**
 * 定时器回调 —— 每次只做三件事：判断跑没跑、判断到没到点、重绘。
 *
 * ★ 这里绝不能出现 `state.accumulatedMs += elapsed` 这类累加。
 *   后台标签页的 interval 会被浏览器节流到 1s 甚至直接冻结，
 *   累加式计时会因此偏慢；而 remainingMs 每次都从 Date.now() 重算，
 *   切回前台的下一次 tick 就直接落到正确数值上。
 */
function tick() {
  if (!core.isRunning(state)) return;

  if (core.remainingMs(state, Date.now()) > 0) {
    render();
    return;
  }

  completePhase();
}

/**
 * 当前这一段跑到头了：推进到下一段。
 *
 * 顺序是「先 enqueue 再 flush」—— 先把 commit 落进 outbox，
 * 即使下一秒页面被刷新，记录也已经持久化，下次加载会重试；
 * flushOutbox 故意不 await，网络失败不能拖住计时继续走。
 */
function completePhase() {
  const finished = state.mode;
  const result = core.advance(state, settings, Date.now());

  state = result.state;
  if (result.commit) {
    // 先落盘到 outbox 再发请求：即使这一刻刷新，记录也不会丢
    enqueueCommit(result.commit);
  }
  persist();

  notifyPhaseChange(finished, state.mode);
  render();
  emit();

  // 不 await：网络失败不影响计时继续，outbox 会在下次重试
  void flushOutbox();
}

/** 一次性缓存所需元素；render 每 250ms 跑一次，不能每次都查 DOM */
function cacheDom() {
  dom = {
    clock: document.querySelector('#timer-clock'),
    mode: document.querySelector('#timer-mode'),
    progress: document.querySelector('#timer-progress'),
    task: document.querySelector('#timer-task'),
    toggle: document.querySelector('#btn-toggle'),
    reset: document.querySelector('#btn-reset'),
    skip: document.querySelector('#btn-skip'),
  };
}

/** 绑定三个控制按钮；用可选链是因为看板之外的页面可能没有这些控件 */
function wireControls() {
  dom.toggle?.addEventListener('click', toggle);
  dom.reset?.addEventListener('click', reset);
  dom.skip?.addEventListener('click', skip);
}

/**
 * 唯一的 DOM 绘制函数，被 tick / 各操作 / visibilitychange 调用。
 *
 * 每次进入都重新用 now 算一遍 remaining，不读任何缓存下来的「剩余时间」。
 * 副作用：改时钟文字、模式标签、进度条宽度与颜色、任务提示文案、
 * 按钮文案，以及 document.title。
 */
function render() {
  if (!dom.clock) return;

  const now = Date.now();
  const remaining = core.remainingMs(state, now);
  const clock = core.formatClock(remaining);
  const running = core.isRunning(state);
  const label = MODE_LABEL[state.mode];

  dom.clock.textContent = clock;
  dom.clock.dataset.mode = state.mode;

  if (dom.mode) {
    dom.mode.textContent = label;
    dom.mode.dataset.mode = state.mode;
  }

  if (dom.progress) {
    // dom.progress 是内层 <i>，宽度与颜色都设在它上面
    dom.progress.style.width = `${Math.round(core.progress(state, now) * 100)}%`;
    dom.progress.style.background = MODE_COLOR_VAR[state.mode];
  }

  if (dom.task) {
    dom.task.textContent = state.taskId ? '正在专注此任务' : '未绑定任务（点任务标题可绑定）';
  }

  if (dom.toggle) {
    // 剩余 === 整段时长 ⇒ 还没动过 ⇒「开始」；否则是暂停了一半 ⇒「继续」
    dom.toggle.textContent = running ? '暂停' : remaining === state.durationMs ? '开始' : '继续';
    dom.toggle.classList.toggle('primary', !running);
  }

  // 标签页标题实时倒计时
  document.title = running ? `${clock} · ${label} — FocusFlow` : 'FocusFlow';
}

/**
 * 把当前状态写进 localStorage。每次状态变更都调它 ——
 * 页面随时可能被关掉，靠「卸载时再存」来不及，而且 refresh 时
 * 状态已经在盘上，恢复才完整。
 */
function persist() {
  writeJson(STORAGE_KEYS.TIMER, state);
}

// ── 提交队列（outbox）────────────────────────────────────

/**
 * 把待写入的 Session 先记进 localStorage，再尝试发送。
 * 这样「专注段结束的瞬间刷新页面」也不会丢记录 ——
 * 服务端靠 clientId 去重，重复发送是安全的。
 */
function enqueueCommit(commit) {
  const outbox = readJson(STORAGE_KEYS.OUTBOX, []) ?? [];
  if (outbox.some((item) => item.clientId === commit.clientId)) return; // 已在队列里
  outbox.push(commit);
  writeJson(STORAGE_KEYS.OUTBOX, outbox);
}

/**
 * 冲掉队列里所有待提交记录；失败的留到下次。
 *
 * 幂等靠两端配合：客户端用 clientId 去重，服务端有
 * @@unique([userId, clientId])，撞唯一键时视为成功。因此「重发」
 * 永远安全 —— 无论上次是真失败还是请求发出去了但响应没回来。
 *
 * 只有整批都成功（pending 为空）才派发 focusflow:session-recorded：
 * 还剩失败项时看板刷新也是白刷，等服务端真收到再说。
 * 成功路径清空 outbox，失败项原样回写，不做任何计数累加 —— 清单本身就是事实来源。
 *
 * 允许在计时器尚未 initTimer 时调用（登出流程依赖这一点）。
 *
 * @returns {Promise<void>}
 */
export async function flushOutbox() {
  const outbox = readJson(STORAGE_KEYS.OUTBOX, []) ?? [];
  if (outbox.length === 0) return;

  const pending = [];
  for (const commit of outbox) {
    try {
      await api.createSession(commit);
    } catch {
      pending.push(commit); // 服务端没收到，保留重试
    }
  }

  writeJson(STORAGE_KEYS.OUTBOX, pending);

  if (pending.length === 0) {
    // 提交成功后让看板刷新番茄数
    window.dispatchEvent(new CustomEvent('focusflow:session-recorded'));
  }
}

/**
 * 请求通知权限。只在状态还是 default（没问过）时问一次 ——
 * 已拒绝（denied）就不再骚扰，反复弹框只会让人更烦。
 * 无 Notification API 的老浏览器直接跳过。
 */
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

/**
 * 段结束时的系统通知。tag 固定为 'focusflow-phase'：
 * 同一 tag 的后一条会替换前一条，避免连续几段时间堆积一屏通知。
 *
 * @param {string} fromMode - 刚结束的模式
 * @param {string} toMode - 刚进入的模式
 */
function notifyPhaseChange(fromMode, toMode) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const body =
    toMode === 'focus'
      ? '休息结束，开始下一个专注段'
      : `${MODE_LABEL[fromMode]}结束，进入${MODE_LABEL[toMode]}`;

  try {
    new Notification('FocusFlow', { body, tag: 'focusflow-phase' });
  } catch {
    // 某些浏览器在非 https 下会抛错，忽略即可
  }
}

/**
 * 停掉 interval。看板正常使用中不会调它（页面一关 interval 自然消失），
 * 主要留给测试拆卸和热重载场景，防止多个 interval 叠着跑。
 * 页面卸载前不再做额外处理：状态每次变更都已同步写入 localStorage。
 */
export function stopTimer() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
