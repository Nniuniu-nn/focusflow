import { api } from './api.js';
import { reportError, toast } from './ui.js';

/**
 * 设置页：读写计时偏好。
 * 注意后端 PUT 支持部分字段更新，这里整表单提交也无妨。
 *
 * 边界：本模块只管「表单 ↔ 服务端」这一来一回，不直接改本地计时器。
 * 数值类字段全部在提交前用 Number() 转换 —— 表单值一律是字符串，
 * 原样发出去服务端会因类型不符拒绝；空字符串转成 0 也交由服务端校验兜底。
 *
 * 保存提示特意写成「下一段计时生效」：timer.js 的 updateSettings 只替换
 * 设置对象，当前正在跑的那一段用的仍是旧时长，改完立刻变短/变长会很突兀。
 */

const FIELDS = ['focusMin', 'shortBreakMin', 'longBreakMin', 'longBreakEvery'];

/**
 * 设置页入口，由 settings.html 顶层脚本调用。
 * 先拉当前设置填表，再挂提交/重置监听；表单不存在时直接返回（便于复用同一脚本）。
 *
 * 副作用：改写表单控件值；提交时发 PUT 请求并弹 toast。
 *
 * @returns {Promise<void>}
 */
export async function initSettings() {
  const form = document.querySelector('#settings-form');
  if (!form) return;

  try {
    const settings = await api.getSettings();
    fillForm(form, settings);
  } catch (error) {
    reportError(error);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await save(form);
  });

  form.addEventListener('reset', () => {
    // 重置到「服务端当前值」而不是 HTML 默认值
    void (async () => {
      try {
        fillForm(form, await api.getSettings());
      } catch (error) {
        reportError(error);
      }
    })();
  });
}

/**
 * 把服务端设置回填到表单控件。
 *
 * 每个控件都先过 namedItem + instanceof 检查：HTML 里少写一个控件
 * 不该让整页崩掉，缺哪个就跳哪个。数值一律 String() 再赋给 value
 * （input.value 是字符串），autoStartNext 是唯一一个布尔勾选框，单独处理。
 *
 * @param {HTMLFormElement} form
 * @param {object} settings - 后端 /settings 返回对象
 */
function fillForm(form, settings) {
  for (const field of FIELDS) {
    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement) {
      input.value = String(settings[field]);
    }
  }

  const autoStart = form.elements.namedItem('autoStartNext');
  if (autoStart instanceof HTMLInputElement) {
    autoStart.checked = Boolean(settings.autoStartNext);
  }
}

/**
 * 收集表单值并整表 PUT 到服务端。失败交给 reportError（会弹错误 toast）。
 * 不在这里做「保存后刷新计时器」—— 新设置要等下一段才生效，见文件头说明。
 *
 * @param {HTMLFormElement} form
 * @returns {Promise<void>}
 */
async function save(form) {
  const patch = {};

  for (const field of FIELDS) {
    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement) {
      patch[field] = Number(input.value);
    }
  }

  const autoStart = form.elements.namedItem('autoStartNext');
  if (autoStart instanceof HTMLInputElement) {
    patch.autoStartNext = autoStart.checked;
  }

  try {
    await api.updateSettings(patch);
    toast('设置已保存（下一段计时生效）');
  } catch (error) {
    reportError(error);
  }
}
