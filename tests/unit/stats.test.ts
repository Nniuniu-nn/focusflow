/**
 * 统计聚合纯函数单测 —— 覆盖 src/lib/stats.ts。
 *
 * 这一层刻意不碰数据库、也不读时钟（now 由参数注入）。为什么不把聚合写进 SQL：
 * 「某天 / 几点」是本地时区问题，塞进 SQL 就得依赖服务器的时区表；而单用户本地
 * 应用 30 天窗口最多几百行，JS 聚合够用且能被 Vitest 直接测。
 *
 * 本文件的一等公民是时区归属边界：同一个 2026-10-04T16:30Z，在东八区属于 10-05，
 * 在 UTC-5 属于 10-04。这类错误只在真实用户处于某个时区时才暴露，必须显式覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  bucketDaily,
  bucketHeatmap,
  completionRate,
  summarize,
  type SessionLike,
} from '../../src/lib/stats.js';

/** 东八区 */
const TZ = 480;

/** 构造一个专注段：从某个 UTC 时刻起持续 duration 秒 */
function focusAt(isoStart: string, durationSeconds: number, type = 'focus', completed = true): SessionLike {
  return { startAt: new Date(isoStart), duration: durationSeconds, type, completed };
}

// 近 N 天每日专注总量。前端按固定槽位画柱状图，所以返回的日期序列
// 必须连续、升序、长度恒等于 days，没有记录的日子补 0 而不是留空洞。
describe('bucketDaily', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z'); // 东八区是 10-05 20:00

  // 长度、起点、终点都要精确：最后一个是今天，往前数 days 天。
  // 缺一天或错位会让整张柱状图的日期标签整体偏移。
  it('返回长度恒为 days 的数组，缺失的日子补 0', () => {
    const buckets = bucketDaily([], 7, TZ, now);
    expect(buckets).toHaveLength(7);
    expect(buckets.every((bucket) => bucket.focusSeconds === 0 && bucket.pomodoros === 0)).toBe(true);
    expect(buckets[6]!.date).toBe('2026-10-05'); // 最后一个是今天
    expect(buckets[0]!.date).toBe('2026-09-29');
  });

  // 去重后仍等于 days，说明日期键无重叠；排序后不变说明升序。
  // 挡住「用 ms 做日历加减踩到夏令时，导致跳日或重复」的坑。
  it('日期序列连续且按升序', () => {
    const dates = bucketDaily([], 30, TZ, now).map((bucket) => bucket.date);
    expect(dates).toHaveLength(30);
    expect(new Set(dates).size).toBe(30);
    expect([...dates].sort()).toEqual(dates);
  });

  // 基线：一段落在今天的专注，秒数与番茄数都进今天的桶。
  it('把专注段累加进所属的本地日期', () => {
    // 2026-10-05T02:00Z = 东八区 10-05 10:00
    const buckets = bucketDaily([focusAt('2026-10-05T02:00:00.000Z', 1500)], 7, TZ, now);
    const today = buckets.find((bucket) => bucket.date === '2026-10-05')!;
    expect(today.focusSeconds).toBe(1500);
    expect(today.pomodoros).toBe(1);
  });

  // 两个只差一小时的段（16:30Z 与 15:30Z）在东八区分属 10-05 与 10-04。
  // 若按 UTC 日期分桶，两者都会落到 10-04 —— 这正是最容易翻车的地方。
  it('★ 跨本地午夜正确分桶（UTC 日期与本地日期不同的经典陷阱）', () => {
    // 2026-10-04T16:30Z = 东八区 10-05 00:30 → 应算作 10-05
    // 2026-10-04T15:30Z = 东八区 10-04 23:30 → 应算作 10-04
    const buckets = bucketDaily(
      [focusAt('2026-10-04T16:30:00.000Z', 600), focusAt('2026-10-04T15:30:00.000Z', 900)],
      7,
      TZ,
      now,
    );

    expect(buckets.find((bucket) => bucket.date === '2026-10-05')!.focusSeconds).toBe(600);
    expect(buckets.find((bucket) => bucket.date === '2026-10-04')!.focusSeconds).toBe(900);
  });

  // 偏移为 0 时本地日期即 UTC 日期，验证换算没有把偏移方向搞反。
  it('UTC 时区（偏移 0）下按 UTC 日期分桶', () => {
    const buckets = bucketDaily([focusAt('2026-10-04T23:30:00.000Z', 300)], 7, 0, now);
    expect(buckets.find((bucket) => bucket.date === '2026-10-04')!.focusSeconds).toBe(300);
  });

  // isFocus 要求 type==='focus' 且 completed===true。
  // 三种非专注输入（短休、长休、未完成专注）混进来，只应留下那一段真专注。
  it('休息段与未完成的段都不计入', () => {
    const buckets = bucketDaily(
      [
        focusAt('2026-10-05T02:00:00.000Z', 1500),
        focusAt('2026-10-05T03:00:00.000Z', 300, 'short_break'),
        focusAt('2026-10-05T04:00:00.000Z', 300, 'long_break'),
        focusAt('2026-10-05T05:00:00.000Z', 300, 'focus', false),
      ],
      7,
      TZ,
      now,
    );
    const today = buckets.find((bucket) => bucket.date === '2026-10-05')!;
    expect(today.focusSeconds).toBe(1500);
    expect(today.pomodoros).toBe(1);
  });

  // 早于窗口起点的记录应被整个丢弃，不能顺着分桶索引串进最老的那一天。
  it('窗口之外的记录被丢弃，不会串进边界日', () => {
    const buckets = bucketDaily([focusAt('2026-09-01T02:00:00.000Z', 1500)], 7, TZ, now);
    expect(buckets.reduce((sum, bucket) => sum + bucket.focusSeconds, 0)).toBe(0);
  });
});

