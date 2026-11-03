import { randomUUID } from 'node:crypto';
import { PrismaClient, type SessionType, type TaskStatus } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';

/** 演示账号。仅供本地开发，不要用在任何真实环境。 */
const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo1234';
/** 与 src/lib/validate.ts 的 USERNAME_RE 保持一致 */
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

/**
 * 示例数据。
 *
 * 为什么需要它：统计页在空库下就是三个空白图表（近 30 天柱状图、星期×小时
 * 热力图、任务完成率），手工点出几十个番茄再看效果太慢。本脚本按「相对今天」
 * 造近 30 天的任务与专注记录，所以任何时候跑都能让页面上有东西可看、可截图。
 *
 * 用法：
 *   npm run db:seed              # 灌给 demo 账号（不存在就建，密码 demo1234）
 *   npm run db:seed -- <用户名>   # 灌给指定账号（不存在就建，密码同上）
 *
 * 常见用法是：先在页面上注册一个自己的账号，然后 `npm run db:seed -- 你的用户名`
 * 把 30 天示例数据挂上去，这样统计页立刻就有东西看。
 *
 * 注意：账号已存在时**不会**改它的密码，只往它名下灌数据 ——
 * 否则一次 seed 就把你自己的密码冲掉了。
 *
 * 账号制下不再需要「把 UUID 塞进 localStorage」那套操作，示例数据
 * 直接登录就能看到，这也是账号制顺带解决的一个麻烦。
 */

const prisma = new PrismaClient();

// UTC 以东为正，东八区 = 480。仅用于下面那行提示日志；真正生成时间用的是
// 本地时区构造函数（localTime），所以数据本身不依赖这个常量。
const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset(); // UTC 以东为正，东八区 = 480

/**
 * 定种子的伪随机数发生器（mulberry32）。返回一个每次调用给出 [0, 1) 的函数。
 *
 * 不用 Math.random 的原因：那样每次跑出来的数据都不同，改一版看效果时没法
 * 判断「图表变了」是代码改的还是数据换的。定种之后重跑得到同一批数据，截图
 * 能直接对比。算法本身很短，够用即可，不需要引入依赖。
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 种子取当前日期，只求一个写死的值 —— 关键是「固定」而非「随机」
const rng = mulberry32(20261005);

// 统一按 25 分钟一段来造；与默认专注时长一致，统计里的时长才对得上
const FOCUS_SECONDS = 25 * 60;
// 生成近 30 天，正好覆盖统计页默认的 30 天窗口
const DAYS = 30;

/** 一天里可能开始的钟点，模拟「上午一段、下午一段、晚上偶尔加个班」 */
const START_HOURS = [9, 10, 11, 14, 15, 16, 17, 20, 21];

// 今日看板的固定样本：手写而不是随机，好让「已完成 / 进行中 / 待办」三态
// 各有代表，状态徽章和完成率一眼就能看出是否正常
const TODAY_TASKS: Array<{ title: string; note?: string; estimate: number; done: number; status: TaskStatus }> = [
  { title: '整理上周客户反馈', note: '按主题归类，标出需要回复的', estimate: 2, done: 2, status: 'done' },
  { title: '写周报', estimate: 1, done: 1, status: 'done' },
  { title: '重构导出模块', note: '先拆出纯函数，再接 UI', estimate: 3, done: 1, status: 'doing' },
  { title: '看完《深度工作》第 4 章', estimate: 2, done: 0, status: 'todo' },
  { title: '回复邮件', estimate: 1, done: 0, status: 'todo' },
];

// 回填历史日子时用的标题池，每次从中不重复地抽，避免同一天出现同名任务
const PAST_TASKS = [
  '对接设计稿',
  '修复登录态过期',
  '整理接口文档',
  '复盘上周排期',
  '优化首页加载',
  '写季度总结',
  '梳理需求池',
];

/**
 * 本地某天的 0 点，对应 Task.date 的存法（与 src/lib/date.ts 的 parseDateOnly 一致）。
 * 用 Date.UTC 而非本地构造，让「哪一天」不随机器时区漂移。month 与 Date 一样是 0 基。
 */
function dateOnly(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/**
 * 本地 wall-clock → Date（存进库是 UTC，但用户看到的是本地时间）。
 * 这里刻意用本地时的构造函数：种子要模拟「本地上午九点开始的专注」，
 * 而不是「UTC 九点」，否则换个时区跑出来的时间轴会整体偏移。month 为 0 基。
 */
function localTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month, day, hour, minute, 0, 0);
}

/**
 * 入口：确保账号存在 → 清掉它名下的旧示例数据 → 按天回填任务与专注段。
 * 全程有写库副作用，且刻意做成可重复执行（下面的删除 + 「绝不覆盖密码」是保证）。
 */
