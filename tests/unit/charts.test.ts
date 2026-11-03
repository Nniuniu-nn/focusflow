import { describe, expect, it } from 'vitest';
import {
  HOURS,
  WEEKDAYS,
  buildCompletionOption,
  buildDailyBarOption,
  buildHeatmapOption,
} from '../../public/js/charts.js';

/**
 * 图表配置的纯函数测试。
 * 重点不是「长什么样」，而是「空数据 / 全零 / 脏数据下不会产出 NaN 或非法坐标」——
 * 这正是手写图表最容易翻车的地方。
 *
 * 覆盖 public/js/charts.js。它只负责构造 ECharts 的 option：不 import echarts、
 * 不调 echarts.init()、不碰 DOM，所以无需浏览器就能直接断言 option 结构。
 * 之所以盯住 NaN，是因为 ECharts 遇到 NaN 坐标会整张图空白且不抛任何错，
 * 线上极难定位；把出口统一要求成有限数，等于把这类故障拦在最前面。
 */

// 近 N 天每日专注柱状图：日期标签与数值都从这里产出，
// 任何一个 NaN 都会污染整条坐标轴。
describe('buildDailyBarOption', () => {
  // 空数组必须产出结构完整的 option（xAxis / series 都在，只是为空），
  // 否则前端在数据为空时会直接抛错。
  it('空数组不报错，series 数据为空', () => {
    const option = buildDailyBarOption([]);
    expect(option.series[0].data).toEqual([]);
    expect(option.xAxis.data).toEqual([]);
  });

  // null / undefined 也要退化成空配置 —— 数据尚未加载完成时会传进来。
  it('非数组输入按空处理', () => {
    expect(buildDailyBarOption(null).series[0].data).toEqual([]);
    expect(buildDailyBarOption(undefined).xAxis.data).toEqual([]);
  });

  // 秒→分钟（四舍五入），以及日期只截 MM-DD（避免标签过挤）。
  it('把秒换算成分钟，日期标签只保留 MM-DD', () => {
    const option = buildDailyBarOption([
      { date: '2026-10-05', focusSeconds: 1500, pomodoros: 1 },
      { date: '2026-10-06', focusSeconds: 3000, pomodoros: 2 },
    ]);

    expect(option.xAxis.data).toEqual(['10-05', '10-06']);
    expect(option.series[0].data).toEqual([25, 50]);
  });

  // 各种脏数值都要被 toMinutes 归一为 0，并最终保证全部是有限数。
  // 这是本组最关键的护栏：一个 NaN 会让整张柱状图空白。
  it('★ NaN / 负数 / Infinity 都被挡成 0，不会污染坐标轴', () => {
    const option = buildDailyBarOption([
      { date: '2026-10-05', focusSeconds: Number.NaN },
      { date: '2026-10-06', focusSeconds: -100 },
      { date: '2026-10-07', focusSeconds: Number.POSITIVE_INFINITY },
      { date: '2026-10-08', focusSeconds: undefined },
    ]);

    expect(option.series[0].data).toEqual([0, 0, 0, 0]);
    expect(option.series[0].data.every((value: number) => Number.isFinite(value))).toBe(true);
  });

  // 全零是「有数据但都为零」，与空数组是不同代码路径，也要能正常出图。
  it('全零数据也是合法配置', () => {
    const option = buildDailyBarOption([
      { date: '2026-10-05', focusSeconds: 0 },
      { date: '2026-10-06', focusSeconds: 0 },
    ]);
    expect(option.series[0].data).toEqual([0, 0]);
  });
});

