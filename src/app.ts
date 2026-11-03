/**
 * Express 应用的构建与装配。本文件只负责「造出 app 并导出」，不调用 listen ——
 * 端口绑定是 src/server.ts 的事。
 *
 * 这个拆分是为了测试：集成测试 import 这个 default app 后自己 listen(0) 拿随机
 * 端口，既不必占用 3000，也不会和开发服务器抢端口。若这里直接 listen，
 * 引入 app 就会产生副作用，测试无法控制生命周期。
 *
 * 边界：不做任何业务逻辑，只安排中间件顺序。Express 是 CJS 包，必须用默认导入
 * （`import * as express` 会得到不可调用的命名空间对象），类型才用命名导入。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录：源码下是 src/..，构建产物下是 dist/..，两种情况都指向仓库根 */
const projectRoot = path.join(currentDir, '..');

const app = express();

// 隐去 X-Powered-By，不主动暴露后端框架版本（省去一类指纹扫描）
app.disable('x-powered-by');
// 限制请求体大小，避免超大 JSON 拖垮内存；1mb 远超本项目任何正常请求
app.use(express.json({ limit: '1mb' }));

// API 必须挂在静态资源之前，否则 /api/* 会先被静态中间件处理掉。
// express.static 对不存在的文件会 next()，看似无害，但它会先把 /api/xxx 当作
// 磁盘路径去查找，命中同名文件就绕过了整个路由与鉴权。
app.use('/api', apiRouter);

// 静态页面：extensions: ['html'] 让 /stats 直接命中 stats.html。
// 由于纯前端页面没有服务端路由，这个选项是 SPA 之外最省事的做法：
// 请求 /stats 时自动补成 stats.html，无需为每个页面写一条路由。
app.use(express.static(path.join(projectRoot, 'public'), { extensions: ['html'] }));

// 末尾顺序固定：先兜 404，再兜错误。errorHandler 作为四参中间件只处理被
// next(err) 或 reject 转发的错误，不会拦截正常请求，所以必须由 notFoundHandler
// 负责「什么都没匹配上」的情况。
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
