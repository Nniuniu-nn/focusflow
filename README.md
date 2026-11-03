# FocusFlow — 番茄钟 + 时间块管理

把「今天要做什么」变成「今天几点做什么」，并用真实专注数据回顾。

面向自由职业者、远程工作者、考研/考公党。单人本地使用，用最朴素的用户名 + 密码登录。

---

## 它解决什么问题

大多数待办清单只回答「今天要做什么」。但一天被浪费掉，往往不是因为不知道要做什么，而是因为**没有把任务放进具体的时间块里**，于是一整天都在「等会儿再说」。

FocusFlow 的做法是两条腿走路：

1. **时间块**：任务按日期归属，配上预估番茄数——你不仅知道今天要做哪几件事，还知道它们大概要吃掉几个小时。
2. **真实数据**：每完成一个专注段就落一条记录。一天结束后，看到的不是「我觉得今天挺忙」，而是「今天专注了 3 小时 45 分，完成了 9 个番茄，其中上午 10 点那段效率最高」。

---

## 三个页面

| 路径 | 页面 | 内容 |
|---|---|---|
| `/` | **今日看板** | 左列任务清单（增删改、预估 vs 实际番茄数）；右列大号计时器 + 今日汇总（专注总时长 / 完成番茄数 / 完成任务数）+ 今日时间轴 |
| `/stats` | **统计** | 近 7/30/90 天专注柱状图、星期 × 小时专注热力图、任务完成率 |
| `/settings` | **计时偏好** | 专注时长、短休/长休时长、几个番茄后进长休、是否自动开始下一段 |
| `/login` | **登录 / 注册** | 用户名 + 密码，两个表单同页切换。不属于主导航，未登录访问其他页面会自动跳到这里 |

计时器支持 **开始 / 暂停 / 跳过 / 重置**，专注段结束自动切到休息，休息结束自动切回专注。段结束时弹浏览器通知，标签页标题实时显示倒计时。

---

## 快速开始

**前置条件**：Node.js ≥ 20、本地 MySQL 8。

```bash
# 1. 安装依赖
npm install

# 2. 建库（字符集用 utf8mb4，否则中文会变问号）
mysql -u root -p -e "CREATE DATABASE focusflow CHARACTER SET utf8mb4;
                     CREATE DATABASE focusflow_test CHARACTER SET utf8mb4;"

# 3. 配置环境变量
cp .env.example .env      # 然后填入你的 MySQL 用户名和密码

# 4. 生成会话密钥（必需，没有默认值；短于 32 字符会启动失败）
#    在 .env 里填上 JWT_SECRET=<上面这条命令的输出>
openssl rand -base64 32

# 5. 建表
npx prisma migrate dev --name init

# 6. 起服务
npm run dev               # http://localhost:3000
```

打开 <http://localhost:3000>，会自动跳到 `/login`。第一次用点「注册」，注册完直接就是登录态。

集成测试也要连数据库，所以还需要 `.env.test`（结构同 `.env`，库名换成 `focusflow_test`）：

```bash
sed 's|/focusflow|/focusflow_test|' .env > .env.test
```

---

## 常用命令

```bash
npm run dev              # 开发（tsx watch，热重载）
npm run build            # 编译到 dist/
npm start                # 跑构建产物

npm run typecheck        # tsc --noEmit
npm run test:unit        # 单元测试，不需要数据库 —— 日常改动先跑这个
npm test                 # 单测 + 集成测
npm run test:integration # 集成测（会先对 focusflow_test 做 migrate deploy）

npx vitest run tests/unit/timer-core.test.ts   # 跑单个文件
npx vitest run -t "长休息"                      # 按用例名过滤

npm run prisma:migrate   # 改完 schema 后建迁移
```

### 灌一份示例数据

统计页在空库下是三个空白图表，所以提供了一个 seed：

```bash
# 先在页面上注册一个账号，再把它交给脚本 —— 最省事的用法
npm run db:seed -- 你的用户名

npm run db:seed              # 不带参数则灌给 demo 账号（不存在就建，密码 demo1234）
```

它会为最近 30 天生成约 70 条专注记录和 30 多个任务（周末少一些、有的天干脆是 0，这样柱状图才有起伏）。

账号已存在时**不会覆盖它的密码**，只往它名下灌数据——否则一次 seed 就把你自己的密码冲掉了。

---

## API

除下面标注「公开」的四个接口外，所有 `/api/*` 都要求带登录 Cookie，未登录返回 `401`。

