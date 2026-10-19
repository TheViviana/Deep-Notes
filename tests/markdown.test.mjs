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

test('空输入返回空串而不是抛错', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});
