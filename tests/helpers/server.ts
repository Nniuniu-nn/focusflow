import type { Server } from 'node:http';
import app from '../../src/app.js';
import { prisma } from '../../src/prisma.js';
import { AUTH_COOKIE } from '../../src/lib/cookie.js';

/**
 * 集成测试基座：用 app.listen(0) 起一个临时端口的真实服务，
 * 再用全局 fetch 打请求。不引入 supertest —— 这样测的就是真实的
 * 中间件链（信封、requireAuth、错误处理），且零额外依赖。
 */

let server: Server | undefined;
let baseUrl = '';

/** 测试账号统一用这个密码，够长且好认 */
export const TEST_PASSWORD = 'test1234';

/**
 * 防呆：集成测试会真的写库，绝不允许连到开发库。
 *
 * `src/env.ts` 里是 `import 'dotenv/config'`，默认加载 `.env`。所以如果直接裸跑
 * `npx vitest run`（而不是走 npm 脚本），DATABASE_URL 会指向开发库 focusflow，
 * 测试数据就写进去了。这里把「静默污染开发库」变成一条明确的报错。
 */
function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';

  if (!/_test(\?|$)/.test(url)) {
    throw new Error(
      '集成测试拒绝连到非测试库。当前 DATABASE_URL 指向的不是以 `_test` 结尾的数据库。\n' +
        '请改用 `npm run test:integration`（它会用 .env.test 并先跑 migrate deploy），\n' +
        '或 `npm test`（单测 + 集成测）。',
    );
  }
}

export interface RawResponse {
  status: number;
  headers: Headers;
  /** getSetCookie() 的原始结果，数组形式，不会像 get('set-cookie') 那样被合并 */
  setCookies: string[];
  body: unknown;
}

export interface RawOptions {
  method?: string;
  body?: unknown;
  /** 直接给 Cookie 请求头的值；不给就不带 cookie */
  cookie?: string | null;
}

/**
 * 最底层的请求：不拆信封、不自动登录，原样返回状态码、响应头和 Set-Cookie。
 * 认证相关的用例需要看 Set-Cookie，所以必须有这一层。
 */
export async function raw(path: string, options: RawOptions = {}): Promise<RawResponse> {
  const headers: Record<string, string> = {};

  if (options.cookie) headers['Cookie'] = options.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON 响应（比如未被捕获的 500 HTML）就留 null，让断言自己去看 status
  }

  return {
    status: response.status,
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
    body,
  };
}

/**
 * 启动真实服务：listen(0) 让内核挑一个空闲端口，避开固定 3000 端口在
 * 本地重复运行或 CI 上的冲突。幂等 —— 同一进程里只起一次。
 */
export async function startTestServer(): Promise<void> {
  if (server) return;

  assertTestDatabase();

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (address && typeof address === 'object') {
        baseUrl = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });
}

/**
 * 先断开 Prisma 再关服务器。Prisma 的连接池不会随 HTTP server 一起关掉，
 * 不手动 $disconnect 的话 vitest 进程会挂着不退出。
 */
export async function stopTestServer(): Promise<void> {
  await prisma.$disconnect();

  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
  baseUrl = '';
}

/**
 * 一个新的测试用户名（不是 id —— 账号制下 id 由服务端生成）。
 * 形如 u_ + 24 位十六进制，天然满足 ^[a-z0-9_]{3,32}$ 且几乎不会重复。
 */
export function newTestUser(): string {
  return `u_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** 独立的 clientId。以前这里错用 newUserId()，语义要分清。 */
export function newClientId(): string {
  return crypto.randomUUID();
}

/** username → Cookie 请求头的值 */
const sessionCache = new Map<string, string>();

/**
 * 拿到某个测试账号的会话 cookie，没有就现注册一个。
 *
 * 懒登录：调用方只在 api(..., { as }) 里写个用户名，不用每个用例都
 * 手动注册、取 cookie、传头。链路本身一点没省 —— 真的走
 * POST /auth/register、Set-Cookie、requireAuth 验签、查库那全套。
 *
 * 内部用底层 fetch 而不是 api()，否则 api() 会回头调它，死循环。
 */
export async function ensureSession(username: string): Promise<string> {
  const cached = sessionCache.get(username);
  if (cached) return cached;

  const payload = JSON.stringify({ username, password: TEST_PASSWORD });

  let response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  const registerStatus = response.status;

  if (response.status !== 201) {
    // 用户名撞车（UUID 基本不会，但残留的旧库会）就退化成登录
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
  }

  if (!response.ok) {
    throw new Error(
      `测试账号「${username}」拿不到会话：register → ${registerStatus}，login → ${response.status}。` +
        '用户名必须满足 ^[a-z0-9_]{3,32}$。',
    );
  }

  // 必须用 getSetCookie()：get('set-cookie') 在有多个 cookie 时会合并成一条，
  // 解析起来容易丢东西。
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${AUTH_COOKIE}=`));

  if (!cookie) {
    throw new Error(`测试账号「${username}」的响应里没有 ${AUTH_COOKIE} cookie`);
  }

  // 只取 name=value，丢掉 Path / HttpOnly / Max-Age 那些属性 ——
  // 请求头里不需要它们。
  const header = cookie.split(';')[0]!;
  sessionCache.set(username, header);
  return header;
}

/** 拆开信封后的响应：status 是 HTTP 状态码，body 是整个 { message, status, code, data } */
export interface ApiResponse {
  status: number;
  body: {
    message: string;
    status: 'ok' | 'error';
    code: number;
    data: unknown;
  };
}

export interface ApiOptions {
  /** 以哪个测试账号的身份发请求；省略或 null 表示不带 cookie（未登录） */
  as?: string | null;
  method?: string;
  body?: unknown;
}

/** 发一个请求并拆开信封，返回 { status, body } */
export async function api(path: string, options: ApiOptions = {}): Promise<ApiResponse> {
  const cookie = options.as ? await ensureSession(options.as) : null;
  const response = await raw(path, { method: options.method, body: options.body, cookie });

  return { status: response.status, body: response.body as ApiResponse['body'] };
}

/**
 * 清掉本次测试建的所有账号（外键 cascade 会带走任务、时段和设置）。
 *
 * 除了扫 u_ 前缀，还顺手清掉上次跑崩留下的残留 —— 集成测试进程被杀时
 * afterAll 不会执行，不清的话测试库会越攒越脏。
 */
export async function cleanupUsers(): Promise<void> {
  await prisma.user.deleteMany({ where: { username: { startsWith: 'u_' } } });
  sessionCache.clear();
}
