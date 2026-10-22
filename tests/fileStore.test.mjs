// 桌面版写盘链路测试（src/neural/fileStore.js）：序列化往返（keep 数组 / updated）、
// 同名消歧、防抖队列的写 / 移动 / 删除与失败重试、知识库根目录键迁移。
// window / localStorage / window.deepnotes.vault 全部用桩代替。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVault} from '../src/neural/importer.js';
import {serialize, resolveRels, queueSync, flush, flushAll, setErrorHandler, retryPending, hasPendingWrites, clearPendingWrites, snapshotBeforeAdopt, listSnapshots} from '../src/neural/fileStore.js';
import {VAULT_ROOT_KEY, CONFIG} from '../src/config.js';

// —— 浏览器全局桩：fileStore 引用裸 localStorage 与 window.deepnotes ——
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.window = {};

const f = (path, text) => ({
  name: path.split('/').pop(),
  webkitRelativePath: path,
  text: async () => text,
  lastModified: 0,
});

test('序列化往返：keep 数组值多行落盘再导入不变形，updated 写进 frontmatter', async () => {
  const md = serialize('notes', {
    id: 'n1', title: '甲', path: '05-方法库 methods/A/甲.md', body: '正文', updatedAt: '2026-03-01 10:00',
    keep: {主题: ['读书', '方法'], 来源: '手记'},
  });
  assert.ok(md.includes('主题:\n  - 读书\n  - 方法')); // 数组展开成多行而不是压成逗号串
  assert.ok(md.includes('updated: 2026-03-01 10:00'));
  const r = await parseVault([f('vault/05-方法库 methods/A/甲.md', md)]);
  const n = r.notes[0];
  assert.equal(n.id, 'n1');
  assert.deepEqual(n.keep['主题'], ['读书', '方法']); // 往返后仍是数组
  assert.equal(n.keep['来源'], '手记');
  assert.equal(n.updatedAt, '2026-03-01 10:00'); // updated 不再恒丢
});

test('序列化往返：作品 keep 与指标、阅读 folder、档案 updated 同样往返', async () => {
  const w = serialize('works', {id: 'w1', title: '文', date: '2026-03-02 09:00', tags: ['a'], views: 10, body: 'b', keep: {栏目: ['x']}});
  assert.ok(w.includes('栏目:\n  - x'));
  const rw = await parseVault([f('vault/01-作品库 works/文.md', w)]);
  assert.equal(rw.works[0].views, 10);
  assert.deepEqual(rw.works[0].keep['栏目'], ['x']);

  const arc = serialize('archives', {id: 'a1', title: '档', date: '2026-03-03', body: 'x', updatedAt: '2026-03-04 08:00'});
  const ra = await parseVault([f('vault/07-档案区 archives/档.md', arc)]);
  assert.equal(ra.archives[0].updatedAt, '2026-03-04 08:00');
});

test('resolveRels：同名标题追加 id 短码消歧，每组第一条保持原名；notes 用自身 path', () => {
  const rels = resolveRels('works', [
    {id: 'w1', title: '同名'},
    {id: 'w2', title: '同名'},
    {id: 'w3', title: '不同'},
  ]);
  assert.equal(rels.get('w1'), '02-作品库/同名.md');
  assert.match(rels.get('w2'), /^02-作品库\/同名--\w+\.md$/);
  assert.equal(rels.get('w3'), '02-作品库/不同.md');
  const nr = resolveRels('notes', [{id: 'n1', path: '05-方法库 methods/A/甲.md'}]);
  assert.equal(nr.get('n1'), '05-方法库 methods/A/甲.md');
});

test('queueSync + flush：写盘带 deepnotes-id，先 move 后 write，同路径多操作不互相吞', async () => {
  const calls = [];
  window.deepnotes = {vault: {
    write: async (root, rel, body) => { calls.push(['write', rel, body]); return {ok: true}; },
    move: async (root, from, to) => { calls.push(['move', from, to]); return {ok: true}; },
    trash: async (root, rel) => { calls.push(['trash', rel]); return {ok: true}; },
  }};
  store.set(VAULT_ROOT_KEY, '/tmp/vault');
  const item = {id: 'd1', title: '草稿', body: '正文'};
  const relMap = resolveRels('drafts', [item]);
  queueSync('drafts', item, null, relMap);
  await flush();
  assert.deepEqual(calls.map(c => c[0]), ['write']);
  assert.match(calls[0][2], /^---\ndeepnotes-id: d1/); // 序列化结果带稳定 id 标识
  assert.equal(relMap.get('d1'), '03-创作台/正在写/草稿.md');

  // 改名：move 旧路径 → 新路径，随后 write 新内容（两个操作都要执行）
  calls.length = 0;
  const renamed = {...item, title: '草稿二'};
  const newMap = resolveRels('drafts', [renamed]);
  queueSync('drafts', renamed, item, newMap, relMap);
  await flush();
  assert.deepEqual(calls.map(c => c[0]), ['move', 'write']);
  assert.deepEqual(calls[0].slice(1), ['03-创作台/正在写/草稿.md', '03-创作台/正在写/草稿二.md']);

  // 删除：item 为 null → trash 旧路径
  calls.length = 0;
  queueSync('drafts', null, renamed, newMap);
  await flush();
  assert.deepEqual(calls.map(c => c[0]), ['trash']);
});

