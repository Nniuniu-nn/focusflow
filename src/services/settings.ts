/**
 * 计时偏好服务：读写设置页的「专注/短休/长休时长、长休间隔、自动开始下一段」。
 *
 * 架构位置：Setting 表与 routes 之间的薄封装，不做身份解析（userId 由鉴权中间件给出）。
 *
 * 边界（刻意不做的）：
 *   - 不校验「长休间隔应大于某值」这类跨字段关系：各字段独立生效，没有组合约束。
 *   - 不缓存：单用户本地应用每次读一行，缓存带来的失效问题不划算。
 *
 * 关键设计：读和写都用 upsert。Setting 的主键就是 userId（与 User 一对一），
 * 于是「首次访问顺手建出默认行」与「更新」能合成一次调用，调用方无需先判断行是否存在。
 */
import type { Setting } from '@prisma/client';
import { prisma } from '../prisma.js';
import { optionalBoolean, optionalIntInRange } from '../lib/validate.js';

export interface UpdateSettingsInput {
  focusMin?: number;
  shortBreakMin?: number;
  longBreakMin?: number;
  longBreakEvery?: number;
  autoStartNext?: boolean;
}

/**
 * 读取计时偏好。用户首次访问时还没有 Setting 行，
 * 这里用 upsert 顺带建出默认值，调用方不必关心「有没有初始化过」。
 *
 * create 分支只给 userId，其余字段全部落在 schema 的 @default 上（25/5/15/4/true），
 * 这样默认值的唯一来源是数据库定义，改默认配置时不用同步改这里。
 *
 * @returns 该用户的 Setting；行不存在时立即以 schema 默认值创建一行
 * @throws 数据库错误直接上抛，不吞异常（避免把连接失败伪装成一份默认配置）
 */
export async function getSettings(userId: string): Promise<Setting> {
  return prisma.setting.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

/**
 * 局部更新计时偏好：只写输入中出现过的字段，未出现的保持原值。
 *
 * 用 upsert 而非 update：允许用户在还没 GET 过的情况下直接 PUT（前端首屏可能
 * 并发发起 GET 与 PUT）。create 分支必须同时带 userId 与 data —— Setting 的
 * 主键就是 userId，建行时主键与待写字段缺一不可。
 *
 * @param input 已由 parseUpdateSettingsInput 校验过的字段子集
 * @returns 更新（或首次创建）后的完整 Setting
 */
export async function updateSettings(
  userId: string,
  input: UpdateSettingsInput,
): Promise<Setting> {
  const data: Record<string, unknown> = {};
  if (input.focusMin !== undefined) data.focusMin = input.focusMin;
  if (input.shortBreakMin !== undefined) data.shortBreakMin = input.shortBreakMin;
  if (input.longBreakMin !== undefined) data.longBreakMin = input.longBreakMin;
  if (input.longBreakEvery !== undefined) data.longBreakEvery = input.longBreakEvery;
  if (input.autoStartNext !== undefined) data.autoStartNext = input.autoStartNext;

  // upsert 而非 update：允许用户在还没 GET 过的情况下直接 PUT
  return prisma.setting.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

/**
 * 解析并校验偏好入参。
 * 范围上限刻意放宽（专注最长 180 分钟），但拦住 0 和负数这类明显错误 ——
 * 时长为 0 会让计时器一启动就结束。
 *
 * 每个字段都可选：未出现的返回 undefined，updateSettings 据此只覆盖真正传了的
 * 字段，于是「只改 autoStartNext」的请求不会顺手重置时长。
 *
 * @throws AppError(400) 任一字段存在但类型/范围不合法
 */
export function parseUpdateSettingsInput(body: unknown): UpdateSettingsInput {
  return {
    focusMin: optionalIntInRange(body, 'focusMin', 1, 180),
    shortBreakMin: optionalIntInRange(body, 'shortBreakMin', 1, 60),
    longBreakMin: optionalIntInRange(body, 'longBreakMin', 1, 60),
    longBreakEvery: optionalIntInRange(body, 'longBreakEvery', 1, 12),
    autoStartNext: optionalBoolean(body, 'autoStartNext'),
  };
}
