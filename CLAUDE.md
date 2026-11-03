# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

**FocusFlow** —— 番茄钟 + 时间块管理。核心主张是把「今天要做什么」变成「今天几点做什么」，并用真实专注数据回顾。三个页面：

| 路径 | 页面 | 内容 |
|---|---|---|
| `/` | 今日看板 | 左列任务清单（按日期归属），右列大号计时器 + 今日汇总 + 今日时间轴 |
| `/stats` | 统计 | 近 7/30/90 天专注柱状图、星期×小时热力图、任务完成率 |
| `/settings` | 计时偏好 | 专注/短休/长休时长、长休间隔、是否自动开始下一段 |

另有 `/login` 一个账号页（登录/注册同页切换，不属于主导航）。

**账号制**：用户名 + 密码注册登录，会话是放在 httpOnly Cookie 里的 JWT。定位仍是单人本地工具，账号的作用是区分数据而不是做多租户，因此**没有**邮箱验证、密码重置、改密码、多设备管理、防暴力破解（见 README「已知局限」）。

## 常用命令

```bash
npm run dev              # tsx watch src/server.ts，热重载开发服务
npm run build            # tsc -p tsconfig.json → dist/
npm start                # 跑构建产物（node dist/server.js）
npm run typecheck        # tsc --noEmit，CI 里应当跑这个

npm test                 # 全部测试（单测 + 集成测），集成测需要 focusflow_test 库
npm run test:unit        # 只跑单测，不需要 MySQL —— 日常改动的第一道关
npm run test:watch       # watch 模式
npm run test:integration # 先对 .env.test 指向的库 migrate deploy，再跑集成测

npx vitest run tests/unit/timer-core.test.ts   # 跑单个测试文件
npx vitest run -t "长休息"                      # 按用例名过滤

npm run prisma:migrate   # prisma migrate dev，改完 schema 后执行
npm run prisma:generate  # 重新生成 Prisma Client
npm run db:seed          # 灌近 30 天示例数据给 demo 账号（不存在就建，密码 demo1234）
npm run db:seed -- <用户名>   # 灌给指定的已注册账号
```

`db:seed` 接受一个用户名参数。**账号已存在时不会覆盖它的密码** —— 否则一次 seed 就把你自己的密码冲掉了。

排查统计页/图表问题时，先灌一份数据比手工点几十次快得多：

```bash
npm run db:seed -- 你的用户名    # 先在页面上注册好账号，再跑这条
```

**首次运行的数据库准备**（`.env` 需自己填 MySQL 密码）：

```bash
mysql -u root -p -e "CREATE DATABASE focusflow CHARACTER SET utf8mb4;
                     CREATE DATABASE focusflow_test CHARACTER SET utf8mb4;"
npx prisma migrate dev --name init
```

**`JWT_SECRET` 是必需项，没有默认值**，缺失或短于 32 字符时进程直接启动失败（`src/env.ts` 的 `requiredSecret`）。三个文件里都要有：`.env`、`.env.test`、`.env.example`。生成方式：`openssl rand -base64 32`。

> 只加 `.env` 会**假通过**：`src/env.ts` 是 `import 'dotenv/config'`，它只加载 `.env` 且不覆盖已有变量；而 `test:integration` 用 dotenv-cli 先注入 `.env.test`。结果是本机测试碰巧能跑，换到只有 `.env.test` 的环境就启动即崩。

`.env.test` 是集成测试专用，结构与 `.env` 相同但库名换成 `focusflow_test`。两个文件都在 `.gitignore` 里。

**重置开发库**（会清空所有数据，需要用户明确同意）：

```bash
npx prisma migrate reset --force
npm run db:seed
```

`prisma migrate reset` 是非交互的、不可逆的破坏性操作，Prisma 内置的保护会要求显式同意。**必须先把「哪些数据会被销毁」告诉用户并拿到同意**，再执行。

> **改 schema 时不要直接对非空库跑 `migrate dev`**：给非空表加无默认值的 NOT NULL 列会触发交互式确认，而这里是非交互环境，会直接失败（"non-interactive environment not supported"）。可行路径是先 `migrate reset` 清库，或者用 `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` 生成 SQL，手工放进新的迁移目录，再 `migrate deploy`。

