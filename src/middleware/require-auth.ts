/**
 * 鉴权中间件与会话身份的唯一读取口。
 *
 * 边界：requireAuth 只负责「拒绝或放行」，不写响应体 —— 失败时 next(AppError)，
 * 由 middleware/error.ts 统一出信封。身份一旦解析出来就挂到 req.userId，
 * 业务路由一律通过 requireUserId() 取，不直接读 req.userId，这个接缝保证了
 * 「谁解析的 userId」只有一个来源。
 */
import type { RequestHandler } from 'express';
import { AppError } from '../lib/http-error.js';
import { AUTH_COOKIE, readCookie } from '../lib/cookie.js';
import { verifyToken } from '../lib/jwt.js';
import { findUserById } from '../services/auth.js';

/**
 * 鉴权中间件。取代原来的 resolveUser（匿名 X-User-Id + upsert）。
 *
 * 与旧实现的关键差别：旧的是「合法就建号」，永远有身份；新的是
 * 「验不过就拒绝」，这是从匿名制转向账号制的本质变化。
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = readCookie(req, AUTH_COOKIE);

  if (!token) {
    next(new AppError(401, '请先登录'));
    return;
  }

  const userId = await verifyToken(token);

  if (!userId) {
    // 过期、篡改、格式错、算法不符 —— 对客户端都是同一件事：重新登录。
    // 区分具体原因只会给攻击者提供信息。
    next(new AppError(401, '登录状态已失效，请重新登录'));
    return;
  }

  // JWT 只证明令牌是我们签发的，不证明用户还在。
  // 少了这一步，被删号的用户拿着未过期的令牌继续请求，会在写入时撞外键，
  // 变成 400「关联的记录不存在」而不是 401。
  const user = await findUserById(userId);

  if (!user) {
    next(new AppError(401, '登录状态已失效，请重新登录'));
    return;
  }

  req.userId = user.id;
  next();
};

/**
 * 从 req 上取已解析的 userId。
 *
 * 签名和语义与改造前完全一致 —— 这是让 14 个业务路由调用点
 * （tasks 6 处、sessions 2 处、settings 2 处、stats 4 处）
 * 一行都不用改的关键。它们只依赖「requireAuth 挂在前面」这个前提。
 *
 * 参数类型刻意写成 `{ userId?: string }` 而非 express 的 Request：这样在任何
 * 拿到 req 的地方都能调，不要求 import Request 类型。
 *
 * 抛 500 而不是 401：走到这里却没有 userId，说明是路由挂载漏了 requireAuth，
 * 属于服务端配置错误，不是用户的身份问题。报 500 才能让日志明确指出是代码 bug，
 * 401 会把它伪装成「用户没登录」，掩盖真正的部署失误。
 */
export function requireUserId(req: { userId?: string }): string {
  if (!req.userId) {
    throw new AppError(500, 'requireAuth 中间件未生效');
  }
  return req.userId;
}
