import type { Session, Task, User } from '@prisma/client';
import { toDateKey } from './date.js';

/**
 * Prisma 的日期字段是 Date 对象，直接 JSON.stringify 会变成带时区的长串。
 * 这里统一转成前端好用的形状：日期用 "YYYY-MM-DD"，时间戳用 ISO 字符串。
 *
 * 这是「数据库行 → 对外 DTO」的唯一出口。凡是会把模型对象直接 res.json() 出去
 * 的地方，都应先经过这里的某个 serialize* —— 否则日期格式不统一，更糟的是
 * 可能把不该外泄的列（如 User.passwordHash）一并序列化出去。
 *
 * DTO 类型与 Prisma 模型是两套：TaskDto 用 Omit + 覆盖把 Date 换成 string，
 * 类型层面即保证「日期已经是字符串」，前端拿到的字段形状与类型一致。
 */

export type TaskDto = Omit<Task, 'date'> & { date: string };
export type SessionDto = Omit<Session, 'startAt' | 'endAt'> & {
  startAt: string;
  endAt: string;
};

/**
 * Task → 对外 DTO。@db.Date 字段取回后是 UTC 零点，故用 toDateKey 切成 "YYYY-MM-DD"
 * 而非 ISO 时间戳 —— 任务只有「归属哪一天」的概念，带上时分秒和时区反而会让前端误读。
 *
 * 注意展开顺序：先 ...task 再覆盖 date，后写的 date 才能压过原字段；反过来写会
 * 保留 Prisma 的 Date 对象，序列化又回到长串。这种「整体展开」意味着模型新增列会
 * 自动流向前端，对 Task / Session 是有意为之；User 则绝不能用这个套路（见 serializeUser）。
 */
export function serializeTask(task: Task): TaskDto {
  return { ...task, date: toDateKey(task.date) };
}

/**
 * Session → 对外 DTO。startAt / endAt 是真正的时刻，统一转 ISO 字符串交给前端本地化，
 * 服务端不预先替用户决定显示成哪个时区。
 */
export function serializeSession(session: Session): SessionDto {
  return {
    ...session,
    startAt: session.startAt.toISOString(),
    endAt: session.endAt.toISOString(),
  };
}

/** 对外的用户信息。**只有这三个字段。** */
export type UserDto = {
  id: string;
  username: string;
  createdAt: string;
};

/**
 * ★ 注意这里**不是** `{ ...user, ... }` 全展开 —— 上面两个序列化函数是那个风格，
 * 照抄过来会把 passwordHash 直接吐给客户端。
 * 这个函数的白名单是手写的，加字段必须是有意识的决定。
 */
export function serializeUser(user: User): UserDto {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt.toISOString(),
  };
}
