/**
 * 计时器状态机 —— 纯逻辑，不引用任何 DOM / localStorage / Date.now()。
 *
 * ★ 本项目最重要的一条不变量 ★
 *   所有时间计算都必须来自「时间戳差值」，即
 *       used = accumulatedMs + (startedAt === null ? 0 : now - startedAt)
 *   绝对不允许写成 `elapsed += 1000` 那种按 interval 累加的写法。
 *   浏览器会把后台标签页的 setInterval 节流到 1 秒甚至完全暂停；
 *   只有时间戳差值才能保证「切到后台再切回来，剩余时间依然准确」。
 *
 * 为了让这个模块可测，`now` 一律由调用方作为参数传入，模块内部不读时钟。
 *
 * 边界（改动前务必确认）：本文件不得出现任何 DOM、localStorage、
 * Notification、fetch 调用。测试环境是 environment: 'node'，刻意不装 jsdom，
 * 只要这里写一句 document.querySelector，32 个单测就全部跑不起来。
 * 所有副作用（渲染、持久化、通知、发请求）都在 timer.js 那一层。
 * 状态对象全部按「不可变」使用：每个函数返回新对象，不改入参。
 */

export const MODE = Object.freeze({
  FOCUS: 'focus',
  SHORT_BREAK: 'short_break',
  LONG_BREAK: 'long_break',
});

/** 模式 → 中文标签；看板和时间轴都从这里取，避免文案各写一份 */
export const MODE_LABEL = Object.freeze({
  [MODE.FOCUS]: '专注',
  [MODE.SHORT_BREAK]: '短休息',
  [MODE.LONG_BREAK]: '长休息',
});

const MS_PER_MINUTE = 60 * 1000;

/** 默认的 id 生成器；浏览器与 Node 18+ 都有全局 crypto */
function defaultIdFactory() {
  return globalThis.crypto.randomUUID();
}

/** 某个模式对应的整段时长（毫秒） */
export function durationForMode(mode, settings) {
  switch (mode) {
    case MODE.FOCUS:
      return settings.focusMin * MS_PER_MINUTE;
    case MODE.SHORT_BREAK:
      return settings.shortBreakMin * MS_PER_MINUTE;
    case MODE.LONG_BREAK:
      return settings.longBreakMin * MS_PER_MINUTE;
    default:
      throw new Error(`未知的计时模式：${mode}`);
  }
}

/** 初始状态：一段尚未开始的专注 */
export function createInitialState(settings, idFactory = defaultIdFactory) {
  return {
    mode: MODE.FOCUS,
    durationMs: durationForMode(MODE.FOCUS, settings),
    startedAt: null,
    accumulatedMs: 0,
    segmentStartAt: null,
    taskId: null,
    completedInCycle: 0,
    segmentId: idFactory(),
    phaseSeq: 0,
  };
}

/** 是否处于运行态。以 startedAt 是否为 null 作为唯一判据 */
export function isRunning(state) {
  return state.startedAt !== null;
}

/** 已经流逝的毫秒数 —— 唯一的计算入口 */
export function elapsedMs(state, now) {
  const currentRun = state.startedAt === null ? 0 : Math.max(0, now - state.startedAt);
  return state.accumulatedMs + currentRun;
}

/**
 * 剩余毫秒数，下限夹到 0。
 * 时钟被往回拨或系统休眠后 now 可能小于 startedAt，Math.max 兜底防止负数进 UI。
 */
export function remainingMs(state, now) {
  return Math.max(0, state.durationMs - elapsedMs(state, now));
}

/**
 * 进度比例 0–1，用于进度条宽度。
 * durationMs 为 0 时直接返回 1，避免 0/0 得 NaN 再去乘百分比。
 */
export function progress(state, now) {
  if (state.durationMs <= 0) return 1;
  return Math.min(1, elapsedMs(state, now) / state.durationMs);
}

