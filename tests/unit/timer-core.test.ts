/**
 * timer-core 状态机单测 —— 本项目测试的重心。
 *
 * 覆盖 public/js/timer-core.js。它能被这样直接单测，是因为该模块刻意不引用
 * DOM / localStorage / Notification，且每个函数都把 `now` 作为参数传入而不是
 * 内部读 Date.now()。于是这里可以用固定的「受控时钟」精确构造「第 25 分 00 秒」
 * 这样的瞬间，完全不需要假定时器，也不需要 jsdom（测试环境是 environment: 'node'）。
 *
 * 这批用例守的是几条硬性不变量：所有时间都来自时间戳差值而非 interval 累加；
 * 超时恢复只补记一段、不合成幽灵番茄；每次转移都换新的幂等键。
 */
import { describe, expect, it } from 'vitest';
import {
  MODE,
  advance,
  createInitialState,
  durationForMode,
  elapsedMs,
  formatClock,
  isRunning,
  pause,
  reconcileOnLoad,
  remainingMs,
  reset,
  reviveState,
  setTask,
  skip,
  start,
} from '../../public/js/timer-core.js';

/** 每个用例都用一个可控时钟，绝不依赖真实时间 */
const T0 = Date.parse('2026-10-05T09:00:00.000Z');
const MINUTE = 60_000;

const SETTINGS = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  autoStartNext: false,
};

/** 可预测的 id 生成器，便于断言「每段都换了新 id」 */
function makeIdFactory() {
  let seq = 0;
  return () => `seg-${(seq += 1)}`;
}

// 这一组守的是第 1 条硬性不变量：时间只由 startedAt / accumulatedMs 与 now 的差值推出。
// 一旦实现被改成 interval 累加，这里会立刻变红。
describe('时间计算：一切都来自时间戳差值', () => {
  // 初始态尚未 start：没有任何已流逝时间，也应处于暂停态。这是后续所有计算的基线。
  it('未开始时剩余时间就是整段时长', () => {
    const state = createInitialState(SETTINGS, makeIdFactory());
    expect(remainingMs(state, T0)).toBe(25 * MINUTE);
    expect(isRunning(state)).toBe(false);
  });

  // 正推的基本盘：跑满 10 分钟 → 已用 10 分、剩 15 分。
  // now/startedAt 方向写反或毫秒/秒单位弄错，这里立刻暴露。
  it('运行中的剩余时间由 now - startedAt 推出', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    expect(remainingMs(state, T0 + 10 * MINUTE)).toBe(15 * MINUTE);
    expect(elapsedMs(state, T0 + 10 * MINUTE)).toBe(10 * MINUTE);
  });

  // 核心场景：后台标签页的 setInterval 被节流甚至暂停，跳过 20 分钟才第一次求值。
  // 用时间戳差值就必须得到「剩 5 分钟」；累加式计时在这里会错成 25 分钟。
  it('即使中间隔了很久没「tick」，剩余时间照样准确（模拟标签页被后台节流）', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    // 直接跳到 20 分钟后再问，中间一次 tick 都没有
    expect(remainingMs(state, T0 + 20 * MINUTE)).toBe(5 * MINUTE);
  });

  // 超时后 remainingMs 不能是负数 —— 负数会让 formatClock 与进度条出怪相。
  it('剩余时间不会小于 0', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    expect(remainingMs(state, T0 + 999 * MINUTE)).toBe(0);
  });

  // 用户手动改系统时间、或 NTP 校时把时钟往回拨时会触发「now 早于 startedAt」。
  // elapsedMs 内部对 currentRun 取了 max(0, ...)，这条就是那个 clamp 的护栏。
  it('时钟回拨（now 早于 startedAt）不会算出负数', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    expect(elapsedMs(state, T0 - 5 * MINUTE)).toBe(0);
    expect(remainingMs(state, T0 - 5 * MINUTE)).toBe(25 * MINUTE);
  });
});

