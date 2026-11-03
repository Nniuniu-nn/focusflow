/**
 * 时段服务：记录与查询专注/休息段，是「番茄数」的记账入口。
 *
 * 架构位置：routes 校验请求形状后调用本模块；本模块负责幂等写入、任务归属校验，
 * 以及把「跑完的专注段」折算成任务的 completedPomodoros。
 *
 * 边界（刻意不做的）：
 *   - 不做统计聚合：按日/按小时分桶在 lib/stats.ts 的纯函数里，见 stats.ts。
 *   - 不校验时长的业务合理性（例如「专注段必须等于 setting.focusMin」）：
 *     计时属于客户端，服务端只记录既成事实，过严会误伤「中途放弃的段」。
 *
 * 关键设计：写入必须幂等，且「写 Session」与「番茄数 +1」必须原子。详见 recordSession。
 */
import type { Session, SessionType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { AppError } from '../lib/http-error.js';
import { endOfLocalDay, startOfLocalDay } from '../lib/date.js';
import { isUuid, requireIsoDate, requireString } from '../lib/validate.js';

/**
 * 一条待记录的时段。clientId 是前端生成的幂等键，不是 Session 的主键。
 *
 * taskId 允许为 null —— 休息段、以及没挂任务的专注段都合法；不挂任务的专注段
 * 只记录专注时长，不会计入任何任务的 completedPomodoros。
 */
export interface RecordSessionInput {
  clientId: string;
  taskId: string | null;
  startAt: Date;
  endAt: Date;
  duration: number;
  type: SessionType;
  completed: boolean;
}

export interface RecordSessionResult {
  session: Session;
  /** true = 本次真正新建；false = 该 clientId 之前已记录过（重放） */
  created: boolean;
}

const SESSION_TYPES: readonly SessionType[] = ['focus', 'short_break', 'long_break'];

/**
 * 记录一个时段，**幂等**。
 *
 * 这是本项目最容易写错的一段，要点有三：
 *
 * 1. 幂等靠 `@@unique([userId, clientId])`。clientId 由前端在「专注段开始」时
 *    生成并持久化，段结束时用它 POST。这样「段结束瞬间刷新页面」导致的重发
 *    不会写出两条记录。
 *
 * 2. `completedPomodoros + 1` 必须与 session 的插入在**同一个事务**里，
 *    且只在真正新建的那条路径上执行。重放路径直接返回既有记录，绝不加一。
 *
 * 3. 先查后插存在竞态（两个请求同时查到「不存在」）。此时靠数据库的唯一约束
 *    兜底：输的一方拿到 P2002，再去读一次既有记录返回即可。
 *
 * @param userId 已鉴权用户；归属由此参数确定，请求体里的任何 id 都不可信
 * @param input 已由 parseRecordSessionInput 归一化过的时段
 * @returns created=true 表示本次真正落库并（可能）加了番茄；false 表示重放
 * @throws AppError(400) taskId 指向不存在的任务，或不属于当前用户
 */
export async function recordSession(
  userId: string,
  input: RecordSessionInput,
): Promise<RecordSessionResult> {
  const existing = await findExisting(userId, input.clientId);
  if (existing) {
    return { session: existing, created: false };
  }

  // 任务必须属于当前用户，否则拒绝。只靠 FK 是不够的：
  // FK 只校验任务存在，不校验归属，恶意 clientId 可以把时段挂到别人的任务上。
  if (input.taskId !== null) {
    const owned = await prisma.task.count({ where: { id: input.taskId, userId } });
    if (owned === 0) {
      throw new AppError(400, 'taskId 不存在或不属于当前用户');
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          userId,
          clientId: input.clientId,
          taskId: input.taskId,
          startAt: input.startAt,
          endAt: input.endAt,
          duration: input.duration,
          type: input.type,
          completed: input.completed,
        },
      });

      // 只有「跑完的专注段」才计入番茄数；休息段与未完成段都不算
      if (input.type === 'focus' && input.completed && input.taskId !== null) {
        await tx.task.updateMany({
          where: { id: input.taskId, userId },
          data: { completedPomodoros: { increment: 1 } },
        });
      }

      return { session, created: true };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const won = await findExisting(userId, input.clientId);
      if (won) {
        return { session: won, created: false };
      }
    }
    throw error;
  }
}

/**
 * 按 (userId, clientId) 复合唯一键读已有记录。
 *
 * 必须用 findUnique 的 userId_clientId 形式命中 @@unique，不能退化成
 * findFirst({ clientId })：clientId 是客户端各造各的 UUID，跨用户同值完全可能，
 * 只按 clientId 查会把别人的时段当成自己的重放。
 */
async function findExisting(userId: string, clientId: string): Promise<Session | null> {
  return prisma.session.findUnique({
    where: { userId_clientId: { userId, clientId } },
  });
}

/**
 * 取某天（按本地时区）的全部时段，按开始时间升序 —— 供时间轴使用。
 *
 * 用半开区间 [startOfLocalDay, endOfLocalDay) 而非日期函数或 BETWEEN：
 * 目标是命中 @@index([userId, startAt])，同时边界的时区换算全部在 date.ts 里
 * 显式完成，不依赖数据库服务器时区。
 *
 * 返回全部类型（含休息段）：时间轴要显示休息；统计侧只要专注段，另有过滤条件。
 */
export async function listSessionsByDate(
  userId: string,
  dateKey: string,
  tzOffsetMinutes: number,
): Promise<Session[]> {
  return prisma.session.findMany({
    where: {
      userId,
      startAt: {
        gte: startOfLocalDay(dateKey, tzOffsetMinutes),
        lt: endOfLocalDay(dateKey, tzOffsetMinutes),
      },
    },
    orderBy: { startAt: 'asc' },
  });
}

/**
 * 解析记录时段的请求体，逐字段校验形状与范围。
 *
 * completed 缺省视为 true：正常 POST 就是「这段跑完了」，只有显式传 false
 * 才表示提前结束；用 `=== true` 而非 truthy 判断，避免 "false" 之类的字符串
 * 被误当成已完成。
 *
 * @throws AppError(400) clientId 非 UUID、type 非法、时间不可解析、
 *                       endAt 早于 startAt、duration 越界、taskId 类型错误
 */
export function parseRecordSessionInput(body: unknown): RecordSessionInput {
  const record = body as Record<string, unknown>;

  const clientId = requireString(body, 'clientId', 64);
  if (!isUuid(clientId)) {
    throw new AppError(400, 'clientId 必须是 UUID');
  }

  const type = record.type;
  if (typeof type !== 'string' || !SESSION_TYPES.includes(type as SessionType)) {
    throw new AppError(400, `type 必须是 ${SESSION_TYPES.join(' / ')} 之一`);
  }

  const startAt = requireIsoDate(body, 'startAt');
  const endAt = requireIsoDate(body, 'endAt');
  if (endAt.getTime() < startAt.getTime()) {
    throw new AppError(400, 'endAt 不能早于 startAt');
  }

  const duration = record.duration;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0 || duration > 86400) {
    throw new AppError(400, 'duration 必须是 0–86400 之间的整数（单位：秒）');
  }

  const taskId = record.taskId;
  if (taskId !== null && taskId !== undefined && typeof taskId !== 'string') {
    throw new AppError(400, 'taskId 必须是字符串或 null');
  }

  return {
    clientId,
    taskId: (taskId as string | null | undefined) ?? null,
    startAt,
    endAt,
    duration,
    type: type as SessionType,
    completed: record.completed === undefined ? true : record.completed === true,
  };
}
