import { describe, expect, it } from 'vitest';
import { getDummyHash, hashPassword, verifyPassword } from '../../src/lib/password.js';

/**
 * 密码哈希的单测。不碰数据库，所以 `npm run test:unit` 单独就能跑。
 *
 * 覆盖 src/lib/password.ts 的 scrypt 实现。它只依赖 node:crypto，不 import env.ts、
 * 不连库，因此可以纯函数地验证：salt 是否真的生效；损坏或被手改的哈希是否安全地
 * 返回 false（而不是抛异常、也不吃爆内存）；getDummyHash 是否抹平了登录时的响应时间差。
 */

/** 造一个指定长度、指定填充字节的 base64 串，用来拼装各种损坏的哈希 */
const b64 = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64');

// 产出侧的格式与随机性。存储格式是自描述的：参数跟着哈希一起存，
// 这样将来调参后旧哈希仍然能被验证。
describe('hashPassword', () => {
  // 格式必须是 scrypt$N$r$p$salt$hash，共 6 段，参数取当前默认值。
  // 段序错了会让 parseStored 全部拒收，等于谁也登录不了。
  it('产出自描述的六段格式', async () => {
    const stored = await hashPassword('hunter2000');
    const parts = stored.split('$');

    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('16384');
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');
    // salt 16 字节、hash 64 字节，base64 后会变长
    expect(parts[4]!.length).toBeGreaterThan(0);
    expect(parts[5]!.length).toBeGreaterThan(0);
  });

  // 每次哈希用新的随机 salt，所以同一明文两次结果不同（彩虹表失效）；
  // 但两者都必须能验回同一密码 —— salt 只影响存储，不影响校验。
  it('同一密码两次哈希结果不同（salt 生效，彩虹表用不上）', async () => {
    const first = await hashPassword('hunter2000');
    const second = await hashPassword('hunter2000');

    expect(first).not.toBe(second);
    // 但两个都能验回来
    await expect(verifyPassword('hunter2000', first)).resolves.toBe(true);
    await expect(verifyPassword('hunter2000', second)).resolves.toBe(true);
  });

  // 数据库列是 VarChar(255)，哈希串必须留有余量；
  // 否则一旦调大 salt/keylen 就会被截断，导致所有密码失效。
  it('哈希串长度不会撑爆 VarChar(255)', async () => {
    expect((await hashPassword('hunter2000')).length).toBeLessThan(255);
  });
});

