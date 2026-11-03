/**
 * 任务路由（/api/tasks）。任务是按「日期」归属的待办条目，看板左列的数据源。
 *
 * 边界：本层只做三件事 —— 取身份（requireUserId）、把原始入参校验成 service
 * 认识的结构、把结果序列化后套信封。归属与存在的判断全在 services/tasks.ts，
 * 那里每个查询都带 userId，越权改别人的任务会得到 404 而不是 403。
 *
 * 一个刻意的约束：`completedPomodoros` 不在本文件的任何写接口里出现。它只能
 * 由 /api/sessions 在写 Session 的同一个事务里 +1，客户端无法直接改写，
 * 否则番茄数会和 Session 流水对不上，统计页的比例也就失去意义。
 */
import express from 'express';
import type { TaskStatus } from '@prisma/client';
import { ok } from '../lib/response.js';
import { AppError } from '../lib/http-error.js';
import { serializeTask } from '../lib/serialize.js';
import { requireUserId } from '../middleware/require-auth.js';
import { optionalIntInRange, optionalString, requireString } from '../lib/validate.js';
import * as tasks from '../services/tasks.js';
import { readDateQuery, readIdParam, readTzOffset } from './helpers.js';

export const tasksRouter = express.Router();

const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done'];

/**
 * GET /api/tasks?date=YYYY-MM-DD&tz=
 * 取某一天的任务列表；date 缺省为该时区下的今天，tz 缺省为 0（UTC）。
 * 返回顺序由 service 决定（order 升序，再按创建时间兜底）。
 */
tasksRouter.get('/', async (req, res) => {
  const userId = requireUserId(req);
  const tz = readTzOffset(req);
  const date = readDateQuery(req, tz);

  const list = await tasks.listTasks(userId, date);
  ok(res, list.map(serializeTask));
});

/**
 * POST /api/tasks
 * 新建任务。title / date 必填，estimatedPomodoros 缺省为 1（由
 * parseCreateTaskInput 负责，路由不重复校验）；新任务排在当天末尾。
 *
 * 副作用：写库。先 res.status(201) 再 ok() —— ok() 内部就是 res.json()，
 * 一旦调用响应即发出，之后改状态码不会生效，顺序不能反。
 */
tasksRouter.post('/', async (req, res) => {
  const userId = requireUserId(req);
  const input = tasks.parseCreateTaskInput(req.body);

  const created = await tasks.createTask(userId, input);
  res.status(201);
  ok(res, serializeTask(created), '任务已创建');
});

/**
 * PATCH /api/tasks/reorder
 * 放在 /:id 之前注册，否则 "reorder" 会被当成 id 吞掉。
 *
 * 入参 orderedIds 是「该日期下任务 id 的期望顺序」，路由只校验它确实是字符串
 * 数组；是不是这天的、属不属于当前用户，由 service 查一遍当天任务集再比对。
 * 任何不属于该日期的 id 都会整体 400，不做「忽略陌生 id」的宽容处理 ——
 * 静默丢弃会让前端以为排序成功，实际顺序与预期不符。
 *
 * 返回重排后的完整列表，让客户端拿到服务端认定的权威顺序，无需自行推算。
 */
tasksRouter.patch('/reorder', async (req, res) => {
  const userId = requireUserId(req);
  const date = requireString(req.body, 'date', 10);

  const record = req.body as Record<string, unknown>;
  const orderedIds = record.orderedIds;
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
    throw new AppError(400, 'orderedIds 必须是字符串数组');
  }

  const list = await tasks.reorderTasks(userId, date, orderedIds as string[]);
  ok(res, list.map(serializeTask), '排序已更新');
});

/** GET /api/tasks/:id —— 不存在、或存在但不属于当前用户，都是 404（由 service 抛出） */
tasksRouter.get('/:id', async (req, res) => {
  const userId = requireUserId(req);
  const task = await tasks.findTask(userId, readIdParam(req));
  ok(res, serializeTask(task));
});

/**
 * PATCH /api/tasks/:id —— 局部更新。
 * 所有字段可选，但显式传了就必须合法；一个字段都没传时由 service 返回 400，
 * 而不是静默地做一次空写。
 *
 * status 用白名单 TASK_STATUSES 校验：Prisma 的枚举在运行时并不拦非法字符串，
 * 直接塞进去要到数据库层才报错，那时已经变成通用 500。
 * note / estimatedPomodoros 交给 lib/validate 的 optional* 助手：前者区分
 * 「没传」和「传 null 清空」，后者只在字段出现时才校验范围。
 */
tasksRouter.patch('/:id', async (req, res) => {
  const userId = requireUserId(req);
  const id = readIdParam(req);

  const record = req.body as Record<string, unknown>;
  const status = record.status;
  if (status !== undefined && (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus))) {
    throw new AppError(400, `status 必须是 ${TASK_STATUSES.join(' / ')} 之一`);
  }

  // title 允许缺省，但显式传了就必须是合法非空字符串（不允许 null）
  const title = 'title' in record ? requireString(req.body, 'title', 200) : undefined;

  // 注意：completedPomodoros 不在这里更新 —— 它由 /api/sessions 在事务里维护，
  // 客户端不能直接改写，否则番茄数会和 Session 记录对不上。
  const updated = await tasks.updateTask(userId, id, {
    title,
    note: optionalString(req.body, 'note'),
    estimatedPomodoros: optionalIntInRange(req.body, 'estimatedPomodoros', 1, 99),
    status: status as TaskStatus | undefined,
  });

  ok(res, serializeTask(updated), '任务已更新');
});

/**
 * DELETE /api/tasks/:id —— 返回 200 + 信封（而非 204），保持「每个响应都是信封」。
 * 删不存在的任务（或不属于自己的）由 service 抛 404，不做「删除幂等、静默成功」——
 * 那会让客户端的删除按钮在数据已被别处删掉时无从察觉。
 */
tasksRouter.delete('/:id', async (req, res) => {
  const userId = requireUserId(req);
  await tasks.deleteTask(userId, readIdParam(req));
  ok(res, null, '任务已删除');
});