/**
 * 开始 / 恢复。已在运行则原样返回（幂等）——避免误触把 startedAt 重置成 now，
 * 白送一段已经跑过的时间。
 */
export function start(state, now) {
  if (isRunning(state)) return state;
  return {
    ...state,
    startedAt: now,
    // segmentStartAt 记录这一段的「墙钟起点」，跨多次暂停/恢复保持不变，
    // 用于写入 Session.startAt，让时间轴上的位置符合直觉。
    segmentStartAt: state.segmentStartAt ?? now,
  };
}

/** 暂停：把本次运行的时长并入 accumulatedMs，然后清空 startedAt */
export function pause(state, now) {
  if (!isRunning(state)) return state;
  return {
    ...state,
    accumulatedMs: elapsedMs(state, now),
    startedAt: null,
  };
}

/**
 * 重置当前这一段（模式不变）。原本在跑的保持跑，原本暂停的保持暂停 ——
 * 保留运行态是为了「重置后接着跑」不必再多点一次开始。
 * segmentStartAt 一并重置为 now，否则时间轴上这段的起点会停在重置前的旧时刻。
 * segmentId 不在这里换：本函数只清空已流逝时间，不算「开新段」。
 */
export function reset(state, now) {
  const running = isRunning(state);
  return {
    ...state,
    accumulatedMs: 0,
    startedAt: running ? now : null,
    segmentStartAt: running ? now : null,
    segmentId: state.segmentId, // 显式保留（其实 ...state 已含）。新幂等键只在 advance/skip 的 transition 里生成
  };
}

/** 切换当前专注绑定的任务；传 null/undefined 统一归一成 null（未绑定） */
export function setTask(state, taskId) {
  return { ...state, taskId: taskId ?? null };
}

/**
 * 构造一条待写入的 Session 提交记录。
 * 只在「专注段跑完」时产生；休息段不产生记录。
 */
function buildCommit(state, endAt) {
  if (state.mode !== MODE.FOCUS) return null;
  return {
    clientId: state.segmentId,
    taskId: state.taskId,
    startAt: new Date(state.segmentStartAt ?? endAt - state.durationMs).toISOString(),
    endAt: new Date(endAt).toISOString(),
    // 单位：秒。用 durationMs 而不是实际 elapsed，保证记录的是「一段完整的番茄」
    duration: Math.round(state.durationMs / 1000),
    type: MODE.FOCUS,
    completed: true,
  };
}

/**
 * 推进到下一段。
 *
 * @param {object} state
 * @param {object} settings
 * @param {number} now       - 本段结束的时刻（用于 endAt）
 * @param {boolean} forceIdle - 强制下一段处于暂停态（补记超时段时用）
 * @param {Function} idFactory
 * @returns {{ state: object, commit: object|null }}
 */
function transition(state, settings, now, forceIdle, idFactory) {
  const commit = buildCommit(state, now);

  let completedInCycle = state.completedInCycle;
  let nextMode;

  if (state.mode === MODE.FOCUS) {
    completedInCycle += 1;
    nextMode =
      completedInCycle % settings.longBreakEvery === 0 ? MODE.LONG_BREAK : MODE.SHORT_BREAK;
  } else {
    // 休息结束回到专注；cycleCount 只在专注完成时前进
    nextMode = MODE.FOCUS;
  }

  const autoStart = forceIdle ? false : Boolean(settings.autoStartNext);

  return {
    commit,
    state: {
      mode: nextMode,
      durationMs: durationForMode(nextMode, settings),
      accumulatedMs: 0,
      startedAt: autoStart ? now : null,
      segmentStartAt: autoStart ? now : null,
      taskId: state.taskId,
      completedInCycle,
      // 新的一段必须换新的幂等键，否则下一段会覆盖上一段的记录
      segmentId: idFactory(),
      phaseSeq: state.phaseSeq + 1,
    },
  };
}

