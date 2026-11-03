/**
 * 请求输入校验层：把来自 body / query 的 unknown 收窄成可信类型。
 *
 * 位置：路由处理器的第一道关，夹在 HTTP 边界与业务层之间。本层只做形状与范围
 * 校验，不碰数据库、不写业务规则 —— 「用户名是否已被占用」那类属于服务层。
 *
 * 设计取向：校验失败**直接抛 AppError(400)**，而不是返回 null / Result。
 * 好处有二：失败路径无需在每层手动传递返回值；Express 5 会把 async 处理器抛出
 * 的异常自动交给 errorHandler，于是路由代码能保持一条直线、不用 try/catch。
 * 因此函数返回值的语义是「已校验通过的值」，拿到就能直接用，无需再判空。
 *
 * 刻意不引入 zod 之类的 schema 库：字段不多、规则稳定，手写换来零依赖和更贴合的
 * 中文报错。代价是规则散落在各函数里，前端新增字段时要记得同步这里。
 */

import { AppError } from './http-error.js';

/** 匿名用户 id 的形状：crypto.randomUUID() 产出的 UUID v4 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 判断是否为形如 UUID 的字符串。
 * 只校验形状、不卡版本位：来源是客户端 localStorage，能接住各种 UUID v4 写法
 * 比锁死生成算法更重要。合法形状才能进入后续 upsert，非法形状在中间件里直接 400。
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * 取一个必填字符串字段（去空白后非空）。
 *
 * 长度按**去除首尾空白之后**的字符串计；返回的是裁剪后的值，调用方应持久化返回值
 * 而非原始输入。默认 maxLength 200 只是通用兜底，长文本字段请显式传更大的值。
 */
export function requireString(body: unknown, field: string, maxLength = 200): string {
  const record = asRecord(body);
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, `${field} 必填，且不能为空白`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new AppError(400, `${field} 长度不能超过 ${maxLength} 个字符`);
  }
  return trimmed;
}

/** 用户名规则：3–32 位小写字母、数字、下划线 */
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

/** 密码长度区间（下限是强度考虑，上限是防止超长输入白烧 CPU） */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

/**
 * 取并归一化用户名。
 *
 * NFKC 归一化 + 去空白 + 转小写之后才校验，这样落库的永远是同一种形态：
 * 全角「ａｂｃ」会先变成「abc」，「Alice」和「alice」是同一个账号。
 *
 * 为什么不靠 MySQL 的 *_ci 排序规则来做大小写不敏感 —— 那既是隐式的
 * （换个排序规则行为就变），也顺带把重音不敏感带了进来。唯一索引只作兜底。
 *
 * 返回的是归一化后的形态，落库与查重都必须用它；若用原始入参，全角或大小写
 * 变体就会绕过唯一约束。
 */
export function requireUsername(body: unknown, field = 'username'): string {
  const record = asRecord(body);
  const value = record[field];
  if (typeof value !== 'string') {
    throw new AppError(400, '用户名必填');
  }

  const normalized = value.normalize('NFKC').trim().toLowerCase();

  if (!USERNAME_RE.test(normalized)) {
    throw new AppError(400, '用户名只能是 3–32 位小写字母、数字或下划线');
  }
  return normalized;
}

/**
 * 取密码。**刻意不走 requireString** —— 它内部会 `.trim()`，
 * 用户设的 "  pass  " 会被静默改成 "pass"，之后按原样输入反而登不上，
 * 而且用户完全不知道发生了什么。密码取原始字符串，只校验长度。
 *
 * 长度按 JS 字符串的 UTF-16 码元计（.length），emoji 之类的代理对算 2 个 ——
 * 这是有意为之：统一按字符计，不按字节数，免得同一密码在不同编码路径下长度判定不一致。
 */
export function requirePassword(body: unknown, field = 'password'): string {
  const record = asRecord(body);
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new AppError(400, '密码必填');
  }
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(
      400,
      `密码长度必须在 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符之间`,
    );
  }
  return value;
}

