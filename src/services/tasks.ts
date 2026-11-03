/**
 * 任务服务：按「日期」维度管理任务清单（今日看板左列的数据源）。
 *
 * 架构位置：夹在 routes 与 Prisma 之间，负责归属校验、排序维护与入参解析；
 * HTTP 状态信封由 routes 层统一处理，这里只抛 AppError。
 *
 * 边界（刻意不做的）：
 *   - 不做跨日期移动：任务归属由 date 决定，改期靠删了重建，而不是原地改字段。
 *   - 不做分页：单日任务量天然很小，一次全取。
 *   - 不碰 Session / 统计：番茄数与专注时长归 sessions、stats 两侧。
 *
 * 关键设计：所有查询都显式带 userId。外键只保证「任务存在」，不保证「属于你」，
 * 所以每一条读写都把 userId 写进 where，让「不属于当前用户」退化为影响 0 行。
 */
import type { Task, TaskStatus } from '@prisma/client';
import { prisma } from '../prisma.js';
import { AppError } from '../lib/http-error.js';
import { parseDateOnly } from '../lib/date.js';
import { optionalString, requireString } from '../lib/validate.js';

export interface CreateTaskInput {
  title: string;
  note: string | null;
  date: string;
  estimatedPomodoros: number;
}

export interface UpdateTaskInput {
  title?: string;
  note?: string | null;
  estimatedPomodoros?: number;
  status?: TaskStatus;
}

/**
 * 取某一天的 任务列表，按 order 升序。
 *
 * 以 createdAt 作次级排序键：createTask 在并发下可能给同一天算出重复的 order
 * （见 createTask 的注释），没有次级键时两次请求返回的相对顺序可能不同，
 * 拖拽界面会看到任务「自己换位」。
 *
 * @param dateKey "YYYY-MM-DD"；经 parseDateOnly 固定按 UTC 午夜解析为 @db.Date，
 *                不受服务器时区影响，避免任务被挪到隔壁那天
 */
