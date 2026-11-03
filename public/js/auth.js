/**
 * 登录 / 注册页：两个表单同页切换，成功后带着 cookie 跳回原页面。
 *
 * 这个文件只被 login.html 加载，且登录页刻意不引入 nav.js
 * （见 login.html 里的注释）。
 *
 * 边界：只做「表单校验 + 提交 + 展示错误」，不渲染导航、不读写计时器状态。
 * 表单里的错误提示能留得住，靠的是 api.js 对 /auth/login、/auth/register
 * 的 401 原样抛出而不跳转 —— 两者是配套的，改动任一侧都要一起想。
 */

import { api } from './api.js';
import { readJson, STORAGE_KEYS, clearUserScopedStorage } from './util.js';

/** 与 src/lib/validate.ts 的 USERNAME_RE 保持一致 */
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
/** 与服务端一致：scrypt 之前先挡住超长输入，避免拿它当 DoS 用 */
const PASSWORD_MAX_LENGTH = 72;

const tabs = [...document.querySelectorAll('[data-auth-tab]')];
const forms = [...document.querySelectorAll('[data-auth-form]')];

/**
 * 落库前先做一次纯客户端校验，图的是即时反馈；服务端仍然会再校验一遍，
 * 它才是最终裁决者。
 * 用户名先按服务端的规则归一化再判断，否则「Alice」会被这里拦下、
 * 而服务端其实会把它归一成「alice」接受 —— 两边规则必须一致。
 */
function normalizeUsername(raw) {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/**
 * 登录只校验「填没填」：具体规则交给服务端，避免本地规则比服务端更严
 * 而把合法账号挡在门外（比如历史遗留的短密码）。
 *
 * @returns {string|null} 错误文案；null 表示通过
 */
function validateLogin(username, password) {
  if (!username) return '请输入用户名';
  if (!password) return '请输入密码';
  return null;
}

/**
 * 注册要按服务端的完整规则校验，越早反馈越好。
 * 密码不 trim：首尾空格属于密码内容，trim 会让用户「看到的」和「提交的」不一致。
 *
 * @returns {string|null} 错误文案；null 表示通过
 */
function validateRegister(username, password) {
  if (!username) return '请输入用户名';
  if (!USERNAME_RE.test(username)) {
    return '用户名只能是 3–32 位的字母、数字或下划线';
  }
  if (!password) return '请输入密码';
  // 密码不做 trim：首尾空格是密码的一部分
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`;
  return null;
}

/** 取某个表单自己的错误槽；两个表单各有各的，不能共用一个 */
function errorSlot(form) {
  return form.querySelector('[data-form-error]');
}

/** 在表单的错误槽里显示文案（用 textContent，天然免疫 HTML 注入） */
function showError(form, message) {
  const slot = errorSlot(form);
  slot.textContent = message;
  slot.hidden = false;
}

/** 清空错误槽并隐藏。切模式、重新提交前都要调用，否则旧错误会残留 */
function clearError(form) {
  const slot = errorSlot(form);
  slot.textContent = '';
  slot.hidden = true;
}

/**
 * 登录成功后的落点。
 *
 * 只接受本站的绝对路径：`//evil.com` 是协议相对 URL，浏览器会当成外站，
 * 所以必须在 `startsWith('/')` 之外单独挡掉，否则就是一个开放重定向。
 */
function safeNext() {
  const raw = new URLSearchParams(location.search).get('next');
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

/** 记录当前账号，顺便清掉上一个账号残留的本地状态 */
function adoptUser(user) {
  const remembered = readJson(STORAGE_KEYS.CURRENT_USER);

  // 换账号时必须清：计时器和待提交队列用的是全局 key，不清的话
  // 上一个账号没提交的专注记录会被记到新账号名下。
  if (remembered && remembered !== user.id) {
    clearUserScopedStorage();
  }

  try {
    // clearUserScopedStorage 会把 CURRENT_USER 一起删掉，所以写在它后面
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user.id));
  } catch {
    // 隐私模式写不了，不影响主流程
  }
}

/**
 * 两个表单共用的提交处理。
 *
 * 提交期间禁用按钮并临时改文案，防止重复点击产生两次请求；
 * finally 里一定会还原，即使请求抛错按钮也不会卡在禁用态。
 * 成功时 adoptUser 记录账号（并清理上个账号的本地残留）后再跳转。
 *
 * @param {'login'|'register'} mode
 * @param {HTMLFormElement} form
 * @param {Event} event
 */
async function onSubmit(mode, form, event) {
  event.preventDefault();
  clearError(form);

  const username = normalizeUsername(form.elements.username.value);
  const password = form.elements.password.value;

  const problem =
    mode === 'register' ? validateRegister(username, password) : validateLogin(username, password);
  if (problem) {
    showError(form, problem);
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = mode === 'login' ? '登录中…' : '注册中…';

  try {
    const { user } = await api[mode](username, password);
    adoptUser(user);
    location.assign(safeNext());
  } catch (error) {
    // 登录失败与注册重名都在这里显示。
    // api.js 对这两个接口的 401 是原样抛出的（不跳转），所以这句提示留得住。
    showError(form, error?.message || '操作失败，请重试');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/**
 * 切换到登录或注册。用 hidden 属性而非移除节点，两个表单都常驻 DOM，
 * 切换只是显隐。切完把焦点放到用户名框，键盘用户可以直接开打字。
 *
 * @param {'login'|'register'} mode
 */
function setMode(mode) {
  for (const tab of tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.authTab === mode));
  }

  for (const form of forms) {
    const active = form.dataset.authForm === mode;
    form.hidden = !active;
    clearError(form);
    // 清掉密码框：在「注册」里敲的密码不该留在「登录」里，
    // 反过来也一样，切换一下就把刚输的密码带过去很怪。
    form.elements.password.value = '';
  }

  document.querySelector(`[data-auth-form="${mode}"]`)?.elements.username.focus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setMode(tab.dataset.authTab));
}

for (const form of forms) {
  form.addEventListener('submit', (event) => {
    void onSubmit(form.dataset.authForm, form, event);
  });
}

setMode('login');