会话是放在 **httpOnly Cookie**（`ff_token`）里的 JWT，有效期 7 天。JS 读不到这个 Cookie——所以 `document.cookie` 里看不到它，这是刻意的（XSS 拿不到令牌）。

响应统一信封：

```json
{ "message": "...", "status": "ok", "code": 200, "data": { } }
```

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 存活检查（**公开**） |
| POST | `/api/auth/register` | 注册（**公开**，成功即登录，返回 201 + `Set-Cookie`） |
| POST | `/api/auth/login` | 登录（**公开**） |
| POST | `/api/auth/logout` | 登出（**公开**且幂等，没登录也返回成功） |
| GET | `/api/auth/me` | 当前用户，导航栏用它显示用户名 |
| GET | `/api/tasks?date=YYYY-MM-DD` | 按日取任务，按 `sortOrder` 排 |
| POST | `/api/tasks` | 新建任务 |
| GET | `/api/tasks/:id` | 取单个任务 |
| PATCH | `/api/tasks/:id` | 改标题 / 备注 / 预估 / 状态 |
| DELETE | `/api/tasks/:id` | 删任务 |
| PATCH | `/api/tasks/reorder` | 批量重排（P1 拖拽排序的钩子） |
| GET | `/api/sessions?date=&tz=` | 当日时间轴 |
| POST | `/api/sessions` | 记录一段（**幂等**，见下） |
| GET | `/api/settings` | 取计时偏好 |
| PUT | `/api/settings` | 改计时偏好 |
| GET | `/api/stats/summary?date=&tz=` | 今日汇总 |
| GET | `/api/stats/daily?days=30&tz=` | 近 N 天专注总量 |
| GET | `/api/stats/heatmap?days=30&tz=` | 星期 × 小时热力 |
| GET | `/api/stats/completion?days=30` | 任务完成率 |

`tz` 是 **UTC 以东的分钟数**（东八区传 `480`），前端用 `-new Date().getTimezoneOffset()` 算出来。服务端据此把时间戳归属到正确的本地日期和小时——不传就按 UTC 算。

---

## 架构

```
浏览器 (public/*.html + 原生 ES Module，无打包器)
   │  fetch + credentials:'same-origin'（会话在 httpOnly Cookie 里，JS 读不到）
   ▼
Express 5 (src/app.ts → src/routes/*.ts)
   │  公开区：/health、/auth 的 register|login|logout
   │  requireAuth 验签 + 查库确认用户仍在；统一信封 ok()/fail()
   ▼
业务层 (src/services/*.ts)  ← 统计聚合是纯函数，可直接单测
   ▼
Prisma Client → MySQL
```

前端刻意不用打包器：`<script type="module">` 直接 `import` 原生 ES Module，浏览器自己解析依赖。改一行前端代码刷新即可生效，没有构建等待。

`src/app.ts` 只构建并导出 app，`src/server.ts` 只负责 `app.listen`。这个拆分是为了让集成测试能 `import app` 后在随机端口上自己 listen，不必真的占用 3000 端口，也不会因为端口被占用而挂掉。

---

## 三个值得一读的设计决策

### 1. 计时用时间戳差值，`setInterval` 只负责重绘

这是整个项目最重要的一条约束。

浏览器会节流后台标签页的定时器——最小化几分钟后，`setInterval(fn, 1000)` 可能变成每 60 秒才跑一次，甚至完全暂停。如果计时逻辑写成「每 tick 把已用时间 +1 秒」，切回前台时计时器就会慢掉一大截。

所以这里根本不做累加：

```js
elapsed   = accumulatedMs + (startedAt === null ? 0 : now - startedAt)
remaining = Math.max(0, durationMs - elapsed)
```

`setInterval(tick, 250)` 的回调**只调 `render()`**，而 `render()` 每次都用上面这两行重新算一遍。这样无论浏览器怎么节流，下一次 tick 拿到的都是正确结果——因为时间来自 `Date.now()`，不是来自被跳过的回调次数。暂停就是把 `startedAt` 折进 `accumulatedMs` 再置空，恢复就是重新记 `startedAt`。

### 2. Session 写入幂等：两层防线

专注段结束的瞬间如果正好刷新页面，客户端会重发同一条记录。如果不处理，番茄数就会重复 +1。