## 架构

```
浏览器 (public/*.html + 原生 ES Module，无打包器)
   │  fetch + credentials:'same-origin'（会话在 httpOnly Cookie 里，JS 读不到）
   ▼
Express 5 (src/app.ts → src/routes/*.ts)
   │  公开区：/health、/auth 的 register|login|logout
   │  requireAuth 中间件验签 + 查库确认用户仍在；统一信封 ok()/fail()
   ▼
业务层 (src/services/*.ts)  ← 统计聚合是纯函数，可直接单测
   ▼
Prisma Client → MySQL
```

- **`src/app.ts` 只构建并导出 app，`src/server.ts` 只负责 `app.listen`。** 这个拆分是为了让集成测试能 `import app` 后自己在随机端口上 `listen(0)`，不必真的占用 3000 端口。
- **API 路由必须挂在静态中间件之前**，否则 `/api/*` 会先被 `express.static` 接走。
- 静态资源用 `express.static(..., { extensions: ['html'] })`，所以 `/stats` 直接命中 `public/stats.html`，不需要额外路由。
- **统一响应信封**：所有接口返回 `{ message, status: 'ok' | 'error', code, data }`。成功用 `ok(res, data, message)`，失败抛 `AppError(status, message)` 交给 `middleware/error.ts`。这是从 `in-action` 系列其他示例延续下来的约定。
- **身份解析**：`requireAuth`（`src/middleware/require-auth.ts`）读 `ff_token` Cookie → `verifyToken` 验签 → **再 `findUserById(sub)` 确认用户仍存在** → 挂 `req.userId`。
- **`requireUserId(req)` 是全项目唯一的身份接缝**：14 个业务路由调用点全都写成 `const userId = requireUserId(req)`，没有任何一处直接读 `req.userId`。所以换身份机制时业务路由一行都不用改 —— 这是刻意保住的边界，改鉴权时请维持它。
- **数据隔离**：所有查询都必须带 `userId` 条件。改/删用 `updateMany` / `deleteMany` 而不是 `update` / `delete`，这样 userId 不匹配时自然影响 0 行。外键只保证"这条记录存在"，**不保证它属于你**——把 Session 绑到别人的 Task 上，靠的是 `prisma.task.count({ where: { id, userId } })` 这样的显式校验。

## 硬性不变量（改鉴权前必读）

**1. 绝不能把 `passwordHash` 返回给客户端。**

`serialize.ts` 里 `serializeUser` 用手写白名单返回 `{ id, username, createdAt }`。**不要照抄隔壁 `serializeTask` / `serializeSession` 的 `...model` 全展开风格** —— 那样会把哈希直接吐出去。

**2. `JWT_SECRET` 没有默认值，缺失就让进程启动失败。**

`src/env.ts` 的 `requiredSecret(name, minLength)` 同时卡「非空」和「至少 32 字符」。写 `env.jwtSecret ?? 'dev-secret'` 这类兜底是把整个鉴权降级成摆设。

**3. 用户名必须在应用层归一化后再落库。**

`normalize('NFKC').trim().toLowerCase()` 之后用 `/^[a-z0-9_]{3,32}$/` 校验（`validate.ts` 的 `requireUsername`）。**不要依赖 MySQL 的 `utf8mb4_unicode_ci` 来实现大小写不敏感** —— 那是隐式的、不可移植的，还顺带把重音不敏感带了进来。唯一索引只作最后兜底。`prisma/seed.ts` 必须用同一套规则，否则会出现「脚本说建好了，但页面就是登不上」。

**4. `requireAuth` 必须补一次主键查询确认用户仍在，不能只验签。**

只验签的话，「用户已删除但令牌未过期」时业务层会拿一个不存在的 `userId` 去写库，撞外键 → `errorHandler` 把 P2003 兜成 **400「关联的记录不存在」而不是 401**。`tests/integration/auth.test.ts` 里有一条专门守这个的用例。

**5. 密码不做 trim。**

`requirePassword` 刻意**不用** `requireString` —— 后者内部 `.trim()`，会把用户设的 `"  pass  "` 静默改成 `"pass"`，登录时按原样输入空格就对不上，且用户毫无感知。密码取原始字符串，只校验长度（8–72）。

