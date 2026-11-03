import type { Response } from 'express';

/**
 * 统一响应信封（沿用 in-action 系列其他示例的约定）：
 *   成功 { message, status: 'ok',    code: 0,        data }
 *   失败 { message, status: 'error', code: <HTTP码>, data: null }
 *
 * 路由里不要手写响应体，一律走这两个函数。
 *
 * 为什么 HTTP 状态码与信封里的 status/code 要冗余两套：
 *   - HTTP 状态码是给网关、浏览器、缓存和监控看的，这些角色都不解析 JSON；
 *   - 信封是给前端业务代码看的，前端只解析一次 JSON 就能分支，不必先判断
 *     res.ok 或 2xx 再决定读哪个字段。各家 fetch 封装还常在非 2xx 时直接
 *     抛异常，导致 message 拿不到 —— 信封能让 4xx/5xx 也走同一条正常解析路径。
 *
 * 成功固定 code: 0（业务码）；错误直接复用 HTTP 状态码，省掉一张
 * 「业务码 ↔ HTTP 码」的映射表 —— 小项目里那层映射只会带来漂移风险。
 *
 * 本模块只负责「怎么包」，不负责「抛什么」：错误一律由业务层抛 AppError，
 * 经 middleware/error.ts 落到 fail()。这两个函数是所有响应的唯一出口。
 */

/**
 * 写成功信封并结束响应。
 *
 * 不显式设置 HTTP 状态码，交给 Express 默认的 200 —— 成功路径永远是 2xx，
 * 没有需要细分的情形。
 *
 * @param data    业务数据。缺省用 null 而不是省略字段，保证信封形状恒定，
 *                前端可以无条件读 data，不必再判 undefined。
 * @param message 面向用户的提示文案，前端通常直接展示。
 */
export function ok(res: Response, data: unknown = null, message = '操作成功'): void {
  res.json({ message, status: 'ok', code: 0, data });
}

/**
 * 写错误信封并结束响应。
 *
 * res.status(code) 与信封里的 code 必须同值：只写其一会得到
 * 「HTTP 200 + status:'error'」或「HTTP 404 + code:0」这类自相矛盾的响应，
 * 让网关的重试策略与前端的错误分支互相打架。
 *
 * data 恒为 null：失败时绝不夹带半截业务数据，防止调用方误把它当成功结果用。
 *
 * @param code    HTTP 状态码，同时作为信封里的错误码。
 * @param message 面向用户的错误提示，通常直接来自 AppError.message。
 */
export function fail(res: Response, code = 400, message = '请求有误'): void {
  res.status(code).json({ message, status: 'error', code, data: null });
}
