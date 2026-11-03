import type { CookieOptions, Request, Response } from 'express';
import { isDev } from '../env.js';
import { SESSION_MAX_AGE_MS } from './jwt.js';

/**
 * 会话 Cookie。
 *
 * Express 5 内建了 res.cookie() / res.clearCookie()，但**读** cookie 需要
 * cookie-parser 中间件。我们只读一个值，而且是 base64url 字符集的 JWT
 * （不含 ; 和 = 之外的特殊字符），所以自己解析几行就够了，不值得为它加依赖。
 */

/** Cookie 名。加 ff_ 前缀是为了和同域下可能存在的其他应用 Cookie 区分开。 */
export const AUTH_COOKIE = 'ff_token';

/**
 * 所有会话 Cookie 共用的属性。写入与清除**必须用同一组**，否则浏览器视为
 * 不同的 Cookie，会出现「清了却还在」。
 *
 *   - httpOnly：JS 读不到，XSS 拿到脚本也偷不走令牌。注意代价是前端无法读 token，
 *     所以身份只能靠服务端从 Cookie 解析。
 *   - sameSite: 'lax'：跨站发起的 POST 不带 Cookie，挡掉常见 CSRF；同时顶层的
 *     链接跳转仍带 Cookie，不影响用户点链接进来。
 *   - secure: 生产环境才置 true；开发走 http，置 true 会让浏览器直接拒收 Cookie。
 *   - path: '/'：全站可读；clearCookie 少写或写错这个值就删不掉。
 */
const BASE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: !isDev,
  path: '/',
} as const satisfies CookieOptions;

/**
 * 写入会话令牌 Cookie。
 * 除 BASE_OPTIONS 外额外设 maxAge —— 7 天，与 JWT 的 exp 对齐，保证不会出现
 * 「Cookie 还在、令牌已过期」的尴尬中间态。
 */
export function setAuthCookie(res: Response, token: string): void {
  // ★ maxAge 的单位是**毫秒**。
  //   传字符串（比如 '7d'）会静默退化成会话 Cookie：Express 内部做 `opts.maxAge - 0`，
  //   '7d' - 0 是 NaN，随后 `if (!isNaN(maxAge))` 整个分支被跳过，expires 和 maxAge
  //   都不写进 Set-Cookie，浏览器一关就丢登录态。这种错误不报错、只在重启浏览器时暴露。
  res.cookie(AUTH_COOKIE, token, { ...BASE_OPTIONS, maxAge: SESSION_MAX_AGE_MS });
}

/**
 * 清除会话 Cookie。
 * 复用 BASE_OPTIONS 不只是图省事，而是必须：清除的依据是「名字 + path + domain」
 * 三元组，任一不一致浏览器就认为不是同一个 Cookie，于是删不掉、表现为「登出无效」。
 */
export function clearAuthCookie(res: Response): void {
  // path 必须与写入时一致，否则浏览器认为不是同一个 Cookie，删不掉。
  res.clearCookie(AUTH_COOKIE, BASE_OPTIONS);
}

/**
 * 读取单个 cookie 的值；不存在或编码损坏都返回 null。
 *
 * 自己手写解析而非引入 cookie-parser：本服务只读一个 base64url 字符集的 JWT，
 * 不含 `;` 之类的分隔符，几行循环足矣，不值得为它多一个依赖。
 * 解析取「第一个匹配的名字」；名字比较前做 trim，容忍 `a=b; c=d` 里分隔后的空格。
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;

    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // 坏 cookie 不能让整个请求 500，当作没有即可
      return null;
    }
  }

  return null;
}