**6. 登录失败的两种原因必须返回逐字节相同的响应。**

「用户名不存在」和「密码错误」都是 `AppError(401, '用户名或密码不正确')`，且查不到用户时**仍要跑一次 `verifyPassword(password, await getDummyHash())`** 抹平时间差。任何一处不同，这个接口就成了用户名枚举器。

**7. `res.cookie` 的 `maxAge` 单位是毫秒。**

传字符串（如 `'7d'`）会被静默忽略（Express 内部做 `opts.maxAge - 0`，`NaN` 导致整个分支被跳过），退化成「关掉浏览器就丢」的会话 cookie，而且**没有任何报错**。`tests/integration/auth.test.ts` 断言了 `Max-Age=604800` 来守住它。`clearAuthCookie` 的 `path` 也必须与写入时一致，否则清不掉。

**8. 前端 401 必须分流，且要跨请求去重。**

- `/auth/login`、`/auth/register` 的 401 是**正常的业务结果**，原样抛给表单，**绝不跳转** —— 否则密码错误的提示会被刷新瞬间清空。判定用的是显式路径集合 `FORM_AUTH_PATHS`，**不能简单写成「凡是 `/auth/` 开头的都放行」**，因为 `/auth/me` 的 401 正是最该跳转的情况。
- 其余接口的 401 → 抛 `AuthError` + 跳 `/login`。模块级 `redirecting` 标志去重：看板一次 `Promise.all` 发三个请求会同时 401，没有这个标志会触发三次跳转。
- `ui.js` 的 `reportError` 对 `AuthError` 静默（页面正在跳转，闪一条 toast 反而像出了别的错）。

**9. 切换账号必须清空按用户隔离的本地状态。**

`focusflow.timer` / `.outbox` / `.tasks` 是**全局 key，没有按用户加前缀**。不清的话：A 未提交的专注记录留在 outbox 里，B 登录后被 `flushOutbox()` 提交到 B 名下；A 正在跑的计时器会被 B 继承。由 `util.js` 的 `clearUserScopedStorage()` 负责，登录（`auth.js`）、导航栏初始化（`nav.js`）、登出三处都调用。

**登出时顺序不能反**：先 `await timer.flushOutbox()`，再清 localStorage。反了的话，刚跑完还没提交的那个番茄会随 `removeItem` 一起消失。若冲刷后仍有未提交项，要 `confirm` 提示用户「有 N 条记录未同步，仍要退出？」。

## 硬性不变量（改计时器前必读）

**1. 所有计时必须由 `Date.now()` 时间戳差值算出，`setInterval` 只用于重绘。**

这是验收标准，不是风格偏好。`public/js/timer.js` 里 `setInterval(tick, 250)` 的回调**只做一件事**：调 `render()`。`render()` 内部每次都用

```js
elapsed   = accumulatedMs + (startedAt === null ? 0 : now - startedAt)
remaining = Math.max(0, durationMs - elapsed)
```

重新算一遍。**定时器回调绝不允许累加任何变量**（写 `elapsed += 250` 这类代码是错的）。因为浏览器会把后台标签页的 interval 节流到 1s 甚至完全暂停，累加式计时必然变慢；而按时间戳重算，切回前台的下一次 tick 就直接得到正确结果。

**2. 纯逻辑与副作用必须分离。**

- `public/js/timer-core.js` —— 纯状态机，**不引用任何 DOM / localStorage / Notification**，且每个函数都把 `now` 作为参数传入（绝不内部调 `Date.now()`）。这样测试能传受控时钟，不需要假定时器。
- `public/js/timer.js` —— 不纯的外壳，负责 DOM、localStorage、通知、`document.title`、outbox 冲刷。
- `public/js/charts.js` —— 纯 ECharts option 构造器，不调 `echarts.init()`。
- `src/lib/stats.ts` —— 纯聚合函数，不碰数据库。

**改动这几个文件时必须保持纯净**：一旦在 `timer-core.js` 里写了 `document.querySelector`，对应的 32 个单测就全部跑不动了（测试环境是 `environment: 'node'`，刻意不装 jsdom）。

