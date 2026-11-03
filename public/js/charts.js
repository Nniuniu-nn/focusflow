/**
 * ECharts option 构造 —— 纯函数，不 import echarts、不碰 DOM。
 *
 * 拆出来的好处：图表配置里最容易出错的地方（空数据、全零数据、
 * 边界值）可以直接用 Vitest 断言，不用真的去渲染一个图表。
 *
 * 边界：这里只「描述图表长什么样」，不创建、不持有、不 resize 实例 ——
 * echarts.init / setOption / resize 全部由 stats.js 负责。
 * 因此本文件可以在 environment: 'node' 下被直接单测（没有 DOM 也没有全局 echarts）。
 *
 * 所有数值入口都做防御：后端聚合结果理论上是干净的，但空数组、
 * 缺字段、NaN 在跨时区边界和首次使用时都可能出现，宁可这里兜底，
 * 也不能让 NaN 流进坐标轴导致整张图渲染失败。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const HOURS = Array.from({ length: 24 }, (_, hour) => `${hour}时`);

/** 番茄红，与 CSS 里的 --accent / --focus 保持一致 */
const ACCENT = '#e2564a';

/** 把秒转成分钟，并挡住 NaN / 负数 / 无穷 */
function toMinutes(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value / 60);
}

/**
 * 近 N 天每日专注柱状图。
 *
 * x 轴取日期的 "MM-DD" 部分：完整日期标签在窄屏会互相压叠，
 * 年份在多日视图里也几乎无信息量。缺失的日期由后端补成 0，
 * 所以这里不需要自己对齐日期轴。
 *
 * @param {object[]} buckets - [{ date: 'YYYY-MM-DD', focusSeconds }]，含零值日
 * @returns {object} ECharts option
 */
export function buildDailyBarOption(buckets) {
  const list = Array.isArray(buckets) ? buckets : [];

  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value) => `${value} 分钟`,
    },
    grid: { left: 44, right: 16, top: 20, bottom: 34 },
    xAxis: {
      type: 'category',
      // 只留 "MM-DD"，日期标签太挤
      data: list.map((bucket) => String(bucket.date ?? '').slice(5)),
      axisTick: { show: false },
      axisLabel: { fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      name: '分钟',
      nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { opacity: 0.15 } },
    },
    series: [
      {
        type: 'bar',
        name: '专注时长',
        data: list.map((bucket) => toMinutes(bucket.focusSeconds)),
        itemStyle: { color: ACCENT, borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 22,
      },
    ],
  };
}

/**
 * 星期 × 小时热力图。
 * 稀疏输入：cells 里只有真正有数据的格子。
 *
 * 这里不补齐 7×24 个空格子：ECharts 的 heatmap 对缺失位置本就不绘制，
 * 补零反而会把「从未专注过的时段」染成和「专注 0 分钟」一样的底色，
 * 视觉上产生误导。轴上的分类（HOURS / WEEKDAYS）保证了坐标完整。
 *
 * maxSeconds 单独传入而不是从 cells 里求最大值：色阶上限要在一段
 * 时间范围内保持稳定，否则换个区间整张图的深浅就失去可比性。
 *
 * @param {object[]} cells - [{ weekday: 0-6, hour: 0-23, focusSeconds }]
 * @param {number} maxSeconds - 色阶上限对应的秒数
 * @returns {object} ECharts option
 */
export function buildHeatmapOption(cells, maxSeconds) {
  const list = Array.isArray(cells) ? cells : [];

  // ECharts 的 heatmap 数据是 [x, y, value]，x 为小时、y 为星期
  const data = list.map((cell) => [
    Number(cell.hour) || 0,
    Number(cell.weekday) || 0,
    toMinutes(cell.focusSeconds),
  ]);

  const maxMinutes = toMinutes(maxSeconds);
  // min === max 时 ECharts 会告警，且整张图会变成同一个颜色；保底给 1
  const upperBound = Math.max(1, maxMinutes);

  return {
    tooltip: {
      formatter: (params) => {
        const [hour, weekday, minutes] = params.value;
        return `${WEEKDAYS[weekday] ?? ''} ${hour}:00–${hour + 1}:00<br/>专注 ${minutes} 分钟`;
      },
    },
    grid: { left: 52, right: 16, top: 16, bottom: 60 },
    xAxis: {
      type: 'category',
      data: HOURS,
      splitArea: { show: true },
      axisLabel: { fontSize: 10, interval: 1 },
    },
    yAxis: {
      type: 'category',
      data: WEEKDAYS,
      splitArea: { show: true },
      axisLabel: { fontSize: 11 },
    },
    visualMap: {
      min: 0,
      max: upperBound,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 6,
      inRange: { color: ['#f0f2f5', '#f6b3ac', ACCENT, '#a8302a'] },
      textStyle: { fontSize: 11 },
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.3)' } },
      },
    ],
  };
}

/**
 * 任务完成率仪表盘。
 *
 * 后端给的 rate 是 0–1 的小数，这里夹到 [0,1] 再乘 100：
 * 脏数据（负数、>1、NaN、缺字段）若直接进仪表盘，指针和图例会落到非法范围。
 * 指针隐藏，进度弧 + 中央百分比已足够表达，少一个会动的部件更稳。
 *
 * @param {object} completion - { rate: 0..1, done, total }，可能为 undefined
 * @returns {object} ECharts option
 */
export function buildCompletionOption(completion) {
  const raw = Number(completion?.rate);
  const rate = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;

  return {
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        radius: '92%',
        progress: { show: true, width: 18, itemStyle: { color: ACCENT } },
        axisLine: { lineStyle: { width: 18, color: [[1, 'rgba(128,128,128,0.18)']] } },
        axisTick: { show: false },
        splitLine: { length: 10, lineStyle: { width: 1, opacity: 0.3 } },
        axisLabel: { fontSize: 10, distance: 14 },
        pointer: { show: false },
        detail: {
          formatter: (value) => `${Math.round(value)}%`,
          fontSize: 30,
          offsetCenter: [0, '8%'],
          color: 'inherit',
        },
        data: [{ value: rate * 100 }],
      },
    ],
  };
}

// 导出给测试与其它模块复用，保证「星期从周日开始」「24 小时」这类
// 轴定义只有一处来源，避免图表和文案各写一套。
export { WEEKDAYS, HOURS };
