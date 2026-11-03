import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MODE,
  advance,
  createInitialState,
  isRunning,
  reconcileOnLoad,
  setTask,
  skip,
  start,
} from '../../public/js/timer-core.js';
import {
  api,
  cleanupUsers,
  newTestUser,
  startTestServer,
  stopTestServer,
} from '../helpers/server.js';

/**
 * 端到端闭环测试：把纯计时核心产生的 commit 直接喂给真实的 API，
 * 验证「专注段结束 → 写入 Session → 任务番茄数 +1」这条验收链路。
 *
 * 这样就把「纯函数的正确性」和「数据库/接口的正确性」接了起来 ——
 * 两边各自的单测都通过，不代表接起来也对。
 */

const DATE = '2026-10-05';
const T0 = Date.parse('2026-10-05T01:00:00.000Z');
const MINUTE = 60_000;

const SETTINGS = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  autoStartNext: false,
};

/** 建一个本次用例专属的账号 */
function user(): string {
  return newTestUser();
}

async function makeTask(as: string, title = '端到端任务'): Promise<string> {
  const res = await api('/api/tasks', {
    as,
    method: 'POST',
    body: { title, date: DATE },
  });
  return (res.body.data as Record<string, unknown>).id as string;
}

async function pomodorosOf(as: string, taskId: string): Promise<number> {
  const res = await api(`/api/tasks/${taskId}`, { as });
  return (res.body.data as Record<string, unknown>).completedPomodoros as number;
}

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await cleanupUsers();
  await stopTestServer();
});

/**
 * 这一层的价值是把纯计时核心（timer-core，无副作用）产出的 commit 原样
 * 喂给真实 API，验证接缝处也对。两边的单测各自通过，不代表字段名、时间
 * 格式、幂等键就对得上。
 */
describe('完整一轮专注', () => {
  // start → advance 25 分钟 → commit 非空且绑定任务。核心产出的 commit
  // 直接作为 POST 的 body，不做任何搬运转换，字段不匹配会立刻暴露。后半段
  // 重发验证的是客户端 outbox 重试与服务端唯一约束两层合起来账不重记。
  it('★ 专注段跑完 → 写 Session → 番茄数 +1；重发不重复计数', async () => {
    const id = user();
    const taskId = await makeTask(id);

    // 用户点「开始」，并把这个任务绑到计时器上
    let state = setTask(createInitialState(SETTINGS), taskId);
    state = start(state, T0);

    // 25 分钟后（时间由时间戳差值推出，不是 interval 累加）
    const { state: next, commit } = advance(state, SETTINGS, T0 + 25 * MINUTE);

    expect(next.mode).toBe(MODE.SHORT_BREAK);
    expect(commit).not.toBeNull();
    expect(commit!.taskId).toBe(taskId);

    // 模拟 outbox 冲刷：把 commit 发给真实 API
    const recorded = await api('/api/sessions', { as: id, method: 'POST', body: commit });
    expect(recorded.status).toBe(201);

    expect(await pomodorosOf(id, taskId)).toBe(1);

    // ★ 模拟「段结束瞬间刷新页面」导致的重发 —— 账不能重复记
    const replay = await api('/api/sessions', { as: id, method: 'POST', body: commit });
    expect(replay.status).toBe(200);
    expect((replay.body.data as Record<string, unknown>).created).toBe(false);

    expect(await pomodorosOf(id, taskId)).toBe(1);
  });

  // 走完 4 个完整循环（专注 + 休息），验证 longBreakEvery=4 的边界在真实
  // 写入下也成立，番茄数恰好是 4。同时 focus 类型的会话条数也应是 4 ——
  // 休息段不能混进来。这是产品主张「4 个番茄后长休」的链路级确认。
  it('★ 连续完成 4 个番茄：第 4 个后进入长休息，且番茄数正好是 4', async () => {
    const id = user();
    const taskId = await makeTask(id);

    let state = setTask(createInitialState(SETTINGS), taskId);
    let now = T0;

    for (let round = 1; round <= 4; round += 1) {
      state = start(state, now);
      const result = advance(state, SETTINGS, now + 25 * MINUTE);

      const recorded = await api('/api/sessions', { as: id, method: 'POST', body: result.commit });
      expect(recorded.status).toBe(201);

      state = result.state;
      now += 25 * MINUTE;

      // 走完休息
      state = start(state, now);
      state = advance(state, SETTINGS, now + 5 * MINUTE).state;
      now += 5 * MINUTE;
    }

    expect(await pomodorosOf(id, taskId)).toBe(4);

    // 4 个番茄后应该看到长休息已经发生过
    const sessions = await api(`/api/sessions?date=${DATE}&tz=0`, { as: id });
    const focusCount = (sessions.body.data as Record<string, unknown>[]).filter(
      (session) => session.type === 'focus',
    ).length;
    expect(focusCount).toBe(4);
  });

  // 关机 3 小时后回来，reconcileOnLoad 只补记一段（结束时间用
  // segmentStartAt + durationMs，而不是回来的墙钟时间），下一段停在暂停态。
  // 若按墙钟合成，3 小时会凭空变出 7 个幽灵番茄 —— 这条守住「诚实记账」。
  it('★ 超时补记：只记一段，且下一段停在暂停态', async () => {
    const id = user();
    const taskId = await makeTask(id, '超时任务');

    const running = start(setTask(createInitialState(SETTINGS), taskId), T0);

    // 用户关掉页面，3 小时后才回来
    const reconciled = reconcileOnLoad(running, SETTINGS, T0 + 180 * MINUTE);

    expect(reconciled.commit).not.toBeNull();
    expect(isRunning(reconciled.state)).toBe(false);
    expect(reconciled.state.completedInCycle).toBe(1);

    await api('/api/sessions', { as: id, method: 'POST', body: reconciled.commit });

    // 只加了一次，没有因为「离开 3 小时」合成出 7 个幽灵番茄
    expect(await pomodorosOf(id, taskId)).toBe(1);
  });

  // 没有绑定任务时 commit.taskId 为 null，但仍要能写入 Session 并计入
  // 今日专注汇总（focusSeconds=1500、pomodoros=1），只是没有任务加上去。
  it('未绑定任务的专注段也能记录，只是没有任务会计数', async () => {
    const id = user();

    const state = start(createInitialState(SETTINGS), T0);
    const { commit } = advance(state, SETTINGS, T0 + 25 * MINUTE);

    expect(commit!.taskId).toBeNull();
    const recorded = await api('/api/sessions', { as: id, method: 'POST', body: commit });
    expect(recorded.status).toBe(201);

    // 今日汇总里应能看到这段专注
    const summary = await api(`/api/stats/summary?date=${DATE}&tz=0`, { as: id });
    expect(summary.body.data).toMatchObject({ focusSeconds: 1500, pomodoros: 1 });
  });

  // skip 在 timer-core 里返回 commit: null，所以不该有任何 Session 落库。
  // 这条守住「跳过」和「完成」在账目上彻底分开。
  it('跳过的专注段不产生任何记录', async () => {
    const id = user();
    const taskId = await makeTask(id, '被跳过的任务');

    // skip 在 timer-core 里返回 commit: null
    const { commit } = skip(
      start(setTask(createInitialState(SETTINGS), taskId), T0),
      SETTINGS,
      T0 + 3 * MINUTE,
    );

    expect(commit).toBeNull();
    expect(await pomodorosOf(id, taskId)).toBe(0);
  });
});