**3. 计时器状态在刷新后必须完整恢复。**

状态存在 localStorage 的 `focusflow.timer`（键名集中在 `public/js/util.js` 的 `STORAGE_KEYS`，别在别处写魔法字符串）。页面加载时用 `reconcileOnLoad(state, settings, now)` 处理"关机几小时后回来"的情况：如果本段早已超时，**只补记一段**（`honestEnd = segmentStartAt + durationMs`，而不是用回来那一刻的墙钟时间），然后停在下一段的暂停态，**不管 `autoStartNext` 设成什么**。不允许因为离开 3 小时就合成出 7 个幽灵番茄。

**4. Session 写入必须幂等。**

客户端在某段开始时生成 `segmentId`（`crypto.randomUUID()`）并持久化，段结束时用它作 `clientId` POST。服务端 `Session` 上有 `@@unique([userId, clientId])`，撞 `P2002` 时视为成功、返回既有记录、**不重复加 `completedPomodoros`**。写 Session 与 `completedPomodoros + 1` 在同一个 `prisma.$transaction` 里；只有 `type === 'focus' && completed && taskId !== null` 时才加一。

客户端还有一层 localStorage outbox：提交失败的记录留在本地，`flushOutbox()` 只重试失败项，成功时派发 `focusflow:session-recorded` 事件让看板刷新。两层加起来，段结束瞬间刷新页面也不会重复记账。

## 数据模型要点

`prisma/schema.prisma`，几处刻意的取舍：

- **`Task.order` + `@map("sort_order")`**：产品需求里这个字段就叫 `order`，所以 Prisma 字段名保留 `order`，但 `order` 是 SQL 保留字，直接用作列名会处处需要反引号，于是物理列名映射成 `sort_order`。**代码里写 `task.order`，数据库里是 `sort_order`。**
- **`Task.date` 是 `@db.Date`**：按日归属只需要日期精度。传进来的是 `YYYY-MM-DD` 字符串，用 `parseDateOnly` 按 UTC 午夜解析，避免时区把任务挪到隔壁那天。
- **`Session` 有独立的 uuid 主键 `id`，另有 `clientId` 作为客户端生成的幂等键**，两者不是一回事。唯一约束是复合的 `@@unique([userId, clientId])` 而不是 `clientId` 单独唯一——否则不同用户之间 UUID 撞车会互相串数据。
- **`User.id` 由服务端 `@default(uuid())` 生成**，不再由客户端自报。`username` 有唯一索引，`passwordHash` 存自描述格式 `scrypt$N$r$p$<salt-b64>$<hash-b64>`（约 135 字符，`VarChar(255)` 够用）。参数跟着哈希一起存，将来调参后旧哈希仍能验证。
- **`Setting` 的主键就是 `userId`**，与 User 一对一。建用户时用嵌套写 `setting: { create: {} }` 一次性带出默认设置。
- 枚举 `TaskStatus { todo doing done }`、`SessionType { focus short_break long_break }`。

### 时区约定

`tzOffsetMinutes` 统一表示**「UTC 以东的分钟数」**，东八区传 `480`。前端这样算：`const tzOffsetMinutes = -new Date().getTimezoneOffset();`。

按日/按小时分桶全部在 `src/lib/stats.ts` 的纯函数里做，用显式传入的 `tzOffsetMinutes`，**不用 SQL 聚合**。原因有两个：Prisma 的 `groupBy` 没法按 `DATE(startAt)` 这样的表达式分组，硬写 raw SQL 会丢掉类型安全；而且纯函数能被 Vitest 直接测，跨本地午夜的归属边界（`2026-10-04T16:30Z` 在东八区属于 10-05）才有自动化保障。

## 技术栈与 `in-action` 系列其他示例的差异

本系列（`part01`、`part02`）的其他示例全部是**纯 JavaScript + CommonJS + Express + 内存数组**，没有数据库、没有 TS、没有构建步骤、测试用 `node --test`。

**本仓库是有意偏离**，按需求引入了 TypeScript、Prisma、MySQL、Vitest。但保留了系列的组织约定：中文注释与文档、统一响应信封、`app`/`server` 拆分、按资源划分的 `express.Router()`、`.claude/settings.local.json` 白名单。**不要把其他示例的写法搬过来**（例如不要在 `package.json` 里去掉 `"type": "module"`）。

