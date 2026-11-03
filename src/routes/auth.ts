/**
 * 认证路由。会话用 JWT（HS256）装在 httpOnly Cookie 里，服务端不存会话状态。
 *
 * 本文件导出两个 router，而不是一个：
 *   - publicAuthRouter（register / login / logout）挂在 requireAuth 之前；
 *   - protectedAuthRouter（/me）挂在 requireAuth 之后。
 * 拆成两个是因为挂载点不同 —— 同一个 app.use('/auth', ...) 前缀下，靠中间件
 * 出现的位置区分公开与受保护，混在一个 router 里无法表达。
 *
 * 边界：这里只做入参校验、调 service、设置 Cookie 与信封；密码哈希、用户名
 * 查重、防枚举的等时比较都在 services/auth.ts 与 lib/password.ts。
 */
import express from 'express';
import { ok } from '../lib/response.js';
import { AppError } from '../lib/http-error.js';
import { clearAuthCookie, setAuthCookie } from '../lib/cookie.js';
import { signToken } from '../lib/jwt.js';
import { requirePassword, requireUsername } from '../lib/validate.js';
import { serializeUser } from '../lib/serialize.js';
import { requireUserId } from '../middleware/require-auth.js';
import * as auth from '../services/auth.js';

/**
 * 公开的认证路由（register / login / logout）。
 *
 * 注意这三个挂在 requireAuth **之前**。特别是 logout：
 * 令牌过期或被篡改时用户仍然必须能清掉浏览器里的坏 Cookie，
 * 否则登录页和首页之间会来回打转 —— 带着一个永远清不掉的坏 Cookie。
 */
export const publicAuthRouter = express.Router();

/**
 * POST /api/auth/register —— 注册即登录，省掉一次往返。
 *
 * 副作用：写 User（连同一行默认 Setting）、设置会话 Cookie、返回 201。
 * 用户名冲突由 service 抛 409「该用户名已被占用」—— 登录接口刻意不区分
 * 「用户不存在」和「密码错」，但注册接口无法回避这个信息：占用了就是占用了。
 */
publicAuthRouter.post('/register', async (req, res) => {
  const username = requireUsername(req.body);
  const password = requirePassword(req.body);

  const user = await auth.registerUser(username, password);
  setAuthCookie(res, await signToken(user.id));

  res.status(201);
  ok(res, { user: serializeUser(user) }, '注册成功');
});

/**
 * POST /api/auth/login —— 校验通过后签发令牌并写入 httpOnly Cookie。
 * 失败统一 401「用户名或密码不正确」（见下方注释）。
 */
publicAuthRouter.post('/login', async (req, res) => {
  const username = requireUsername(req.body);
  const password = requirePassword(req.body);

  const user = await auth.authenticate(username, password);

  if (!user) {
    // 「用户名不存在」和「密码错误」必须是同一条消息，
    // 否则这个接口就成了用户名枚举器。
    throw new AppError(401, '用户名或密码不正确');
  }

  setAuthCookie(res, await signToken(user.id));
  ok(res, { user: serializeUser(user) }, '登录成功');
});

/** POST /api/auth/logout —— 幂等：没登录也返回成功 */
publicAuthRouter.post('/logout', (_req, res) => {
  // 只能清掉浏览器里的 Cookie。JWT 是无状态的，令牌本身在过期前
  // 技术上仍然有效 —— 要真正吊销就得引入服务端状态（黑名单或
  // User.tokenVersion），那等于放弃 JWT 的无状态优势。
  // 本地单用户工具，7 天过期 + 清 Cookie 足够。
  clearAuthCookie(res);
  ok(res, null, '已退出登录');
});

/**
 * 受保护的认证路由，挂在 requireAuth 之后。
 * 单独一个 router 是因为 /me 必须读到 requireAuth 解析出的身份，
 * 不能和上面三个混在一起。
 */
export const protectedAuthRouter = express.Router();

/**
 * GET /api/auth/me —— 前端用它判断登录态、取导航栏显示的用户名。
 * 有 requireAuth 在，正常必然能查到用户；service 的 findUserById 返回 null
 * 只可能在「验签通过后、这次查询之前用户被删」的极小窗口里发生，兜住它即可。
 */
protectedAuthRouter.get('/me', async (req, res) => {
  const user = await auth.findUserById(requireUserId(req));

  if (!user) {
    // requireAuth 已经查过一次，正常走不到这里；保留是为了类型收窄
    throw new AppError(401, '登录状态已失效，请重新登录');
  }

  ok(res, { user: serializeUser(user) });
});