// 星期×小时的热力图，稀疏输出：只产出真正有数据的格子。
// 相比按天，它回答的是「我一般在什么时段效率高」。
describe('bucketHeatmap', () => {
  // 空输入时 max 必须是 0，而不是 NaN/undefined —— 前端会拿 max 做颜色映射，
  // 一个 NaN 会让整张热力图渲染不出来且不报任何错。
  it('空输入返回空格子且 max 为 0（前端不会算出 NaN）', () => {
    const result = bucketHeatmap([], TZ);
    expect(result.cells).toEqual([]);
    expect(result.max).toBe(0);
  });

  // 2026-10-05 是周一，02:00Z 在东八区是周一 10:00，应产出 {weekday:1, hour:10}。
  // 顺带确认只有一个格子时 max 就等于它自身。
  it('按本地星期与小时分桶', () => {
    // 2026-10-05 是周一；02:00Z = 东八区周一 10:00
    const result = bucketHeatmap([focusAt('2026-10-05T02:00:00.000Z', 1500)], TZ);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toEqual({ weekday: 1, hour: 10, focusSeconds: 1500 });
    expect(result.max).toBe(1500);
  });

  // 跨周的两个相同「星期+小时」应累加进同一格（日期差 7 天，星期与小时一致）。
  it('同一格子的多段累加', () => {
    const result = bucketHeatmap(
      [focusAt('2026-10-05T02:00:00.000Z', 600), focusAt('2026-10-12T02:30:00.000Z', 900)],
      TZ,
    );
    // 两个日期差 7 天，星期与小时都相同
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.focusSeconds).toBe(1500);
  });

  // max 用于颜色上限，必须是所有格子中的最大值（而非求和）。
  it('max 取所有格子里的最大值', () => {
    const result = bucketHeatmap(
      [focusAt('2026-10-05T02:00:00.000Z', 600), focusAt('2026-10-05T05:00:00.000Z', 1800)],
      TZ,
    );
    expect(result.max).toBe(1800);
  });

  // 休息段不进热力图；同时输出的坐标必须永远落在合法范围内 ——
  // 越界的 weekday/hour 会让 ECharts 热力图出现非法坐标。
  it('忽略休息段，星期范围始终是 0–6、小时范围 0–23', () => {
    const result = bucketHeatmap(
      [
        focusAt('2026-10-05T02:00:00.000Z', 600),
        focusAt('2026-10-05T03:00:00.000Z', 600, 'short_break'),
      ],
      TZ,
    );
    expect(result.cells).toHaveLength(1);
    for (const cell of result.cells) {
      expect(cell.weekday).toBeGreaterThanOrEqual(0);
      expect(cell.weekday).toBeLessThanOrEqual(6);
      expect(cell.hour).toBeGreaterThanOrEqual(0);
      expect(cell.hour).toBeLessThanOrEqual(23);
    }
  });
});

