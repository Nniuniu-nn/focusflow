/**
 * 时段路由（/api/sessions）。一个 Session 是计时器跑完的一段专注/休息记录，
 * 是今日时间轴与统计页的原始数据源。
 *
 * 边界：本层只负责身份、入参校验与响应编排；幂等与「番茄数 +1」的事务在
 * services/sessions.ts。这里唯一需要小心的是状态码语义与 created 标志的配合，
 * 见下方 POST 的注释。
 */
import express from 'express';
import { ok } from '../lib/response.js';
import { serializeSession } from '../lib/serialize.js';
import { requireUserId } from '../middleware/require-auth.js';
import * as sessions from '../services/sessions.js';
import { readDateQuery, readTzOffset } from './helpers.js';

export const sessionsRouter = express.Router();

/**
 * GET /api/sessions?date=YYYY-MM-DD&tz= —— 某天的时段列表，供时间轴渲染。
 * 「某天」按 tz 指定的本地时区取半开区间 [当天 00:00, 次日 00:00)，跨午夜的
 * 时段因此仍归入它开始的那天，且不会在两天里重复出现。
 */
sessionsRouter.get('/', async (req, res) => {
  const userId = requireUserId(req);
  const tz = readTzOffset(req);
  const date = readDateQuery(req, tz);

  const list = await sessions.listSessionsByDate(userId, date, tz);
  ok(res, list.map(serializeSession));
});

/**
 * POST /api/sessions —— 记录一个时段（幂等）
 *
 * 重放同一个 clientId 时返回 200 + 既有记录（created: false），
 * 新建时返回 201。前端靠 `created` 判断是否真的记了一笔。
 *
 * created 标志与状态码必须同时给出：离线期间失败的记录会留在 localStorage
 * outbox 里重发，网络超时（请求其实已落库）与真正的重放都会走到这里。前端若
 * 只看 HTTP 是否成功，就无法区分「这次真的新增了」和「上次其实已成功」，
 * 重发时会重复触发看板刷新或误报。201/200 是给日志和调试看的，created 才是
 * 客户端逻辑的依据。
 */
sessionsRouter.post('/', async (req, res) => {
  const userId = requireUserId(req);
  const input = sessions.parseRecordSessionInput(req.body);

  const result = await sessions.recordSession(userId, input);

  if (result.created) {
    res.status(201);
  }
  ok(res, { session: serializeSession(result.session), created: result.created }, result.created ? '时段已记录' : '该时段已记录过');
});
