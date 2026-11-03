// 让 requireAuth 中间件挂到 req 上的 userId 有类型。
//
// 这是声明合并（declaration merging）：Express 的 Request 接口在 @types/express
// 里被声明为可扩展的，这里同名再声明一次即把 userId 追加进去，源代码里
// req.userId 才有类型。它是纯类型文件，编译后不产出任何运行时代码。
//
// 末尾的 `export {}` 不能删：只有让本文件成为模块（含 import/export），
// 顶层的 `declare global` 才会把声明注入全局而非困在文件作用域内。
declare global {
  namespace Express {
    interface Request {
      /** 由 requireAuth 中间件注入；在它执行之前的处理器里为 undefined */
      userId?: string;
    }
  }
}
export {};
