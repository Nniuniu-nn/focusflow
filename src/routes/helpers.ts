/**
 * 路由层的公共读取助手：把 query / params 里的原始值转成已校验的、可直接
 * 交给 service 的形状。
 *
 * 边界：只做「读取 + 形状校验」，不含业务规则，也不碰数据库。校验失败一律抛
 * AppError(400)，交给 middleware/error.ts 统一出信封 —— 这里不写 res。
 *
 * 这三个函数被 tasks / sessions / stats 共用，把「查询参数长什么样」这个
 * 决定收敛在一处，避免同名的 tz、date 在不同路由里出现不同解析口径。
 */
import type { Request } from 'express';
import { AppError } from '../lib/http-error.js';
import { isValidDateOnly, todayKey } from '../lib/date.js';

/**
 * 读取时区偏移。约定为「UTC 以东的分钟数」：东八区传 480。
 * 前端计算方式：-new Date().getTimezoneOffset()
 *
 * 为什么由客户端显式传，而不是用服务端本地时区：服务器可能部署在 UTC，
 * 用户却分布在各地，而「这条记录算哪一天」必须是用户视角下的那天。
 * 缺省按 0（UTC）处理，方便只想要原始时间戳、不关心按日分桶的调用方省略它。
 *
 * 边界：范围取真实存在的 UTC-12:00 ~ UTC+14:00（即 -720 ~ 840），超出即 400。
 * 在入口挡掉明显畸形的偏移，好过让它在后续分桶里算出静默离谱的结果。
 */
export function readTzOffset(req: Request): number {
  const raw = req.query.tz;
  if (raw === undefined || raw === '') return 0;

  const value = Number(raw);
  // 真实存在的偏移范围是 UTC-12:00 ~ UTC+14:00
  if (!Number.isInteger(value) || value < -720 || value > 840) {
    throw new AppError(400, '查询参数 tz 必须是 -720–840 之间的整数（UTC 以东的分钟数）');
  }
  return value;
}

/**
 * 读取日期参数；缺省为给定时区下的「今天」。
 *
 * 「今天」必须用传入的 tz 算（todayKey(tz)），不能用服务端本地时间 ——
 * 否则东八区用户在部署于 UTC 的服务器上深夜访问，会看到前一天的任务。
 *
 * 校验用 isValidDateOnly 而非简单正则：它会拒绝 2026-02-30 这种格式正确、
 * 日历上却不存在的日期，防止它被 parseDateOnly 悄悄滚到下个月。
 */
export function readDateQuery(req: Request, tzOffsetMinutes: number): string {
  const raw = req.query.date;
  if (raw === undefined || raw === '') {
    return todayKey(tzOffsetMinutes);
  }
  if (!isValidDateOnly(raw)) {
    throw new AppError(400, '查询参数 date 必须是合法的 YYYY-MM-DD');
  }
  return raw;
}

/**
 * 读取路径参数里的 id。
 *
 * 默认取名为 id，tasks / sessions 直接用默认值；第二个参数是为了将来出现
 * 嵌套资源（如 /tasks/:taskId/sessions/:id）时能明确取哪一个。
 *
 * 只保证「存在且非空」，不校验 UUID 形状：id 不是 UUID 时查库自然查不到，
 * 由服务层返回 404。硬造一个 400 反而会泄露「这个格式不像 id」这种无关信息。
 */
export function readIdParam(req: Request, name = 'id'): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value === '') {
    throw new AppError(400, `缺少路径参数 ${name}`);
  }
  return value;
}
