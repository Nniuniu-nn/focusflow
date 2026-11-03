import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 密码哈希：node:crypto 的 scrypt。
 *
 * 选它而不是 bcrypt/argon2 的原因很实在：零新依赖，且不需要编译原生模块
 * （在 Windows + Node 24 上，bcrypt/argon2 的原生模块经常装不上）。
 *
 * 存储格式是自描述的，参数跟着哈希一起存，这样将来调参后旧哈希仍然能验证：
 *
 *     scrypt$16384$8$1$<salt-base64>$<hash-base64>
 *
 * 本模块只依赖 node:crypto —— 刻意不 import env.ts，
 * 否则 `npm run db:seed` 会因为缺 JWT_SECRET 而崩（seed 需要哈希密码）。
 */

const PREFIX = 'scrypt';

/** 默认参数。128 * N * r = 16MB，落在 Node 默认 maxmem（32MB）之内。 */
const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

const KEY_LEN = 64;
const SALT_LEN = 16;

/**
 * 解析存储串时允许的上界。
 * 哈希参数是存在数据库里的，万一有人手改库构造出 N=2^20 之类的值，
 * 直接算会瞬间吃掉几个 GB 内存。这里按「内存开销」卡死，而不是按单个参数卡。
 */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptParams & { maxmem: number },
) => Promise<Buffer>;

/**
 * 用异步版 scrypt。单次约 30ms，同步版会阻塞事件循环 ——
 * 几个人同时登录就能把整个服务卡住。
 */
async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const memory = 128 * params.N * params.r;

  return scryptAsync(password, salt, KEY_LEN, {
    ...params,
    // 留一倍余量，避免恰好卡在 Node 的内存检查边界上
    maxmem: Math.max(2 * memory, 1024 * 1024),
  });
}

/**
 * 明文密码 → 可入库的哈希串。每次调用都用新的随机 salt（同一密码两次哈希结果不同，
 * 防止彩虹表），返回上面头注释里描述的自描述格式。
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(plain, salt, { N: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P });

  return [
    PREFIX,
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * 解析存储串，任何异常一律返回 null（fail closed）。
 *
 * 逐项设防：段数、前缀、参数均为整数且 N>1、r/p>0、内存开销不超上限、盐与哈希
 * 非空。参数来自数据库，若被手改成 N=2^20 这类值，不拦就会在 verifyPassword 里
 * 瞬间吃掉几个 GB —— 所以按内存卡死，而不是逐参数设限（真正决定开销的是 128*N*r）。
 *
 * @returns 解析成功给 { params, salt, hash }；任一处不合法给 null。
 */
function parseStored(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  if (parts[0] !== PREFIX) return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N <= 1 || r <= 0 || p <= 0) return null;
  if (128 * N * r > MAX_MEMORY_BYTES) return null;

  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const hash = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || hash.length === 0) return null;

  return { params: { N, r, p }, salt, hash };
}

/**
 * 校验密码。任何异常（格式损坏、参数越界、编码错误）一律返回 false，
 * 而不是抛出去 —— 调用方关心的是「能不能登录」，不是「哪里坏了」。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;

  let candidate: Buffer;
  try {
    candidate = await derive(plain, parsed.salt, parsed.params);
  } catch {
    return false;
  }

  // timingSafeEqual 在两个 Buffer 长度不等时会直接抛异常，
  // 所以必须先比长度。长度不等本身就说明对不上，直接返回 false 也很安全。
  if (candidate.length !== parsed.hash.length) return false;

  return timingSafeEqual(candidate, parsed.hash);
}

let dummyHash: Promise<string> | null = null;

/**
 * 一个「谁的密码都不是」的假哈希，用于登录时抹平响应时间差。
 *
 * 用户名不存在时如果直接返回，响应会明显快于「密码错误」那条路径，
 * 攻击者据此可以枚举出哪些用户名已被注册。所以查不到用户时也跑一次
 * 等价的哈希计算。进程内只算一次，不是每个请求现算。
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('ff-dummy-password-for-timing-equalization');
  return dummyHash;
}
