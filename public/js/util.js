/**
 * 前端通用小工具：日期键、时区偏移、DOM 辅助。
 */

/** localStorage / sessionStorage 的键名集中在这里，避免到处写魔法字符串 */
export const STORAGE_KEYS = Object.freeze({
  TIMER: 'focusflow.timer',
  OUTBOX: 'focusflow.outbox',
  TASKS_CACHE: 'focusflow.tasks',
  /** 当前登录用户的 id，用于判断「换了账号」，本身不参与业务 */
  CURRENT_USER: 'focusflow.currentUser',
  /** 匿名身份时代留下的键，现在不再写入，但清理时要带上 */
  LEGACY_USER_ID: 'focusflow.userId',
});

/**
 * 清空所有按用户隔离的本地状态。
 *
 * 登录/登出/切换账号时必须调用。这些键是全局的，没有按用户加前缀，
 * 不清的话会串数据：A 未提交的专注记录留在 outbox 里，B 登录后被
 * flushOutbox() 提交到 B 名下；A 正在跑的计时器也会被 B 继承，
 * 结束时段记到 B 头上。
 *
 * 调用前记得先 flushOutbox()，否则刚跑完还没提交的那个番茄会直接丢失。
 */
export function clearUserScopedStorage() {
  for (const key of Object.values(STORAGE_KEYS)) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 隐私模式下 localStorage 可能不可写，忽略
    }
  }
}

/**
 * 时区偏移，约定为「UTC 以东的分钟数」：东八区返回 480。
 * 注意 JS 的 getTimezoneOffset() 符号是反的（东八区返回 -480），所以要取负。
 * 后端所有 tz 参数都用这个约定。
 */
export function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

/**
 * 某个时刻的本地日期键 "YYYY-MM-DD"。
 *
 * 刻意用 getFullYear / getMonth / getDate 这些「本地」取法，而不是
 * toISOString：任务是按用户所在的那一天归属的，用 UTC 会在东八区
 * 凌晨（本地已是新的一天、UTC 还在前一天）把任务记错日子。
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function toDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 今天的本地日期键，看板和任务默认归属都用它 */
export function todayKey() {
  return toDateKey(new Date());
}

/**
 * 秒 → 「1 小时 25 分」这种中文可读形式。
 * 小时与分钟都为 0 时（含 0 秒、undefined）返回 "0 分"，不留空字符串。
 */
export function formatDuration(seconds) {
  if (!seconds) return '0 分';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分`;
  if (hours > 0) return `${hours} 小时`;
  return `${minutes} 分`;
}

/**
 * 把 Date / ISO 串格式化成 "HH:MM"（本地时区，不含秒）。
 * 时间轴按分钟粒度展示即可，秒会把整列撑宽且没有信息量。
 * 同时接受 Date 和字符串，是因为后端返回 ISO 串、前端手边常有 Date。
 */
export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 转义 HTML，用于任何要拼进 innerHTML 的用户输入。
 * 五个字符都要转：& < > " ' —— 少转引号，带引号的属性值就可能被闭合后注入。
 * 这是本应用唯一的防注入手段，所有拼模板的地方都必须过它。
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 从 localStorage 读 JSON，坏了就当没有 */
export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 写 JSON 到 localStorage；失败静默降级，不抛给调用方 */
export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额满或隐私模式：静默降级，不影响主流程
  }
}
