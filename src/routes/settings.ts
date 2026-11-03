/**
 * 计时偏好路由（/api/settings）。Setting 与 User 一对一，主键就是 userId，
 * 因此这里没有 :id 路径参数，也天然不存在越权读写别人的设置。
 *
 * 边界：路由只做身份与入参校验；读写都用 upsert 而非 update/insert，
 * 「用户是否已初始化过设置」这件事被藏进 service，调用方无需分支。
 */
import express from 'express';
import { ok } from '../lib/response.js';
import { requireUserId } from '../middleware/require-auth.js';
import * as settings from '../services/settings.js';

export const settingsRouter = express.Router();

/**
 * GET /api/settings —— 用户没有 Setting 行时会自动建出默认值。
 * 用 upsert 而非「查不到就报错」，是让前端不必区分「新用户」和「老用户」：
 * 任何已登录用户调这个接口都必然拿到一份可用配置。
 */
settingsRouter.get('/', async (req, res) => {
  const userId = requireUserId(req);
  ok(res, await settings.getSettings(userId));
});

/**
 * PUT /api/settings —— 覆盖式保存，请求里出现的字段才更新，未出现的保留原值。
 * 同样是 upsert：允许用户从未 GET 过就直接 PUT（例如本地缓存着旧设置）。
 * 数值范围由 parseUpdateSettingsInput 校验，其中时长下限是 1 而非 0 ——
 * 时长为 0 会让计时器一启动就立即结束，属于必须挡住的输入。
 */
settingsRouter.put('/', async (req, res) => {
  const userId = requireUserId(req);
  const input = settings.parseUpdateSettingsInput(req.body);
  ok(res, await settings.updateSettings(userId, input), '设置已保存');
});
