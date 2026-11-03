import { tzOffsetMinutes } from './util.js';

/**
 * 后端 API 的唯一入口：带 Cookie、拆信封、失败时抛错。
 *
 * 后端统一返回 { message, status: 'ok'|'error', code, data }，
 * 这里把 status !== 'ok' 一律转成异常，调用方只处理成功路径。
 *
 * 会话令牌在 httpOnly Cookie 里 —— JS 读不到它，这是刻意的
 * （XSS 拿不到令牌）。所以这里不需要、也没办法注入任何身份信息。
 *
 * 边界：本模块不碰 localStorage、不弹提示、不渲染 DOM。它只负责
 * 「发请求 + 解信封 + 出错时抛合适的异常」；怎么呈现交由调用方（ui.js）。
 * 唯一的例外是基于路径与状态码的跳转分流，见 FORM_AUTH_PATHS。
 *
 * 所有接口的成功分支都返回信封里的 data（而非整个 payload），
 * 调用方拿到的直接是业务数据。
 */

const BASE = '/api';

/** 登录态失效时抛这个，页面据此静默处理（此时正在跳转，弹提示很突兀） */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * 只有登录和注册这两个接口的 401 是「正常的业务结果」（用户名或密码不对），
 * 必须原样交给表单显示。如果和「登录态失效」混在一起无差别跳转，
 * 输错密码时页面会被刷新，用户根本来不及看到那句错误提示。
 *
 * 注意这里**不能**简单写成「凡是 /auth/ 开头的都放行」：
 * /auth/me 的 401 就是「没登录」，那正是最该跳转的情况。
 */
const FORM_AUTH_PATHS = new Set(['/auth/login', '/auth/register']);

/** 比对前先剥掉 query，与下面 withTz 给路径拼参的写法保持一致 */
function isFormAuth(path) {
  return FORM_AUTH_PATHS.has(path.split('?')[0]);
}

let redirecting = false;

function redirectToLogin() {
  // 看板初始化时 Promise.all 会同时发三个请求，三个都会 401，
  // 没有这个标志就会触发三次跳转。
  if (redirecting) return;
  redirecting = true;

  const next = location.pathname + location.search;
  location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/**
 * 发一个 API 请求并解包信封。
 *
 * 副作用：网络请求；401 时可能触发整页跳转（表单登录接口除外）。
 *
 * 抛错策略分三层：
 * - 网络层失败（fetch reject）→ 普通 Error，文案说明连不上服务器；
 * - 响应不是 JSON → 普通 Error，带上状态码方便排查反向代理返回的 HTML 错误页；
 * - 信封 status !== 'ok' → 401 走 AuthError 分流，其余按后端消息抛普通 Error。
 *
 * @param {string} path - 相对 /api 的路径，可含 query
 * @param {{ method?: string, body?: unknown }} [options] - body 会 JSON.stringify；
 *   只有带 body 时才设 Content-Type，避免给 GET 塞无谓的头
 * @returns {Promise<any>} 信封里的 data
 */
export async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      // 同源请求默认就会带 Cookie，这里显式写出来是为了表明这是有意为之 ——
      // 会话就靠它，改成 'omit' 会直接变成未登录。
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`无法连接到服务器：${error.message}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务器返回了非 JSON 响应（HTTP ${response.status}）`);
  }

  if (payload.status !== 'ok') {
    if (response.status === 401) {
      const message = payload.message || '用户名或密码不正确';
      // 表单自己会把这句显示出来，不跳转
      if (isFormAuth(path)) throw new AuthError(message);

      redirectToLogin();
      throw new AuthError(payload.message || '登录状态已失效');
    }

    throw new Error(payload.message || `请求失败（HTTP ${response.status}）`);
  }

  return payload.data;
}

/**
 * 给路径拼上 tz 参数（以及可选的 extra 参数）。
 *
 * 「今天」「近 N 天」这类按日切分的接口都必须带 tz：服务端拿它把 UTC
 * 时间戳换算成用户本地日界线，否则跨时区时任务/统计会错归到隔壁那天。
 * 用 URLSearchParams 拼接顺带做了编码，date 里的字符也不用担心。
 *
 * @param {string} path
 * @param {Record<string,string>} [extra] - 额外 query 参数
 * @returns {string} 带 query 的完整相对路径
 */
function withTz(path, extra = {}) {
  const params = new URLSearchParams({ tz: String(tzOffsetMinutes()), ...extra });
  return `${path}?${params.toString()}`;
}

/**
 * 全部接口的薄封装：每个方法只是一句 request 调用，不含业务逻辑。
 * 集中成对象是为了页面里写 api.xxx() 清晰，也方便测试替身整体替换。
 * 按日/按小时聚合的接口统一走 withTz 带上时区。
 */
export const api = {
  // 账号
  register: (username, password) =>
    request('/auth/register', { method: 'POST', body: { username, password } }),
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),

  // 任务
  listTasks: (date) => request(withTz('/tasks', { date })),
  createTask: (input) => request('/tasks', { method: 'POST', body: input }),
  updateTask: (id, patch) => request(`/tasks/${id}`, { method: 'PATCH', body: patch }),
  deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  reorderTasks: (date, orderedIds) =>
    request('/tasks/reorder', { method: 'PATCH', body: { date, orderedIds } }),

  // 时段
  listSessions: (date) => request(withTz('/sessions', { date })),
  createSession: (input) => request('/sessions', { method: 'POST', body: input }),

  // 设置
  getSettings: () => request('/settings'),
  updateSettings: (patch) => request('/settings', { method: 'PUT', body: patch }),

  // 统计
  summary: (date) => request(withTz('/stats/summary', { date })),
  daily: (days = 30) => request(withTz('/stats/daily', { days: String(days) })),
  heatmap: (days = 30) => request(withTz('/stats/heatmap', { days: String(days) })),
  completion: (days = 30) => request(withTz('/stats/completion', { days: String(days) })),
};