// 热力图：坐标轴固定 24 小时 × 7 天，数据点转成 [小时, 星期, 值] 三元组。
// 最关键的兜底是 visualMap.max —— 它直接决定配色，不能是 0 或 NaN。
describe('buildHeatmapOption', () => {
  // 即便没有任何数据点，24×7 的坐标轴也要完整存在，只是没有一个着色格子。
  it('空数据时坐标轴完整、data 为空（图表空白而非崩溃）', () => {
    const option = buildHeatmapOption([], 0);
    expect(option.xAxis.data).toHaveLength(24);
    expect(option.yAxis.data).toHaveLength(7);
    expect(option.series[0].data).toEqual([]);
  });

  // ECharts 在 visualMap 的 min 等于 max 时会告警并把整张图刷成同一种颜色，
  // 所以 max 要保底为 1（严格大于 min=0）。
  it('★ 全零数据时 visualMap.max 兜底为 1，避免 min === max 告警', () => {
    const option = buildHeatmapOption([], 0);
    expect(option.visualMap.max).toBe(1);
    expect(option.visualMap.min).toBe(0);
    expect(option.visualMap.max).toBeGreaterThan(option.visualMap.min);
  });

  // 顺序必须是 [x=小时, y=星期, value=分钟]，顺序错了整张热力图会转置。
  it('数据点转成 [小时, 星期, 分钟] 三元组', () => {
    const option = buildHeatmapOption([{ weekday: 1, hour: 9, focusSeconds: 1500 }], 1500);
    expect(option.series[0].data).toEqual([[9, 1, 25]]);
  });

  // max 的单位要与数据点一致（都是分钟）；单位错位会让颜色映射整体失真。
  it('max 以分钟为单位且不小于任何数据点', () => {
    const option = buildHeatmapOption([{ weekday: 2, hour: 14, focusSeconds: 3600 }], 3600);
    expect(option.visualMap.max).toBe(60);
    // 任何数据点的值都不超过 max
    for (const point of option.series[0].data) {
      expect(point[2]).toBeLessThanOrEqual(option.visualMap.max);
    }
  });

  // NaN 坐标是 ECharts 最隐蔽的失败模式：图不报错但整块空白。
  // 这里要求每个三元组的每个分量都是有限数。
  it('脏数据不会产出 NaN 坐标', () => {
    const option = buildHeatmapOption(
      [
        { weekday: Number.NaN, hour: Number.NaN, focusSeconds: Number.NaN },
        { weekday: 3, hour: 5, focusSeconds: -1 },
      ],
      100,
    );
    for (const point of option.series[0].data) {
      expect(point.every((value: number) => Number.isFinite(value))).toBe(true);
    }
  });

  // WEEKDAYS / HOURS 是对外的坐标轴标签，长度与两端取值都必须稳定，
  // 否则热力图的行列会错位。
  it('导出的坐标轴标签长度正确', () => {
    expect(WEEKDAYS).toHaveLength(7);
    expect(WEEKDAYS[0]).toBe('周日');
    expect(WEEKDAYS[6]).toBe('周六');
    expect(HOURS).toHaveLength(24);
    expect(HOURS[0]).toBe('0时');
  });
});

// 完成率仪表盘。输入是 completionRate 产出的 0–1 小数，输出百分数。
describe('buildCompletionOption', () => {
  // 0–1 映射到 0–100，三个端点是仪表盘刻度的锚。
  it('rate 转成百分数', () => {
    expect(buildCompletionOption({ rate: 0.5 }).series[0].data[0].value).toBe(50);
    expect(buildCompletionOption({ rate: 1 }).series[0].data[0].value).toBe(100);
    expect(buildCompletionOption({ rate: 0 }).series[0].data[0].value).toBe(0);
  });

  // 无任务时 rate 为 0，仪表盘必须显示 0% 而不是 NaN%。
  it('★ 无任务（rate 为 0）时不显示 NaN', () => {
    const option = buildCompletionOption({ total: 0, done: 0, rate: 0 });
    expect(option.series[0].data[0].value).toBe(0);
    expect(Number.isNaN(option.series[0].data[0].value)).toBe(false);
  });

  // null / undefined / 空对象 / NaN / 非数字字符串等非法输入统一归零，
  // 防止后端字段缺失时仪表盘出现 NaN。
  it('★ 脏输入一律归零', () => {
    for (const input of [null, undefined, {}, { rate: Number.NaN }, { rate: 'abc' }]) {
      const value = buildCompletionOption(input).series[0].data[0].value;
      expect(value).toBe(0);
    }
  });

  // rate 超出 [0, 1] 时夹到边界，避免百分比超出仪表盘量程。
  it('超出 0–1 的 rate 被夹紧', () => {
    expect(buildCompletionOption({ rate: 1.8 }).series[0].data[0].value).toBe(100);
    expect(buildCompletionOption({ rate: -0.5 }).series[0].data[0].value).toBe(0);
  });
});