**服务端**：`Session` 上有 `@@unique([userId, clientId])`，`clientId` 是客户端在段开始时生成并持久化的 UUID。撞唯一约束（Prisma 报 `P2002`）时**视为成功**，返回既有记录，不重复加 `completedPomodoros`。写 Session 和 `completedPomodoros + 1` 在同一个事务里，要么都成，要么都不成。

**客户端**：提交失败的记录留在 localStorage 的 outbox 里（按 clientId 去重），页面加载和网络恢复时 `flushOutbox()` 只重试失败项，成功时派发事件让看板刷新。

项目里有一个端到端集成测试专门跑这条链路：模拟段结束 → commit 发给真实 API → 断言番茄数 +1 → 重发同一条 → 断言仍然是 1。

### 3. 统计聚合用 JS 纯函数，不用 SQL

30 天最多几百条记录，JS 聚合完全够用。更重要的是三点：

- Prisma 的 `groupBy` 无法按 `DATE(startAt)` 这样的表达式分组，硬写 raw SQL 会丢掉类型安全。
- 按**本地时区**分桶在 SQL 里很难写对——「10 月 5 日凌晨 0:30 的专注算哪一天」取决于用户在哪个时区。
- 纯函数能被直接单测。`tests/unit/stats.test.ts` 里就有 `2026-10-04T16:30Z` 在东八区应当归属到 10-05 这样的跨日边界用例。

路由层只负责按 `startAt` 范围查库，把数组喂给 `src/lib/stats.ts` 里的纯函数。

### 4. 密码用 `node:crypto` 的 scrypt，不用 bcrypt

理由很实在：**零新依赖，且不需要编译原生模块**。bcrypt 和 argon2 都是原生扩展，在 Windows + Node 24 上经常装不上，装上了换台机器/换个 Node 版本还得重来。scrypt 是 Node 标准库自带的，`npm install` 到能跑之间没有任何变数。

安全性上没有让步：scrypt 是内存硬的 KDF，抗 GPU/ASIC 并行比 bcrypt 更强。

存储格式是**自描述**的，参数跟着哈希一起存：

```
scrypt$16384$8$1$<salt-base64>$<hash-base64>
```

这样将来调参（比如把 N 从 16384 提到 32768）时，老哈希仍然能验证，用户不用重置密码。

几个刻意的细节：

