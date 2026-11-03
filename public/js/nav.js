/**
 * 三个页面共享的顶部导航。
 * 每个 HTML 里放一个 <header data-nav></header>，由这里填充。
 *
 * 边界：只管导航条本身的渲染与「退出登录」，不渲染页面主体。
 * 登录页刻意不引入本文件 —— 那里还没有「当前用户」，而且退出按钮本就不该出现。
 *
 * 文件末尾直接调用 renderNav()：各页面需要的是一进来就看到的导航，
 * 由调用方再包一层只会多一次时序问题，索性模块加载即渲染。
 */

import { api } from './api.js';
import { escapeHtml, readJson, STORAGE_KEYS, clearUserScopedStorage } from './util.js';
import { reportError } from './ui.js';

const PAGES = [
  { path: '/', label: '今日看板' },
  { path: '/stats', label: '统计' },
  { path: '/settings', label: '设置' },
];

/**
 * 渲染导航条：链接区同步画出，账号区异步填充（见下方 fillUserArea）。
 * 找不到 [data-nav] 容器时直接返回，方便在暂无导航的页面上安全引入。
 *
 * 副作用：改写 host 的 innerHTML；异步部分还会请求 /auth/me。
 */
export function renderNav() {
  const host = document.querySelector('[data-nav]');
  if (!host) return;

  // 去掉结尾斜杠，让 /stats 和 /stats/ 判定为同一页
  const current = location.pathname.replace(/\/+$/, '') || '/';

  const links = PAGES.map((page) => {
    const active = page.path === current ? ' aria-current="page"' : '';
    return `<a href="${page.path}"${active}>${page.label}</a>`;
  }).join('');

  // 先同步把链接渲染出来（瞬间完成），账号区留空稍后异步填 ——
  // 这里绝不能用 await：调用方是各页面的顶层代码，导航要立刻可见。
  host.innerHTML = `
    <div class="nav-inner">
      <a class="brand" href="/">
        <span class="brand-dot" aria-hidden="true"></span>
        FocusFlow
      </a>
      <div class="nav-right">
        <nav class="nav-links">${links}</nav>
        <div class="nav-user" data-nav-user></div>
      </div>
    </div>
  `;

  void fillUserArea(host);
}

/** 异步取当前用户，填右侧的「用户名 + 退出」。 */
async function fillUserArea(host) {
  let response;
  try {
    response = await api.me();
  } catch (error) {
    // 401 时 api.js 已经在跳登录页了，这里静默等跳转即可；
    // 其它错误（比如后端没起来）也不该刷一屏红字，导航栏空着就空着。
    console.warn('获取当前用户失败', error);
    return;
  }

  // ★ /auth/me 的 data 是 { user }，不是 user 本身。
  //   漏掉外面这层解构的话，user.username 会是 undefined ——
  //   页面不报错，只是导航栏上明晃晃写着「undefined」，很难一眼看出原因。
  const user = response?.user;
  if (!user?.id) {
    console.warn('当前用户响应形状不对，导航栏留空', response);
    return;
  }

  // 换了账号（或第一次登录）：把上一个账号残留的本地状态清掉，
  // 否则别人的计时器和未提交记录会被带进来。
  const remembered = readJson(STORAGE_KEYS.CURRENT_USER);
  if (remembered && remembered !== user.id) {
    clearUserScopedStorage();
  }
  // 注意：clearUserScopedStorage 会把 CURRENT_USER 一并删掉，所以要写在后面
  try {
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user.id));
  } catch {
    // 隐私模式下写不了，不影响使用
  }

  const slot = host.querySelector('[data-nav-user]');
  if (!slot) return;

  slot.innerHTML = `
    <span class="nav-username" title="${escapeHtml(user.username)}">${escapeHtml(user.username)}</span>
    <button type="button" class="ghost" data-logout>退出</button>
  `;

  slot.querySelector('[data-logout]')?.addEventListener('click', (event) => {
    void handleLogout(event.currentTarget);
  });
}

async function handleLogout(button) {
  button.disabled = true;

  // 退出会清空本地状态，所以在清之前先把还没提交的专注记录推上去。
  // 否则刚跑完的那个番茄就随着 localStorage.removeItem 一起没了。
  let pending = 0;
  try {
    const timer = await import('./timer.js');
    await timer.flushOutbox();
    pending = readJson(STORAGE_KEYS.OUTBOX, [])?.length ?? 0;
  } catch (error) {
    // 计时器模块没加载过也无所谓，flushOutbox 本来就允许在未初始化时调用
    console.warn('退出前同步未提交记录失败', error);
  }

  if (pending > 0) {
    const ok = confirm(
      `还有 ${pending} 条专注记录没能同步到服务器。现在退出会丢失这些记录，确定要退出吗？`,
    );
    if (!ok) {
      button.disabled = false;
      return;
    }
  }

  try {
    // logout 是公开路由：即使 cookie 已经过期或被篡改，也能把它清掉
    await api.logout();
  } catch (error) {
    // 服务端没清成功也要继续往下走，本地状态必须清干净，
    // 否则下次打开页面会用着上一个账号的缓存。
    reportError(error);
  }

  clearUserScopedStorage();
  location.assign('/login');
}

renderNav();
