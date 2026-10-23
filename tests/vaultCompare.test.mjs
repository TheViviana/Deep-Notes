// 自动同步比对器（src/neural/vaultCompare.js）回归：
// 与解析器同口径归一化 + 按 id 顺序无关比对——自己写盘的回声（trim 正文 / 空指标 null↔0 /
// media 缺省 / 正文 #话题 并入标签）与数组顺序差异不得误判为「外部变更」；
// 真正的外部改动（改正文 / 新增 / 删除 / 改分类）必须能识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVault} from '../src/neural/importer.js';
import {serialize} from '../src/neural/fileStore.js';
import {sameVaultContent} from '../src/neural/vaultCompare.js';

const f = (path, text) => ({
  name: path.split('/').pop(),
  webkitRelativePath: path,
  text: async () => text,
  lastModified: 0,
});

const baseWork = {id: 'w1', title: '文', date: '2026-10-01 12:00', direction: '', tags: ['方法'], body: '正文末尾有换行\n', media: null,
  views: 0, likes: null, comments: null, saves: null, follows: null, shares: null, impressions: null, ctr: null, duration: null};
const baseNote = {id: 'n1', title: '笔记 ', path: '05-方法库 methods/新建/笔记.md', body: '  首尾空白 \n'};
const baseReading = {id: 'r1', title: '读', author: '', source: '', folder: '收藏', date: '2026-10-02', body: 'x\n'};
const baseIdea = {id: 'idea-abc', title: '题', platform: '小红书', priority: '中', status: '待写', note: ''};

const filesOf = () => [
  f('vault/02-作品库/文.md', serialize('works', baseWork)),
  f('vault/05-方法库 methods/新建/笔记.md', serialize('notes', baseNote)),
  f('vault/06-阅读区/读.md', serialize('readings', baseReading)),
  f('vault/04-选题池/题.md', serialize('ideas', baseIdea)),
];
const curOf = () => ({works: [baseWork], notes: [baseNote], drafts: [], readings: [baseReading], archives: [], ideas: [baseIdea]});

test('自写回声不误判：trim 正文 / 空指标 / media 缺省 / 标题尾空白，往返后仍判无变化', async () => {
  const data = await parseVault(filesOf());
  assert.ok(sameVaultContent(curOf(), data, data.concepts));
});

test('顺序无关：内存与盘上的条目顺序不同仍判无变化（阅读按日期倒排、选题按文件序）', async () => {
  const a2 = {id: 'r2', title: '读二', author: '', source: '', folder: '', date: '2026-10-05', body: 'y'};
  const i2 = {id: 'idea-def', title: '题二', platform: '小红书', priority: '中', status: '待写', note: ''};
  const files = [...filesOf(),
    f('vault/06-阅读区/读二.md', serialize('readings', a2)),
    f('vault/04-选题池/题二.md', serialize('ideas', i2))];
  const data = await parseVault(files);
  // 内存顺序故意与解析结果相反：阅读内存 [旧, 新]、解析按日期 [新, 旧]
  const cur = curOf();
  cur.readings = [baseReading, a2];
  cur.ideas = [i2, baseIdea];
  assert.ok(sameVaultContent(cur, data, data.concepts));
});

test('真外部变更能识别：改正文 / 改分类 / 新增 / 删除', async () => {
  const data = await parseVault(filesOf());
  assert.ok(sameVaultContent(curOf(), data, data.concepts), '基线应判无变化');

  const changed = await parseVault(filesOf().map((x, i) => i === 2 ? f('vault/06-阅读区/读.md', serialize('readings', {...baseReading, body: 'x\n\n外部追加了一段'})) : x));
  assert.equal(sameVaultContent(curOf(), changed, changed.concepts), false, '正文被外部改动必须识别');

  const moved = await parseVault(filesOf().map((x, i) => i === 2 ? f('vault/06-阅读区/读.md', serialize('readings', {...baseReading, folder: '别类'})) : x));
  assert.equal(sameVaultContent(curOf(), moved, moved.concepts), false, '阅读分类被外部改动必须识别');

  const added = await parseVault([...filesOf(), f('vault/07-档案区/档.md', serialize('archives', {id: 'a1', title: '档', date: '2026-10-03', body: 'z'}))]);
  assert.equal(sameVaultContent(curOf(), added, added.concepts), false, '外部新增必须识别');

  const removed = await parseVault(filesOf().slice(1));
  assert.equal(sameVaultContent(curOf(), removed, removed.concepts), false, '外部删除必须识别');
});

test('正文带 #话题 的作品：解析端标签并集（frontmatter ∪ 正文话题）不造成误判', async () => {
  const w = {...baseWork, id: 'w2', tags: ['a'], body: '正文里提到 #方法 与 #a'};
  const data = await parseVault([f('vault/02-作品库/文.md', serialize('works', w))]);
  assert.deepEqual(data.works[0].tags, ['a', '方法']); // 解析端确实并入了正文话题
  assert.ok(sameVaultContent({works: [w], notes: [], drafts: [], readings: [], archives: [], ideas: []}, data, data.concepts));
});

test('概念词表：盘上概念是当前词表子集判无变化，出现新词判有变化', async () => {
  const data = await parseVault(filesOf());
  assert.ok(data.concepts.length > 0);
  assert.ok(sameVaultContent(curOf(), data, [...data.concepts, ['手动概念', ['x']]]), '内存词表更大（应用内新增概念）不算库变更');
  assert.equal(sameVaultContent(curOf(), data, []), false, '盘上有、内存没有的概念 → 有变化');
});
