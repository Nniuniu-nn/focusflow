import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  cleanupUsers,
  newClientId,
  newTestUser,
  startTestServer,
  stopTestServer,
} from '../helpers/server.js';

const DATE = '2026-10-05';
const TZ = 480;

/** 建一个本次用例专属的账号 */
function user(): string {
  return newTestUser();
}

/** 建一个任务并返回 id */
async function makeTask(as: string, title = '任务'): Promise<string> {
  const res = await api('/api/tasks', {
    as,
    method: 'POST',
    body: { title, date: DATE },
  });
  return (res.body.data as Record<string, unknown>).id as string;
}

/** 构造一个专注段的请求体 */
function focusBody(clientId: string, taskId: string | null, startIso = '2026-10-05T01:00:00.000Z') {
  return {
    clientId,
    taskId,
    startAt: startIso,
    endAt: new Date(Date.parse(startIso) + 25 * 60_000).toISOString(),
    duration: 1500,
    type: 'focus',
    completed: true,
  };
}

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await cleanupUsers();
  await stopTestServer();
});

/**
 * 时段记录是「写 Session 与番茄数 +1」同一事务里的写入。这一组的关键
 * 不是能不能写，而是幂等：同一 clientId 重放（刷新、网络重试、并发）绝不能
 * 重复记账；同时守住跨用户、跨任务的越权不能发生。
 */
