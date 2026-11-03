/**
 * 环境变量的唯一读取入口。
 *
 * 为什么集中在一处：process.env 的取值是 string | undefined，散落各处会到处冒出
 * 判空和默认值。这里在模块加载时一次性读完并校验，之后全项目只 import 这个对象，
 * 拿到的就是确定的类型与取值。
 *
 * 「启动即失败」原则：缺失或过短的必要配置直接 throw、让进程起不来。若带着
 * undefined 或弱密钥继续跑，问题会潜伏到第一次签名或连数据库时才爆发，排查成本高得多。
 */

// 副作用导入：把 .env 载入 process.env。必须排在读 env 的代码之前 ——
// ESM 按书写顺序求值，下面的 required(...) 才读得到 .env 里的值。
import 'dotenv/config';

/**
 * 读取必填环境变量，缺失时立刻失败而不是带着 undefined 跑下去。
 * @param name 变量名，仅用于报错文案。
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请参考 .env.example 检查 .env`);
  }
  return value;
}

/**
 * 读取必填的密钥，并校验最小长度。
 *
 * required() 只检查「非空」，一个字符 'x' 也能通过 —— 对签名密钥来说，
 * 那和没有密钥是等价的（可被暴力穷举）。所以这里额外卡长度。
 * 同样地：**绝不给 JWT_SECRET 设默认值**，缺失就让进程起不来。
 */
function requiredSecret(name: string, minLength: number): string {
  const value = required(name);
  if (value.length < minLength) {
    throw new Error(
      `环境变量 ${name} 太短：至少要 ${minLength} 个字符（当前 ${value.length}）。` +
        '可以用 `openssl rand -base64 32` 生成一个。',
    );
  }
  return value;
}

/**
 * 启动时快照的环境配置。as const 让各项取值留成字面量类型。
 *
 * 快照语义：模块加载后即使有人改 process.env 也不会反映到这里。配置在进程生命周期内
 * 应恒定，运行中变更只会让行为不可预测。
 *
 * port 的 Number() 未另做合法性校验：PORT 非数字会得到 NaN，属于配置错误，
 * 会在 app.listen 时暴露，这里不再多加一层。
 */
export const env = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: requiredSecret('JWT_SECRET', 32),
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const;

/** 是否开发环境。被 prisma 的日志级别、cookie 的 secure 等消费。 */
export const isDev = env.nodeEnv === 'development';
