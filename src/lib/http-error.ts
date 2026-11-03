/**
 * 业务错误：路由/服务层抛出它，由 errorHandler 统一转成错误信封。
 * Express 5 会自动转发 async 处理器抛出的异常，所以不需要 try/catch 包装器。
 *
 * 这个类刻意不 import 任何 Express 类型：services/ 与纯函数层也用它表达
 * 「这是个 400」，「怎么把它变成 HTTP 响应」是 middleware 的事。这样业务层
 * 不必拖上一个 Web 框架的类型依赖，也就更容易单测。
 *
 * 不用普通的 `throw new Error(...)`:普通 Error 没有状态码，errorHandler 只能
 * 一律按 500 处理，把「用户名已被占用」这种正常的 4xx 也报成服务端故障。
 */
export class AppError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    // 显式设 name：子类化内建 Error 时，某些打包/转译产物里 name 会退回 'Error'，
    // errorHandler 与日志正是靠它区分 AppError 与意外异常。
    this.name = 'AppError';
    // readonly：状态码在构造时定死，防止中间件或 catch 块在传递途中误改。
    this.status = status;
  }
}
