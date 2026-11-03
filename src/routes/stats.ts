/**
 * 统计路由（/api/stats）。四个只读接口，分别喂给今天的汇总卡片、近 N 天柱状图、
 * 星期×小时热力图与任务完成率。
 *
 * 边界：路由层不参与任何聚合计算，聚合是 src/lib/stats.ts 里的纯函数（可按
 * 受控时钟单测）；这里只负责把 tz、days 这类查询参数校验好再转交 service。
 *
 * 三个图表接口共用 days 范围 1–365、默认 30。窗口的「天」按 tz 指定的本地
 * 时区切分，所以哪怕数据落库是 UTC，返回的也是用户视角下的分桶。
 */
import express from 'express';
import { ok } from '../lib/response.js';
import { parseQueryInt } from '../lib/validate.js';
import { requireUserId } from '../middleware/require-auth.js';
import * as stats from '../services/stats.js';
import { readDateQuery, readTzOffset } from './helpers.js';

export const statsRouter = express.Router();

/**
 * GET /api/stats/summary?date=&tz= —— 今日汇总（看板右列）。
 * date 缺省为 tz 下的今天；返回当天专注时长、完成番茄数、任务完成情况等。
 */
statsRouter.get('/summary', async (req, res) => {
  const userId = requireUserId(req);
  const tz = readTzOffset(req);
  const date = readDateQuery(req, tz);

  ok(res, await stats.getTodaySummary(userId, date, tz));
});

/**
 * GET /api/stats/daily?days=30&tz= —— 每日专注柱状图。
 * 只统计 type=focus 且 completed=true 的段；未跑完的专注不计入时长，
 * 与「番茄数只加完成段」的口径保持一致。
 */
statsRouter.get('/daily', async (req, res) => {
  const userId = requireUserId(req);
  const tz = readTzOffset(req);
  const days = parseQueryInt(req.query.days, 'days', 30, 1, 365);

  ok(res, await stats.getDailyBuckets(userId, days, tz));
});

/**
 * GET /api/stats/heatmap?days=30&tz= —— 星期×小时热力图。
 * 「星期几」和「几点」都用 tz 下的本地值换算，否则跨时区用户的作息会被整体
 * 平移，热力图的模式就失真了。
 */
statsRouter.get('/heatmap', async (req, res) => {
  const userId = requireUserId(req);
  const tz = readTzOffset(req);
  const days = parseQueryInt(req.query.days, 'days', 30, 1, 365);

  ok(res, await stats.getHeatmap(userId, days, tz));
});

/**
 * GET /api/stats/completion?days=30&tz= —— 任务完成率。
 * 与另外三个接口不同，这里的窗口是按 Task.date（日期精度字段）过滤的，
 * 不是按时间戳，因此分桶走 parseDateOnly 那条路径而非时间区间。
 */
statsRouter.get('/completion', async (req, res) => {
  const userId = requireUserId(req);
  const tz = readTzOffset(req);
  const days = parseQueryInt(req.query.days, 'days', 30, 1, 365);

  ok(res, await stats.getCompletionRate(userId, days, tz));
});
