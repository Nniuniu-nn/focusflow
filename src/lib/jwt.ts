import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';

/**
 * 会话令牌：JWT（HS256），由 src/lib/cookie.ts 装进 httpOnly Cookie。
 *
 * 用 jose 而不是 jsonwebtoken：jose 是 ESM 原生、自带 TS 类型、零依赖。
 * jsonwebtoken 是 CJS 且类型要另装 @types 包，在 module:NodeNext 下
 * 命名导入还得指望 Node 能静态识别它的 module.exports。
 *
 * 不手写 HS256 签名验证：那属于安全敏感代码，alg 混淆、漏用定时安全比较、
 * 忘记校验 exp，每一条都是经典的 CVE 来源。
 */

const ALG = 'HS256';

/** 与 cookie 的 maxAge 保持一致，否则会出现「cookie 还在但令牌已过期」 */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * jose 的时长写法。与上面的 SESSION_MAX_AGE_MS 指同一段 7 天，但单位不同：
 * cookie 要毫秒数，jose 要人类可读串。改其一务必同步改其二。
 */
const EXPIRES_IN = '7d';

/**
 * 把 env.jwtSecret 编码成 jose 需要的字节。HS256 的密钥是一段字节而非字符串，
 * UTF-8 编码对 ASCII 密钥即原样。长度下限（32 字符）已在 env.ts 启动时强制校验。
 */
function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.jwtSecret);
}

/**
 * payload 里只放 sub（用户 id）。不放 username ——
 * 用户名将来若支持修改，令牌里的就是陈旧数据，一律以读库为准。
 *
 * @returns 紧凑序列化的 JWS 字符串（header.payload.signature），可直接塞进 Cookie。
 */
export async function signToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(EXPIRES_IN)
    .sign(secretKey());
}

/**
 * 验签并取出用户 id。过期、篡改、格式错、算法不符，一律返回 null ——
 * 调用方不需要区分这些情况，统一按「未登录」处理即可。
 *
 * algorithms 必须显式锁定。不写的话，alg:none 和 RS256↔HS256 混淆
 * 都是能直接绕过验证的经典漏洞。
 */
export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    const sub = payload.sub;
    return typeof sub === 'string' && sub !== '' ? sub : null;
  } catch {
    return null;
  }
}
