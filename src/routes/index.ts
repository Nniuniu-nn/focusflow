/**
 * API 根路由：把各资源的子路由拼装到 /api 前缀下，并在这里划定公开与受保护的分界线。
 *
 * 边界：本文件只做挂载与顺序编排，不含业务逻辑、参数校验与响应构造 ——
 * 那些分别属于同目录的资源路由与 services/*.ts。
 *
 * 挂载顺序本身就是安全边界。Express 的 app.use 按注册顺序匹配、命中即执行，
 * 所以某个路由落在 requireAuth 之前还是之后，直接决定它是否需要登录。
 */
import express from 'express';
import { ok } from '../lib/response.js';
import { requireAuth } from '../middleware/require-auth.js';
import { protectedAuthRouter, publicAuthRouter } from './auth.js';
import { tasksRouter } from './tasks.js';
import { sessionsRouter } from './sessions.js';
import { settingsRouter } from './settings.js';
import { statsRouter } from './stats.js';

/** 所有 API 子路由的挂载点，在 app.ts 里挂到 /api 前缀下 */
export const apiRouter = express.Router();

/**
 * 存活检查，不需要身份。
 * 只读进程状态、不碰数据库：探活接口一旦依赖数据库，数据库抖动就会被
 * 编排系统误判成进程已死并反复重启，把小故障放大成雪崩。
 */
apiRouter.get('/health', (_req, res) => {
  ok(res, { uptime: Math.round(process.uptime()), time: new Date().toISOString() });
});

// 注册 / 登录 / 退出必须放在 requireAuth 之前 —— 尤其是退出，
// 令牌已失效时用户仍要能清掉浏览器里的坏 Cookie。
// 如果 logout 落在 requireAuth 之后，那个坏 Cookie 会同时挡住「退出登录」
// 这个唯一的自救动作，用户只能去手动清浏览器存储。
apiRouter.use('/auth', publicAuthRouter);

// 这一行以下的所有 /api 路由都需要登录。
// requireAuth 挂在整个 apiRouter 上，后面每个业务路由无需各自再校验身份 ——
// 反过来说，任何加在它之前的路由都是匿名可访问的，新增路由时必须想清楚放哪。
apiRouter.use(requireAuth);

apiRouter.use('/auth', protectedAuthRouter);
apiRouter.use('/tasks', tasksRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/stats', statsRouter);