test('flush：写盘失败自动重试一次，仍失败才回调 errorHandler，内容不丢队列外', async () => {
  let n = 0;
  const failed = [];
  setErrorHandler(list => failed.push(...list));
  window.deepnotes = {vault: {
    write: async () => { n++; return {ok: false, error: '磁盘满'}; },
  }};
  const item = {id: 'd9', title: '失败稿', body: 'x'};
  queueSync('drafts', item, null, resolveRels('drafts', [item]));
  await flush(); // 第一次失败 → 进入重试队列
  await flush(); // 手动触发重试（清掉 2.5s 定时器立刻跑）
  assert.equal(n, 2);
  assert.deepEqual(failed, ['03-创作台/正在写/失败稿.md']);
  setErrorHandler(null);
});

test('知识库根目录键迁移：旧前缀键里的路径自动迁到固定键', async () => {
  store.clear();
  store.set('neural-dashboard-vault-root-v1', '/Users/demo/我的库');
  const {getRoot} = await import('../src/neural/fileStore.js');
  assert.equal(getRoot(), '/Users/demo/我的库');
  assert.equal(store.get(VAULT_ROOT_KEY), '/Users/demo/我的库'); // 固定键已写入
  assert.equal(store.get('neural-dashboard-vault-root-v1'), '/Users/demo/我的库'); // 旧键保留，回退旧版本不丢
});

// —— 审计 v2-① 回归：留底不能在写盘结果未知前清掉 ——

const PENDING_KEY = CONFIG.storagePrefix + '-pending-writes-v1';
const makePending = async (id, title) => {
  const item = {id, title, body: 'x'};
  queueSync('drafts', item, null, resolveRels('drafts', [item]));
  await flush();
  await flush(); // 两次失败 → 挂起留底
};

test('retryPending：写盘完成前留底不清除，成功后才清（审计 v2-①）', async () => {
  store.clear();
  store.set(VAULT_ROOT_KEY, '/tmp/vault');
  setErrorHandler(() => {});
  window.deepnotes = {vault: {write: async () => ({ok: false, error: '磁盘满'})}};
  await makePending('d10', '挂起稿');
  assert.ok(JSON.parse(store.get(PENDING_KEY)).length, '两次失败后留底已记录');
  // 写盘挂起期间：留底必须还在（旧实现先清后写，进程此时被杀就会丢编辑）
  let release, released = false;
  window.deepnotes.vault.write = () => released
    ? Promise.resolve({ok: true})
    : new Promise(r => { release = () => { released = true; r({ok: true}); }; });
  const done = retryPending();
  await new Promise(r => setTimeout(r, 10)); // 让重试的 flush 进入写盘等待
  assert.ok(JSON.parse(store.get(PENDING_KEY)).length, '写盘结果未知前留底不清');
  release({ok: true});
  await done;
  assert.ok(!hasPendingWrites(), '写盘成功后留底清除');
  assert.ok(!store.has(PENDING_KEY), 'localStorage 留底键已移除');
  setErrorHandler(null);
});

test('retryPending：写盘仍失败时留底保留', async () => {
  store.clear();
  store.set(VAULT_ROOT_KEY, '/tmp/vault');
  setErrorHandler(() => {});
  window.deepnotes = {vault: {write: async () => ({ok: false, error: '磁盘满'})}};
  await makePending('d11', '仍失败');
  const n = await retryPending();
  assert.equal(n, 1);
  assert.ok(hasPendingWrites(), '仍失败：留底保留（由 flush 失败路径重新记录）');
  assert.ok(JSON.parse(store.get(PENDING_KEY)).length, 'localStorage 里的留底还在');
  setErrorHandler(null);
});

test('retryPending：没有桌面 API 时不清留底', async () => {
  store.clear();
  store.set(VAULT_ROOT_KEY, '/tmp/vault');
  setErrorHandler(() => {});
  window.deepnotes = {vault: {write: async () => ({ok: false, error: '磁盘满'})}};
  await makePending('d12', '无API');
  window.deepnotes = {}; // 撤掉 vault API
  assert.equal(await retryPending(), 0);
  assert.ok(hasPendingWrites(), '留底原样保留（清了就真丢）');
  assert.ok(JSON.parse(store.get(PENDING_KEY)).length);
  setErrorHandler(null);
});

