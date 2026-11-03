import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  TEST_PASSWORD,
  cleanupUsers,
  newTestUser,
  raw,
  startTestServer,
  stopTestServer,
  type RawResponse,
} from '../helpers/server.js';
import { prisma } from '../../src/prisma.js';
import { AUTH_COOKIE } from '../../src/lib/cookie.js';
import { env } from '../../src/env.js';

/**
 * 账号体系的集成测试。
 *
 * 这里刻意不走 helpers 的懒登录（api(..., { as })），全部用 raw() 手写请求 ——
 * 要断言 Set-Cookie、要控制错误的用户名和密码、要伪造令牌，
 * 这些都不是「以某个正常账号的身份发请求」能表达的。
 */

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await cleanupUsers();
  await stopTestServer();
});

/** 手写注册请求 —— 需要自选用户名/密码，并查看 Set-Cookie */
function register(username: string, password: string = TEST_PASSWORD): Promise<RawResponse> {
  return raw('/api/auth/register', { method: 'POST', body: { username, password } });
}

/** 手写登录请求 —— 同样为了控制输入并拿到 Set-Cookie */
function login(username: string, password: string = TEST_PASSWORD): Promise<RawResponse> {
  return raw('/api/auth/login', { method: 'POST', body: { username, password } });
}

/** 从响应的 Set-Cookie 里取出可放进请求头的 `name=value` */
function cookieOf(res: RawResponse): string | null {
  const found = res.setCookies.find((value) => value.startsWith(`${AUTH_COOKIE}=`));
  return found ? found.split(';')[0]! : null;
}

/** 从 Set-Cookie 里取整个 Set-Cookie 值（含属性），用于断言 HttpOnly/Max-Age 等 */
function setCookieOf(res: RawResponse): string {
  const found = res.setCookies.find((value) => value.startsWith(`${AUTH_COOKIE}=`));
  if (!found) throw new Error(`响应里没有 ${AUTH_COOKIE} cookie`);
  return found;
}

/** 用同一个密钥签一个已经过期的令牌 */
async function signExpiredToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 3600)
    .sign(new TextEncoder().encode(env.jwtSecret));
}

/**
 * 注册即登录是产品选择：响应同时种下会话 cookie，用户不必再跳一次登录页。
 * 这一组守注册入口的输入校验与落库形态。
 */
describe('注册', () => {
  // 基础路径：201 + 直接种 cookie；响应里绝不能出现 passwordHash 或 scrypt 前缀。
  // 敏感字段泄漏往往就是序列化时忘了 omit。
  it('注册成功返回 201 并直接种下会话 cookie', async () => {
    const username = newTestUser();
    const res = await register(username);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'ok',
      data: { user: { username } },
    });

    // 注册即登录：不用再跳一次登录页
    expect(cookieOf(res)).not.toBeNull();

    // 敏感字段绝不能出现在响应里
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
  });

  // HttpOnly 挡住 XSS 读 cookie，SameSite=Lax 挡 CSRF，Max-Age 决定持久登录。
  // 这几项是安全与体验的硬要求，不是「长什么样」的展示性断言。
  it('★ cookie 是 httpOnly + SameSite=Lax，且 Max-Age 没有退化成会话 cookie', async () => {
    const res = await register(newTestUser());
    const cookie = setCookieOf(res);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');

    // res.cookie 的 maxAge 单位是毫秒。传成字符串（比如 '7d'）会被静默忽略，
    // 退化成「关掉浏览器就丢」的会话 cookie —— 这条断言就是为了守住它。
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).toMatch(/Expires=/);
  });

  // 用户名不是主键（id 才由服务端生成），唯一性靠显式冲突检测。
  // 漏了这条会在数据库唯一约束上抛错，被兜成 500 而不是可读的 409。
  it('重复用户名返回 409', async () => {
    const username = newTestUser();
    await register(username);

    const again = await register(username);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ status: 'error', code: 409 });
  });

  // 用户名要能安全地出现在 URL、日志和展示里。太短、空格、连字符、中文、
  // 超长都拒绝 —— 正则一放宽，前端展示与排序都会出问题。
  it.each([
    ['太短', 'ab'],
    ['含内部空格', 'a b'],
    ['含连字符', 'user-name'],
    ['含中文', '用户名abc'],
    ['超长', 'u'.repeat(33)],
    ['只有下划线且太短', '__'],
  ])('用户名%s 返回 400', async (_label, username) => {
    expect((await register(username)).status).toBe(400);
  });

  // 同一账号只能有一种落库形态。注册大写后归一化成小写，再用小写也能登录；
  // 不归一化的话大写和小写会变成两个不同账号，登录时互相找不到。
  it('★ 用户名会被归一化：注册大写形式后，落库和登录都用小写形态', async () => {
    const base = newTestUser();
    const upper = base.toUpperCase();

    await expect(register(upper)).resolves.toMatchObject({ status: 201 });

    // 归一化后落库的是小写形态
    const stored = await prisma.user.findUnique({ where: { username: base } });
    expect(stored).not.toBeNull();

    // 再用小写登录也认
    expect((await login(base)).status).toBe(200);
  });

  // 密码只校验长度和类型，不 trim、不限制字符集。太短拦掉，
  // 超长也拦掉（散列开销），非字符串同样拦掉。
  it.each([
    ['不足 8 位', 'short12'],
    ['超长', 'x'.repeat(73)],
    ['不是字符串', 12345678],
  ])('密码%s 返回 400', async (_label, password) => {
    const res = await raw('/api/auth/register', {
      method: 'POST',
      body: { username: newTestUser(), password },
    });
    expect(res.status).toBe(400);
  });
});

