// 附属数据三向合并回归（审计 B7，src/neural/conceptStore.js 的 merge3）：
// shadow 记录「本机已确认与盘上一致的最后一版」，据此判定每个键是哪边改的，
// 双机来回编辑不互相抹；冲突取盘上收敛（多台机器最终一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {merge3} from '../src/neural/conceptStore.js';

test('merge3：两边一致时结果不变', () => {
  assert.deepEqual(merge3({a: 1}, {a: 1}, {a: 1}), {a: 1});
});

test('merge3：本地没动（== shadow）用盘上——另一台机器的新增 / 修改同步进来', () => {
  assert.deepEqual(merge3({a: 1}, {a: 1, b: 2}, {a: 1}), {a: 1, b: 2});
  assert.deepEqual(merge3({a: 1}, {a: 9}, {a: 1}), {a: 9});
});

test('merge3：盘上没动（== shadow）用本地——本机新增的卡片不丢', () => {
  assert.deepEqual(merge3({a: 1, c: 3}, {a: 1}, {a: 1}), {a: 1, c: 3});
});

test('merge3：两边都动同一键时取盘上，双机收敛到同一份', () => {
  assert.deepEqual(merge3({a: 2}, {a: 3}, {a: 1}), {a: 3});
});

test('merge3：删除语义——一边删另一边没动时，删除生效', () => {
  assert.deepEqual(merge3({}, {a: 1}, {a: 1}), {}, '本地删了、盘上没动 → 尊重本地删除');
  assert.deepEqual(merge3({a: 1}, {}, {a: 1}), {}, '盘上删了、本地没动 → 尊重盘上删除');
});

test('merge3：无 shadow 键也能合（新增键两边都有时取盘上）', () => {
  assert.deepEqual(merge3({a: 1}, {a: 2}, {}), {a: 2});
  assert.deepEqual(merge3({a: 1}, {}, {}), {a: 1}, '只本地有 → 保留');
  assert.deepEqual(merge3({}, {b: 2}, {}), {b: 2}, '只盘上有 → 收进来');
});