// 暂停/恢复是 accumulatedMs + startedAt 这套模型最容易写错的地方：
// 暂停期间的时间绝不能计进专注，重复 start/pause 也不能重复累加同一段。
describe('暂停与恢复', () => {
  // 暂停的语义：把「本次运行」结算进累计值，并把 startedAt 置空。
  // 置空很关键 —— 之后 remainingMs 只看 accumulatedMs，暂停期间不再增长。
  it('暂停把本次已用时长并入 accumulatedMs，并清空 startedAt', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = pause(state, T0 + 10 * MINUTE);

    expect(isRunning(state)).toBe(false);
    expect(state.startedAt).toBeNull();
    expect(state.accumulatedMs).toBe(10 * MINUTE);
    expect(remainingMs(state, T0 + 999 * MINUTE)).toBe(15 * MINUTE);
  });

  // 跨一次长达两小时的暂停后恢复。若暂停时没清空 startedAt，
  // 这两小时会被算成专注，剩余时间会瞬间归零。
  it('恢复后从累计值继续，暂停期间的时间不计入', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = pause(state, T0 + 10 * MINUTE);
    // 暂停了两小时
    state = start(state, T0 + 130 * MINUTE);

    expect(remainingMs(state, T0 + 130 * MINUTE)).toBe(15 * MINUTE);
    expect(remainingMs(state, T0 + 135 * MINUTE)).toBe(10 * MINUTE);
  });

  // 多轮 3+2=5 分钟的累计，防止「每次恢复都从 0 重来」或「同一段被重复计入」。
  it('反复暂停/恢复，累计时长正确', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = pause(state, T0 + 3 * MINUTE);
    state = start(state, T0 + 10 * MINUTE);
    state = pause(state, T0 + 12 * MINUTE);
    state = start(state, T0 + 30 * MINUTE);

    expect(state.accumulatedMs).toBe(5 * MINUTE);
    expect(remainingMs(state, T0 + 30 * MINUTE)).toBe(20 * MINUTE);
  });

  // UI 快速连点、或多条代码路径同时触发时会发生重复调用。
  // start 对运行中的状态必须原样返回（startedAt 不被刷新）；
  // pause 对已暂停的状态必须原样返回（accumulatedMs 不被重复累加）。
  it('重复调用 start / pause 是幂等的', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = start(state, T0 + 5 * MINUTE);
    expect(state.startedAt).toBe(T0);

    state = pause(state, T0 + 5 * MINUTE);
    const paused = pause(state, T0 + 9 * MINUTE);
    expect(paused.accumulatedMs).toBe(5 * MINUTE);
  });

  // segmentStartAt 是这一段的墙钟起点，只记一次，用于写入 Session.startAt。
  // 若每次恢复都把它重置，时间轴上的一段番茄会被拉到很晚的位置。
  it('segmentStartAt 跨暂停保持不变（Session.startAt 用墙钟起点）', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = pause(state, T0 + 5 * MINUTE);
    state = start(state, T0 + 60 * MINUTE);
    expect(state.segmentStartAt).toBe(T0);
  });
});

// reset 只清零已用时长，既不改变模式、也不改变「当前是否在跑」。
describe('重置', () => {
  // 运行中点重置：应继续运行（startedAt 被刷新为 now），但已用归零。
  it('清零已用时长但保持当前模式，运行中的继续运行', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = reset(state, T0 + 12 * MINUTE);

    expect(state.mode).toBe(MODE.FOCUS);
    expect(state.accumulatedMs).toBe(0);
    expect(remainingMs(state, T0 + 12 * MINUTE)).toBe(25 * MINUTE);
    expect(isRunning(state)).toBe(true);
  });

  // 反向分支：暂停态重置后必须仍是暂停态，不能顺手把计时跑起来。
  it('暂停态下重置不会把它变成运行态', () => {
    let state = createInitialState(SETTINGS, makeIdFactory());
    state = reset(state, T0);
    expect(isRunning(state)).toBe(false);
  });
});

