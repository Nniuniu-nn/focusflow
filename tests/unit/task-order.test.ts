/**
 * 任务排序纯函数单测。
 *
 * 覆盖 public/js/task-order.js。拖拽交互本身在 board.js 里（要碰 DOM，不做单测），
 * 但「把某个 id 移到另一个 id 前/后」这一步是纯数组操作，单独抽出来之后
 * 就能在 Node 环境直接断言，不需要 jsdom。
 *
 * 这里守的边界：
 *   - 不允许原地修改入参（board.js 会用旧数组做失败回滚）；
 *   - 找不到 id、拖到自己身上时返回顺序不变的副本，而不是抛错；
 *   - 越界的键盘移动直接不生效。
 */
import { describe, expect, it } from 'vitest';
import { moveAfter, moveBefore, moveBy } from '../../public/js/task-order.js';

const IDS = ['a', 'b', 'c', 'd'];

describe('moveBefore', () => {
  it('把靠后的任务移到最前', () => {
    expect(moveBefore(IDS, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });

  it('把靠前的任务移到中间任务之前', () => {
    expect(moveBefore(IDS, 'a', 'c')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('目标原本就在自己后面一位时顺序不变', () => {
    expect(moveBefore(IDS, 'a', 'b')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('拖到自己身上时顺序不变', () => {
    expect(moveBefore(IDS, 'c', 'c')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('找不到 active 或 target 时返回原顺序', () => {
    expect(moveBefore(IDS, 'missing', 'a')).toEqual(IDS);
    expect(moveBefore(IDS, 'a', 'missing')).toEqual(IDS);
  });

  it('不修改入参数组', () => {
    const original = [...IDS];
    moveBefore(IDS, 'd', 'a');
    expect(IDS).toEqual(original);
  });
});

describe('moveAfter', () => {
  it('把最前的任务移到末尾', () => {
    expect(moveAfter(IDS, 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('把靠后的任务移到中间任务之后', () => {
    expect(moveAfter(IDS, 'd', 'b')).toEqual(['a', 'b', 'd', 'c']);
  });

  it('目标原本就在自己前面一位时顺序不变', () => {
    expect(moveAfter(IDS, 'b', 'a')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('拖到自己身上时顺序不变', () => {
    expect(moveAfter(IDS, 'c', 'c')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('找不到 active 或 target 时返回原顺序', () => {
    expect(moveAfter(IDS, 'missing', 'a')).toEqual(IDS);
    expect(moveAfter(IDS, 'a', 'missing')).toEqual(IDS);
  });

  it('不修改入参数组', () => {
    const original = [...IDS];
    moveAfter(IDS, 'a', 'd');
    expect(IDS).toEqual(original);
  });
});

describe('moveBy（键盘上下移动）', () => {
  it('上移一位', () => {
    expect(moveBy(IDS, 'b', -1)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('下移一位', () => {
    expect(moveBy(IDS, 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('已经在最前时上移不生效', () => {
    expect(moveBy(IDS, 'a', -1)).toEqual(IDS);
  });

  it('已经在最后时下移不生效', () => {
    expect(moveBy(IDS, 'd', 1)).toEqual(IDS);
  });

  it('找不到 id 时返回原顺序', () => {
    expect(moveBy(IDS, 'missing', 1)).toEqual(IDS);
  });

  it('delta 为 0 或非法值时返回原顺序', () => {
    expect(moveBy(IDS, 'b', 0)).toEqual(IDS);
    expect(moveBy(IDS, 'b', 1.5)).toEqual(IDS);
  });

  it('不修改入参数组', () => {
    const original = [...IDS];
    moveBy(IDS, 'b', 1);
    expect(IDS).toEqual(original);
  });
});