// 单日看板右侧汇总卡的数据来源，一次汇总专注侧与任务侧两组口径。
describe('summarize', () => {
  // 专注侧（时长/番茄）与任务侧（总数/完成数）不能串口径。
  it('汇总专注时长、番茄数与任务进度', () => {
    const result = summarize(
      [focusAt('2026-10-05T02:00:00.000Z', 1500), focusAt('2026-10-05T03:00:00.000Z', 1500)],
      [{ status: 'done' }, { status: 'todo' }, { status: 'doing' }],
    );
    expect(result.focusSeconds).toBe(3000);
    expect(result.pomodoros).toBe(2);
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksDone).toBe(1);
  });

  // 空输入四项全 0，保证汇总卡不会出现 NaN 或 undefined。
  it('空输入全是 0', () => {
    expect(summarize([], [])).toEqual({
      focusSeconds: 0,
      pomodoros: 0,
      tasksTotal: 0,
      tasksDone: 0,
    });
  });

  // 与 bucketDaily 保持同一口径：只有专注段进入汇总。
  it('休息段不计入专注总量', () => {
    const result = summarize([focusAt('2026-10-05T03:00:00.000Z', 300, 'short_break')], []);
    expect(result.focusSeconds).toBe(0);
    expect(result.pomodoros).toBe(0);
  });
});

// 任务完成率。核心是「没有任务时不能除以 0」。
describe('completionRate', () => {
  // 常规比例计算，rate 为原始 0–1 小数（不预先乘 100）。
  it('计算完成比例', () => {
    expect(completionRate([{ status: 'done' }, { status: 'done' }, { status: 'todo' }])).toEqual({
      total: 3,
      done: 2,
      rate: 2 / 3,
    });
  });

  // 0/0 在 JS 里是 NaN，会一路渗进仪表盘。空任务必须显式记 0。
  it('没有任务时 rate 为 0 而不是 NaN', () => {
    const result = completionRate([]);
    expect(result).toEqual({ total: 0, done: 0, rate: 0 });
    expect(Number.isNaN(result.rate)).toBe(false);
  });

  // 只有 status==='done' 才计数；doing 是进行中，不算完成。
  it('doing 不算完成', () => {
    expect(completionRate([{ status: 'doing' }]).rate).toBe(0);
  });
});

// 把同一批数据喂给东西两个半球，验证归属差异 ——
// 这类错误只在真实用户处于某个时区时才暴露，单测必须显式覆盖。
describe('时区偏移的边界', () => {
  // 同一段 02:00Z：东八区落在 10-05，UTC-5 落在 10-04。
  // 若偏移方向写反，两者会互换，这条断言会同时挂掉。
  it('UTC-5 与 UTC+8 对同一时刻给出不同的日期归属', () => {
    const session = [focusAt('2026-10-05T02:00:00.000Z', 600)];
    const now = Date.parse('2026-10-05T12:00:00.000Z');

    const east = bucketDaily(session, 3, 480, now);
    const west = bucketDaily(session, 3, -300, now);

    // 02:00Z 在 UTC+8 是 10-05 10:00，在 UTC-5 是 10-04 21:00
    expect(east.find((bucket) => bucket.date === '2026-10-05')!.focusSeconds).toBe(600);
    expect(west.find((bucket) => bucket.date === '2026-10-04')!.focusSeconds).toBe(600);
  });

  // 365 天窗口 + 空数据，验证大窗口路径不会因边界计算抛错或漏格。
  it('输入为空时大窗口也不出错', () => {
    const buckets = bucketDaily([], 365, TZ, Date.parse('2026-10-05T12:00:00.000Z'));
    expect(buckets).toHaveLength(365);
    expect(buckets.reduce((sum, bucket) => sum + bucket.focusSeconds, 0)).toBe(0);
  });
});