/**
 * 取一个可选字符串字段，三态语义（PATCH 式更新的关键）：
 *   - 字段不存在 → undefined，表示「本次不修改」，服务层据此跳过该列；
 *   - 显式传 null → null，表示「清空该字段」；
 *   - 传字符串    → 原样返回。
 * 与 requireString 不同，这里**不 trim**：可选字段多为备注类，保留用户输入的首尾
 * 空白是合理的；若误传成数字/对象则报 400，而不是静默丢弃。
 */
export function optionalString(body: unknown, field: string, maxLength = 2000): string | null | undefined {
  const record = asRecord(body);
  if (!(field in record)) return undefined;
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError(400, `${field} 必须是字符串`);
  }
  if (value.length > maxLength) {
    throw new AppError(400, `${field} 长度不能超过 ${maxLength} 个字符`);
  }
  return value;
}

/**
 * 取一个必填整数并校验闭区间范围。
 * 只接受 number 类型 —— JSON body 里的数字是真 number，而 query 参数都是字符串，
 * 那条路径请用 parseQueryInt。Number.isInteger 同时挡下 NaN 与小数。
 */
export function requireIntInRange(
  body: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const record = asRecord(body);
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError(400, `${field} 必须是整数`);
  }
  if (value < min || value > max) {
    throw new AppError(400, `${field} 必须在 ${min}–${max} 之间`);
  }
  return value;
}

/**
 * 取一个可选整数：字段缺失或显式为 undefined 都算「不修改」，其余委托给
 * requireIntInRange —— 范围校验只维护一处，避免两个入口的规则分叉。
 */
export function optionalIntInRange(
  body: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const record = asRecord(body);
  if (!(field in record) || record[field] === undefined) return undefined;
  return requireIntInRange(body, field, min, max);
}

/**
 * 取一个可选布尔字段。
 * 只认真正的 boolean，不把 'true' / '1' 这类字符串强转成 true —— 否则前端传个
 * 拼错的字符串（如 'false ' 带空格）会静默生效，排查起来很费劲。
 */
export function optionalBoolean(body: unknown, field: string): boolean | undefined {
  const record = asRecord(body);
  if (!(field in record) || record[field] === undefined) return undefined;
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new AppError(400, `${field} 必须是布尔值`);
  }
  return value;
}

/** 取一个可选 ISO 时间字符串并转成 Date；字段缺失返回 undefined（不修改）。 */
export function optionalIsoDate(body: unknown, field: string): Date | undefined {
  const record = asRecord(body);
  if (!(field in record) || record[field] === undefined) return undefined;
  return requireIsoDate(body, field);
}

/**
 * 取一个必填 ISO 时间字符串并转成 Date。
 *
 * 用 new Date(value) 解析，能接受带时区偏移的完整 ISO 串，也会接受 "2026-10-05"
 * 这种纯日期（按 UTC 零点解释）。只挡下解析结果为 NaN 的输入。
 * 本函数不强制要求带时区后缀 —— 调用方（如 session.startAt）本就按 ISO 串约定。
 */
export function requireIsoDate(body: unknown, field: string): Date {
  const record = asRecord(body);
  const value = record[field];
  if (typeof value !== 'string') {
    throw new AppError(400, `${field} 必须是 ISO 时间字符串`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, `${field} 不是合法的时间`);
  }
  return parsed;
}

/**
 * 把 query 里的数字参数解析成整数，带默认值与闭区间校验。
 *
 * raw 是 Express 给的字符串（也可能是字符串数组）。空串与 undefined 都走默认值：
 * Number('') 会得到 0，若不加这道判断，`?days=` 会被悄悄当成 0 而非缺省值。
 * 非整数（'abc'、'1.5'）或越界一律 400 而不是静默回落，免得前端拼错参数却毫无提示。
 */
export function parseQueryInt(
  raw: unknown,
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError(400, `查询参数 ${field} 必须是 ${min}–${max} 之间的整数`);
  }
  return value;
}

/**
 * 把请求体收窄成普通对象。
 * null 与数组都要显式挡掉：数组的 typeof 也是 'object'，放行的话 record['days']
 * 会静默取到 undefined，错误被推迟到很远的地方才暴露。
 * 这是内部辅助函数，不对路由导出。
 */
function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(400, '请求体必须是一个 JSON 对象');
  }
  return body as Record<string, unknown>;
}