// 段与段之间的转移规则，以及 longBreakEvery 的取模边界。
// 转移同时决定要不要写 Session（commit），所以这里也是记账正确性的第一道关。
describe('自动转移：专注 → 休息 → 专注', () => {
  // 最基础的转移：专注跑完 → 短休息，completedInCycle 前进到 1。
  // commit 非空说明专注段会写 Session，且 type / duration 都正确。
  it('第 1 次专注完成后进入短休息', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const { state: next, commit } = advance(state, SETTINGS, T0 + 25 * MINUTE);

    expect(next.mode).toBe(MODE.SHORT_BREAK);
    expect(next.completedInCycle).toBe(1);
    expect(commit).not.toBeNull();
    expect(commit.type).toBe(MODE.FOCUS);
    expect(commit.duration).toBe(25 * 60);
  });

  // 取模边界：只有 completedInCycle % longBreakEvery === 0 才进长休息。
  // 特意循环 4 次观察第 4 次的行为 —— 差一错误（写成 (n-1)%k 或 n%k===1）在这里最容易被抓到。
  it('第 4 次专注完成后进入长休息（longBreakEvery 边界）', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    let now = T0;

    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = advance(state, SETTINGS, now + 25 * MINUTE);
      state = start(result.state, now + 25 * MINUTE); // 手动开始休息，autoStartNext 为 false
      seen.push(state.mode);
      now += 25 * MINUTE;
      const brk = advance(state, SETTINGS, now + durationForMode(state.mode, SETTINGS));
      state = start(brk.state, now);
      now += durationForMode(state.mode, SETTINGS);
    }

    expect(seen).toEqual([MODE.SHORT_BREAK, MODE.SHORT_BREAK, MODE.SHORT_BREAK, MODE.LONG_BREAK]);
    expect(state.completedInCycle).toBe(4);
  });

  // 休息段结束只换模式，不推进番茄计数；且休息段 commit 必须为 null
  // （休息不写 Session、也不算番茄）。
  it('休息完成回到专注，且 completedInCycle 不变', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const afterFocus = advance(state, SETTINGS, T0 + 25 * MINUTE).state;
    expect(afterFocus.completedInCycle).toBe(1);

    const breakState = start(afterFocus, T0 + 25 * MINUTE);
    const afterBreak = advance(breakState, SETTINGS, T0 + 30 * MINUTE);

    expect(afterBreak.state.mode).toBe(MODE.FOCUS);
    expect(afterBreak.state.completedInCycle).toBe(1);
    expect(afterBreak.commit).toBeNull(); // 休息段不写 Session
  });

  // autoStartNext 为真时，转移后立即处于运行态，startedAt 落在本段结束的时刻。
  it('autoStartNext=true 时下一段自动开跑', () => {
    const auto = { ...SETTINGS, autoStartNext: true };
    const state = start(createInitialState(auto, makeIdFactory()), T0);
    const { state: next } = advance(state, auto, T0 + 25 * MINUTE);

    expect(isRunning(next)).toBe(true);
    expect(next.startedAt).toBe(T0 + 25 * MINUTE);
    expect(next.accumulatedMs).toBe(0);
  });

  // 反之停在暂停态：startedAt / segmentStartAt 清空，剩余时间等于新段的整段时长。
  it('autoStartNext=false 时下一段停在待启动', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const { state: next } = advance(state, SETTINGS, T0 + 25 * MINUTE);

    expect(isRunning(next)).toBe(false);
    expect(next.startedAt).toBeNull();
    expect(next.segmentStartAt).toBeNull();
    expect(remainingMs(next, T0 + 999 * MINUTE)).toBe(5 * MINUTE);
  });

  // segmentId 是客户端幂等键，服务端有 @@unique([userId, clientId]) 兜底。
  // 若转移时沿用旧 id，第二段 POST 会撞唯一键、被当成重复而丢弃。
  // 同时确认 commit.clientId 用的是「刚结束那一段」的 id。
  it('每次转移都换新的 segmentId —— 否则下一段会覆盖上一段的幂等键', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const next = advance(state, SETTINGS, T0 + 25 * MINUTE).state;
    expect(next.segmentId).not.toBe(state.segmentId);

    const first = advance(state, SETTINGS, T0 + 25 * MINUTE).commit;
    expect(first.clientId).toBe(state.segmentId);
  });
});

