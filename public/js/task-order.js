/**
 * 任务排序的纯逻辑。
 *
 * 与 board.js 分开是为了可测试：拖拽要碰 DOM，而「把某个 id 移到另一个 id
 * 前/后」只是数组操作。这个模块不引用 DOM、不发请求，所有函数都返回新数组，
 * 绝不原地修改入参 —— board.js 需要用旧数组做请求失败后的回滚。
 *
 * 找不到 id、拖到自己身上、越界移动都属于「无事发生」，统一返回原顺序的副本，
 * 让调用方不必区分这些分支。
 */

/**
 * 把 activeId 移到 targetId 之前，返回新数组。
 *
 * @param {string[]} ids - 当前顺序
 * @param {string} activeId - 被拖动的任务 id
 * @param {string} targetId - 落点参照的任务 id
 * @returns {string[]} 新顺序；任何一方不存在时返回原顺序的副本
 */
export function moveBefore(ids, activeId, targetId) {
  return moveRelative(ids, activeId, targetId, 0);
}

/**
 * 把 activeId 移到 targetId 之后，返回新数组。
 *
 * @param {string[]} ids - 当前顺序
 * @param {string} activeId - 被拖动的任务 id
 * @param {string} targetId - 落点参照的任务 id
 * @returns {string[]} 新顺序；任何一方不存在时返回原顺序的副本
 */
export function moveAfter(ids, activeId, targetId) {
  return moveRelative(ids, activeId, targetId, 1);
}

/**
 * 键盘排序：把 activeId 上移/下移一位。
 *
 * 越界（已经在最前/最后）或 delta 非法时不动，而不是把任务挪到数组另一端 ——
 * 用户按住 Alt+↑ 到顶后继续按，预期是「没反应」，不是「跳到末尾」。
 *
 * @param {string[]} ids - 当前顺序
 * @param {string} activeId - 要移动的任务 id
 * @param {number} delta - -1 上移，+1 下移（只接受这两个整数）
 * @returns {string[]} 新顺序
 */
export function moveBy(ids, activeId, delta) {
  if (delta !== -1 && delta !== 1) return [...ids];

  const from = ids.indexOf(activeId);
  if (from === -1) return [...ids];

  const to = from + delta;
  if (to < 0 || to >= ids.length) return [...ids];

  return delta < 0
    ? moveBefore(ids, activeId, ids[to])
    : moveAfter(ids, activeId, ids[to]);
}

/**
 * 移动到 targetId 的前（offset=0）或后（offset=1）。
 *
 * 先把 active 从数组里摘掉，再在「摘掉之后」的坐标里插入：直接沿用原下标
 * 会因为在 active 之前的元素少了一个而错位。
 *
 * @param {string[]} ids
 * @param {string} activeId
 * @param {string} targetId
 * @param {0|1} offset
 * @returns {string[]}
 */
function moveRelative(ids, activeId, targetId, offset) {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || activeId === targetId) return [...ids];

  const result = [...ids];
  result.splice(from, 1);

  // active 原本在 target 之前时，摘掉后 target 的下标要减一
  const targetIndex = from < to ? to - 1 : to;
  result.splice(targetIndex + offset, 0, activeId);
  return result;
}
