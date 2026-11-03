/**
 * 进程入口：只做一件事 —— 把 app.ts 构建好的 app 绑到端口上。
 *
 * 之所以独立成文件、而不是在 app.ts 里直接 listen：集成测试需要 import app
 * 后在随机端口上自行监听，若 import 即绑定端口，测试既无法控制生命周期，
 * 也会和开发服务器抢 3000 端口。这个文件是生产/开发进程的唯一 listen 调用点。
 *
 * 端口来自 env.port（.env 的 PORT，缺省 3000），不在代码里硬编码。
 */
import app from './app.js';
import { env } from './env.js';

app.listen(env.port, () => {
  console.log(`FocusFlow 已启动：http://localhost:${env.port}`);
});
