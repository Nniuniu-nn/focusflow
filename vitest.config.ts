import { defineConfig } from 'vitest/config';

/**
 * Vitest 配置。
 *
 * 这里几乎没配什么，但这几项每一项都是踩过之后的取舍。
 */
export default defineConfig({
  test: {
    // 单测与集成测都在 Node 环境跑：前端纯逻辑模块（timer-core.js / charts.js）
    // 刻意不引用 DOM，所以不需要 jsdom。
    //
    // 这不只是「省一个依赖」——它同时是一条架构约束的执行者：
    // 一旦有人在 timer-core.js 里写了 document.querySelector，那 32 个单测
    // 会立刻全部报 "document is not defined"，改动当场被挡下来。
    environment: 'node',

    include: ['tests/**/*.test.ts'],

    // 集成测试会真的连 MySQL，文件间并行容易互相踩数据（比如一个文件的
    // cleanupUsers() 扫 u_ 前缀，会把另一个文件正在用的账号删掉），串行更稳。
    fileParallelism: false,

    // 集成测试要真的建表、注册账号、跑 scrypt（单次约 30ms），
    // 默认的 5 秒对这种用例偏紧。
    testTimeout: 15000,
  },
});