/**
 * 登录的等价条件是「用户名归一化 + 密码逐字节比对」。这一组还守两条安全
 * 不变量：失败时不分是用户名错还是密码错，以及密码不被静默 trim。
 */
describe('登录', () => {
  // 基础路径：200 + 种 cookie，返回的 user.username 是归一化后的形态。
  it('密码正确返回 200 并种下 cookie', async () => {
    const username = newTestUser();
    await register(username);

    const res = await login(username);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: { user: { username } } });
    expect(cookieOf(res)).not.toBeNull();
  });

  // 注册小写、用大写登录也要成功，证明登录和注册走的是同一套归一化逻辑，
  // 而不是各写一遍、各归一化一次。
  it('★ 大小写不敏感：注册小写，用大写也能登进来', async () => {
    const base = newTestUser();
    await register(base);

    expect((await login(base.toUpperCase())).status).toBe(200);
  });

  // 密码必须逐字节比对。带空格的原样能过、去掉空格的过不了 —— 两头都验，
  // 才能证明既没有 trim，也没有在解析时把空格当分隔符吃掉。
  it('★ 密码首尾空格不被吞', async () => {
    const username = newTestUser();
    const password = '  spaced1234  ';
    await register(username, password);

    // 原样带空格的能登进来
    expect((await login(username, password)).status).toBe(200);
    // 去掉空格的不行 —— 说明没有偷偷 trim
    expect((await login(username, 'spaced1234')).status).toBe(401);
  });

  // 这是防用户名枚举的核心：若两种失败响应有任何差异，攻击者就能逐个试探
  // 出哪些用户名已注册。两条路径必须逐字节相同，并共用同一句文案。
  it('★ 密码错误与用户名不存在返回逐字节相同的响应', async () => {
    const username = newTestUser();
    await register(username);

    const wrongPassword = await login(username, 'definitely-wrong');
    const noSuchUser = await login(newTestUser(), 'definitely-wrong');

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // 只要有任何一个字段不同，这个接口就成了用户名枚举器
    expect(JSON.stringify(noSuchUser.body)).toBe(JSON.stringify(wrongPassword.body));
    expect(JSON.stringify(wrongPassword.body)).toContain('用户名或密码不正确');
  });
});

/**
 * requireAuth 的判定顺序：有没有 cookie → 签名和有效期对不对 → 用户还在不在。
 * 三层各自独立，缺任何一层都会以不同形态的错误漏出来。
 */