// 校验侧。核心约定：任何异常输入都返回 false，绝不把异常抛给调用方 ——
// 调用方只关心「能不能登录」，不关心「哪里坏了」。
describe('verifyPassword', () => {
  // 正向与几个反向用例：多一位、少一位、空串都必须被拒绝。
  it('正确密码通过，错误密码不通过', async () => {
    const stored = await hashPassword('hunter2000');

    await expect(verifyPassword('hunter2000', stored)).resolves.toBe(true);
    await expect(verifyPassword('hunter2001', stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
    await expect(verifyPassword('hunter200', stored)).resolves.toBe(false);
  });

  // 密码不做 trim：'  pass1234  ' 与 'pass1234' 是两个不同的密码。
  // 若某处顺手加了 trim，会悄悄改变用户实际的密码，导致某些人无法登录。
  it('★ 不 trim：首尾空格是密码的一部分', async () => {
    const stored = await hashPassword('  pass1234  ');

    await expect(verifyPassword('  pass1234  ', stored)).resolves.toBe(true);
    await expect(verifyPassword('pass1234', stored)).resolves.toBe(false);
  });

  // hashPassword 不负责强度校验，空串也能正常哈希与验证；
  // 长度/强度限制由 validate.ts 负责，这里的职责边界不能被混进来。
  it('空密码本身能被哈希和验证（长度限制由 validate.ts 负责，不在这里）', async () => {
    const stored = await hashPassword('');

    await expect(verifyPassword('', stored)).resolves.toBe(true);
    await expect(verifyPassword('x', stored)).resolves.toBe(false);
  });

  // 一张损坏哈希表：格式、段数、前缀、参数类型/范围、空 salt/hash 各挑一例。
  // 它们全部走 parseStored 的提前返回路径，必须干净地返回 false 而不是抛异常。
  it.each([
    ['空串', ''],
    ['随便一段文本', 'not-a-hash'],
    ['段数不对', 'scrypt$16384$8$1$abc'],
    ['前缀不对', 'bcrypt$16384$8$1$abc$def'],
    ['N 不是数字', 'scrypt$abc$8$1$abc$def'],
    ['N 是小数', 'scrypt$16384.5$8$1$abc$def'],
    ['p 为 0', 'scrypt$16384$8$0$abc$def'],
    ['r 为负', 'scrypt$16384$-8$1$abc$def'],
    ['salt 为空', `scrypt$16384$8$1$${b64(64, 1)}`],
    ['hash 为空', `scrypt$16384$8$1$${b64(16, 1)}$`],
  ])('损坏的哈希（%s）返回 false 而不是抛异常', async (_label, stored) => {
    await expect(verifyPassword('hunter2000', stored)).resolves.toBe(false);
  });

  // 有人手改数据库把 N 调成 2^20（128*N*r = 1GB）—— 必须在开算之前挡掉，
  // 否则 scrypt 会瞬间吃爆内存。这条若失效，测试会因 OOM 直接崩，而不是失败得好看。
  it('★ 手改库塞进超大参数时拒绝解析（不能拿它打爆内存）', async () => {
    // N=2^20、r=8 时内存需求是 1GB，远超上界，必须在开算之前就挡掉。
    // 如果这里没挡住，测试会直接 OOM 挂掉，而不是失败得好看。
    const bomb = `scrypt$1048576$8$1$${b64(16, 1)}$${b64(64, 1)}`;
    await expect(verifyPassword('hunter2000', bomb)).resolves.toBe(false);
  });

  // timingSafeEqual 对长度不等的 Buffer 会直接抛异常，所以解析后必须先比长度。
  // 这里把 64 字节的 hash 砍成 32 字节，验证被拦下而不是崩溃。
  it('长度不符的 hash 返回 false（timingSafeEqual 长度不等会抛，必须先拦）', async () => {
    const stored = await hashPassword('hunter2000');
    const parts = stored.split('$');
    // 把 64 字节的 hash 砍成 32 字节
    const truncated = [...parts.slice(0, 5), b64(32, 9)].join('$');

    await expect(verifyPassword('hunter2000', truncated)).resolves.toBe(false);
  });
});

// 用于登录时抹平「用户名不存在」与「密码错误」的响应时间差，
// 防止攻击者通过响应快慢枚举出哪些用户名已被注册。
describe('getDummyHash', () => {
  // dummy 必须是一个格式合法、能参与完整 scrypt 校验的哈希，
  // 且它的固定明文并不对应任何真实用户的密码。
  it('返回一个合法的哈希，且没有真实密码能对上它', async () => {
    const dummy = await getDummyHash();

    expect(dummy.split('$')).toHaveLength(6);
    // 用它的固定明文去验当然是 true —— 这里想确认的是它本身是有效哈希
    await expect(verifyPassword('ff-dummy-password-for-timing-equalization', dummy)).resolves.toBe(
      true,
    );
    await expect(verifyPassword('hunter2000', dummy)).resolves.toBe(false);
  });

  // 缓存的是同一个 Promise：多次调用返回同一份。
  // 若每次现算，登录接口在用户名不存在时反而更慢，时间差抹平就失效了。
  it('多次调用返回同一份（进程内只算一次，不是每请求现算）', async () => {
    const [a, b] = await Promise.all([getDummyHash(), getDummyHash()]);
    expect(a).toBe(b);
  });
});