describe('时段记录与幂等', () => {
  // 基线：正常路径下 201、created=true、番茄 +1。后面的幂等与越权用例
  // 都是相对这条基线说的，先把它钉住。
  it('首次提交返回 201，并让任务的 completedPomodoros +1', async () => {
    const id = user();
    const taskId = await makeTask(id);

    const res = await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), taskId),
    });

    expect(res.status).toBe(201);
    const data = res.body.data as Record<string, unknown>;
    expect(data.created).toBe(true);

    const task = await api(`/api/tasks/${taskId}`, { as: id });
    expect((task.body.data as Record<string, unknown>).completedPomodoros).toBe(1);
  });

  // 客户端在某段开始时生成 clientId，段结束时用它 POST。刷新或网络重试
  // 会让同一个 clientId 到达两次：第二次必须命中唯一约束当作成功、返回既有
  // 记录，番茄数不再 +1。真正的断言是「恰好为 1」—— 只看返回码会漏掉重复计数。
  it('★ 重放同一 clientId：返回 200、created=false、番茄数不再增加', async () => {
    const id = user();
    const taskId = await makeTask(id);
    const clientId = newClientId();
    const body = focusBody(clientId, taskId);

    const first = await api('/api/sessions', { as: id, method: 'POST', body });
    const replay = await api('/api/sessions', { as: id, method: 'POST', body });

    expect(first.status).toBe(201);
    expect((first.body.data as Record<string, unknown>).created).toBe(true);

    expect(replay.status).toBe(200);
    expect((replay.body.data as Record<string, unknown>).created).toBe(false);

    // 两次返回的是同一条记录
    const firstSession = (first.body.data as Record<string, unknown>).session as Record<string, unknown>;
    const replaySession = (replay.body.data as Record<string, unknown>).session as Record<string, unknown>;
    expect(replaySession.id).toBe(firstSession.id);

    // 关键断言：番茄数恰好是 1
    const task = await api(`/api/tasks/${taskId}`, { as: id });
    expect((task.body.data as Record<string, unknown>).completedPomodoros).toBe(1);
  });

  // 三个请求同时发出，模拟「段结束瞬间刷新」时两个请求撞在 P2002 上。
  // 串行重放通过不代表并发也过：若幂等靠「先查再写」而不是交给唯一约束，
  // 两个并发请求可能都查到不存在、然后各自插入。允许 201/200，但番茄数必须还是 1。
  it('★ 并发重放（模拟刷新边界）也只记一次', async () => {
    const id = user();
    const taskId = await makeTask(id);
    const body = focusBody(newClientId(), taskId);

    const results = await Promise.all([
      api('/api/sessions', { as: id, method: 'POST', body }),
      api('/api/sessions', { as: id, method: 'POST', body }),
      api('/api/sessions', { as: id, method: 'POST', body }),
    ]);

    expect(results.every((res) => res.status === 201 || res.status === 200)).toBe(true);

    const task = await api(`/api/tasks/${taskId}`, { as: id });
    expect((task.body.data as Record<string, unknown>).completedPomodoros).toBe(1);
  });

  // 只有 type=focus 才计数。休息段走的是同一张 Session 表，
  // 若条件写成「completed 就 +1」，短休和长休会悄悄刷任务进度。
  it('休息段不增加番茄数', async () => {
    const id = user();
    const taskId = await makeTask(id);

    const res = await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: {
        clientId: newClientId(),
        taskId,
        startAt: '2026-10-05T02:00:00.000Z',
        endAt: '2026-10-05T02:05:00.000Z',
        duration: 300,
        type: 'short_break',
        completed: true,
      },
    });

    expect(res.status).toBe(201);
    const task = await api(`/api/tasks/${taskId}`, { as: id });
    expect((task.body.data as Record<string, unknown>).completedPomodoros).toBe(0);
  });

  // completed=false 表示中途放弃。计时中断也要留痕（供统计真实专注时长），
  // 但不能兑现成番茄 —— 否则跳过/提前结束也会加数。
  it('未完成的专注段不增加番茄数', async () => {
    const id = user();
    const taskId = await makeTask(id);

    await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: { ...focusBody(newClientId(), taskId), completed: false },
    });

    const task = await api(`/api/tasks/${taskId}`, { as: id });
    expect((task.body.data as Record<string, unknown>).completedPomodoros).toBe(0);
  });

  // 计时器允许不选任务就开始。taskId 为 null 时仍要落 Session，
  // 只是没有任务可加番茄。这条守住「没绑任务」不是错误路径。
  it('不绑任务的专注段也能记录', async () => {
    const id = user();
    const res = await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), null),
    });
    expect(res.status).toBe(201);
  });

  // 外键只保证 task 存在，不保证它属于你。服务端必须显式
  // count({ id, userId }) 校验归属。省掉这步，Bob 就能往 Alice 的任务里刷
  // 番茄数。末尾再确认 Alice 的任务没被动过 —— 400 也可能是「先写后回滚失败」。
  it('★ 不能把时段挂到别人的任务上', async () => {
    const alice = user();
    const bob = user();
    const aliceTaskId = await makeTask(alice, '爱丽丝的任务');

    const res = await api('/api/sessions', {
      as: bob,
      method: 'POST',
      body: focusBody(newClientId(), aliceTaskId),
    });

    expect(res.status).toBe(400);

    // 爱丽丝的任务没有被别人刷番茄数
    const aliceTask = await api(`/api/tasks/${aliceTaskId}`, { as: alice });
    expect((aliceTask.body.data as Record<string, unknown>).completedPomodoros).toBe(0);
  });

  // 唯一约束是复合的 @@unique([userId, clientId])，不是 clientId 单列唯一。
  // 两个用户各自生成 UUID 理论上会撞车；约束写错的话，先到的会把后到的挤成
  // 「已存在」，后者的专注直接丢账。两人都应 201，且各计 1。
  it('★ 相同 clientId 在不同用户之间互不影响', async () => {
    const alice = user();
    const bob = user();
    const taskA = await makeTask(alice, 'A');
    const taskB = await makeTask(bob, 'B');
    const sharedClientId = newClientId();

    const a = await api('/api/sessions', {
      as: alice,
      method: 'POST',
      body: focusBody(sharedClientId, taskA),
    });
    const b = await api('/api/sessions', {
      as: bob,
      method: 'POST',
      body: focusBody(sharedClientId, taskB),
    });

    // 两个人各自都该新建成功，而不是互相把对方挤成「已存在」
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const taskAResult = await api(`/api/tasks/${taskA}`, { as: alice });
    const taskBResult = await api(`/api/tasks/${taskB}`, { as: bob });
    expect((taskAResult.body.data as Record<string, unknown>).completedPomodoros).toBe(1);
    expect((taskBResult.body.data as Record<string, unknown>).completedPomodoros).toBe(1);
  });

  // clientId 既是幂等键也要进库，形状不对（非 UUID）要在入口拒绝，
  // 别让它污染唯一索引。
  it('非法 clientId 返回 400', async () => {
    const res = await api('/api/sessions', {
      as: user(),
      method: 'POST',
      body: { ...focusBody('not-a-uuid', null) },
    });
    expect(res.status).toBe(400);
  });

  // type 是枚举。放进 'nap' 之类的值，会让统计按 type 分组时分不到桶，
  // 也会让番茄计数逻辑的 type===focus 判断悄悄为假。
  it('非法 type 返回 400', async () => {
    const res = await api('/api/sessions', {
      as: user(),
      method: 'POST',
      body: { ...focusBody(newClientId(), null), type: 'nap' },
    });
    expect(res.status).toBe(400);
  });

  // 时长由时间戳差值推出，start > end 会得到负数。统计柱状图和热力图
  // 都会因此出现负值。必须在入口挡下，靠前端校验不够。
  it('endAt 早于 startAt 返回 400', async () => {
    const res = await api('/api/sessions', {
      as: user(),
      method: 'POST',
      body: {
        ...focusBody(newClientId(), null),
        startAt: '2026-10-05T05:00:00.000Z',
        endAt: '2026-10-05T01:00:00.000Z',
      },
    });
    expect(res.status).toBe(400);
  });

  // 查询按 tz 把时段归属到某一天，前一天那条要被排除。升序是时间轴/热力图
  // 按时间铺开的前提 —— 顺序乱了图形就会错位。
  it('按时段查询只返回当天、且按开始时间升序', async () => {
    const id = user();

    await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), null, '2026-10-05T04:00:00.000Z'),
    });
    await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), null, '2026-10-05T01:00:00.000Z'),
    });
    // 前一天的一条，不应出现在 10-05 的结果里
    await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), null, '2026-10-04T01:00:00.000Z'),
    });

    const res = await api(`/api/sessions?date=${DATE}&tz=${TZ}`, { as: id });
    const list = res.body.data as Record<string, unknown>[];

    expect(list).toHaveLength(2);
    expect(list[0]!.startAt).toBe('2026-10-05T01:00:00.000Z');
    expect(list[1]!.startAt).toBe('2026-10-05T04:00:00.000Z');
  });
});

