// 示例数据完整性测试：src/data 是看板与导入的权威字段说明，字段缺失会导致页面静默异常。
import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshot, posts, postContent, notes, seedIdeas, seedDrafts, seedReadings, seedArchives, concepts} from '../src/data/index.js';

const METRICS = ['views', 'likes', 'comments', 'saves', 'shares', 'follows', 'impressions', 'ctr', 'duration'];

test('快照字段齐全', () => {
  for (const k of ['account', 'followers', 'capturedAt', 'publishedFrom', 'publishedTo', 'source'])
    assert.ok(k in snapshot, `snapshot 缺 ${k}`);
});

test('posts：字段类型与日期格式（缺失指标写 0 / null）', () => {
  assert.ok(posts.length > 0);
  const ids = new Set();
  for (const p of posts) {
    assert.ok(p.id && !ids.has(p.id), 'id 必填且不重复'); ids.add(p.id);
    assert.ok(p.title, `作品 ${p.id} 缺标题`);
    assert.match(p.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `作品 ${p.id} 日期应为 YYYY-MM-DD HH:mm`);
    for (const m of METRICS.slice(0, 8))
      assert.equal(typeof p[m], 'number', `作品 ${p.id} 的 ${m} 应为数字（缺失写 0）`);
    assert.ok(p.duration === null || typeof p.duration === 'number');
  }
});

test('postContent：与 posts 按 id 对应（无 id 回退 title），正文与媒体类型合法', () => {
  // postContent 是数组，每项带 id（与 posts 关联，同名作品不串正文）；老数据允许按 title 回退
  const cm = new Map((postContent || []).map(c => [c.id || c.title, c]));
  assert.ok(cm.size > 0);
  for (const p of posts) {
    const c = cm.get(p.id) || cm.get(p.title);
    assert.ok(c, `postContent 缺「${p.title}」`);
    assert.equal(typeof c.body, 'string');
    assert.ok(['images', 'video'].includes(c.media), `「${p.title}」media 应为 images / video`);
    assert.ok(Array.isArray(c.tags));
  }
});

test('notes：id / title / path / body 齐全，path 至少两段', () => {
  assert.ok(notes.length > 0);
  for (const n of notes) {
    assert.ok(n.id && n.title && typeof n.body === 'string', `笔记 ${n.id} 字段缺失`);
    assert.ok(n.path.split('/').length >= 2, `笔记「${n.title}」path 形如 05-方法库 methods/<子目录>/<文件名>.md`);
    assert.match(n.path, /\.md$/);
  }
});

test('seedIdeas：id 数字、优先级与状态在枚举内', () => {
  for (const i of seedIdeas) {
    assert.equal(typeof i.id, 'number');
    assert.ok(['高', '中', '低'].includes(i.priority), `选题「${i.title}」优先级非法`);
    assert.ok(['待写', '待扩展', '已转草稿'].includes(i.status), `选题「${i.title}」状态非法`);
    assert.ok('note' in i);
  }
});

test('seedDrafts：body 为字符串，source 为选题 id 或 null', () => {
  const ideaIds = new Set(seedIdeas.map(i => i.id));
  for (const d of seedDrafts) {
    assert.equal(typeof d.body, 'string', `草稿「${d.title}」缺正文`);
    assert.ok(d.source === null || ideaIds.has(d.source), `草稿「${d.title}」的 source 应为 null 或有效选题 id`);
  }
});

test('seedReadings：字段齐全，日期为 YYYY-MM-DD', () => {
  assert.ok(seedReadings.length > 0);
  for (const r of seedReadings) {
    assert.ok(r.id && r.title && typeof r.body === 'string', `阅读「${r.title || r.id}」字段缺失`);
    assert.match(String(r.date), /^\d{4}-\d{2}-\d{2}$/, `阅读「${r.title}」日期应为 YYYY-MM-DD`);
    assert.ok(typeof r.author === 'string' && typeof r.source === 'string');
  }
});

test('seedArchives：字段齐全，日期为 YYYY-MM-DD', () => {
  assert.ok(Array.isArray(seedArchives) && seedArchives.length > 0);
  for (const a of seedArchives) {
    assert.ok(a.id && a.title && typeof a.body === 'string', `档案「${a.title || a.id}」字段缺失`);
    assert.match(String(a.date), /^\d{4}-\d{2}-\d{2}$/, `档案「${a.title}」日期应为 YYYY-MM-DD`);
  }
});

test('concepts：[概念名, [关键词…]] 结构', () => {
  assert.ok(Array.isArray(concepts) && concepts.length > 0);
  for (const c of concepts) {
    assert.ok(Array.isArray(c) && typeof c[0] === 'string' && Array.isArray(c[1]) && c[1].length > 0);
  }
});

test('示例数据为虚构内容：不应包含真实个人信息标记', () => {
  const all = JSON.stringify({posts, notes, seedIdeas, seedDrafts, seedReadings, seedArchives});
  assert.ok(!/@(gmail|qq|163|outlook)\./i.test(all), '示例数据不应包含真实邮箱');
});