// 跳过 = 转移但不记账。它与 advance 的关键区别就是 commit 恒为 null。
describe('跳过', () => {
  // 被跳过的专注段不能算完成：不写 Session，completedInCycle 保持不动。
  it('跳过不产生 Session 记录，也不增加番茄计数', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const result = skip(state, SETTINGS, T0 + 3 * MINUTE);

    expect(result.commit).toBeNull();
    expect(result.state.mode).toBe(MODE.SHORT_BREAK);
    expect(result.state.completedInCycle).toBe(0);
  });

  // 反向分支：休息段跳过应回到专注，而不是继续待在休息。
  it('从休息跳过回到专注', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = skip(state, SETTINGS, T0 + 1 * MINUTE).state;
    const back = skip(state, SETTINGS, T0 + 2 * MINUTE);
    expect(back.state.mode).toBe(MODE.FOCUS);
  });
});

// reconcileOnLoad 处理「页面刷新 / 关机几小时后回来」。
// 这是防幽灵番茄的最后一道闸：超时只补记一段，且强制暂停。
describe('刷新恢复与超时对账', () => {
  // 正常刷新（尚未到期）：必须原样返回同一个对象，不做任何改动。
  // 计时继续靠时间戳差值自动算准，不需要特殊处理。
  it('未到期时原样返回，计时继续', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const result = reconcileOnLoad(state, SETTINGS, T0 + 10 * MINUTE, makeIdFactory());

    expect(result.commit).toBeNull();
    expect(result.state).toBe(state);
    expect(remainingMs(result.state, T0 + 10 * MINUTE)).toBe(15 * MINUTE);
  });

  // 从未 start 过的状态（startedAt 为 null）无论过去多久都不该补记。
  it('未启动的状态直接返回，不产生补记', () => {
    const state = createInitialState(SETTINGS, makeIdFactory());
    const result = reconcileOnLoad(state, SETTINGS, T0 + 500 * MINUTE, makeIdFactory());
    expect(result.commit).toBeNull();
  });

  // 关键不变量：补记的 endAt 用 segmentStartAt + durationMs（本该结束的时刻），
  // 而非回来那一刻。否则离开 3 小时会被记成一段 3 小时的「专注」。
  it('过期数小时后只补记一段，且 endAt 是本该结束的时刻而非现在', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const result = reconcileOnLoad(state, SETTINGS, T0 + 180 * MINUTE, makeIdFactory());

    expect(result.commit).not.toBeNull();
    expect(result.commit!.startAt).toBe(new Date(T0).toISOString());
    // 关键：endAt = 起点 + 25 分钟，而不是 3 小时后
    expect(result.commit!.endAt).toBe(new Date(T0 + 25 * MINUTE).toISOString());
    expect(result.commit!.duration).toBe(25 * 60);
  });

  // 即使设置里开了自动开始，超时恢复也必须停在暂停态。
  // 否则下一次 reconcile 会基于新一段继续补记，级联生成一串幽灵番茄。
  // completedInCycle 恰好为 1，证明只推进了一段而已。
  it('超时补记后强制暂停，即使 autoStartNext=true —— 避免级联出幽灵番茄', () => {
    const auto = { ...SETTINGS, autoStartNext: true };
    const state = start(createInitialState(auto, makeIdFactory()), T0);
    const result = reconcileOnLoad(state, auto, T0 + 600 * MINUTE, makeIdFactory());

    expect(isRunning(result.state)).toBe(false);
    expect(result.state.startedAt).toBeNull();
    expect(result.state.accumulatedMs).toBe(0);
    // 只推进了一段：1 次专注 → 短休息，completedInCycle 恰好为 1
    expect(result.state.mode).toBe(MODE.SHORT_BREAK);
    expect(result.state.completedInCycle).toBe(1);
  });

  // 超时的若是休息段：回到专注、强制暂停，但 commit 仍为 null。
  it('超时的是休息段则不产生任何记录（休息不算工作）', () => {
    let state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    state = advance(state, SETTINGS, T0 + 25 * MINUTE).state; // 进入短休息
    state = start(state, T0 + 25 * MINUTE);

    const result = reconcileOnLoad(state, SETTINGS, T0 + 300 * MINUTE, makeIdFactory());
    expect(result.commit).toBeNull();
    expect(result.state.mode).toBe(MODE.FOCUS);
    expect(isRunning(result.state)).toBe(false);
  });
});

