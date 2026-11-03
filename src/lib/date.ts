/**
 * 日期工具。
 *
 * 时区约定（重要）：
 *   - 数据库里的时间戳一律是 UTC。
 *   - 但「某一天的专注时长」「几点到几点」是**本地时区**问题。
 *   - 本文件与 stats.ts 中的 `tzOffsetMinutes` 统一表示「UTC 以东的分钟数」，
 *     即 UTC+8 传 480。前端这样算：
 *         const tzOffsetMinutes = -new Date().getTimezoneOffset();   // 东八区 → 480
 *     （注意 JS 的 getTimezoneOffset() 符号是反的，东八区返回 -480。）
 *   - 因此分桶必须在 JS 里按显式偏移做，不能塞进 SQL —— SQL 的 CONVERT_TZ
 *     依赖服务器时区表，既不可移植又无法单测。
 *
 * 本文件所有函数都把偏移量作为显式参数，绝不读服务器时区或 process.env.TZ ——
 * 服务端可能部署在世界任何一个时区，而「用户的一天」只由浏览器传来的偏移决定。
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验是否为合法的 "YYYY-MM-DD"，且是一个真实存在的日期。
 *
 * 光靠正则不够：`new Date('2026-02-30T00:00:00Z')` 不会报错，JS 会把它
 * 规范化成 2026-03-02。所以构造后再用 toISOString() 切片回读、与原串比对，
 * 一旦发生溢出（2 月 30 号、13 月、32 号）就对不上，从而拒绝。
 * 正则还顺带挡下了 2026-2-3 这类未补零的写法。
 *
 * @param value 任意类型；非字符串直接判否。
 */
export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * "YYYY-MM-DD" → UTC 零点的 Date。
 *
 * 必须固定用 UTC 零点，否则 @db.Date 字段会因本地时区产生跨日偏移：若按
 * 服务器本地时区解析 "2026-10-05"，在西半球会得到比 UTC 更早的时间戳，
 * 落库时被 @db.Date 截成 10-04，任务就凭空挪到了隔壁那天。
 *
 * 前置条件：调用方保证 value 已通过 isValidDateOnly。本函数不重新校验，
 * 遇到 2026-02-30 会静默规范化成 03-02 而非抛错 —— 刻意把「合法性判定」和
 * 「朴素转换」分成两件事，转换本身保持无分支。
 */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Date → "YYYY-MM-DD"。按 UTC 切片，与 parseDateOnly 互为逆运算，两者必须成对
 * 使用 —— 混入本地时区的切片就会在跨日边界出错。@db.Date 字段经 Prisma 取回后
 * 也是 UTC 零点，所以这里直接切片是安全的。
 */
export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 给定时刻在指定时区下的日期键。
 *
 * 手法是「先平移、再读 UTC」：把瞬时加上偏移量后整体当作 UTC 读取日历字段，
 * 等价于读出该时刻在本地墙钟上的日期。例：2026-10-04T16:30Z 加 480 分钟后是
 * 2026-10-05T00:30Z，切片即 "2026-10-05" —— 它在东八区确实属于 10-05。
 * 这个「平移后读 UTC」是本文件与 stats.ts 所有分桶的唯一实现手法。
 */
export function localDateKey(date: Date, tzOffsetMinutes: number): string {
  return new Date(date.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * 给定时区下「今天」的日期键。
 * now 显式作为参数（默认取当前时间），便于测试注入受控时钟；纯逻辑层不直接读 Date.now()。
 */
export function todayKey(tzOffsetMinutes: number, now: number = Date.now()): string {
  return localDateKey(new Date(now), tzOffsetMinutes);
}

/**
 * 在指定时区下，某个日期键对应的当天 00:00 的 UTC 时刻（按日查询的时间区间下界）。
 * 由「该日期键的 UTC 零点」减去偏移量得到：东八区 2026-10-05 的本地零点，
 * 即 UTC 的 2026-10-04T16:00Z。
 */
export function startOfLocalDay(dateKey: string, tzOffsetMinutes: number): Date {
  const utcMidnight = parseDateOnly(dateKey).getTime();
  return new Date(utcMidnight - tzOffsetMinutes * 60_000);
}

/**
 * 在指定时区下，某个日期键次日的 00:00 的 UTC 时刻，用作半开区间上界。
 *
 * 取「次日零点」而不是「当日 23:59:59」是为了配合 [start, end) 半开区间：
 * 正好落在次日零点的记录归下一天，不会两天各算一次，也就避开了毫秒级的边界之争。
 * 这里直接加 24 小时是安全的 —— 偏移量是固定数值而非真实时区，不建模夏令时，
 * 不存在某天 23 或 25 小时的情形。
 */
export function endOfLocalDay(dateKey: string, tzOffsetMinutes: number): Date {
  const start = startOfLocalDay(dateKey, tzOffsetMinutes);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * 在指定时区下，近 days 天（含今天）窗口的起点（本地零点）。
 * days=1 即只要今天，days=7 即从今天往前推到 6 天前，故减 (days-1) 天。
 */
export function startOfLocalDayRange(days: number, tzOffsetMinutes: number, now: number = Date.now()): Date {
  const today = todayKey(tzOffsetMinutes, now);
  const start = startOfLocalDay(today, tzOffsetMinutes);
  return new Date(start.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
}

/**
 * 在指定时区下，某时刻是星期几（0=周日 … 6=周六），用于热力图。
 * 依旧用「平移后读 UTC」：getUTCDay() 与 getDay() 的区别正在于此，
 * 直接用 getDay() 会读到服务器时区，跨时区部署时热力图就整体偏一天。
 */
export function localWeekday(date: Date, tzOffsetMinutes: number): number {
  return new Date(date.getTime() + tzOffsetMinutes * 60_000).getUTCDay();
}

/**
 * 在指定时区下，某时刻的小时（0–23），用于热力图。
 * 与 localWeekday 同一手法；注意小时是跨天平移后的结果，可能连带改变日期，
 * 这正是热力图「星期 × 小时」需要同时调用两者的原因。
 */
export function localHour(date: Date, tzOffsetMinutes: number): number {
  return new Date(date.getTime() + tzOffsetMinutes * 60_000).getUTCHours();
}