### 两个容易踩的坑

- **`module: NodeNext` + ESM 要求源码里所有相对导入都写 `.js` 后缀**（`import { ok } from './lib/response.js'`），即使源文件是 `.ts`。这是标准行为，不是配置错误。Vitest 和 tsx 都能正确解析。
- **Express 是 CJS 包，必须用默认导入**：`import express from 'express'`，类型用 `import type { Request, Response } from 'express'`。写 `import * as express` 会得到不可调用的命名空间对象，运行时报 `express is not a function`。

- **Prisma 固定 6.19.3，不要升级。** 两个原因：`prisma@latest` 目前解析到 8.x 的 RC 版本，而 Prisma 7 起 schema 里不再允许 `datasource.url`（会报 `P1012`，要求改用 `prisma.config.ts` + driver adapter）。本项目按需求把连接串放在 `.env`，所以精确锁定 6.19.3（不带 `^`），`prisma` 与 `@prisma/client` 必须同版本。

## 测试组织

单测与集成测都在 Node 环境跑（`environment: 'node'`，刻意不装 jsdom），`fileParallelism: false` 让集成测串行以免互相踩数据。

- `tests/unit/timer-core.test.ts` —— 32 个用例，本项目的测试重心。计时数学、跨段转移、`longBreakEvery` 边界、`autoStartNext` 两个分支、超时恢复不补记。
- `tests/unit/stats.test.ts` —— 20 个用例，含跨本地午夜和 UTC-5 与 UTC+8 的归属差异。
- `tests/unit/charts.test.ts` —— 15 个用例，重点不是"长什么样"而是"空数据/全零/脏数据下不产出 NaN 或非法坐标"。
- `tests/unit/password.test.ts` —— 13 个用例，scrypt 哈希：salt 生效、不 trim 密码、损坏哈希返回 `false` 而不是抛异常、**手改库塞进超大 `N` 时拒绝解析**（不能拿它打爆内存）。
- `tests/integration/timer-flow.test.ts` —— **把纯计时核心产出的 commit 直接喂给真实 API**，验证「专注段结束 → 写 Session → 番茄数 +1」这条闭环，以及重发不重复计数。两边各自的单测都通过，不代表接起来也对，所以需要这一层。
- `tests/integration/auth.test.ts` —— 25 个用例，账号体系。**全部用 `raw()` 手写请求**，因为要断言 `Set-Cookie`、控制错误的用户名和密码、伪造令牌，这些都不是「以某个正常账号的身份发请求」能表达的。其中几条是守不变量的：cookie 的 `Max-Age` 没退化成会话 cookie、两种登录失败响应逐字节相同、**用同一密钥签的过期令牌被拒**、**令牌合法但用户已删除返回 401 而不是 400**。
- `tests/helpers/server.ts` —— 集成测试基座，`app.listen(0)` 起随机端口 + 全局 `fetch`，不引入 supertest。
  - **懒登录**：`api(path, { as: '用户名' })` 会在首次用到时自动走真实的 `POST /auth/register` 拿 cookie，缓存起来复用。这样 92 个调用点只有约 15 处需要手改，而链路真实性一点没省（真的 register、真的 `Set-Cookie`、真的验签、真的查库）。
  - **`ensureSession` 内部必须用底层 `fetch`**，不能回头调 `api()` —— 会死循环。
  - 读 `Set-Cookie` 用 `response.headers.getSetCookie()`（返回数组）。**不要用 `get('set-cookie')`** —— 有多个 cookie 时会被合并成一条，解析容易丢东西。
  - `newTestUser()` 生成的是**用户名**（`u_` + 24 位十六进制），不是 id；`newClientId()` 才是给 `clientId` 用的。这两个以前混用过，改的时候注意语义。
  - `cleanupUsers()` 在 `afterAll` 里扫 `u_` 前缀删除。集成测试进程被杀时 `afterAll` 不会执行，所以这个扫描同时也是在清上次跑崩留下的残留。

`npm run test:unit` 不需要数据库，是改前端纯逻辑时最快的反馈回路。