/**
 * 统计是纯聚合函数 + 接口的组合。这一组守三类最容易出错的点：
 * 空数据不崩（不产出 NaN 或非法坐标）、跨时区归属正确、参数越界被拒。
 */
describe('统计接口', () => {
  // 两个专注段各 1500s，外加一个已完成任务：汇总必须是 3000s / 2 番茄 / 1 中 1 完成。
  // focusSeconds 按真实时长累加，而不是番茄数乘固定值。
  it('summary 汇总今日专注、番茄与任务进度', async () => {
    const id = user();
    const taskId = await makeTask(id);

    await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), taskId, '2026-10-05T01:00:00.000Z'),
    });
    await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), taskId, '2026-10-05T02:00:00.000Z'),
    });
    await api(`/api/tasks/${taskId}`, { as: id, method: 'PATCH', body: { status: 'done' } });

    const res = await api(`/api/stats/summary?date=${DATE}&tz=${TZ}`, { as: id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      focusSeconds: 3000,
      pomodoros: 2,
      tasksTotal: 1,
      tasksDone: 1,
    });
  });

  // 连续 30 天哪怕一条数据都没有，也要返回 30 个日期桶（值为 0）。
  // 有空洞的话前端柱状图的 x 轴会缺格、日期整体错位。空库时总和为 0。
  it('daily 返回 30 个桶且没有空洞', async () => {
    const res = await api(`/api/stats/daily?days=30&tz=${TZ}`, { as: user() });
    const data = res.body.data as Record<string, unknown>[];

    expect(res.status).toBe(200);
    expect(data).toHaveLength(30);
    expect(data.every((bucket) => typeof bucket.date === 'string')).toBe(true);
    expect(data.reduce((sum, bucket) => sum + (bucket.focusSeconds as number), 0)).toBe(0);
  });

  // 没有任何专注时返回空 cells、max=0。max 是用来算颜色刻度的，
  // 若为 undefined 或 NaN，ECharts 会画出非法颜色甚至直接报错。
  it('heatmap 在无数据时返回空格子且 max=0', async () => {
    const res = await api(`/api/stats/heatmap?days=30&tz=${TZ}`, { as: user() });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cells: [], max: 0 });
  });

  // 2026-10-05T01:00Z 在东八区是周一 09:00。这条同时验证按 tz 换算出的
  // weekday/hour 和 focusSeconds 累加 —— 时区算错格子会落到隔壁小时或星期。
  it('heatmap 能反映已记录的专注段', async () => {
    const id = user();
    // 2026-10-05T01:00Z = 东八区周一 09:00
    await api('/api/sessions', {
      as: id,
      method: 'POST',
      body: focusBody(newClientId(), null, '2026-10-05T01:00:00.000Z'),
    });

    const res = await api(`/api/stats/heatmap?days=30&tz=${TZ}`, { as: id });
    const data = res.body.data as { cells: Record<string, number>[]; max: number };

    expect(data.cells).toHaveLength(1);
    expect(data.cells[0]).toMatchObject({ weekday: 1, hour: 9, focusSeconds: 1500 });
    expect(data.max).toBe(1500);
  });

  // 完成率 = done / total；无任务时必须返回 { total:0, done:0, rate:0 }，
  // 而不是 NaN。空分母是这类计算最经典的翻车点。
  it('completion 计算完成率，且无任务时 rate 为 0', async () => {
    const id = user();
    for (const title of ['A', 'B', 'C']) {
      await makeTask(id, title);
    }
    const list = await api(`/api/tasks?date=${DATE}`, { as: id });
    const ids = (list.body.data as Record<string, unknown>[]).map((task) => task.id as string);
    await api(`/api/tasks/${ids[0]}`, { as: id, method: 'PATCH', body: { status: 'done' } });

    const res = await api(`/api/stats/completion?days=30&tz=${TZ}`, { as: id });
    expect(res.body.data).toMatchObject({ total: 3, done: 1 });
    expect((res.body.data as Record<string, number>).rate).toBeCloseTo(1 / 3);

    const empty = await api(`/api/stats/completion?days=30&tz=${TZ}`, { as: user() });
    expect(empty.body.data).toEqual({ total: 0, done: 0, rate: 0 });
  });

  // days 有上限，不校验的话一次请求就能扫全表、把数据库拖慢。
  it('非法 days 参数返回 400', async () => {
    const res = await api('/api/stats/daily?days=9999', { as: user() });
    expect(res.status).toBe(400);
  });

  // tz 是有范围的分钟偏移。越界值会让分桶算出非法小时，
  // 甚至把日期推到隔壁一天。
  it('非法 tz 参数返回 400', async () => {
    const res = await api('/api/stats/daily?tz=99999', { as: user() });
    expect(res.status).toBe(400);
  });
});