- **用异步 `scrypt`，不用 `scryptSync`**。单次约 30ms，同步版会阻塞事件循环——几个人同时登录就能把整个服务卡住。
- **参数不能随意调大**。Node 默认 `maxmem` 是 32MB（= 128·N·r），`N=32768` 会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`。
- **解析存储串时对 `N`/`r`/`p` 做上界校验**。哈希是存在数据库里的，万一有人手改库构造出 `N=2^20`，直接算会瞬间吃掉几个 GB 内存——所以按「内存开销」而不是按单个参数卡死。
- **`verifyPassword` 对任何损坏都返回 `false`，绝不抛异常**。调用方关心的是「能不能登录」，不是「哪里坏了」。
- **查不到用户时也跑一次等价的哈希计算**（`getDummyHash()`）。否则「用户名不存在」的响应会明显快于「密码错误」，攻击者据此能枚举出哪些用户名已被注册。

---

## 测试

```bash
npm run test:unit   # 87 个用例，不需要 MySQL
npm test            # 共 160 个用例（87 单测 + 73 集成测）
```

| 文件 | 用例数 | 测什么 |
|---|---|---|
| `tests/unit/timer-core.test.ts` | 32 | 计时数学、跨段转移、`longBreakEvery` 边界、`autoStartNext` 两个分支、超时恢复不补记 |
| `tests/unit/stats.test.ts` | 20 | 30 天日聚合、完成率、热力图分桶、跨本地午夜的归属边界 |
| `tests/unit/charts.test.ts` | 15 | ECharts option 构造在空数据 / 全零 / 脏数据下不产出 NaN 或非法坐标 |
| `tests/unit/password.test.ts` | 21 | scrypt 哈希：salt 生效、不 trim 密码、损坏哈希返回 `false` 而不抛异常、手改库塞进超大 `N` 时拒绝解析 |
| `tests/integration/*.test.ts` | 73 | 任务 CRUD、按日隔离、Session 幂等（含并发重放）、跨用户越权拒绝、设置读写、统计接口、账号体系（含 25 个鉴权用例） |

集成测试用**懒登录**：`api(path, { as: '用户名' })` 首次用到时自动走真实的 `POST /auth/register` 拿 Cookie 再缓存复用。链路一点没省——真的注册、真的 `Set-Cookie`、真的验签、真的查库——但 92 个调用点里只有十几处需要显式指定身份。

几条专门守不变量的用例值得一提：cookie 的 `Max-Age` 没有退化成会话 cookie、登录失败的两种原因响应逐字节相同、**用同一密钥签的过期令牌被拒**（证明 `exp` 真的在生效，而不是「随便什么串都返回 401」）、**令牌合法但用户已删除时返回 401 而不是 400**。

**为什么要专门测「纯逻辑」**：`public/js/timer-core.js`、`public/js/charts.js`、`src/lib/stats.ts` 三个文件被设计成不引用 DOM、不直接连库，且 `timer-core.js` 的每个函数都把 `now` 作为参数传入而不是内部调 `Date.now()`。这样 Vitest 能在 Node 环境直接测它们，用受控时钟精确构造「第 25 分 00 秒」这样的时刻，不需要假定时器。测试环境是 `environment: 'node'`，刻意不装 jsdom。

`tests/integration/timer-flow.test.ts` 是连接两层的桥：把纯计时核心产出的 commit 直接喂给真实 API，验证「专注段结束 → 写 Session → 番茄数 +1」这条闭环。两边各自的单测都通过，不代表接起来也对。

---

## 技术栈

Express 5 · TypeScript (ESM) · Prisma · MySQL 8 · Vitest · 原生 ES Module · ECharts 5 (CDN) · jose (JWT) · `node:crypto` (scrypt)

密码哈希和 JWT 分别用 `node:crypto` 与 **jose**，都是零原生模块、零编译步骤的纯 JS 方案，`npm install` 到能跑之间没有任何变数。选 jose 而不是 jsonwebtoken：它是 ESM 原生、自带 TS 类型、零依赖；jsonwebtoken 是 CJS 且类型要另装 `@types` 包，在 `module: NodeNext` 下很容易踩到互操作的坑。

> **Prisma 固定在 6.19.3**，不要升级：Prisma 7 起 schema 里不再允许 `datasource.url`（报 `P1012`，要求改用 `prisma.config.ts` + driver adapter），而本项目按需求把连接串放在 `.env`。

> `/stats` 的 ECharts 走 CDN，离线环境下图表会挂。想完全离线，把 `echarts.min.js` 下到 `public/vendor/` 并把 `stats.html` 里的 `<script src>` 改成本地路径即可。

---

## 已知局限 / 未做的部分

账号体系是「最朴素」的，以下是明确知道且**有意不做**的，不是漏了：

- **JWT 无法真正吊销**。`POST /auth/logout` 只能清掉浏览器里的 Cookie，令牌本身在 7 天过期前技术上仍然有效。要真正吊销就得引入服务端状态（黑名单或 `User.tokenVersion`），那等于放弃 JWT 的无状态优势。本地单用户工具，7 天过期 + 清 Cookie 足够。
- **没有防暴力破解**。无失败次数限制、无验证码、无速率限制。scrypt 单次约 30ms 本身构成一点天然延缓，但这不是防护。真要暴露到公网必须先补这块。
- **没有密码重置、改密码、邮箱验证、多设备会话管理**。「忘记密码」目前只能直接改库。
- **多人协作**：非目标。账号的作用是区分数据，不是做多租户。
- **移动端原生 App**：非目标，页面做了基本的响应式适配。
- **P1 功能只预留了扩展点**：拖拽排序（`Task.order` + `PATCH /api/tasks/reorder` 已就绪）、白噪音、周报 Markdown 导出、任务标签（需要新增多对多表）都还没做。
- **休息段暂不写入 Session**：数据模型里留了 `short_break` / `long_break` 两种类型，但当前只有专注段会落库。补上能让时间轴更完整。

### 关于 CSRF：为什么没加 token

`SameSite=Lax` 在本项目已经足够，理由是分析而不是偷懒：

Lax 只对跨站的**子请求**不带 Cookie，顶层 GET 导航才带。而本项目**没有任何用 GET 改数据的路由**（四个 router 都已确认），所以 Lax 的唯一边界打不到有副作用的接口。另外两条路也堵死了——服务端没有 CORS 中间件，跨站 `fetch` 会触发预检被浏览器拦下；跨站表单 POST 的 `Content-Type` 不被 `express.json()` 解析，而且同样带不上 Cookie。

所以**不加** CSRF token。也没上 `SameSite=Strict`——那会让从外部链接进来时落回未登录态，是体验倒退。
