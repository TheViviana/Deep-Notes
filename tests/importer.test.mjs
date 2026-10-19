// 软件内知识库导入测试（src/neural/importer.js）：目录分类、frontmatter 中英文字段、
// 数值简写（1.2万）、媒体类型、选题来源解析、概念词推导。File 对象用桩代替。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVault} from '../src/neural/importer.js';

const f = (path, text, lastModified = 0) => ({
  name: path.split('/').pop(),
  webkitRelativePath: path,
  text: async () => text,
  lastModified
});

const files = [
  f('vault/01-作品库 works/甲.md',
    '---\ntitle: 甲\n观看: 1.2万\nlikes: 100\ndate: 2026-01-02\n类型: 视频\ntags: [t1, t2]\n---\n正文甲'),
  f('vault/01-作品库 works/乙.md',
    '---\ntitle: 乙\ndate: 2026-01-01\ntags: [t1]\n---\n正文乙 #t3'),
  f('vault/05-方法库 methods/写作/方法一.md',
    '# 方法一\n方法内容'),
  f('vault/04-选题池 ideas/选题一.md',
    '---\npriority: 高\n---\n备注内容'),
  f('vault/03-创作台 drafts/草稿一.md',
    '---\nsource: 选题一\n---\n草稿正文'),
  f('vault/06-阅读区 readings/阅读一.md',
    '---\ntitle: 阅读一\nauthor: 某作者\nsource: 某博客\ndate: 2026-02-10\n---\n阅读正文'),
  f('vault/README.txt', '不是 Markdown，应被忽略')
];

test('目录按名字分类：作品 / 方法 / 选题 / 草稿 / 阅读，非 md 文件被忽略', async () => {
  const r = await parseVault(files);
  assert.equal(r.vault, 'vault');
  assert.equal(r.counts.works, 2);
  assert.equal(r.counts.notes, 1);
  assert.equal(r.counts.ideas, 1);
  assert.equal(r.counts.drafts, 1);
  assert.equal(r.counts.readings, 1);
  const rd = r.readings[0];
  assert.equal(rd.title, '阅读一');
  assert.equal(rd.author, '某作者');
  assert.equal(rd.source, '某博客');
  assert.equal(rd.date, '2026-02-10');
  assert.equal(rd.body, '阅读正文');
  assert.ok(!JSON.stringify(r.counts).includes('README'));
});

test('frontmatter 中英文字段与数值简写：1.2万 → 12000，类型视频', async () => {
  const r = await parseVault(files);
  const w = r.works.find(x => x.title === '甲');
  assert.equal(w.views, 12000);
  assert.equal(w.likes, 100);
  assert.equal(w.media, 'video');
  assert.ok(w.date.startsWith('2026-01-02'));
  assert.ok(w.tags.includes('t1') && w.tags.includes('t2'));
});

test('作品按日期倒序排列', async () => {
  const r = await parseVault(files);
  assert.equal(r.works[0].title, '甲');
});

test('方法笔记路径包含子目录', async () => {
  const r = await parseVault(files);
  assert.equal(r.notes[0].title, '方法一');
  assert.equal(r.notes[0].path, '05-方法库 methods/写作/方法一.md');
});

test('选题：优先级识别，正文作为备注回退', async () => {
  const r = await parseVault(files);
  const idea = r.ideas[0];
  assert.equal(idea.title, '选题一');
  assert.equal(idea.priority, '高');
  assert.equal(idea.status, '待写');
  assert.ok(idea.note.includes('备注内容'));
});

test('草稿：来源选题按标题解析为 id', async () => {
  const r = await parseVault(files);
  assert.equal(r.drafts[0].title, '草稿一');
  assert.equal(r.drafts[0].source, r.ideas[0].id);
});

test('概念词：出现在两条以上内容的话题标签才入选', async () => {
  const r = await parseVault(files);
  // t1 出现在甲、乙两条作品 → 入选；t2 / t3 只出现一次 → 落选
  assert.ok(r.concepts.some(([name]) => name === 't1'));
  assert.ok(!r.concepts.some(([name]) => name === 't2' || name === 't3'));
});

test('快照：来源说明为本地导入，日期区间来自作品', async () => {
  const r = await parseVault(files);
  assert.equal(r.snapshot.source, '导入自本地笔记');
  assert.equal(r.snapshot.publishedFrom, '2026-01-01');
  assert.equal(r.snapshot.publishedTo, '2026-01-02');
});
