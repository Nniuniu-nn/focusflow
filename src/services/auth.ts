/**
 * 认证服务：注册与登录的核心逻辑（不含 JWT 签发与 Cookie 写入，那些在上层）。
 *
 * 架构位置：routes/auth 调用本模块完成「建用户」「验密码」，路由层再负责发令牌。
 *
 * 边界（刻意不做的）：
 *   - 不管会话/令牌：登录成功后如何签发、放在哪里属于上层职责。
 *   - 不在这里归一化用户名：requireUsername 已在入口完成 NFKC + 去空白 + 转小写。
 *   - 不区分「用户不存在」与「密码错误」：对外是同一种失败，否则就成了用户名枚举器。
 *
 * 关键设计：注册靠唯一索引兜底 P2002 转 409；登录在「查不到用户」时也跑一次
 * 等价的哈希计算，抹平两种失败路径的响应时间差。
 */
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../prisma.js';
import { AppError } from '../lib/http-error.js';
import { getDummyHash, hashPassword, verifyPassword } from '../lib/password.js';

/**
 * 注册。用户名已经由 validate 层归一化过了，这里直接用。
 *
 * 建 User 时用嵌套写一次性把默认 Setting 也建好 —— 与改造前 resolveUser
 * 中间件的写法一致，这样账号一建出来就是可用的完整状态。
 *
 * @param username 已归一化（小写）的用户名，来自 requireUsername
 * @param password 明文密码，仅用于派生哈希，绝不落库
 * @returns 新建的 User（其默认 Setting 由嵌套写一并建好）
 * @throws AppError(409) 用户名已被占用；并发注册时由 @unique 的 P2002 兜底
 */
export async function registerUser(username: string, password: string): Promise<User> {
  const passwordHash = await hashPassword(password);

  try {
    return await prisma.user.create({
      data: { username, passwordHash, setting: { create: {} } },
    });
  } catch (error) {
    // 「先查重再插入」之间永远有竞态窗口，两个人的注册请求可以同时通过查重。
    // 唯一索引是最后一道防线，撞上了说明用户名确实被占了。
    // 这里不依赖全局 errorHandler 的 P2002→409，因为那条消息是通用的
    // 「记录已存在」，无法告诉用户到底哪个字段冲突了。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, '该用户名已被占用');
    }
    throw error;
  }
}

/**
 * 校验用户名密码。失败一律返回 null —— 调用方不区分「用户不存在」和
 * 「密码错误」，两者对外是同一条消息，否则就成了用户名枚举器。
 *
 * 用户不存在时也要跑一次等价的哈希计算：直接返回的话响应会明显更快，
 * 攻击者掐表就能问出哪些用户名已被注册。
 *
 * @returns 校验通过返回 User；失败一律 null，调用方不得据此区分失败原因
 */
export async function authenticate(username: string, password: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { username } });

  if (!user) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

/**
 * 按 id 取用户。鉴权中间件每次请求都会调它 ——
 * JWT 只证明「这个令牌是我们签发的」，不证明「这个人还在」。
 * 用户被删掉之后，令牌在过期前仍然验签通过，若不查库就会让业务层
 * 拿着一个不存在的 userId 去写，撞外键后变成 400「关联的记录不存在」，
 * 而不是一个说得通的 401。
 *
 * @returns 用户已被删除时返回 null，由调用方（鉴权中间件）转成 401
 */
export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}
