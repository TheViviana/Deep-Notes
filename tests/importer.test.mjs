// 软件内知识库导入测试（src/neural/importer.js）：目录分类、frontmatter 中英文字段、
// 数值简写（1.2万）、媒体类型、选题来源解析、概念词推导、阅读区分类往返。File 对象用桩代替。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVault} from '../src/neural/importer.js';
import {serialize} from '../src/neural/fileStore.js';

const f = (path, text, lastModified = 0) => ({
  name: path.split('/').pop(),
  webkitRelativePath: path,
  text: async () => text,
  lastModified
});

const files = [
  f('vault/01-作品库 works/甲.md',
    '---\ntitle: 甲\n观看: 1.2万\nlikes: 100\n涨粉: 12\n分享: 30\n曝光: 5.1万\nctr: 0.062\nduration: 75\ndate: 2026-01-02\n类型: 视频\ntags: [t1, t2]\n---\n正文甲'),
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
  // 指标字段与 CLI 同一套别名：涨粉 / 分享 / 曝光 / ctr / 时长都要读出来（缺侧分析面板丢数据）
  assert.equal(w.follows, 12);
  assert.equal(w.shares, 30);
  assert.equal(w.impressions, 51000);
  assert.equal(w.ctr, 0.062);
  assert.equal(w.duration, 75);
  assert.ok(!w.keep, '已消费的指标键不应进 keep（否则写回 frontmatter 出现重复行）');
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

test('方法库根目录直下的文件路径不再重复目录名，兜底归入「笔记」', async () => {
  const r = await parseVault([
    f('vault/05-方法库 methods/根下笔记.md', '内容'),
  ]);
  assert.equal(r.notes[0].path, '05-方法库 methods/笔记/根下笔记.md');
  // 分类兜底命中的普通目录名（不匹配方法库规则）仍原样保留
  const r2 = await parseVault([
    f('vault/读书笔记/散记.md', '内容'),
  ]);
  assert.equal(r2.notes[0].path, '05-方法库 methods/读书笔记/散记.md');
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

test('概念词：全部话题标签入选（不限数量），按出现次数排序', async () => {
  const r = await parseVault(files);
  // 不设阈值与上限：t1 出现两次、t2 / t3 出现一次，全部入选，出现多的排前面
  assert.ok(r.concepts.some(([name]) => name === 't1'));
  assert.ok(r.concepts.some(([name]) => name === 't2'));
  assert.ok(r.concepts.some(([name]) => name === 't3'));
  assert.ok(r.concepts.findIndex(([name]) => name === 't1') < r.concepts.findIndex(([name]) => name === 't2'));
});

test('快照：来源说明为本地导入，日期区间来自作品', async () => {
  const r = await parseVault(files);
  assert.equal(r.snapshot.source, '导入自本地笔记');
  assert.equal(r.snapshot.publishedFrom, '2026-01-01');
  assert.equal(r.snapshot.publishedTo, '2026-01-02');
});

test('阅读区分类往返：folder 落盘进 frontmatter，再导入不丢分类', async () => {
  const md = serialize('readings', {
    id: 'reading-1', title: '阅读一', author: '某作者', source: '某博客',
    folder: '技术长文', date: '2026-02-10', body: '阅读正文',
  });
  assert.ok(md.includes('folder: 技术长文'));
  const r = await parseVault([f('vault/06-阅读区 readings/阅读一.md', md)]);
  const rd = r.readings[0];
  assert.equal(rd.folder, '技术长文'); // 再导入 / 自动同步后分类还在
  assert.equal(rd.title, '阅读一');
  assert.equal(rd.body, '阅读正文');
  assert.equal(rd.id, 'reading-1'); // deepnotes-id 随 frontmatter 往返
  // 没有分类的阅读不受影响：folder 为空字符串，落盘时不写 folder 行
  const plain = serialize('readings', {id: 'reading-2', title: '无分类', folder: '', date: '2026-02-11', body: 'x'});
  assert.ok(!plain.includes('folder:'));
});

test('稳定 id：deepnotes-id 往返，文件顺序变化 / 新增文件后已有 id 不变（防交叉误删回归）', async () => {
  const a = serialize('notes', {id: 'n4', title: '甲笔记', path: '05-方法库 methods/甲笔记.md', body: '内容甲'});
  const b = serialize('notes', {id: 'n9', title: '乙笔记', path: '05-方法库 methods/乙笔记.md', body: '内容乙'});
  const r1 = await parseVault([
    f('vault/05-方法库 methods/甲笔记.md', a),
    f('vault/05-方法库 methods/乙笔记.md', b),
  ]);
  assert.deepEqual(r1.notes.map(x => x.id), ['n4', 'n9']);
  assert.ok(!r1.notes[0].keep); // deepnotes-id 是通用键，不算自定义 frontmatter

  // 顺序颠倒 + 新增一个无 id 文件：已有 id 一动不动，新文件按「前缀 + 相对路径散列」补号
  const r2 = await parseVault([
    f('vault/05-方法库 methods/乙笔记.md', b),
    f('vault/05-方法库 methods/甲笔记.md', a),
    f('vault/05-方法库 methods/丙笔记.md', '---\ntitle: 丙笔记\n---\n内容丙'),
  ]);
  const byTitle = Object.fromEntries(r2.notes.map(x => [x.title, x.id]));
  assert.equal(byTitle['甲笔记'], 'n4');
  assert.equal(byTitle['乙笔记'], 'n9');
  const pid = byTitle['丙笔记'];
  assert.match(pid, /^n[0-9a-z]+$/); // 散列 id 仍满足 deepnotes-id 字符集
  assert.ok(!['n4', 'n9'].includes(pid));

  // 再导入且中间插入另一个无 id 文件：丙的散列 id 不漂移（旧实现按下标会变号触发误删）
  const r3 = await parseVault([
    f('vault/05-方法库 methods/甲笔记.md', a),
    f('vault/05-方法库 methods/丁笔记.md', '---\ntitle: 丁笔记\n---\n内容丁'),
    f('vault/05-方法库 methods/丙笔记.md', '---\ntitle: 丙笔记\n---\n内容丙'),
    f('vault/05-方法库 methods/乙笔记.md', b),
  ]);
  assert.equal(r3.notes.find(x => x.title === '丙笔记').id, pid);
  assert.equal(new Set(r3.notes.map(x => x.id)).size, 4);
});

test('稳定 id：重复 deepnotes-id 只承认第一个，后来者与无 id 文件按路径散列补号', async () => {
  const r = await parseVault([
    f('vault/05-方法库 methods/甲.md', '---\ntitle: 甲\ndeepnotes-id: n1\n---\n内容'),
    f('vault/05-方法库 methods/乙.md', '---\ntitle: 乙\ndeepnotes-id: n1\n---\n内容'),
    f('vault/05-方法库 methods/丙.md', '---\ntitle: 丙\n---\n内容'),
  ]);
  const ids = r.notes.map(x => x.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'n1');
  assert.notEqual(ids[1], 'n1');
});

test('稳定 id：作品 / 草稿 / 阅读 / 档案同样按 deepnotes-id 往返', async () => {
  const r = await parseVault([
    f('vault/01-作品库 works/文章.md', serialize('works', {id: 'w2', title: '文章', date: '2026-03-01', body: 'x', tags: []})),
    f('vault/03-创作台 drafts/草稿.md', serialize('drafts', {id: 'draft-5', title: '草稿', body: 'x'})),
    f('vault/06-阅读区 readings/阅读.md', serialize('readings', {id: 'reading-3', title: '阅读', date: '2026-03-02', body: 'x'})),
    f('vault/07-档案区 archives/档案.md', serialize('archives', {id: 'archive-7', title: '档案', date: '2026-03-03', body: 'x'})),
  ]);
  assert.equal(r.works.find(x => x.title === '文章').id, 'w2');
  assert.equal(r.drafts[0].id, 'draft-5');
  assert.equal(r.readings[0].id, 'reading-3');
  assert.equal(r.archives[0].id, 'archive-7');
});

// —— P1-1 回归：frontmatter 块标量 / 含冒号引号值往返不丢 ——
test('frontmatter：块标量多行值、含冒号引号值、列表值 往返不丢', async () => {
  const src = `---\nid: x\nnote: |\n  第一行\n  第二行\nquote: "a: b, c"\ntags:\n  - 一\n  - 二\n---\n正文`;
  const r = await parseVault([f('vault/05-方法库 methods/笔记/x.md', src)]);
  const note = r.notes[0];
  const md = serialize('notes', note);
  const r2 = await parseVault([f('vault/05-方法库 methods/笔记/x.md', md)]);
  // 块标量文本保留（进 keep 后 round-trip）
  assert.ok(md.includes('note: |'), '块标量按 | 回写');
  assert.ok(md.includes('第一行') && md.includes('第二行'), '两行正文都还在');
  // 含冒号引号值二次解析不错位
  const keep = r2.notes[0].keep || {};
  assert.equal(keep.quote, 'a: b, c', '含冒号引号值二次解析正确');
});

test('frontmatter：块标量任意合法缩进不吃字符（1 空格 / 4 空格 / 混合加深）', async () => {
  const {parse: fmParse, pick: fmPick} = await import('../src/neural/vaultRules.js');
  const p1 = fmParse('---\nnote: |\n x\n y\n---\n正文');
  assert.equal(fmPick(p1.fm, ['note']), 'x\ny', '1 空格缩进内容不丢字符');
  const p4 = fmParse('---\nnote: |\n    a\n      b\n---\n正文');
  assert.equal(fmPick(p4.fm, ['note']), 'a\n  b', '4 空格基准 + 更深行保留相对缩进');
});
