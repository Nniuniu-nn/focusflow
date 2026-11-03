import { PrismaClient } from '@prisma/client';
import { isDev } from './env.js';

/**
 * 全局唯一的 PrismaClient 实例。
 * 每次 new PrismaClient() 都会新建一个连接池，所以这里必须是单例。
 *
 * ESM 模块在一个进程内只求值一次，模块级的 const 天然就是进程内单例。`npm run dev`
 * 用的是 tsx watch，改动时重启整个进程、旧实例随进程一起销毁，因此这里**不需要**
 * 「把实例挂到 globalThis 上防热重载重复实例化」那套 —— 那是 Next.js 这类在同一进程内
 * 热替换模块的框架才需要的。
 *
 * 若将来把开发工具换成进程内热更的，就得补上 globalThis 缓存，否则每次热更都会多出
 * 一个连接池，很快耗尽 MySQL 的连接数。
 *
 * PrismaClient 惰性连接：这里只是创建对象，真正的连接在第一次查询时才建立，
 * 所以无需显式 $connect()。
 *
 * 日志级别按环境分：开发记 warn/error 便于发现连接与慢查询问题，生产只记 error，
 * 免得高频查询日志淹没真正的错误、也省 IO。
 */
export const prisma = new PrismaClient({
  log: isDev ? ['warn', 'error'] : ['error'],
});