// —— 自动同步防丢编辑回归：flushAll 必须把队列写尽（含一次自动重试）再返回 ——

test('flushAll：含自动重试写尽队列，重试成功不留底；空队列无害', async () => {
  store.clear();
  clearPendingWrites();
  store.set(VAULT_ROOT_KEY, '/tmp/vault');
  let n = 0;
  const rels = [];
  window.deepnotes = {vault: {
    write: async (root, rel) => { n++; rels.push(rel); return n === 1 ? {ok: false, error: '瞬时故障'} : {ok: true}; },
  }};
  setErrorHandler(() => {});
  const item = {id: 'd20', title: '重试稿', body: 'x'};
  queueSync('drafts', item, null, resolveRels('drafts', [item]));
  await flushAll(); // 第一次失败入重试队列，flushAll 内部第二次写成功
  assert.equal(n, 2, '同一操作共写两次（原次 + 重试）');
  assert.ok(!hasPendingWrites(), '重试成功不留底');
  await flushAll(); // 队列已空：no-op
  assert.equal(n, 2);
  setErrorHandler(null);
});

test('flushAll：持续失败全部留底，队列写尽后返回（同步可据此跳过）', async () => {
  store.clear();
  clearPendingWrites();
  store.set(VAULT_ROOT_KEY, '/tmp/vault');
  let n = 0;
  window.deepnotes = {vault: {write: async () => { n++; return {ok: false, error: '磁盘满'}; }}};
  setErrorHandler(() => {});
  const item = {id: 'd21', title: '留底稿', body: 'x'};
  queueSync('drafts', item, null, resolveRels('drafts', [item]));
  await flushAll();
  assert.equal(n, 2, '原次 + 重试各一次');
  assert.ok(hasPendingWrites(), '两次失败 → 挂起留底（同步据此跳过防覆盖）');
  // 清掉留底再单独验证第二轮：无历史留底干扰时，flushAll 恰好原次 + 重试各一次
  clearPendingWrites();
  const before = n;
  const item2 = {id: 'd22', title: '再排', body: 'y'};
  queueSync('drafts', item2, null, resolveRels('drafts', [item2]));
  await flushAll();
  assert.equal(n, before + 2, '第二条同样原次 + 重试，队列写尽');
  assert.ok(JSON.parse(store.get(PENDING_KEY)).some(op => op.rel.includes('再排')), '第二条留底已记录');
  setErrorHandler(null);
  clearPendingWrites();
});

// —— 应用内快照（文件恢复第二层网）：外部同步 adopt 用盘上版本覆盖内存前，先把内存里
// 有差异的条目记进 IndexedDB 快照网（测试环境无 indexedDB，持久层静默失败、内存列表可用）——

test('snapshotBeforeAdopt：外部覆盖前记录内存版本，同内容重跑不重复，每条上限 15 份、新的在前', () => {
  const cur = {drafts: [{id: 'd1', title: '稿', body: '旧版'}]};
  const fresh = {drafts: [{id: 'd1', title: '稿', body: '新版'}]};
  snapshotBeforeAdopt(cur, fresh); // 内存版本『旧版』即将被盘上『新版』顶掉：先留快照
  let list = listSnapshots();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'drafts:d1');
  assert.equal(list[0].item.body, '旧版', '存的是即将被覆盖的内存版本');
  assert.ok(list[0].ts > 0);
  assert.equal(list[0].title, '稿');
  snapshotBeforeAdopt(cur, fresh); // 同样的差异再跑一遍：内容相同不重复记
  assert.equal(listSnapshots().length, 1);
  snapshotBeforeAdopt({drafts: [{id: 'd1', title: '稿', body: '新版'}]}, fresh); // 内存与盘上一致：不记
  assert.equal(listSnapshots().length, 1);
  // 盘上没有的条目视为应用内已删除（.trash 可找回），不参与快照
  snapshotBeforeAdopt({drafts: [{id: 'd2', title: '已删', body: 'x'}]}, fresh);
  assert.equal(listSnapshots().length, 1);
  // 每轮内容变化都记一份，超出 15 份只留最新 15 份
  for (let i = 0; i < 20; i++) {
    snapshotBeforeAdopt(
      {drafts: [{id: 'd1', title: '稿', body: '内存 v' + i}]},
      {drafts: [{id: 'd1', title: '稿', body: '盘上 v' + i}]});
  }
  const mine = listSnapshots().filter(s => s.key === 'drafts:d1');
  assert.equal(mine.length, 15, '每条内容最多保留 15 份');
  assert.equal(mine[0].item.body, '内存 v19', '新的在前');
  assert.equal(mine[14].item.body, '内存 v5', '最旧的被截掉');
});
