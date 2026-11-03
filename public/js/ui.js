/**
 * 轻量反馈提示：一个可复用的 toast，加上统一的异步错误处理。
 *
 * 边界：只管「显示一条瞬时消息」，不排队、不堆叠、不做 toast 之外的 UI。
 * 整个应用共享同一个 DOM 节点 —— 短消息同时来了就后者覆盖前者，
 * 这在本项目里反而是想要的（最新的操作结果最相关）。
 */

import { AuthError } from './api.js';

/** 复用同一个 toast 节点，避免频繁创建/销毁 DOM */
let toastEl = null;
/** 当前那条自动隐藏的定时器，新消息进来要把它清掉，否则会被提前关掉 */
let hideHandle = null;

/**
 * 弹一条 toast。
 *
 * 副作用：创建并写入 DOM、设置 data-show / data-kind 交给 CSS 显隐与配色、
 * 安排一个定时器在若干毫秒后把 data-show 置回 false。
 *
 * 错误类提示停留久一点（4s vs 2.2s）：报错往往带具体原因，需要读完；
 * 成功类提示扫一眼就够。反复调用时先 clearTimeout，保证新消息完整显示满时长。
 *
 * @param {string} message - 展示文案
 * @param {'info'|'error'} [kind] - 视觉样式
 */
export function toast(message, kind = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }

  toastEl.textContent = message;
  toastEl.dataset.kind = kind;
  toastEl.dataset.show = 'true';

  clearTimeout(hideHandle);
  hideHandle = setTimeout(() => {
    toastEl.dataset.show = 'false';
  }, kind === 'error' ? 4000 : 2200);
}

/**
 * 把一次异步操作的错误统一提示出来，各页面 catch 块都调它。
 * 始终先 console.error 留下完整堆栈，再决定要不要弹给用户看。
 *
 * AuthError 直接静默：api.js 在抛它之前已经发起了跳转登录页，
 * 此刻再弹 toast 只会在页面消失前闪一下，反而让人以为出了别的错。
 *
 * @param {unknown} error
 */
export function reportError(error) {
  console.error(error);

  // 登录态失效时 api.js 已经在跳转登录页了，再弹一条 toast
  // 只会在页面消失前闪一下，反而像是出了别的错。
  if (error instanceof AuthError) return;

  toast(error?.message || '操作失败', 'error');
}