async function main(): Promise<void> {
  // npm 把 `--` 之后的参数原样透传，node 的 argv[0] 是 node、argv[1] 是脚本路径，
  // 所以用户名落在 argv[2]；不传就退回演示账号
  const argUsername = process.argv[2];
  // 归一化方式与 validate.ts 的 requireUsername 一致，否则会出现
  // 「脚本说建好了，但页面就是登不上」这种排查起来很烦的问题
  const username = (argUsername ?? DEMO_USERNAME).normalize('NFKC').trim().toLowerCase();

  if (!USERNAME_RE.test(username)) {
    throw new Error(
      `用户名「${username}」不合法：只能是 3–32 位小写字母、数字或下划线` +
        '（与注册页的规则一致）。',
    );
  }

  console.log(`提示：时区偏移按本机计算 = UTC${TZ_OFFSET_MINUTES >= 0 ? '+' : ''}${TZ_OFFSET_MINUTES / 60}\n`);

  // 已存在就复用，**绝不覆盖已有密码** —— 否则一次 seed 就把人家自己的密码冲掉了。
  // 查的是归一化后的 username，与唯一索引存的形态一致，所以能命真实账号。
  let user = await prisma.user.findUnique({ where: { username } });
  // 只有这次新建的账号才需要打印密码；老账号打印密码会误导用户去用 demo1234
  let createdNow = false;

  if (!user) {
    user = await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(DEMO_PASSWORD),
        // 与注册接口一致：建用户时连默认 Setting 一起建出来
        setting: { create: {} },
      },
    });
    createdNow = true;
  }

  const userId = user.id;

  // 可重复执行：先清掉这个用户已有的示例数据（外键 cascade 会带走 Session）。
  // 顺序是先 Session 后 Task —— 反过来的话，任务被删时 Session.taskId 会被
  // 置空留下无主记录，还得再删一遍。
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let totalSessions = 0;
  let totalTasks = 0;

  // 从 29 天前排到今天（back 递减到 0）
  for (let back = DAYS - 1; back >= 0; back -= 1) {
    // getDate() - back 会由 Date 自动处理跨月、跨年，不必自己算月末
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const y = day.getFullYear();
    const m = day.getMonth();
    const d = day.getDate();
    const weekday = day.getDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const isToday = back === 0;

    // ── 任务 ──
    // 收集本日刚建出来的任务，供下面把专注段挂上去（只留 id/标题/状态）
    const taskRows: Array<{ id: string; title: string; status: TaskStatus }> = [];

    if (isToday) {
      // 今日用固定样本；数组下标直接当 order，看板顺序就与这里写的顺序一致
      for (const [index, spec] of TODAY_TASKS.entries()) {
        const created = await prisma.task.create({
          data: {
            userId,
            title: spec.title,
            note: spec.note ?? null,
            date: dateOnly(y, m, d),
            estimatedPomodoros: spec.estimate,
            completedPomodoros: spec.done,
            status: spec.status,
            order: index,
          },
        });
        taskRows.push({ id: created.id, title: created.title, status: created.status });
        totalTasks += 1;
      }
    } else if (rng() < 0.45) {
      // 过去的日子有一部分留空，这样柱状图才有起伏而不是一条平线
      const count = 1 + Math.floor(rng() * 3);
      // 每天的池子都拷一份再 splice，避免取走标题把共享的 PAST_TASKS 掏空
      const pool = [...PAST_TASKS];
      for (let i = 0; i < count && pool.length > 0; i += 1) {
        const title = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
        // 过去的任务大多已经做完了，留一部分没做完让完成率不是 100%
        const status: TaskStatus = rng() < 0.8 ? 'done' : 'todo';
        const estimate = 1 + Math.floor(rng() * 3);

        const created = await prisma.task.create({
          data: {
            userId,
            title,
            date: dateOnly(y, m, d),
            estimatedPomodoros: estimate,
            // 已完成的就当它确实吃满了预估番茄，未完成的保持 0，让预估/实际有对比
            completedPomodoros: status === 'done' ? estimate : 0,
            status,
            order: i,
          },
        });
        taskRows.push({ id: created.id, title: created.title, status: created.status });
        totalTasks += 1;
      }
    }

    // ── 专注时段 ──
    // 周末少一些；再叠一点随机，让某些天干脆是 0
    let count = Math.floor(rng() * (isWeekend ? 4 : 9));
    // 约 12% 的天一条都不造，柱状图/热力图才会出现真正的空白天
    if (rng() < 0.12) count = 0;

    // 把候选钟点用 rng 打乱后取前 count 个，等于随机挑出互不重复的开始时刻；
    // 因为 rng 定种，重跑得到的排列不变
    const hours = [...START_HOURS].sort(() => rng() - 0.5).slice(0, count);

    for (const hour of hours) {
      // 分钟只取 0/15/30/45，比纯随机分钟更像真人手动开始的时间
      const startAt = localTime(y, m, d, hour, Math.floor(rng() * 4) * 15);
      const endAt = new Date(startAt.getTime() + FOCUS_SECONDS * 1000);

      // 今天的数据不能跑到「现在」之后 —— 未来的专注记录会让时间轴出现诡异条目
      if (isToday && endAt.getTime() > now.getTime()) continue;

      // 一部分时段挂到当天某个任务上，一部分不挂 —— 真实使用里两者都有
      // （临时查资料、开会等不挂任务），也让统计里「有归属/无归属」两种情况都有样本
      const bound = taskRows.length > 0 && rng() < 0.7 ? taskRows[Math.floor(rng() * taskRows.length)]! : null;

      await prisma.session.create({
        data: {
          userId,
          // clientId 是幂等键；种子数据无所谓幂等，随便给个不重复的 UUID 满足唯一约束即可
          clientId: randomUUID(),
          taskId: bound?.id ?? null,
          startAt,
          endAt,
          duration: FOCUS_SECONDS,
          // 只造专注段：统计口径本来就只看 focus，造休息段也不会出现在图表里
          type: 'focus' as SessionType,
          completed: true,
        },
      });
      totalSessions += 1;
    }
  }

  console.log(`已为「${username}」灌入 ${totalSessions} 条专注记录、${totalTasks} 个任务（近 ${DAYS} 天）。\n`);

  if (createdNow) {
    console.log('这是一个新建的账号，直接登录即可看到数据：');
    console.log(`  用户名：${username}`);
    console.log(`  密  码：${DEMO_PASSWORD}\n`);
    console.log('（仅供本地开发使用，别用在任何真实环境）');
  } else {
    console.log(`账号「${username}」已存在，密码未改动，用你原来的密码登录即可。`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
