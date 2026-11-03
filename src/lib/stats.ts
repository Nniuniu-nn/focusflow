import { localDateKey, localHour, localWeekday, parseDateOnly, toDateKey, todayKey } from './date.js';

/**
 * 统计聚合的**纯函数**层：不碰数据库、不碰 DOM、不读时钟（now 由参数注入）。
 *
 * 为什么不用 SQL 聚合：
 *   - Prisma 的 groupBy 无法按 DATE(startAt) 这样的表达式分组，硬写 raw SQL 会丢掉类型。
 *   - 更关键的是「某天」「几点」是本地时区问题，塞进 SQL 就得依赖 CONVERT_TZ
 *     和服务器时区表，既不可移植又无法单测。
 *   - 单用户本地应用，30 天窗口最多几百行，JS 聚合完全够用，还能直接单测。
 */

/**
 * 输入刻意用结构化类型，而不是直接引用 Prisma 的 Session / Task 类型：
 * 这样本文件不依赖 @prisma/client，单测可以直接塞普通对象字面量，且模型加减字段
 * 不会连带影响聚合逻辑。字段越少越好，凡聚合用不到的列都不在此声明。
 */
export interface SessionLike {
  startAt: Date;
  duration: number; // 秒
  type: string;
  completed: boolean;
}

export interface TaskLike {
  status: string;
}

export interface DailyBucket {
  date: string;
  focusSeconds: number;
  pomodoros: number;
}

export interface HeatmapCell {
  weekday: number; // 0=周日 … 6=周六
  hour: number; // 0–23
  focusSeconds: number;
}

export interface HeatmapResult {
  cells: HeatmapCell[];
  max: number;
}

export interface TodaySummary {
  focusSeconds: number;
  pomodoros: number;
  tasksTotal: number;
  tasksDone: number;
}

export interface CompletionRate {
  total: number;
  done: number;
  rate: number; // 0–1，无任务时为 0
}

/**
 * 「这一段算不算专注时长」的唯一判定。
 *
 * 两个条件缺一不可：type 必须是 focus（短休/长休从不计入专注），completed 必须为真
 * （用户中途放弃或重置的一段不该算数，否则「专注时长」会被垃圾数据灌水）。
 * 三个聚合函数都复用同一个谓词，改这里的语义会一致地影响所有统计 —— 这正是把它
 * 单独抽出来的原因，避免三处各写一份、日后悄然分叉。
 */
function isFocus(session: SessionLike): boolean {
  return session.type === 'focus' && session.completed;
}

/**
 * 近 `days` 天（含今天）的每日专注总量。
 * 返回长度恒为 days 的数组，没有记录的日子补 0 —— 前端画柱状图时不能有空洞。
 *
 * 窗口是本地时区下 [今天-(days-1), 今天]，按日期键归属而非毫秒区间：一条落在
 * 2026-10-04T16:30Z 的专注，在东八区（offset=480）属于 10-05，会记进最后一根柱子。
 * 这正是「必须按显式偏移分桶」的典型边界，也是本文件被单测重点覆盖的地方。
 *
 * 入参不要求 pre-filter：窗口外的记录会被索引查不到而静默跳过，未完成的段也被
 * isFocus 挡掉。空数组输入得到全 0 的 days 个桶，不会报错。
 *
 * @param sessions        待聚合的记录，通常是数据库查出的窗口内数据，但多给也无妨。
 * @param days            窗口天数，须 ≥ 1。
 * @param tzOffsetMinutes UTC 以东的分钟数（东八区 480）。
 * @param now             注入的当前时刻，便于测试固定「今天」。
 */