/**
 * 计时归零：正常完成一段并转移。focus 段会产出一条 commit（待写 Session），
 * 休息段不会。是否自动开始下一段由 settings.autoStartNext 决定。
 *
 * @returns {{ state: object, commit: object|null }}
 */
export function advance(state, settings, now, idFactory = defaultIdFactory) {
  return transition(state, settings, now, false, idFactory);
}

/**
 * 跳过当前段：转移但不写 Session（跳过的段不算数，也不计入番茄数）。
 */
export function skip(state, settings, now, idFactory = defaultIdFactory) {
  const nextMode = state.mode === MODE.FOCUS ? MODE.SHORT_BREAK : MODE.FOCUS;
  const autoStart = Boolean(settings.autoStartNext);

  return {
    commit: null,
    state: {
      mode: nextMode,
      durationMs: durationForMode(nextMode, settings),
      accumulatedMs: 0,
      startedAt: autoStart ? now : null,
      segmentStartAt: autoStart ? now : null,
      taskId: state.taskId,
      completedInCycle: state.completedInCycle,
      segmentId: idFactory(),
      phaseSeq: state.phaseSeq + 1,
    },
  };
}

/**
 * 页面加载时的对账。
 *
 * 处理两种情形：
 *   1. 正常：还没到期 → 原样返回，计时继续（时间由时间戳差值自动算准）。
 *   2. 超时：例如关掉页面几小时后再打开。此时**只补记一段**，
 *      并且补记的 endAt 用「该段本应结束的时刻」而不是 now，
 *      这样记录的时长是诚实的，不会把离开的几小时算成专注。
 *
 * 关键：补记后下一段**强制暂停**，无视 autoStartNext。
 * 用户显然离开了，不能自动开始新一段，更不能级联补记出一串幽灵番茄。
 *
 * @returns {{ state: object, commit: object|null }}
 */
export function reconcileOnLoad(state, settings, now, idFactory = defaultIdFactory) {
  if (state.startedAt === null) {
    return { state, commit: null };
  }
  if (remainingMs(state, now) > 0) {
    return { state, commit: null };
  }

  const honestEnd = (state.segmentStartAt ?? now) + state.durationMs;
  const result = transition(state, settings, honestEnd, true, idFactory);
  return { state: result.state, commit: result.commit };
}

/**
 * 毫秒 → "MM:SS"（超过一小时显示 "H:MM:SS"）。
 * 用 Math.ceil 而不是 floor：剩 0.4 秒时显示「00:01」比「00:00」更符合直觉，
 * 也避免计时器在读数归零后还停留一瞬间。
 */
export function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 从持久化状态里恢复到内存（容错：结构不对就回到初始状态）。
 *
 * 逐字段校验而不是直接信任 JSON.parse：localStorage 里可能躺着
 * 旧版本写入的 schema、被手工改过的内容，或结构完整的 null。
 * mode 不合法或整体不是对象就整个丢弃回初始态；其余字段坏了只回退该字段，
 * 尽量保住仍然可用的部分（比如 taskId 还在，就没必要连绑定一起丢）。
 */
export function reviveState(raw, settings, idFactory = defaultIdFactory) {
  if (!raw || typeof raw !== 'object') {
    return createInitialState(settings, idFactory);
  }

  const validModes = Object.values(MODE);
  if (!validModes.includes(raw.mode)) {
    return createInitialState(settings, idFactory);
  }

  return {
    mode: raw.mode,
    durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : durationForMode(raw.mode, settings),
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    accumulatedMs: Number.isFinite(raw.accumulatedMs) ? raw.accumulatedMs : 0,
    segmentStartAt: Number.isFinite(raw.segmentStartAt) ? raw.segmentStartAt : null,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : null,
    completedInCycle: Number.isInteger(raw.completedInCycle) ? raw.completedInCycle : 0,
    segmentId: typeof raw.segmentId === 'string' ? raw.segmentId : idFactory(),
    phaseSeq: Number.isInteger(raw.phaseSeq) ? raw.phaseSeq : 0,
  };
}
