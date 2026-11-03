import { prisma } from '../prisma.js';
import { parseDateOnly, startOfLocalDayRange, toDateKey, todayKey } from '../lib/date.js';
import {
  bucketDaily,
  bucketHeatmap,
  completionRate,
  summarize,
  type CompletionRate,
  type DailyBucket,
  type HeatmapResult,
  type TodaySummary,
} from '../lib/stats.js';
import { listSessionsByDate } from './sessions.js';
import { listTasks } from './tasks.js';

/**
 * 统计服务：只负责「按时间窗口查库」，聚合一律交给 lib/stats.ts 的纯函数。
 *
 * 架构位置：routes/stats 的上游，把 sessions/tasks 的原始行交给纯函数分桶。
 *
 * 边界（刻意不做的）：
 *   - 不在 SQL 里做 GROUP BY / DATE()：Prisma 的 groupBy 无法按表达式分组，
 *     硬写 raw SQL 会丢掉类型安全；而且「某天/几点」是本地时区问题，塞进 SQL
 *     就得依赖 CONVERT_TZ 与服务器时区表，既不可移植又无法单测。
 *   - 不在这里过滤脏数据或补零：窗口对齐、空桶补齐都在 lib/stats.ts 完成。
 *
 * 关键设计：把「查库」与「聚合」分开，聚合函数因此能脱离数据库直接单测；
 * 本文件所有时间窗口都由显式传入的 tzOffsetMinutes 换算（UTC 以东的分钟数，东八区为 480）。
 */

/** 今日汇总 */
/**
 * 今日汇总：专注时长、完成番茄数、任务总数/完成数。
 *
 * sessions 与 tasks 两个查询互不依赖，用 Promise.all 并发 —— 这是看板首屏的
 * 关键路径，串行会白白多一个数据库往返。
 *
 * @param dateKey 本地日期键 "YYYY-MM-DD"
 * @param tzOffsetMinutes UTC 以东的分钟数（东八区 = 480）
 */
export async function getTodaySummary(
  userId: string,
  dateKey: string,
  tzOffsetMinutes: number,
): Promise<TodaySummary> {
  const [sessions, tasks] = await Promise.all([
    listSessionsByDate(userId, dateKey, tzOffsetMinutes),
    listTasks(userId, dateKey),
  ]);
  return summarize(sessions, tasks);
}

/** 近 days 天的每日专注量（柱状图数据源） */
/**
 * 近 days 天（含今天）的每日专注量，柱状图数据源。
 *
 * 只取 type=focus 且 completed=true 的段，并只 select 分桶需要的四个字段：
 * 30/90 天窗口可能有上千行，没必要把整个 Session 拉回来。
 *
 * 下界用 startOfLocalDayRange 生成，保证「今天」被包含，且交给 bucketDaily 的
 * 行数上限不超过窗口 —— 真正决定桶数的是 bucketDaily 的 days 参数，不是这里。
 */
export async function getDailyBuckets(
  userId: string,
  days: number,
  tzOffsetMinutes: number,
): Promise<DailyBucket[]> {
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      type: 'focus',
      completed: true,
      startAt: { gte: startOfLocalDayRange(days, tzOffsetMinutes) },
    },
    select: { startAt: true, duration: true, type: true, completed: true },
  });
  return bucketDaily(sessions, days, tzOffsetMinutes);
}

/** 星期 × 小时热力图 */
/**
 * 星期 × 小时热力图。
 *
 * 查询条件与 getDailyBuckets 完全相同（专注、已完成、同一时间窗口），区别只在
 * 交给 bucketHeatmap 按本地 weekday/hour 分桶。两个函数刻意不合并：分桶函数
 * 签名与返回结构不同，合并只会让两边都多一层参数判断。
 */
export async function getHeatmap(
  userId: string,
  days: number,
  tzOffsetMinutes: number,
): Promise<HeatmapResult> {
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      type: 'focus',
      completed: true,
      startAt: { gte: startOfLocalDayRange(days, tzOffsetMinutes) },
    },
    select: { startAt: true, duration: true, type: true, completed: true },
  });
  return bucketHeatmap(sessions, tzOffsetMinutes);
}

/**
 * 近 days 天的任务完成率。
 * 注意 Task 的窗口是按「日期」而非「时间戳」过滤的，
 * 所以这里算的是日期键，走的也是 parseDateOnly 那条路径。
 *
 * 窗口从「今天往前数 days-1 天」的日期键起算：Task.date 是 @db.Date，比较的是
 * 日期精度，用日界线而不是「now - days*24h」的时间戳，才能让今天新建的任务
 * 稳定落在窗口内。tzOffsetMinutes 在这里只用于确定「今天」是哪一天。
 *
 * 只 select status：完成率只看状态，不必把标题等字段拉回来；
 * 分母为 0（窗口内没有任务）时由 completionRate 返回 rate=0 而非 NaN。
 */
export async function getCompletionRate(
  userId: string,
  days: number,
  tzOffsetMinutes: number,
): Promise<CompletionRate> {
  const base = parseDateOnly(todayKey(tzOffsetMinutes)).getTime();
  const fromKey = toDateKey(new Date(base - (days - 1) * 24 * 60 * 60 * 1000));

  const tasks = await prisma.task.findMany({
    where: { userId, date: { gte: parseDateOnly(fromKey) } },
    select: { status: true },
  });
  return completionRate(tasks);
}
