import { api } from './api.js';
import { buildCompletionOption, buildDailyBarOption, buildHeatmapOption } from './charts.js';
import { reportError } from './ui.js';

/**
 * 统计页：拿数据 → 交给 charts.js 构造 option → 交给 ECharts 渲染。
 * 本文件不写任何图表配置逻辑，全在纯函数里。
 *
 * 边界：本模块是图表「实例」的持有者（init / setOption / resize 都在这里），
 * 而 charts.js 只产出纯 option。这样图表配置能脱离 DOM 单测，
 * 实例的生死则集中在一处，便于统一 resize 和换区间时重建。
 *
 * ECharts 是通过 CDN 的 <script> 挂在 window.echarts 上的全局对象，
 * 不是 ESM 依赖 —— 离线或 CDN 抽风时就只剩个空容器，所以首屏要显式检测。
 */

let days = 30;
const charts = {};

/**
 * 统计页入口，由 stats.html 顶层脚本调用。
 *
 * 主题只在 init 时读一次（跟随系统深浅色）；运行中切换系统主题不重绘，
 * 因为重建实例会丢掉动画与用户当前的缩放状态，收益不抵成本。
 *
 * @returns {Promise<void>}
 */
export async function initStats() {
  // ECharts 由 CDN 的 <script> 提供，挂在 window 上
  if (typeof window.echarts === 'undefined') {
    reportError(new Error('ECharts 未能加载（离线环境下 CDN 不可用）'));
    return;
  }

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'dark' : null;

  charts.daily = window.echarts.init(document.querySelector('#chart-daily'), theme);
  charts.heatmap = window.echarts.init(document.querySelector('#chart-heatmap'), theme);
  charts.completion = window.echarts.init(document.querySelector('#chart-completion'), theme);

  wireRangePicker();

  // 容器尺寸变化时（窗口缩放、移动端旋转）必须显式 resize
  window.addEventListener('resize', () => {
    for (const chart of Object.values(charts)) chart.resize();
  });

  await refresh();
}

/** 绑定近 7/30/90 天的区间切换：只改 days 变量再重拉数据 */
function wireRangePicker() {
  const host = document.querySelector('#range-picker');
  if (!host) return;

  host.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.dataset.days) return;

    days = Number(target.dataset.days);
    for (const button of host.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button === target));
    }
    await refresh();
  });
}

/**
 * 按当前 days 拉三份统计并重绘。三个接口互不依赖，用 Promise.all 并发。
 *
 * setOption 的第二个参数 true 表示「不与旧数据合并」：换区间时
 * 必须整体替换，否则短区间切长区间会残留上一份的柱子和色阶上限。
 * charts.daily?. 的可选链是为 echarts 未加载时（initStats 提前 return）兜底。
 *
 * @returns {Promise<void>}
 */
export async function refresh() {
  try {
    const [daily, heatmap, completion] = await Promise.all([
      api.daily(days),
      api.heatmap(days),
      api.completion(days),
    ]);

    charts.daily?.setOption(buildDailyBarOption(daily), true);
    charts.heatmap?.setOption(buildHeatmapOption(heatmap.cells, heatmap.max), true);
    charts.completion?.setOption(buildCompletionOption(completion), true);

    renderCompletionText(completion);
  } catch (error) {
    reportError(error);
  }
}

/**
 * 仪表盘旁边补一句文字，比单看百分比更有信息量。
 * total 为 0 时单独出一句提示：此时百分比的 0% 会被误读成「一个都没做完」，
 * 实际是「压根没有任务」，两者含义不同。
 *
 * @param {object} completion - { total, done }
 */
function renderCompletionText(completion) {
  const host = document.querySelector('#completion-text');
  if (!host) return;

  const total = Number(completion?.total) || 0;
  const done = Number(completion?.done) || 0;

  host.textContent =
    total === 0
      ? `最近 ${days} 天还没有任务记录`
      : `最近 ${days} 天共 ${total} 个任务，完成 ${done} 个`;
}
