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

// —— 审计 H1 回归：未闭合 / 不在行首的围栏曾让后续正文整体跳过转义并漏出原生 HTML ——

test('未闭合围栏后面的原生 HTML 会被转义（H1 实测绕过 POC）', () => {
  const html = renderMarkdown('note ```html\n<script>alert(1)</script>');
  assert.ok(!/<script/.test(html), 'script 不得原样输出');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '按纯文本显示');
});

test('行内代码后接未闭合围栏同样安全（H1 实测绕过 POC）', () => {
  const html = renderMarkdown('`x` ```html\n<script>alert(1)</script>');
  assert.ok(!/<script/.test(html), 'script 不得原样输出');
  assert.ok(html.includes('<code'), '行内代码正常渲染');
});

test('闭合代码块里的 HTML 按代码原样显示（先转义、渲染前还原）', () => {
  const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
  assert.ok(html.includes('<pre><code'), '仍是代码块');
  assert.ok(html.includes('&lt;script'), '代码内容转义显示（高亮 token 会拆开实体）');
  assert.ok(html.includes('alert('), '代码内容完整');
  assert.ok(!/<script>/.test(html), '不得出现原生 script 标签');
});

test('行内代码里的尖括号显示不变', () => {
  const html = renderMarkdown('写 `<div>` 和 `a < b` 没问题');
  assert.ok(html.includes('&lt;div'), '行内代码 HTML 按文本显示（高亮 token 会拆开实体）');
  assert.ok(html.includes('&gt;'), '闭合尖括号按文本显示');
  assert.ok(html.includes('a &lt; b'), '普通比较号按文本显示');
});

test('代码块里的 [[..]] 与公式语法不被替换', () => {
  const html = renderMarkdown('```\n[[不是链接]] $x$\n```');
  assert.ok(!html.includes('md-wikilink'), '代码块里不做双链替换');
  assert.ok(!html.includes('katex'), '代码块里不做公式渲染');
  assert.ok(html.includes('[[不是链接]]'), '原文保留');
});

test('脚注区在渲染管线外追加，脚注引用与定义正常', () => {
  const html = renderMarkdown('正文[^1]\n\n[^1]: 这是注解');
  assert.ok(html.includes('md-footnotes'), '脚注区存在');
  assert.ok(html.includes('fnref-1'), '引用上标存在');
  assert.ok(html.includes('这是注解'), '定义文本存在');
  assert.ok(!html.includes('\u0000'), '无占位符泄漏');
});

test('空输入返回空串而不是抛错', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('裸文件名相对引用的图片放行（Obsidian 短引用），由 vault:asset 回填', () => {
  const html = renderMarkdown('![](abc123.jpg) ![说明](images/图.png)');
  assert.ok(html.includes('<img src="abc123.jpg"'), '裸文件名应渲染成 img');
  assert.ok(html.includes('src="images/图.png"'), '带目录的相对路径应渲染成 img');
  assert.ok(html.includes('alt="说明"'), 'alt 文本保留');
});

test('危险协议与未知 scheme 的图片引用仍被丢弃', () => {
  const html = renderMarkdown('![](javascript:alert(1)) ![x](data:text/html;base64,PHNjcmlwdD4=) ![y](vbscript:x)');
  assert.ok(!html.includes('<img'), '任何非图片 src 不得渲染成 img');
  assert.ok(!html.includes('javascript:'), 'javascript: 不得出现在输出里');
  assert.ok(!html.includes('vbscript:'), 'vbscript: 不得出现在输出里');
});

test('本地视频：![](x.mp4) 渲染播放器，![[x.mp4|480]] 带宽度', () => {
  const html = renderMarkdown('![](learn-to-build/01.mp4)\n\n![[02.mp4|480]]');
  assert.ok(html.includes('class="md-embed-video"'), '视频渲染成 video 标签');
  assert.ok(html.includes('data-asset="learn-to-build/01.mp4"'), '相对路径视频');
  assert.ok(html.includes('data-asset="02.mp4"'), 'Obsidian 嵌入语法');
  assert.ok(html.includes('style="width:480px"'), '|宽度 生效');
  assert.ok(html.includes('controls'), '带播放控件');
});

test('本地视频：表格里的 [文件名](x.mp4) 变成灯箱入口，不内联撑破表格', () => {
  const html = renderMarkdown('| [01.mp4](01.mp4) | 3h |');
  assert.ok(html.includes('class="md-video-link"'), '渲染成视频链接');
  assert.ok(html.includes('data-asset="01.mp4"'), '带引用地址');
  assert.ok(!html.includes('<video'), '表格单元格里不内联播放器');
  // 危险协议仍按普通文本处理，不会变成视频入口
  const bad = renderMarkdown('[x](javascript:alert(1).mp4)');
  assert.ok(!bad.includes('md-video-link'), '带 scheme 的引用不得进视频灯箱');
  assert.ok(!bad.includes('javascript:'), 'javascript: 不进输出');
});