export function bucketDaily(
  sessions: SessionLike[],
  days: number,
  tzOffsetMinutes: number,
  now: number = Date.now(),
): DailyBucket[] {
  const base = parseDateOnly(todayKey(tzOffsetMinutes, now)).getTime();

  // 先在 UTC 上做纯日历运算生成日期键，避免用 ms 加减踩到夏令时
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    keys.push(toDateKey(new Date(base - i * 24 * 60 * 60 * 1000)));
  }

  const index = new Map<string, DailyBucket>();
  for (const key of keys) {
    index.set(key, { date: key, focusSeconds: 0, pomodoros: 0 });
  }

  for (const session of sessions) {
    if (!isFocus(session)) continue;
    const bucket = index.get(localDateKey(session.startAt, tzOffsetMinutes));
    if (!bucket) continue; // 落在窗口之外
    bucket.focusSeconds += session.duration;
    bucket.pomodoros += 1;
  }

  return keys.map((key) => index.get(key)!);
}

/**
 * 星期 × 小时的专注热力图（稀疏输出：只给有数据的格子）。
 * 相比「按天」的格子，星期×小时更能回答「我一般在什么时段效率高」。
 *
 * 本函数没有时间窗口参数：窗口由调用方在查库时就定好（如近 30 天），这里只负责
 * 把给定记录摊到 7×24 的格子上。空数组输入返回 cells: []、max: 0。
 *
 * 稀疏而非补齐 168 格，是因为 ECharts heatmap 对缺失网格按「无数据」渲染，
 * 补齐反而要传一堆 0 让视觉上分不清「没数据」和「有数据但为 0」。
 *
 * max 是给色阶归一化用的；全零时返回 0，调用方（charts.js）必须自行避免除以 0。
 * 输出按 weekday、hour 排序，是为了让结果稳定可断言，不依赖 Map 的插入顺序。
 *
 * @param sessions        专注记录，未完成段会被 isFocus 过滤。
 * @param tzOffsetMinutes UTC 以东的分钟数（东八区 480）。
 */
export function bucketHeatmap(
  sessions: SessionLike[],
  tzOffsetMinutes: number,
): HeatmapResult {
  const map = new Map<string, HeatmapCell>();

  for (const session of sessions) {
    if (!isFocus(session)) continue;
    const weekday = localWeekday(session.startAt, tzOffsetMinutes);
    const hour = localHour(session.startAt, tzOffsetMinutes);
    const key = `${weekday}-${hour}`;
    const cell = map.get(key) ?? { weekday, hour, focusSeconds: 0 };
    cell.focusSeconds += session.duration;
    map.set(key, cell);
  }

  const cells = [...map.values()].sort(
    (a, b) => a.weekday - b.weekday || a.hour - b.hour,
  );
  const max = cells.reduce((acc, cell) => Math.max(acc, cell.focusSeconds), 0);

  return { cells, max };
}

/**
 * 单日汇总：专注总时长、完成的番茄数、任务总数与已完成数。
 *
 * 只对传进来的数组求和，不自己筛日期 —— 「哪一天」由调用方限定（如按本地日区间
 * 查出当天记录）。这样本函数保持纯粹，也便于单测直接喂构造好的数据。
 *
 * 番茄数按「完成的专注段」计数（每段计 1），而非按 duration 反推 ——
 * 时长可能被用户自定义，反推出来的个数会不准。
 */
export function summarize(
  sessions: SessionLike[],
  tasks: TaskLike[],
): TodaySummary {
  let focusSeconds = 0;
  let pomodoros = 0;

  for (const session of sessions) {
    if (!isFocus(session)) continue;
    focusSeconds += session.duration;
    pomodoros += 1;
  }

  return {
    focusSeconds,
    pomodoros,
    tasksTotal: tasks.length,
    tasksDone: tasks.filter((task) => task.status === 'done').length,
  };
}

/**
 * 任务完成率；没有任务时 rate 记 0 而不是 NaN。
 *
 * 空集时 0/0 会得到 NaN，一路传到前端就是 "NaN%" 或让图表坐标崩掉；用 0 表达
 * 「尚无任务、谈不上完成率」比 NaN 安全，也更符合展示直觉。rate 是 0–1 的比例，
 * 百分号的换算留给展示层。
 */
export function completionRate(tasks: TaskLike[]): CompletionRate {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === 'done').length;
  return { total, done, rate: total === 0 ? 0 : done / total };
}
