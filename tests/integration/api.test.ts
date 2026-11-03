import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  cleanupUsers,
  newTestUser,
  raw,
  startTestServer,
  stopTestServer,
} from '../helpers/server.js';

const DATE = '2026-10-05';

/** 建一个本次用例专属的账号。用户名唯一，天然与其他用例隔离。 */
function user(): string {
  return newTestUser();
}

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await cleanupUsers();
  await stopTestServer();
});

/**
 * 身份来自签名 cookie，而不是以前的 X-User-Id 头。这一组守的是
 * 「未登录 / 伪造凭证都被挡在业务逻辑之外」，以及注册后默认设置确实落了库。
 */
describe('鉴权', () => {
  // 健康检查是唯一的公开业务入口；requireAuth 白名单里漏掉它，
  // 探活和负载均衡会直接收到 401。响应信封的 status/code 也顺带钉在这里。
  it('/api/health 不需要登录', async () => {
    const res = await api('/api/health', { as: null });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.code).toBe(0);
  });

  // 缺失 cookie 必须由 requireAuth 在进业务层之前截住。data 为 null 是信封约定：
  // 错误响应不携带负载，前端只需看 status/code。
  it('★ 未登录访问业务接口返回 401 信封', async () => {
    const res = await api('/api/tasks', { as: null });
    expect(res.status).toBe(401);
    expect(res.body.status).toBe('error');
    expect(res.body.code).toBe(401);
    expect(res.body.data).toBeNull();
  });

  it('★ 伪造的 token 返回 401', async () => {
    // 以前这里是「X-User-Id 不是 UUID → 400」。
    // 现在身份来自签名 cookie，伪造一个形状像 JWT 的串必须被验签挡下。
    const res = await raw('/api/tasks', { cookie: `ff_token=${crypto.randomUUID()}` });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: 'error', code: 401 });
  });

  // 注册时在同一事务里建了 Setting 行。这条守住「新用户第一次打开设置页
  // 看到的是产品默认值（25/5/15/4），而不是 0 或空」。
  it('注册后即拥有默认设置', async () => {
    const res = await api('/api/settings', { as: user() });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      focusMin: 25,
      shortBreakMin: 5,
      longBreakMin: 15,
      longBreakEvery: 4,
      autoStartNext: true,
    });
  });

  // 未匹配到路由也要走统一信封；否则前端对 404 的 HTML 调 res.json()
  // 会先抛解析错误，真正的 404 反而看不见。这条同时覆盖 errorHandler 的兜底。
  it('不存在的路径返回 404 信封', async () => {
    const res = await api('/api/nope', { as: user() });
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });
});

/**
 * 任务的增删改查与排序。重点不在单个接口能不能用，而在两条隔离线：
 * 按 date 归属到某一天，以及按 userId 越权 —— 外键只保证记录存在，
 * 不保证它属于调用者。
 */
