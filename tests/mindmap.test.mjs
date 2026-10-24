// 思维导图数据层测试（src/neural/mindmap.js）：大纲 ⇄ 树往返无损、节点装饰（颜色/备注）编解码、
// 导图转草稿 Markdown 的层级与备注转换。
import test from 'node:test';
import assert from 'node:assert/strict';
import {outlineToTree, treeToOutline, parseNodeText, formatNodeText, mapToDraftMarkdown} from '../src/neural/mindmap.js';

test('大纲 ⇄ 树往返无损（含颜色与备注）', () => {
  const md = '- 甲\n  - {{mint}} 甲一 :: 备注A\n  - 甲二\n- 乙';
  const tree = outlineToTree(md);
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].children.length, 2);
  assert.equal(treeToOutline(tree), md);
});

test('parseNodeText / formatNodeText 编解码', () => {
  assert.deepEqual(parseNodeText('{{gold}} 标题 :: 备注'), {label: '标题', note: '备注', color: 'gold'});
  assert.deepEqual(parseNodeText('纯文本'), {label: '纯文本', note: '', color: ''});
  assert.deepEqual(parseNodeText('标题 :: 只有备注'), {label: '标题', note: '只有备注', color: ''});
  assert.equal(formatNodeText('标题', '备注', 'gold'), '{{gold}} 标题 :: 备注');
  assert.equal(formatNodeText('标题', '', ''), '标题');
  // 未知颜色不生效
  assert.deepEqual(parseNodeText('{{red}} 标题').color, '');
});

test('节点 id 用路径序号，重复解析稳定', () => {
  const md = '- 甲\n  - 甲一\n- 乙';
  const t1 = outlineToTree(md), t2 = outlineToTree(md);
  assert.equal(t1.children[0].children[0].id, '0-0-0');
  assert.equal(t1.children[1].id, '0-1');
  assert.equal(t1.children[1].id, t2.children[1].id);
});

test('mapToDraftMarkdown：一级分支转小节、深层转列表、备注转引用', () => {
  const md = mapToDraftMarkdown({outline: '- 章节一 :: 本章备注\n  - 要点A\n    - 子要点\n- 章节二'});
  assert.ok(md.includes('## 章节一'), '一级分支应为 ## 小节');
  assert.ok(md.includes('> 本章备注'), '一级备注应为引用行');
  assert.ok(md.includes('- 要点A'), '二级应为列表项');
  assert.ok(md.includes('  - 子要点'), '三级应缩进');
  assert.ok(md.includes('## 章节二'), '并列分支各自成节');
  // 小节与下一小节之间必须有空行（Markdown 结构清晰）
  assert.match(md, /- 要点A\n {2}- 子要点\n\n## 章节二/);
});

test('mapToDraftMarkdown：空大纲返回空串', () => {
  assert.equal(mapToDraftMarkdown({outline: ''}), '');
  assert.equal(mapToDraftMarkdown(null), '');
});
