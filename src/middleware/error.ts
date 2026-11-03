/**
 * 错误处理的最后一道关口，保证「任何响应都是信封」，客户端不需要为错误分支
 * 单独解析一种响应形状。
 *
 * 两个 handler 都挂在 app.ts 的最末尾，顺序不能反：notFoundHandler 是普通中间件
 * （四参错误中间件不会拦截普通请求），必须在 errorHandler 之前把未匹配的请求
 * 兜成 404；若把它放到 errorHandler 之后，未匹配请求将永远走不到它。
 *
 * 边界：这里把各类错误「翻译」成 HTTP 语义，不记录业务上下文，也不做重试。
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/http-error.js';
import { fail } from '../lib/response.js';

/**
 * 未匹配到任何路由 / 静态资源时的兜底。
 * 消息里带上方法与原始路径，方便调用方判断是不是拼错了 URL ——
 * 这些信息本就是请求方自己发出的，回显不构成信息泄露。
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  fail(res, 404, `接口不存在：${req.method} ${req.originalUrl}`);
};

/**
 * 统一错误处理。Express 5 会自动把 async 处理器中被 reject 的 Promise
 * 转发到这里，所以路由里不需要 try/catch 包装。
 *
 * 分派顺序即优先级：显式抛出的 AppError 原样透传；Prisma 的已知错误码翻译成
 * 合理的 HTTP 语义；请求体解析失败是 400；其余一律 500 且只记日志、不把原始
 * 错误消息吐给客户端（可能含 SQL、字段名等内部信息）。
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // 已经发过响应就不要再写一次，交给 Express 默认处理。
  // 典型的触发场景是流式响应中途出错：响应头已发出，再调 res.json() 会抛
  // ERR_HTTP_HEADERS_SENT，把原始错误盖掉。
  if (res.headersSent) {
    return;
  }

  if (err instanceof AppError) {
    fail(res, err.status, err.message);
    return;
  }

  // Prisma 的已知请求错误：只翻译业务上真会遇到的三个码，其余继续往下走。
  // P2025 = update/delete 目标不存在（虽然业务层多用 updateMany/deleteMany
  // 规避它，但直连 Prisma 的调用仍可能命中）；P2002 = 唯一约束冲突；
  // P2003 = 外键约束失败 —— 兜成 400 而非 500，因为根源通常是客户端传了
  // 一个不存在或不属于自己的关联 id。
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') {
      fail(res, 404, '记录不存在');
      return;
    }
    if (err.code === 'P2002') {
      fail(res, 409, '记录已存在');
      return;
    }
    if (err.code === 'P2003') {
      fail(res, 400, '关联的记录不存在');
      return;
    }
  }

  // express.json() 解析失败。body-parser 抛的 SyntaxError 带 body 属性，
  // 用它把「JSON 解析错误」与其他 SyntaxError 区分开，否则一律 400 会误伤。
  if (err instanceof SyntaxError && 'body' in err) {
    fail(res, 400, '请求体不是合法的 JSON');
    return;
  }

  // 未识别的错误：日志里留全量信息供排查，响应里只给一句通用话术。
  console.error('[未捕获错误]', err);
  fail(res, 500, '服务器内部错误');
};
