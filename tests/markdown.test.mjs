// Markdown 渲染测试（ArticleView.jsx 的 renderMarkdown，供阅读模式与对照分屏复用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from '../src/neural/ArticleView.jsx';

test('标题与加粗正常渲染', () => {
  const html = renderMarkdown('# 标题\n\n**加粗**文字');
  assert.ok(html.includes('<h1>'));
  assert.ok(html.includes('<strong>'));
});

test('[[双链]] 转成带 data-target 的内联链接，支持别名', () => {
  const html = renderMarkdown('看 [[目标页|别名字]]');
  assert.ok(html.includes('data-target="目标页"'));
  assert.ok(html.includes('>别名字<'));
});

test('双链目标与显示文本都会转义，防注入', () => {
  const html = renderMarkdown('[[<img src=x onerror=1>|<script>]]');
  assert.ok(!html.includes('<img'), '目标里的 HTML 不应原样输出');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('代码块内容不被双链规则改写', () => {
  const html = renderMarkdown('```\n[[不是链接]]\n```');
  assert.ok(!html.includes('md-wikilink'), '代码块里的 [[..]] 不应变成链接');
});

test('格式栏受信标签成对还原：文字颜色与下划线在阅读视图显示效果', () => {
  const html = renderMarkdown('<span style="color:#e05d5d">红字</span> 普通 <u>下划线</u>');
  assert.ok(html.includes('<span style="color:#e05d5d">'), '彩色 span 应还原为真标签');
  assert.ok(html.includes('<u>下划线</u>'), '下划线应还原为真标签');
  // 不成对的标签仍是转义文本，不会被还原
  const lone = renderMarkdown('<u>只有开头</u 与 stray</span>');
  assert.ok(!lone.includes('<u>'), '不成对的开标签不应还原');
  assert.ok(lone.includes('&lt;/span'), '孤立闭标签保持转义');
});

test('受信标签还原不放行任意 HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script> <span style="color:javascript:x">坏</span>');
  assert.ok(!html.includes('<script'), 'script 不得原样输出');
  assert.ok(!/<span style="color:javascript/.test(html), '非十六进制色值不得还原');
  assert.ok(html.includes('&lt;script'), 'script 按纯文本显示');
});

test('空输入返回空串而不是抛错', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});