describe('任务 CRUD', () => {
  // 把完整生命周期串起来测，任何一步丢字段都会在这条暴露。
  // 新建任务的默认值（status=todo、completedPomodoros=0、order=0）也在钉死。
  it('创建 → 查询 → 更新 → 删除 全流程', async () => {
    const id = user();

    const created = await api('/api/tasks', {
      as: id,
      method: 'POST',
      body: { title: '写 FocusFlow', date: DATE, estimatedPomodoros: 3 },
    });
    expect(created.status).toBe(201);
    const task = created.body.data as Record<string, unknown>;
    expect(task.title).toBe('写 FocusFlow');
    expect(task.date).toBe(DATE);
    expect(task.estimatedPomodoros).toBe(3);
    expect(task.completedPomodoros).toBe(0);
    expect(task.status).toBe('todo');
    expect(task.order).toBe(0);

    const listed = await api(`/api/tasks?date=${DATE}`, { as: id });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);

    const updated = await api(`/api/tasks/${task.id}`, {
      as: id,
      method: 'PATCH',
      body: { status: 'done', note: '备注' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ status: 'done', note: '备注' });

    const deleted = await api(`/api/tasks/${task.id}`, { as: id, method: 'DELETE' });
    expect(deleted.status).toBe(200);

    const afterDelete = await api(`/api/tasks?date=${DATE}`, { as: id });
    expect(afterDelete.body.data).toHaveLength(0);
  });

  // 库/列的字符集若不是 utf8mb4，中文会在写入时被截断或变问号。
  // 从创建到查询读回完全一致，才说明这条链路没有在某处降级。
  it('中文标题能正确往返（验证 UTF-8 存储）', async () => {
    const id = user();
    const created = await api('/api/tasks', {
      as: id,
      method: 'POST',
      body: { title: '复习英语单词', date: DATE },
    });
    expect((created.body.data as Record<string, unknown>).title).toBe('复习英语单词');

    const listed = await api(`/api/tasks?date=${DATE}`, { as: id });
    expect((listed.body.data as Record<string, unknown>[])[0]!.title).toBe('复习英语单词');
  });

  // 列表顺序由 order 决定，新建必须追加到末尾而不是插到 0。
  // 若 order 取时间戳或随机值，重排后的稳定性就无从谈起。
  it('新建的任务排在当天末尾（order 递增）', async () => {
    const id = user();
    for (const title of ['A', 'B', 'C']) {
      await api('/api/tasks', { as: id, method: 'POST', body: { title, date: DATE } });
    }

    const listed = await api(`/api/tasks?date=${DATE}`, { as: id });
    const orders = (listed.body.data as Record<string, unknown>[]).map((task) => task.order);
    expect(orders).toEqual([0, 1, 2]);
  });

  // 任务按 date 归属。这条守的是 parseDateOnly 按 UTC 午夜解析没被本地时区带偏 ——
  // 一旦用本地时区，跨午夜写入的任务会被挪到隔壁那一天，看板上凭空多/少一条。
  it('★ 按日期隔离：查 10-06 看不到 10-05 的任务', async () => {
    const id = user();
    await api('/api/tasks', { as: id, method: 'POST', body: { title: '昨天的', date: '2026-10-04' } });
    await api('/api/tasks', { as: id, method: 'POST', body: { title: '今天的', date: DATE } });

    const today = await api(`/api/tasks?date=${DATE}`, { as: id });
    expect(today.body.data).toHaveLength(1);
    expect((today.body.data as Record<string, unknown>[])[0]!.title).toBe('今天的');
  });

  // 不传 date 时服务端按传入的 tz 推算「今天」。tz 缺省或算错，
  // 会让看板在跨午夜时打开到空列表或前一天的列表。
  it('缺省 date 时返回给定时区下的今天', async () => {
    const id = user();
    // 东八区 UTC+8
    const res = await api('/api/tasks?tz=480', { as: id });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // 日历上不存在的日期必须被校验挡下。否则会被 JS Date 的溢出行为静默
  // 转成 2026-03-02，任务记到错误的一天而且没人报错。
  it('非法 date 返回 400', async () => {
    const res = await api('/api/tasks?date=2026-02-30', { as: user() });
    expect(res.status).toBe(400);
  });

  // 纯空白要按空处理。只在客户端 trim 是不够的 —— 绕过前端直接打 API
  // 就能塞进一个看起来什么也没有的任务。
  it('空标题返回 400', async () => {
    const res = await api('/api/tasks', {
      as: user(),
      method: 'POST',
      body: { title: '   ', date: DATE },
    });
    expect(res.status).toBe(400);
  });

  // 改/删走 updateMany/deleteMany + userId 条件，命中 0 行自然返回 404。
  // 列表、读、改、删四条路径逐个验，少验一条就可能留下一个能碰别人数据的口子；
  // 最后再确认 Alice 的数据完好无损，排除「请求被拒但副作用已发生」。
  it('★ 跨用户隔离：看不到也改不了别人的任务', async () => {
    const alice = user();
    const bob = user();

    const created = await api('/api/tasks', {
      as: alice,
      method: 'POST',
      body: { title: '爱丽丝的任务', date: DATE },
    });
    const taskId = (created.body.data as Record<string, unknown>).id as string;

    // Bob 查不到
    const bobList = await api(`/api/tasks?date=${DATE}`, { as: bob });
    expect(bobList.body.data).toHaveLength(0);

    // Bob 读不到详情
    const bobGet = await api(`/api/tasks/${taskId}`, { as: bob });
    expect(bobGet.status).toBe(404);

    // Bob 改不了
    const bobPatch = await api(`/api/tasks/${taskId}`, {
      as: bob,
      method: 'PATCH',
      body: { title: '被篡改' },
    });
    expect(bobPatch.status).toBe(404);

    // Bob 删不掉
    const bobDelete = await api(`/api/tasks/${taskId}`, { as: bob, method: 'DELETE' });
    expect(bobDelete.status).toBe(404);

    // Alice 的任务完好无损
    const aliceGet = await api(`/api/tasks/${taskId}`, { as: alice });
    expect((aliceGet.body.data as Record<string, unknown>).title).toBe('爱丽丝的任务');
  });

  // 番茄数只能由 /api/sessions 在事务里维护。PATCH 一旦接受这个字段，
  // 客户端就能自主伪造专注记录，统计页的所有数据随之失去可信度。
  it('客户端不能直接改写 completedPomodoros（只能由 /api/sessions 维护）', async () => {
    const id = user();
    const created = await api('/api/tasks', {
      as: id,
      method: 'POST',
      body: { title: '任务', date: DATE },
    });
    const taskId = (created.body.data as Record<string, unknown>).id as string;

    await api(`/api/tasks/${taskId}`, {
      as: id,
      method: 'PATCH',
      body: { completedPomodoros: 99 },
    });

    const after = await api(`/api/tasks/${taskId}`, { as: id });
    expect((after.body.data as Record<string, unknown>).completedPomodoros).toBe(0);
  });

  // status 是枚举，写进一个不认识的值会让看板按状态分组的分支落空。
  // 必须在入口拒绝，而不是先存后错。
  it('非法 status 返回 400', async () => {
    const id = user();
    const created = await api('/api/tasks', {
      as: id,
      method: 'POST',
      body: { title: '任务', date: DATE },
    });
    const taskId = (created.body.data as Record<string, unknown>).id as string;

    const res = await api(`/api/tasks/${taskId}`, {
      as: id,
      method: 'PATCH',
      body: { status: '进行中' },
    });
    expect(res.status).toBe(400);
  });

  // 一次提交整份顺序，服务端逐条写 order 并按新顺序把列表返回，
  // 让前端拖拽后不必再拉一次就能刷新。这里同时验证返回的确实是新顺序。
  it('批量重排会写入新的 order 并返回新列表', async () => {
    const id = user();
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      const created = await api('/api/tasks', {
        as: id,
        method: 'POST',
        body: { title, date: DATE },
      });
      ids.push((created.body.data as Record<string, unknown>).id as string);
    }

    const reordered = await api('/api/tasks/reorder', {
      as: id,
      method: 'PATCH',
      body: { date: DATE, orderedIds: [ids[2], ids[0], ids[1]] },
    });

    expect(reordered.status).toBe(200);
    const titles = (reordered.body.data as Record<string, unknown>[]).map((task) => task.title);
    expect(titles).toEqual(['C', 'A', 'B']);
  });

  // 整批里只要有一个 id 不属于当前用户，就整体拒绝 —— 否则可以借重排
  // 顺带改动别人的任务。宁可整批失败，也不做「跳过外人的」那种半途状态。
  it('重排时混入别人的任务 id 会被拒绝', async () => {
    const alice = user();
    const bob = user();

    const aliceTask = await api('/api/tasks', {
      as: alice,
      method: 'POST',
      body: { title: '爱丽丝的', date: DATE },
    });
    const aliceTaskId = (aliceTask.body.data as Record<string, unknown>).id as string;

    const bobTask = await api('/api/tasks', {
      as: bob,
      method: 'POST',
      body: { title: '鲍勃的', date: DATE },
    });
    const bobTaskId = (bobTask.body.data as Record<string, unknown>).id as string;

    const res = await api('/api/tasks/reorder', {
      as: bob,
      method: 'PATCH',
      body: { date: DATE, orderedIds: [aliceTaskId, bobTaskId] },
    });

    expect(res.status).toBe(400);
  });
});

/**
 * 计时偏好按用户存成单行。这一组守的是默认值、更新能持久化，
 * 以及用户之间绝不串味。
 */
describe('设置', () => {
  // PUT 是部分更新：没提到的字段保持原值。同时验证 Alice 的改动没带偏 Bob。
  // Setting 以 userId 为键，写错键就会变成全局共享一份偏好。
  it('更新后能读回，且不影响其他用户', async () => {
    const alice = user();
    const bob = user();

    const updated = await api('/api/settings', {
      as: alice,
      method: 'PUT',
      body: { focusMin: 50, shortBreakMin: 10, autoStartNext: false },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ focusMin: 50, shortBreakMin: 10, autoStartNext: false });

    const aliceAgain = await api('/api/settings', { as: alice });
    expect(aliceAgain.body.data).toMatchObject({ focusMin: 50 });

    const bobSettings = await api('/api/settings', { as: bob });
    expect(bobSettings.body.data).toMatchObject({ focusMin: 25, shortBreakMin: 5 });
  });

  // 用户可能一进设置页就改一项，PUT 必须 upsert，
  // 不能依赖先 GET 把 Setting 行建出来。
  it('未先 GET 直接 PUT 也能工作（upsert）', async () => {
    const res = await api('/api/settings', {
      as: user(),
      method: 'PUT',
      body: { focusMin: 30 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ focusMin: 30, longBreakMin: 15 });
  });

  // 边界值（0、负数、超上限、类型不对）必须由服务端校验。非法的时长会让
  // 计时器算出 0 或负数；非法的 longBreakEvery 会打乱长休节奏；
  // autoStartNext 收到字符串会被当成 truthy，静默开启自动开始。
  it.each([
    ['focusMin 为 0', { focusMin: 0 }],
    ['focusMin 超上限', { focusMin: 999 }],
    ['shortBreakMin 为负', { shortBreakMin: -1 }],
    ['longBreakEvery 超上限', { longBreakEvery: 100 }],
    ['autoStartNext 不是布尔', { autoStartNext: 'yes' }],
  ])('%s 返回 400', async (_label, body) => {
    const res = await api('/api/settings', { as: user(), method: 'PUT', body });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
  });
});