// 每段在开始时把设置里的时长快照进 state.durationMs，
// 于是中途改偏好不会影响正在跑的这一段，只在下一段生效。
describe('设置快照', () => {
  // 传入改了 focusMin 的新 settings，验证当前段仍按旧值 25 分钟走，
  // 新值 5 分钟要到下一段才生效。
  it('中途改设置不会影响当前这一段的时长', () => {
    const state = start(createInitialState(SETTINGS, makeIdFactory()), T0);
    const changed = { ...SETTINGS, focusMin: 5 };

    // state 里已经快照了 durationMs，所以剩余时间仍按 25 分钟算
    expect(remainingMs(state, T0 + 1 * MINUTE)).toBe(24 * MINUTE);
    // 新设置只在**下一段**生效
    const next = advance(state, changed, T0 + 25 * MINUTE).state;
    expect(next.durationMs).toBe(5 * MINUTE);
  });
});

// taskId 决定专注段完成后 Session 归属到哪个任务，也决定番茄数是否 +1
// （服务端只对 type=focus && completed && taskId !== null 的记录计数）。
describe('任务绑定', () => {
  // setTask(null) 应被归一成 null 而不是 undefined，
  // 否则序列化进 localStorage 再读回时会丢字段。
  it('setTask 绑定与解绑', () => {
    const state = createInitialState(SETTINGS, makeIdFactory());
    expect(setTask(state, 'task-1').taskId).toBe('task-1');
    expect(setTask(state, null).taskId).toBeNull();
  });

  // taskId 跨段保留：休息期间用户不必重新选任务，回到专注时仍绑着同一个。
  it('转移到休息段时保留 taskId，回到专注后仍然绑着', () => {
    let state = setTask(start(createInitialState(SETTINGS, makeIdFactory()), T0), 'task-1');
    state = advance(state, SETTINGS, T0 + 25 * MINUTE).state;
    expect(state.taskId).toBe('task-1');
    state = advance(start(state, T0 + 25 * MINUTE), SETTINGS, T0 + 30 * MINUTE).state;
    expect(state.taskId).toBe('task-1');
  });

  // 完成的番茄必须带着 taskId 进 commit，否则服务端不会给它加番茄计数。
  it('commit 里带上 taskId', () => {
    const state = setTask(start(createInitialState(SETTINGS, makeIdFactory()), T0), 'task-9');
    const { commit } = advance(state, SETTINGS, T0 + 25 * MINUTE);
    expect(commit!.taskId).toBe('task-9');
  });
});

// 与显示、持久化相关的纯函数。它们同属 timer-core，所以同样不碰 DOM。
describe('格式化与状态恢复', () => {
  // 覆盖补零、满一小时切换到 H:MM:SS、以及负数兜底为 00:00。
  it('formatClock 补零并处理小时', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(25 * MINUTE)).toBe('25:00');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-1)).toBe('00:00');
  });

  // localStorage 里可能是 null、被手改坏、或旧版本遗留的结构。
  // 恢复函数必须容错到「回到干净的初始状态」，而不是抛异常让整页白屏。
  it('reviveState 对垃圾输入回退到初始状态', () => {
    const fallback = reviveState(null, SETTINGS, makeIdFactory());
    expect(fallback.mode).toBe(MODE.FOCUS);
    expect(fallback.startedAt).toBeNull();

    const badMode = reviveState({ mode: 'nonsense' }, SETTINGS, makeIdFactory());
    expect(badMode.mode).toBe(MODE.FOCUS);
  });

  // 合法字段原样保留，缺失/类型不对的字段用默认值补齐 ——
  // 尤其 segmentId 缺失时要用 idFactory 生成，不能留成 undefined。
  it('reviveState 保留合法字段并补全缺失字段', () => {
    const restored = reviveState(
      { mode: MODE.SHORT_BREAK, durationMs: 5 * MINUTE, startedAt: T0, accumulatedMs: 0 },
      SETTINGS,
      makeIdFactory(),
    );
    expect(restored.mode).toBe(MODE.SHORT_BREAK);
    expect(restored.startedAt).toBe(T0);
    expect(restored.segmentId).toBe('seg-1'); // 缺失字段用 idFactory 补
    expect(restored.completedInCycle).toBe(0);
  });
});
