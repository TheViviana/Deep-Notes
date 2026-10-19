// 图谱推导测试：目录归属、[[双链]]（实链 / 幽灵节点 / 路径文件名解析）、选题来源、
// 话题标签、概念提及与双向共振。全部用小型合成数据，断言与 graph.js 的规则一一对应。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGraph, neighbors, moduleOf, CONTENT} from '../src/neural/graph.js';

const works = [
  {id: 'w1', title: '文章甲', date: '2026-01-02 10:00', body: '先看 [[方法一]]，再对照 [[文章乙]]，还有 [[不存在]]。', tags: ['alpha'], views: 10},
  {id: 'w2', title: '文章乙', date: '2026-01-01 09:00', body: '共同话题 x 和 y 都在这里。', tags: ['alpha', 'beta']}
];
const notes = [
  {id: 'n1', title: '方法一', path: '05-方法库 methods/写作/方法一.md', body: '方法正文'},
  {id: 'n2', title: '正式名', path: '05-方法库 methods/收集/别名.md', body: '按路径文件名被链接'}
];
const ideas = [{id: 1, title: '选题一', status: '已转草稿'}];
const drafts = [{id: 'd1', title: '草稿一', body: '引用 [[方法一]] 和 [[别名]]', source: 1}];
// 两个共同概念 → 触发双向共振
const concepts = [['概念x', ['x']], ['概念y', ['y']]];
// 让 w1 / w2 正文同时包含 x、y：重新构造（覆盖上面的 body 会被 link 断言用到，所以单独建一套）
const resWorks = [
  {id: 'w1', title: '文章甲', date: '2026-01-02 10:00', body: '共同话题 x 和 y 都在这里。', tags: ['alpha']},
  {id: 'w2', title: '文章乙', date: '2026-01-01 09:00', body: 'x 与 y 再次出现。', tags: ['alpha', 'beta']}
];

test('core 节点与五类内容节点存在，模块归属正确', () => {
  const g = buildGraph({works: resWorks, notes, ideas, drafts, concepts});
  assert.ok(g.nodes.some(n => n.id === 'core'));
  for (const k of ['post', 'note', 'idea', 'draft', 'concept'])
    assert.ok(g.nodes.some(n => n.kind === k), `缺 ${k} 类节点`);
  assert.equal(moduleOf(g.index.get('post:w1'))?.id, 'works');
  assert.equal(moduleOf(g.index.get('note:n1'))?.id, 'methods');
});

test('[[双链]]：按标题与路径文件名解析为实链', () => {
  const g = buildGraph({works, notes, ideas, drafts, concepts: []});
  // 草稿一 → 方法一（标题解析）；草稿一 → 正式名（路径文件名「别名」解析）
  const wikiFrom = id => g.links.filter(l => l.kind === 'wiki' && l.s === id).map(l => l.t);
  assert.ok(wikiFrom('draft:d1').includes('note:n1'));
  assert.ok(wikiFrom('draft:d1').includes('note:n2'));
  assert.ok(wikiFrom('post:w1').includes('note:n1'));
  assert.ok(wikiFrom('post:w1').includes('post:w2'));
});

test('未创建的双链生成 ghost 幽灵节点', () => {
  const g = buildGraph({works, notes, ideas, drafts, concepts: []});
  const ghost = g.index.get('ghost:不存在');
  assert.ok(ghost && ghost.kind === 'ghost');
  assert.ok(g.links.some(l => l.kind === 'wiki' && l.s === 'post:w1' && l.t === 'ghost:不存在'));
});

test('选题来源：草稿指向选题，且「已转草稿」的选题反向成立（双向共振为 mutual）', () => {
  const g = buildGraph({works, notes, ideas, drafts, concepts: []});
  const nb = neighbors(g, 'idea:1');
  const ids = arr => arr.map(n => n.id);
  assert.ok(ids(nb.mutual).includes('draft:d1'), '来源连接应为双向');
});

test('话题标签：tags 生成 tag 节点并连线', () => {
  const g = buildGraph({works, notes, ideas, drafts, concepts: []});
  const tag = g.index.get('tag:alpha');
  assert.ok(tag && tag.kind === 'tag' && tag.title === '#alpha');
  assert.ok(g.links.some(l => l.kind === 'tag' && l.s === 'post:w1' && l.t === 'tag:alpha'));
});

test('概念提及：词表命中 ≥2 条内容才建概念节点', () => {
  // alpha 只出现在 w1 的 tags、不出现在正文 → 不建概念；x、y 出现在两条正文 → 各建一个
  const g = buildGraph({works: resWorks, notes: [], ideas: [], drafts: [], concepts});
  assert.ok(!g.index.get('concept:alpha'));
  assert.ok(g.index.get('concept:概念x') && g.index.get('concept:概念y'));
  assert.ok(g.links.some(l => l.kind === 'mention' && l.s === 'post:w1' && l.t === 'concept:概念x'));
});

test('双向共振：两条内容共同提及 ≥2 个概念时互连', () => {
  const g = buildGraph({works: resWorks, notes: [], ideas: [], drafts: [], concepts});
  const nb = neighbors(g, 'post:w1');
  assert.ok(nb.mutual.map(n => n.id).includes('post:w2'));
  const one = buildGraph({works: resWorks, notes: [], ideas: [], drafts: [], concepts: [concepts[0]]});
  assert.ok(!neighbors(one, 'post:w1').mutual.map(n => n.id).includes('post:w2'), '只有 1 个共同概念不应共振');
});

test('neighbors 对未知 id 返回空集合且不抛错', () => {
  const g = buildGraph({works, notes, ideas, drafts, concepts: []});
  const nb = neighbors(g, 'nope');
  assert.equal(nb.out.length + nb.back.length + nb.mutual.length, 0);
});

test('双链别名语法 [[目标|别名]] 只按目标解析', () => {
  const ws = [{id: 'w1', title: '文章甲', date: '2026-01-02 10:00', body: '见 [[方法一|快捷方式]]', tags: []}];
  const g = buildGraph({works: ws, notes, ideas: [], drafts: [], concepts: []});
  assert.ok(g.links.some(l => l.kind === 'wiki' && l.s === 'post:w1' && l.t === 'note:n1'));
});

test('CONTENT 集合覆盖四种内容类型', () => {
  for (const k of ['post', 'note', 'idea', 'draft']) assert.ok(CONTENT.has(k));
});