describe('鉴权中间件', () => {
  // 没有 cookie 时中间件直接 401，根本不进业务层。
  it('未登录访问业务接口返回 401', async () => {
    const res = await raw('/api/tasks');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: 'error', code: 401 });
  });

  // 形状像 cookie 但不是合法 JWT 的串必须被验签失败挡下，
  // 绝不能当成匿名放行，也不能抛成 500。
  it('伪造的令牌返回 401', async () => {
    const res = await raw('/api/tasks', { cookie: `${AUTH_COOKIE}=not-a-jwt` });
    expect(res.status).toBe(401);
  });

  // 签名对、密钥对，唯一问题就是 exp 已经过去。这条能过就证明 exp 真的在
  // 生效，而不是「随便什么串都返回 401」—— 后者意味着过期令牌永远有效。
  it('★ 用同一密钥签的过期令牌也被拒', async () => {
    const username = newTestUser();
    await register(username);
    const user = await prisma.user.findUniqueOrThrow({ where: { username } });

    // 签名是对的、密钥也是对的，唯一的问题是过期了 ——
    // 这条能过就说明 exp 真的在生效，而不是「随便什么串都返回 401」。
    const expired = await signExpiredToken(user.id);
    const res = await raw('/api/tasks', { cookie: `${AUTH_COOKIE}=${expired}` });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 401 });
  });

  // 验收点：验签通过后 requireAuth 还必须查一次库确认用户还在。
  it('★ 令牌合法但用户已被删除 → 401（不是 400）', async () => {
    const username = newTestUser();
    const res0 = await register(username);
    const cookie = cookieOf(res0)!;

    // 拿一个有效会话先确认它是通的
    expect((await raw('/api/auth/me', { cookie })).status).toBe(200);

    await prisma.user.delete({ where: { username } });

    // 如果 requireAuth 只验签不查库，这里业务层会拿一个不存在的 userId 去写库，
    // 撞外键 → P2003 → 被 errorHandler 兜成 400「关联的记录不存在」。
    // 断言 401 就是在守住「必须补一次主键查询」这个决定。
    const res = await raw('/api/tasks', { cookie });
    expect(res.status).toBe(401);
  });
});

/**
 * 身份自省接口，前端用它判断是否已登录并渲染用户名。响应必须是字段白名单，
 * 不能把整个 User 行原样丢出去。
 */
describe('/api/auth/me', () => {
  // Object.keys 必须恰好是 createdAt/id/username。多出任何字段
  // （比如 passwordHash 或内部字段）都是信息泄漏。
  it('返回当前用户，且响应里没有密码哈希', async () => {
    const username = newTestUser();
    const registered = await register(username);
    const cookie = cookieOf(registered)!;

    const me = await raw('/api/auth/me', { cookie });
    expect(me.status).toBe(200);

    const data = (me.body as { data: { user: Record<string, unknown> } }).data;
    expect(data.user).toMatchObject({ username });
    expect(Object.keys(data.user).sort()).toEqual(['createdAt', 'id', 'username']);
    expect(JSON.stringify(me.body)).not.toContain('scrypt$');
  });

  // me 也要走 requireAuth，不能给未登录用户回一个 200 的空对象 ——
  // 那会让前端误判「已登录」。
  it('未登录返回 401', async () => {
    expect((await raw('/api/auth/me')).status).toBe(401);
  });
});

/**
 * 登出就是下发一个同名、同 Path 的空 cookie 覆盖掉原来的。无状态 JWT
 * 服务端没有会话表可清，全靠浏览器丢弃 cookie。
 */
describe('登出', () => {
  it('返回成功，并下发一个把 cookie 清掉的 Set-Cookie', async () => {
    const res = await raw('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);

    const cookie = setCookieOf(res);
    // 清 cookie 靠的是「同名 + 同 Path + 空值/已过期」。
    // Path 必须与写入时一致，否则浏览器认为不是同一个 cookie，根本不会清掉。
    expect(cookie.startsWith(`${AUTH_COOKIE}=;`)).toBe(true);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
  });

  // 登出不能要求 cookie 有效，否则一个坏 cookie 会永远卡在浏览器里清不掉，
  // 用户陷入「登不出去也登不进来」。所以登出路由不过 requireAuth。
  it('★ 带着一个坏 cookie 也能登出（否则坏 cookie 永远清不掉）', async () => {
    const res = await raw('/api/auth/logout', {
      method: 'POST',
      cookie: `${AUTH_COOKIE}=garbage`,
    });
    expect(res.status).toBe(200);
  });
});