export async function listTasks(userId: string, dateKey: string): Promise<Task[]> {
  return prisma.task.findMany({
    where: { userId, date: parseDateOnly(dateKey) },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * 按 id 取任务，并强制它属于该用户。
 *
 * 用 findFirst（id + userId 两个条件）而不是 findUnique：findUnique 只能按唯一键
 * 查，无法附加 userId；若改成 findUnique 再人工比对 userId，就会多出一条
 * 「任务存在但不属于你」的分支要维护，而两种失败对外都应是无差别的 404。
 *
 * @throws AppError(404) 任务不存在或不属于当前用户（不区分二者）
 */
export async function findTask(userId: string, id: string): Promise<Task> {
  const task = await prisma.task.findFirst({ where: { id, userId } });
  if (!task) {
    throw new AppError(404, '任务不存在');
  }
  return task;
}

/**
 * 新建任务，自动追加到当天末尾。
 *
 * order 取「当天最大 order + 1」；没有任务时 _max.order 为 null，用 -1 兜底，
 * 于是首个任务的 order 从 0 开始，与 schema 的 @default(0) 对齐。
 *
 * @returns 新建的 Task；order 由服务端决定，调用方传入的 order 会被忽略
 */
export async function createTask(userId: string, input: CreateTaskInput): Promise<Task> {
  const date = parseDateOnly(input.date);

  // 新任务排在当天末尾。并发创建时可能撞上同一个 order，
  // 但 order 只用于展示排序，撞了也不会出错。
  const aggregate = await prisma.task.aggregate({
    where: { userId, date },
    _max: { order: true },
  });
  const order = (aggregate._max.order ?? -1) + 1;

  return prisma.task.create({
    data: {
      userId,
      title: input.title,
      note: input.note,
      date,
      estimatedPomodoros: input.estimatedPomodoros,
      order,
    },
  });
}

/**
 * 局部更新任务：只写输入里真正出现过的字段，未出现的保持原值。
 *
 * 先 findTask 做归属校验，再用 update 按主键写。这是本文件里唯一「不带 userId
 * 直接 update」的写操作 —— 前提是 findTask 已把归属锁死；其余删除/改番茄数都走
 * xxxMany + userId，为的是省掉这一次额外的查询。
 *
 * 空 data 直接拒绝：Prisma 对空 data 的 update 是合法但无副作用的请求，
 * 若静默成功，调用方拼错字段名时只会看到 200 却什么都没变。
 *
 * @throws AppError(404) 任务不存在或不属于当前用户
 * @throws AppError(400) 没有任何可更新字段
 */
export async function updateTask(userId: string, id: string, input: UpdateTaskInput): Promise<Task> {
  await findTask(userId, id); // 先确认归属，避免越权改别人的任务

  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.note !== undefined) data.note = input.note;
  if (input.estimatedPomodoros !== undefined) data.estimatedPomodoros = input.estimatedPomodoros;
  if (input.status !== undefined) data.status = input.status;

  if (Object.keys(data).length === 0) {
    throw new AppError(400, '没有需要更新的字段');
  }

  return prisma.task.update({ where: { id }, data });
}

/**
 * 删除任务。
 *
 * deleteMany + { id, userId } 一步完成「归属校验 + 删除」：delete 的 where 只能
 * 放唯一键，塞不下 userId，就必须先查后删（多一次查询，还多一个竞态窗口），
 * 且记录不存在时会抛 P2025，得再包一层 try/catch。deleteMany 把这两件事一起省掉。
 *
 * 删不到就报 404，而不是静默成功 —— 调用方需要知道「你删的东西不在」。
 *
 * @throws AppError(404) 任务不存在或不属于当前用户
 */
export async function deleteTask(userId: string, id: string): Promise<void> {
  // deleteMany + userId 条件：既做归属校验，又避免 P2025 抛错
  const result = await prisma.task.deleteMany({ where: { id, userId } });
  if (result.count === 0) {
    throw new AppError(404, '任务不存在');
  }
}

/**
 * 批量重排（P1 拖拽排序的接口，本轮先把服务端能力备好）。
 * 只接受当天属于自己的任务 id，逐个写入新的 order。
 *
 * 先在写库前一次性取出「当天 + 当前用户」的 id 白名单，凡是 orderedIds 里
 * 出现白名单之外的 id 就整批拒绝。这样做而不是逐条查到哪写到哪：越权或过期的
 * id 会在任何写入发生之前暴露，不会留下改了一半的顺序。
 *
 * @param orderedIds 期望顺序；语义是完整列表，服务端按数组下标 0,1,2… 覆盖 order。
 *                   若只传子集，未列出的任务保持原 order，可能与新序号重叠。
 * @returns 重排后按 order 重新读出的完整列表（前端据此原地刷新）
 * @throws AppError(400) orderedIds 含不属于该用户 / 该日期的任务 id
 */
export async function reorderTasks(userId: string, dateKey: string, orderedIds: string[]): Promise<Task[]> {
  const date = parseDateOnly(dateKey);
  const tasks = await prisma.task.findMany({ where: { userId, date }, select: { id: true } });
  const owned = new Set(tasks.map((task) => task.id));

  const foreign = orderedIds.filter((id) => !owned.has(id));
  if (foreign.length > 0) {
    throw new AppError(400, `存在不属于该日期的任务 id：${foreign.join(', ')}`);
  }

  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.task.update({ where: { id }, data: { order: index } }),
    ),
  );

  return listTasks(userId, dateKey);
}

/**
 * 从请求体解析新建任务的入参。
 *
 * date 这里只校验「非空白且不超过 10 字符」，不校验是否真实存在：合法性交给
 * parseDateOnly + Prisma 的 @db.Date 兜底。title 上限 200 对应 schema 的
 * VarChar(200)，在入口拦截比等数据库截断/报错更友好。
 *
 * @throws AppError(400) title 缺失/空白/超长，或 date 缺失/超长
 */
export function parseCreateTaskInput(body: unknown): CreateTaskInput {
  return {
    title: requireString(body, 'title', 200),
    note: optionalString(body, 'note') ?? null,
    date: requireString(body, 'date', 10),
    estimatedPomodoros: readEstimated(body),
  };
}

/**
 * 读 estimatedPomodoros，缺省为 1。
 *
 * 默认值 1 是产品语义（新建任务默认预计一个番茄），在入口补齐，使 createTask
 * 永远拿到确定的整数，不必依赖 Prisma 的 @default(1)。
 *
 * @returns 1–99 的整数
 * @throws AppError(400) 非整数、越界，或传了字符串数字
 */
function readEstimated(body: unknown): number {
  const record = body as Record<string, unknown>;
  const raw = record.estimatedPomodoros;
  if (raw === undefined || raw === null) return 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 99) {
    throw new AppError(400, 'estimatedPomodoros 必须是 1–99 之间的整数');
  }
  return raw;
}
