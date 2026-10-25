// 文章全文视图：在页面下方展开，Markdown 编辑 / 预览，[[ 双链自动汇入图谱。
import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {marked} from 'marked';
import mermaid from 'mermaid';
mermaid.initialize({startOnLoad: false, securityLevel: 'loose', theme: 'dark'});
import katex from 'katex';
import 'katex/contrib/mhchem'; // 化学式 \ce{...}（注册进同一个 katex 实例）
import 'katex/dist/katex.min.css';
import {CONTENT, nameIndex} from './graph';
import {Icon} from './icons';
import {useWikiComplete, WikiSuggest, resolveTarget, scrollToAnchor, headingMap} from './wiki';
import {isVideoRef} from './images';
import {headingAt} from './vaultRules';
import {useEditorEnhancers, usePlugins, useNetwork} from './plugins';
import {isTranslatable, translateText} from './translate';
import {serialize, exportFiles, safeName, capable, getRoot} from './fileStore';
import {CONFIG} from '../config';

marked.setOptions({gfm: true, breaks: false});

// —— 阅读进度记忆：每篇内容记住预览模式读到的滚动百分比（百分比对内容增删天然容错）——
// 只存本机 localStorage，最多记 500 篇（按时间淘汰最旧）；供 ArticleView 恢复与列表显示。
const PROGRESS_KEY = CONFIG.storagePrefix + '-reading-progress-v1';
export const readProgress = id => {
  try { const v = JSON.parse(localStorage.getItem(PROGRESS_KEY))?.[id]; return v && Number.isFinite(v.pct) ? v : null; } catch { return null; }
};
function saveProgress(id, pct) {
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {};
    all[id] = {pct, ts: Date.now()};
    const entries = Object.entries(all).sort((a, b) => b[1].ts - a[1].ts).slice(0, 500);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {} // 进度只是便利功能，存不进去不影响阅读
}

// 滚动容器探测：md-preview 通常自身滚动，但专注模式解除高度上限后滚动发生在祖先或页面
const scrollSpanOf = el => (el ? el.scrollHeight - el.clientHeight : 0);
function findScroller(box) {
  if (scrollSpanOf(box) > 4) return box;
  let p = box.parentElement;
  while (p && p !== document.body && p !== document.documentElement && scrollSpanOf(p) <= 4) p = p.parentElement;
  if (p && scrollSpanOf(p) > 4) return p;
  return document.scrollingElement || document.documentElement;
}

// —— 文内查找（⌘F）：在渲染后的正文 DOM 里命中并高亮，支持上一个 / 下一个跳转 ——
// 只处理文本节点，跳过沉浸式译文的 .md-trans 与已高亮的 mark；从后往前包 mark 不破坏偏移。
function clearFindMarks(root) {
  if (!root) return;
  root.querySelectorAll('mark.av-find').forEach(m => { m.replaceWith(document.createTextNode(m.textContent)); });
  root.normalize();
}
function markFindHits(root, q) {
  if (!root || !q) return 0;
  // 用带 i 标志的正则在原文上匹配：toLocaleLowerCase 会改变个别字符（如 İ）的长度，
  // 坐标系错位会包错文字甚至越界抛错；matchAll 的偏移始终落在原文本坐标系
  const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      const p = n.parentElement;
      if (!p || /script|style|mark/i.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest('.md-trans')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const tn of nodes) {
    const positions = [...tn.data.matchAll(rx)].map(m => m.index);
    for (let p = positions.length - 1; p >= 0; p--) { // 从后往前：先包后面的不影响前面偏移
      try {
        const range = document.createRange();
        range.setStart(tn, positions[p]);
        range.setEnd(tn, positions[p] + q.length);
        const mark = document.createElement('mark');
        mark.className = 'av-find';
        range.surroundContents(mark);
      } catch {} // 节点边界异常（极少见）跳过该处命中
    }
  }
  return root.querySelectorAll('mark.av-find').length; // DOM 序即文档序
}
function focusFindHit(root, idx) {
  const marks = root ? root.querySelectorAll('mark.av-find') : [];
  marks.forEach((m, i) => m.classList.toggle('cur', i === idx));
  marks[idx]?.scrollIntoView({block: 'center'});
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// 源码层已把 < 转成 &lt;；注入点还原后走完整 esc()，避免二次转义把实体显示成文字（esc(原文本) 幂等）
const unescLt = s => String(s).replace(/&lt;/g, '<');
// 公式占位符（\u0000M{n}E\u0000）：解析之后会整段替换成 KaTeX 生成的 HTML，只能出现在文本节点里。
// 一旦被拼进 data-target / data-asset / alt / title 等属性，后置还原就会把 < 与引号写进属性值，
// 截断属性并注入真实 DOM 节点——所有拼属性的地方都必须先拦下它。
const PH_RE = /\u0000M\d+E\u0000/;

// —— 极简语法高亮（零依赖）：颜色值 / 字符串 / 注释 / 关键字 / 数字 / 属性 / HTML 标签 ——
// 单遍 tokenize：命中区间染色、未命中区间转义，避免「先转义再匹配」的实体污染。
// 颜色值放在注释之前，避免 #ff0000 被 # 注释吃掉；色块 sw 显示实际颜色。
function hiRegex(lang) {
  const hashCm = /^(py|python|sh|bash|zsh|shell|yaml|yml|rb|ruby|conf|ini|toml|makefile|dockerfile)$/i.test(String(lang || '').trim());
  return new RegExp(
    '(#[0-9a-fA-F]{3,8})\\b'
    + '|("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)'
    + '|(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|(?<=^|[({\\s])' + (hashCm ? '#[^\\n]*' : '#(?![0-9a-fA-F]{3,8}\\b)[^\\n]*') + ')'
    + '|\\b(const|let|var|function|return|if|else|for|while|import|export|from|default|class|new|async|await|try|catch|throw|switch|case|break|continue|typeof|instanceof|of|in|do|def|lambda|pass|self|this|super|null|undefined|true|false|True|False|None|print|require|public|private|void|int|float|str|bool|with|as|elif|unless|fn|pub|use|mut)\\b'
    + '|\\b(\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)'
    + '|([a-zA-Z-]+)(?=\\s*:)'
    + '|(<\\/?[a-zA-Z][\\w-]*)',
    'g');
}
// base 为 null 时供阅读视图使用；传入源码偏移时（编辑镜像层）token 与明文都带 data-s 供坐标映射
export function hiCode(code, lang = '', base = null) {
  const out = [];
  let last = 0, m;
  const re = hiRegex(lang);
  re.lastIndex = 0;
  const put = (seg, i) => {
    if (seg) out.push(base == null ? esc(seg) : `<span data-s="${base + i}">${esc(seg)}</span>`);
  };
  while ((m = re.exec(String(code)))) {
    if (m.index > last) put(code.slice(last, m.index), last);
    const cls = m[1] ? 'tk-h' : m[2] ? 'tk-s' : m[3] ? 'tk-c' : m[4] ? 'tk-k' : m[5] ? 'tk-n' : m[6] ? 'tk-p' : 'tk-t';
    out.push((base == null ? `<i class="${cls}">` : `<i class="${cls}" data-s="${base + m.index}">`)
      + esc(m[0]) + '</i>' + (m[1] ? `<b class="tk-sw" style="background:${m[1]}"></b>` : ''));
    last = m.index + m[0].length;
  }
  put(String(code).slice(last), last);
  return out.join('');
}
// 安全：markdown 链接 / 图片走协议白名单（http/https/mailto、相对路径与页内锚点），
// 屏蔽 javascript: 等危险协议；原生 HTML 由「源码层全量转义 + html renderer 白名单」双层防护。
// 净防护网（审计 H1）：正常路径下源码层已把所有类标签的 < 转义，能走到 html renderer 的
// 原生 HTML 只剩 proc() 注入的受信标签；白名单只放行这几种固定形状，任何漏网的原生 HTML
// （含未闭合围栏误开代码段等边界场景）一律转义成纯文本显示，绝不再原样输出。
const TRUSTED_HTML = new RegExp('^<(?:'
  + '/(?:mark|u|sub|sup|dl|dt|dd|a|span)>'
  + '|mark>|u>|sub>|sup>|dl>|dt>|dd>'
  + '|span style="color:#[0-9a-fA-F]{3,8}">'
  // 审计 C1：属性值收紧为不含引号 / 尖括号 / 换行（此前 [^"]* 允许换行与 <，理论可夹带标签）
  + '|a class="md-wikilink" data-target="[^"<>\\n]*">'
  + '|a href="#fn-\\d+">'
  + '|sup class="md-fn" id="fnref-\\d+">'
  + '|img class="md-embed" data-asset="[^"<>\\n]*" alt="[^"<>\\n]*"(?: style="width:\\d+px")?\\s*/?>'
  // 视频（![[x.mp4]] 注入的受信标签）：整块或分开的起止标签都放行
  + '|video class="md-embed-video" data-asset="[^"<>\\n]*"(?: style="width:\\d+px")? controls preload="metadata" playsinline></video>'
  + '|video class="md-embed-video" data-asset="[^"<>\\n]*"(?: style="width:\\d+px")? controls preload="metadata" playsinline>'
  + '|/video>'
  + ')\\s*$');

// 视频播放器标签：src 由 resolveVaultVideo 回填（桌面版经 deepnotes-asset:// 流式读盘，
// 网页版保持虚线占位）。属性顺序固定，TRUSTED_HTML 才能按形状放行。
const videoTag = (ref, width = 0) =>
  PH_RE.test(String(ref || '')) ? esc(ref) // 占位符不得进 data-asset（还原时会注入 KaTeX HTML）
    : `<video class="md-embed-video" data-asset="${esc(ref)}"${width > 0 ? ` style="width:${width}px"` : ''} controls preload="metadata" playsinline></video>`;
marked.use({renderer: {
  // 代码段在源码层也做了 < 转义（与正文同等防护），渲染前先还原再交给 hiCode 转义上色，
  // 否则 hiCode 的 esc() 会把 &lt; 二次转义成 &amp;lt; 显示成实体文字
  code({text, lang}) {
    if (lang === 'mermaid') return `<pre class="mermaid">${esc(unescLt(text))}</pre>`;
    return `<pre><code class="hl">${hiCode(unescLt(text), lang)}</code></pre>`;
  },
  codespan({text}) { return `<code class="hl">${hiCode(unescLt(text), '')}</code>`; },
  // 占位符只应出现在文本节点：出现在 html token 里说明被拼进了属性，整段按纯文本显示（不还原成 DOM）
  html({text}) {
    const t = String(text ?? '');
    if (PH_RE.test(t)) return esc(t);
    // 定义列表 <dl> 由 proc() 注入（用户源码里的 < 已在更外层转义，到不了这里），整块放行
    if (/^<dl[\s>]/.test(t) && /<\/dl>\s*$/.test(t)) return t;
    return TRUSTED_HTML.test(t) ? t : esc(t);
  },
  link({href, title, tokens}) {
    const h = String(href || '').trim();
    const inner = this.parser.parseInline(tokens);
    if (PH_RE.test(h)) return inner; // 地址里出现占位符：不生成属性，只保留链接文字
    // 标题携带公式占位符时丢弃 title：解析后的还原会把 KaTeX HTML 打进属性值
    const tt = title && !PH_RE.test(String(title)) ? ` title="${esc(title)}"` : '';
    // 无 scheme 的相对视频引用（Obsidian 表格里常见的 [文件名](x.mp4)）：渲染成可点击的视频
    // 入口，点击由 useVaultImages 的全局委托打开灯箱播放——直接塞播放器会撑破表格单元格
    if (isVideoRef(h) && !/^[a-z][a-z0-9+.-]*:/i.test(h)) {
      return `<a class="md-video-link" data-asset="${esc(h)}"${tt}>${inner}</a>`;
    }
    return /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(h) ? `<a href="${esc(h)}"${tt}>${inner}</a>` : `<a${tt}>${inner}</a>`;
  },
  image({href, title, text}) {
    const h = String(href || '').trim();
    // 占位符进 src / alt / title 都会在还原时被打穿属性：整个图片退化成纯文本
    if (PH_RE.test(h) || PH_RE.test(String(text || ''))) return esc(text || h);
    // 视频引用（![](x.mp4)）直接渲染成播放器；网页版无本地访问权限时保持虚线占位
    if (isVideoRef(h) && !/^[a-z][a-z0-9+.-]*:/i.test(h)) return videoTag(h);
    // 除白名单协议外，无 URL scheme 的相对引用（裸文件名 / images/foo.jpg）也放行：
    // Obsidian 等导出的笔记常用 ![](图.jpg) 短引用，图片实际在子目录里，
    // 桌面版渲染后由 resolveVaultImg → vault:asset 回填（先按路径直找、找不到按文件名全库搜）；
    // 带 scheme 又不在白名单里的（javascript: 等）一律丢弃，维持协议白名单防护。
    const isSafe = /^(https?:|data:image\/|\/|\.\/|\.\.\/)/i.test(h) || !/^[a-z][a-z0-9+.-]*:/i.test(h);
    if (!isSafe) return esc(text || '');
    const tt = title && !PH_RE.test(String(title)) ? ` title="${esc(title)}"` : '';
    return `<img src="${esc(h)}" alt="${esc(text || '')}"${tt} loading="lazy"/>`;
  },
}});

// 镜像层行内片段（dataURL 图片 / 彩色 span / 下划线 / 双链 / 高亮 / 加粗 / 斜体 / 删除线 / 行内代码）。
// walk 递归处理嵌套片段，每个 walk 实例化独立正则（共享 lastIndex 会互相踩踏）。
const INLINE_SRC = '!\\[[^\\]\\n]*\\]\\(data:[^)\\s]+\\)'
  + '|<span style="color:(#[0-9a-fA-F]{3,8})">[\\s\\S]*?<\\/span>'
  + '|<u>[\\s\\S]*?<\\/u>'
  + '|\\[\\[[^\\]\\n]+\\]\\]|==[^=\\n]+==|\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__|~~[^~\\n]+~~|\\*[^*\\n]+\\*(?!\\*)|`[^`\\n]+`';

// 公式渲染：KaTeX 全本地（CSS + 字体随包），失败时回退原文。mhchem 已注册，\ce{} 化学式可用。
function renderKatex(tex, display) {
  try { return katex.renderToString(tex, {displayMode: display, throwOnError: false, strict: 'ignore'}); }
  catch { return esc(tex); }
}

// Markdown 渲染：先把 [[双链]] 替换成带 data-target 的内联 <a>（内容已转义），再交给 marked。
// 同时供创作台阅读模式与对照分屏复用。围栏代码块与行内代码里的 [[..]] 不做替换（与 Obsidian 一致）。
// 公式与脚注同样先摘出再进 marked：
//   数学/物理 $…$ 与 $$…$$、\(…\) 与 \[…\] → KaTeX（含 mhchem 化学式 \ce{}）；
//   脚注 [^key] 引用 + [^key]: 定义（行首）→ 编号上标 + 文末脚注区。
// 行内 $ 的判定从紧：$ 后不能是空白、$ 前不能紧贴字母/数字/$/反斜杠、$ 后不能紧跟数字（避开「价格 $5 和 $6」）。
export function renderMarkdown(md) {
  const maths = [];               // {tex, display}
  const stashMath = (tex, display) => { maths.push({tex, display}); return `\u0000M${maths.length - 1}E\u0000`; };
  const footnotes = new Map();    // key → 定义文本
  const fnOrder = [];             // 保持出现顺序编号
  const proc = seg => {
    let s = seg
      // 公式先摘出（在 HTML 转义之前：$a < b$ 里的 < 属于公式内容，不能被转义破坏），
      // 避免 _ ^ \\ 等被 marked 当作 Markdown 语法吃掉
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stashMath(t, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stashMath(t, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stashMath(t, false))
      .replace(/(?<![\\$\w])\$((?:[^\s$]|[^\n$]*?[^\s$]))\$(?!\d)/g, (_, t) => stashMath(t, false))
      // XSS 防护：转义类 HTML 标签（第三方 md 里的 <script>/<img onerror> 一律按纯文本显示）。
      // 只吃 <字母/!/? 开头的标签形结构，「a < b」这类普通文本不受影响；
      // 之后注入的受信 HTML（双链 <a>、嵌入图 <img> 等）在转义之后拼接，不会被转回去
      .replace(/<(?=[a-zA-Z!/?])/g, '&lt;');
    // 脚注定义（行首 [^key]: 文本）；支持多行续行（后续以 ≥2 空格或制表符开头的行，含中间空行）。
    // 引用（未定义的 [^x] 原样保留）。
    const lines = s.split('\n');
    const out = [];
    let cur = null; // {key, text:[]}
    const flush = () => { if (cur) { if (!footnotes.has(cur.key)) fnOrder.push(cur.key); footnotes.set(cur.key, cur.text.join('\n').trim()); cur = null; } };
    for (const ln of lines) {
      const m = ln.match(/^[ \t]*\[\^([^\]\s]+)\]:[ \t]*(.*)$/);
      if (m) { flush(); cur = {key: m[1], text: [m[2]]}; continue; }
      if (cur) {
        if (ln.length === 0 || /^[ \t]{2,}|\t/.test(ln)) { cur.text.push(ln.replace(/^[ \t]{2,}/, '').replace(/^\t/, '')); continue; }
        else { flush(); }
      }
      out.push(ln);
    }
    flush();
    s = out.join('\n');
    if (footnotes.size) s = s.replace(/\[\^([^\]\s]+)\]/g, (m, k) => {
      const i = fnOrder.indexOf(k);
      return i < 0 ? m : `<sup class="md-fn" id="fnref-${i + 1}"><a href="#fn-${i + 1}">${i + 1}</a></sup>`;
    });
    // 标注块 > [!note] 标题 → 引用块开头的加粗标题（内容仍走普通引用样式）
    s = s.replace(/^>[ \t]*\[!(note|tip|warning|info|important|caution)\][ \t]*([^\n]*)$/gim,
      (_, t, title) => title.trim() ? `> **${title.trim()}**` : '>');
    return s
      // 定义列表：术语行 + 一至多行「: 定义」→ <dl>（GFM 没有，Obsidian 支持）。
      // 结尾补空行：marked 把 <dl> 当作 HTML 块时一路吃到空行为止，不补会把紧邻的下一段正文吞进块里
      .replace(/(^|\n)([^\n:][^\n]*)\n((?:[ \t]*: [^\n]+\n?)+)/g, (_, pre, term, defs) =>
        `${pre}<dl><dt>${esc(term.trim())}</dt>${defs.trim().split('\n').map(l => `<dd>${esc(l.replace(/^[ \t]*: /, ''))}</dd>`).join('')}</dl>\n\n`)
      // 下标 ~x~ / 上标 ^x^：两侧非 ~ / ^、非空白，避免误伤 GFM 删除线 ~~…~~ 与公式占位符；
      // ^ 前是 [ 时跳过（未定义的脚注引用 [^x] 原样保留，相邻两个 [^a][^b] 不被误包成上标）
      .replace(/(?<!~)~([^~\n\s]+)~(?!~)/g, '<sub>$1</sub>')
      .replace(/(?<![\^\[])\^([^\^\n\s]+)\^(?!\^)/g, '<sup>$1</sup>')
      // ==高亮==：内容先还原 / 转义再包 <mark>（必须在双链 / 嵌入图之前替换，转义才不会破坏它们注入的标签）
      .replace(/==([^=\n]+)==/g, (_, t) => '<mark>' + esc(unescLt(t)) + '</mark>')
      // ![[图片.png]] / ![[图.png|300]] 嵌入图（Obsidian 语法）→ <img data-asset>；
      // 视频（![[课程.mp4|480]]）→ <video>，统一由桌面版读盘回填（网页版显示占位）。
      .replace(/!\[\[([^\]\n]+)\]\]/g, (_, t) => {
        const [name, size] = t.split('|');
        const n = unescLt((name || '').trim());
        if (PH_RE.test(n)) return esc(n); // 公式占位符不得拼进 data-asset / alt：退化为纯文本
        const w = parseInt(size, 10);
        if (isVideoRef(n)) return videoTag(n, w);
        return `<img class="md-embed" data-asset="${esc(n)}" alt="${esc(n)}"${w > 0 ? ` style="width:${w}px"` : ''}/>`;
      })
      .replace(/\[\[([^\]\n]+)\]\]/g, (_, t) => {
        const [target, alias] = t.split('|');
        const raw = unescLt((target || '').trim());
        if (PH_RE.test(raw)) return esc(raw); // data-target 里出现占位符：不生成链接，按纯文本显示
        const [name, anchor] = raw.split('#');
        // 块引用 [[笔记#小节]] 显示为「笔记 › 小节」；别名优先
        const label = unescLt((alias || '').trim())
          || (anchor ? `${(name || '').trim()} › ${anchor.trim()}` : raw);
        return `<a class="md-wikilink" data-target="${esc(raw)}">${esc(label)}</a>`;
      })
      // 格式栏插入的受信标签（文字颜色 / 下划线）成对还原为真标签，阅读视图才能显示效果。
      // 只还原固定格式（色值限定 #rgb–#rrggbb 十六进制，配不成对的原样转义显示），
      // 中间内容不允许再出现 &lt;（审计 M5：防止跨标签错配把别处的内容圈进受信标签），
      // 用户手写的其他 HTML（<script>、<img onerror> 等）不受影响，仍是纯文本。
      .replace(/&lt;(span style="color:#[0-9a-fA-F]{3,8}")>((?:(?!&lt;)[\s\S])*?)&lt;\/span>/g, '<$1>$2</span>')
      .replace(/&lt;(u)>((?:(?!&lt;)[\s\S])*?)&lt;\/u>/g, '<$1>$2</$1>');
  };
  // 用捕获组 split：奇数段是 ```围栏``` 或 `行内代码`，偶数段才做双链等替换。
  // 审计 H1：代码段也必须转义类标签的 <——行文里出现的 ```（不在行首 / 未闭合）会把
  // 后续正文误判成代码段，若整体跳过转义，marked 又不认这个围栏，原生 HTML 就漏出去了。
  // 代码段只转义、不做其他替换（双链 / 公式 / 高亮与 Obsidian 一致在代码里不生效），
  // code / codespan renderer 渲染前会先还原这个转义，代码显示不受影响。
  let src = String(md || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((seg, i) => i % 2 ? seg.replace(/<(?=[a-zA-Z!/?])/g, '&lt;') : proc(seg)).join('');
  let out = marked.parse(src);
  // 脚注区在 marked.parse 之后追加：不再作为整块 HTML 走 marked（html renderer 的
  // 白名单只认单个受信标签，整块区块会被误转义）。追加顺序在公式占位符替换之前，
  // 脚注定义里如果摘出过公式，占位符照样能被还原。
  if (fnOrder.length) out += '\n\n<section class="md-footnotes">'
    + fnOrder.map((k, i) => `<p class="md-fn-item" id="fn-${i + 1}"><sup>${i + 1}</sup> ${marked.parseInline(footnotes.get(k))} <a class="md-fn-back" href="#fnref-${i + 1}" aria-label="返回出处 Back">↩</a></p>`).join('\n')
    + '</section>';
  if (maths.length) out = out.replace(/\u0000M(\d+)E\u0000/g, (_, i) => { const m = maths[+i]; return m ? renderKatex(m.tex, m.display) : ''; });
  return out;
}

// —— Live Preview 式镜像层 v2（对齐 Obsidian）：镜像层是唯一布局主体 ——
// 语法符号（#、**、<span…>、[[ ]] 等）默认完全不输出（宽度真正回收，正文顶格连续），
// 光标或选区落在所属片段内（行首标记 #、>、``` 则随光标所在行）时才把符号渲染出来，可像源码一样编辑；
// textarea 退化为透明输入黑盒（不折行、不滚动、指针穿透），只负责键盘 / 输入法与选区状态；
// 光标与选区由镜像层自绘，点击 / 拖选 / 双击由镜像层接管并映射回源码偏移。
// 正文仍是同一个 textarea：双链补全 / 斜杠菜单 / 格式栏 / 打字机模式全部无感。
// 可见文本段都带 data-s（源码偏移），行 div 带 data-s0 / data-ln，隐藏符号处放零宽锚点 .lm-z，
// 由此实现 DOM 坐标 ↔ 源码偏移的双向换算。

const textNodesIn = (el, acc = []) => {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) acc.push(c);
    else if (c.nodeType === 1) textNodesIn(c, acc);
  }
  return acc;
};

// 收集镜像层映射表：可见段（data-s）与行盒（data-s0），按源码偏移排序
function buildOffsetMap(inner) {
  const spans = [], lines = [];
  for (const el of inner.querySelectorAll('[data-s]')) {
    let len = 0;
    for (const t of textNodesIn(el)) len += t.data.length;
    spans.push({s: +el.dataset.s, len, el});
  }
  for (const el of inner.querySelectorAll('[data-s0]')) lines.push({s: +el.dataset.s0, n: +el.dataset.ln, el});
  spans.sort((a, b) => a.s - b.s);
  lines.sort((a, b) => a.s - b.s);
  return {spans, lines};
}

// 源码偏移 → 定位结果：span 内部 / 行首 / 行尾 / 相邻可见段之间的隐藏间隙
function resolveOffset(offset, map) {
  const {spans, lines} = map;
  let lo = 0, hi = lines.length - 1, line = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, L = lines[mid];
    if (offset < L.s) hi = mid - 1;
    else if (offset > L.s + L.n) lo = mid + 1;
    else { line = L; break; }
  }
  if (!line) return null;
  const lineEnd = line.s + line.n;
  lo = 0; hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, S = spans[mid];
    if (offset < S.s) hi = mid - 1;
    else if (offset >= S.s + S.len) lo = mid + 1;
    else return {k: 'span', line, span: S, at: offset - S.s};
  }
  const inLine = spans.filter(S => S.s >= line.s && S.s < lineEnd);
  if (offset === lineEnd) return {k: 'end', line, inLine};
  if (offset === line.s || !line.n) return {k: 'start', line, inLine};
  let prev = null, next = null;
  for (const S of inLine) {
    if (S.s + S.len <= offset) prev = S;
    else { next = S; break; }
  }
  return {k: 'gap', line, prev, next};
}

// 元素内第 at 个（解码后）字符的视口矩形；end 为真时取末位字符右缘（光标落在段尾）
function charRect(span, at, end) {
  const nodes = textNodesIn(span.el);
  let acc = 0;
  for (const nd of nodes) {
    const l = nd.data.length;
    if (at < acc + l) {
      const r = document.createRange();
      r.setStart(nd, at - acc);
      r.setEnd(nd, Math.min(l, at - acc + 1));
      const rect = r.getBoundingClientRect();
      return end ? {left: rect.right, top: rect.top, height: rect.height} : rect;
    }
    acc += l;
  }
  return null;
}

const rowPack = (r, el) => { // 光标高度按该处行高取齐（标题行更高）
  if (!r) return null;
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return {left: r.left, top: r.top + r.height / 2 - lh / 2, height: lh};
};

// 源码偏移 → 视口坐标（自绘光标 / 打字机居中用）
function locateRect(offset, map) {
  const res = resolveOffset(offset, map);
  if (!res) return null;
  if (res.k === 'span') return rowPack(charRect(res.span, res.at), res.span.el);
  if (res.k === 'gap') { // 落在隐藏符号上：贴到后一个可见段起点，否则前一个可见段终点
    const r = res.next ? rowPack(charRect(res.next, 0), res.next.el)
      : res.prev ? rowPack(charRect(res.prev, Math.max(0, res.prev.len - 1), true), res.prev.el) : null;
    if (r) return r;
  }
  const {line, inLine} = res;
  if (res.k !== 'start' && inLine.length) {
    const lastS = inLine[inLine.length - 1];
    const r = rowPack(charRect(lastS, Math.max(0, lastS.len - 1), true), lastS.el);
    if (r) return r;
  }
  if (inLine.length) {
    const r = rowPack(charRect(inLine[0], 0), inLine[0].el);
    if (r) return r;
  }
  const r = line.el.getBoundingClientRect();
  return {left: r.left, top: r.top, height: parseFloat(getComputedStyle(line.el).lineHeight) || 20};
}

function endpointOf(span, atEnd) {
  const nodes = textNodesIn(span.el);
  if (!nodes.length) return null;
  const nd = atEnd ? nodes[nodes.length - 1] : nodes[0];
  return {node: nd, off: atEnd ? nd.data.length : 0};
}

// 定位结果 → Range 端点（自绘选区用）
function resolveEndpoint(res) {
  if (!res) return null;
  if (res.k === 'span') {
    let acc = 0;
    for (const nd of textNodesIn(res.span.el)) {
      if (res.at < acc + nd.data.length) return {node: nd, off: res.at - acc};
      acc += nd.data.length;
    }
    return endpointOf(res.span, true);
  }
  if (res.k === 'gap') {
    const e = res.next ? endpointOf(res.next, false) : res.prev ? endpointOf(res.prev, true) : null;
    if (e) return e;
  }
  const {line, inLine} = res;
  if (res.k !== 'start' && inLine.length) {
    const e = endpointOf(inLine[inLine.length - 1], true);
    if (e) return e;
  }
  if (inLine.length) {
    const e = endpointOf(inLine[0], false);
    if (e) return e;
  }
  return {el: line.el, child: res.k === 'end' ? line.el.childNodes.length : 0};
}

// 视口坐标 → 源码偏移（镜像层点击 / 拖选用）
function offsetFromPoint(api, x, y) {
  let r = null;
  try { r = document.caretRangeFromPoint(x, y); } catch { return null; }
  const inner = api.inner && api.inner();
  if (!r || !inner) return null;
  const node = r.startContainer, off = r.startOffset;
  if (node.nodeType === 3) {
    let el = node.parentElement;
    while (el && el !== inner && !(el.dataset && (el.dataset.s !== undefined || el.dataset.s0 !== undefined))) el = el.parentElement;
    if (!el || el === inner) return null;
    if (el.dataset.s !== undefined) {
      let before = 0;
      for (const t of textNodesIn(el)) { if (t === node) break; before += t.data.length; }
      return +el.dataset.s + before + Math.min(off, node.data.length);
    }
    return +el.dataset.s0; // 空行的零宽空格
  }
  const el = node;
  if (el.dataset && el.dataset.s !== undefined) {
    const kids = el.childNodes;
    if (off < kids.length && textNodesIn(kids[off]).length) return +el.dataset.s;
    let len = 0;
    for (const t of textNodesIn(el)) len += t.data.length;
    return +el.dataset.s + len;
  }
  if (el.dataset && el.dataset.s0 !== undefined) {
    let sum = 0;
    const kids = el.childNodes;
    for (let i = 0; i < Math.min(off, kids.length); i++) {
      const c = kids[i];
      sum += c.nodeType === 3 ? c.data.length : textNodesIn(c).reduce((n, t) => n + t.data.length, 0);
    }
    return +el.dataset.s0 + sum;
  }
  return null;
}

// 双击选词：优先 Intl.Segmenter（中日文按词），退化为连续词字符
function wordRangeAt(src, o) {
  src = String(src);
  o = Math.max(0, Math.min(o, src.length));
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      for (const s of new Intl.Segmenter('zh-hans', {granularity: 'word'}).segment(src)) {
        if (s.index <= o && o < s.index + s.segment.length && s.isWordLike)
          return [s.index, s.index + s.segment.length];
      }
    }
  } catch { /* ignore */ }
  const isW = c => /[\w\u4e00-\u9fff\u3400-\u4dbf'’-]/.test(c);
  if (isW(src[o] || '')) {
    let a = o, b = o + 1;
    while (a > 0 && isW(src[a - 1])) a--;
    while (b < src.length && isW(src[b])) b++;
    return [a, b];
  }
  let a = o, b = Math.min(o + 1, src.length);
  while (a > 0 && !isW(src[a - 1]) && src[a - 1] !== '\n') a--;
  while (b < src.length && !isW(src[b]) && src[b] !== '\n') b++;
  return [a, b];
}

export function LineMirror({text, taRef}) {
  const [sel, setSel] = useState([0, 0, 0]); // [光标行号, 选区起点, 选区终点]
  const [focused, setFocused] = useState(false);
  const degraded = String(text || '').length > MIRROR_DEGRADE_LIMIT;
  const box = useRef(null), inner = useRef(null), caretEl = useRef(null), selBox = useRef(null);
  const api = useRef({}).current; // 挂到 textarea 上的镜像层 API（打字机 / 大纲目录经它取镜像坐标）
  const html = useMemo(() => buildMirrorHtml(text, sel), [text, sel]);

  // 排版属性对齐（每次渲染重拷：padding 会随大纲目录显隐变化）
  useEffect(() => {
    const el = taRef.current, ip = inner.current;
    if (!el || !ip) return;
    const cs = getComputedStyle(el);
    for (const k of ['fontSize', 'lineHeight', 'fontFamily', 'fontWeight', 'letterSpacing', 'wordSpacing',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'overflowWrap'])
      ip.style[k] = cs[k];
    ip.style.whiteSpace = 'pre-wrap';
  });

  // 自绘光标与选区（文本 / 选区 / 焦点变化后）
  useLayoutEffect(() => {
    const el = taRef.current, ip = inner.current, ce = caretEl.current, sb = selBox.current, sc = box.current;
    if (!el || !ip || !ce || !sb || !sc) return;
    const map = buildOffsetMap(ip);
    api.map = map; api.mapText = el.value;
    const ir = ip.getBoundingClientRect();
    const s = el.selectionStart || 0, e = Math.max(el.selectionEnd || 0, s);
    const head = el.selectionDirection === 'backward' ? s : e; // 光标跟随移动端（shift+方向键）
    const focusNow = focused && document.activeElement === el;
    if (focusNow) {
      const c = locateRect(head, map);
      if (c) {
        ce.style.display = 'block';
        ce.style.transform = `translate(${c.left - ir.left}px, ${c.top - ir.top}px)`;
        ce.style.height = c.height + 'px';
        if (!api.drag) { // 光标出视口时滚动补足（拖选中不打断）
          const vr = sc.getBoundingClientRect(), over = 2;
          if (c.top < vr.top + over) sc.scrollTop -= vr.top + over - c.top + c.height;
          else if (c.top + c.height > vr.bottom - over) sc.scrollTop += c.top + c.height - vr.bottom + over + c.height;
        }
      } else ce.style.display = 'none';
    } else ce.style.display = 'none';
    sb.textContent = '';
    if (focusNow && e > s) {
      try {
        const a = resolveEndpoint(resolveOffset(s, map)), b = resolveEndpoint(resolveOffset(e, map));
        if (a && b) {
          const rg = document.createRange();
          if (a.node) rg.setStart(a.node, a.off); else rg.setStart(a.el, a.child);
          if (b.node) rg.setEnd(b.node, b.off); else rg.setEnd(b.el, b.child);
          for (const r of rg.getClientRects()) {
            if (!r || r.height < 2) continue; // 零宽锚点不计入选区
            const d = document.createElement('i');
            d.className = 'lm-selr';
            d.style.left = (r.left - ir.left) + 'px';
            d.style.top = (r.top - ir.top) + 'px';
            d.style.width = Math.max(r.width, 2) + 'px';
            d.style.height = r.height + 'px';
            sb.appendChild(d);
          }
        }
      } catch { /* ignore */ }
    }
  });

  // 挂载：事件绑定 + API 挂载（三个编辑器各一份，互不干扰）
  useEffect(() => {
    const el = taRef.current, sc = box.current, ip = inner.current;
    if (!el || !sc || !ip) return;
    api.scroller = sc;
    api.inner = () => inner.current;
    api.drag = false;
    api.dblT = 0; api.dblO = -1;
    api.ensureMap = () => {
      if (!api.map || api.mapText !== el.value) {
        api.mapText = el.value;
        api.map = inner.current ? buildOffsetMap(inner.current) : null;
      }
      return api.map;
    };
    api.caretRect = () => {
      const map = api.ensureMap();
      if (!map) return null;
      const s = el.selectionStart || 0, e = Math.max(el.selectionEnd || 0, s);
      return locateRect(el.selectionDirection === 'backward' ? s : e, map);
    };
    api.lineTop = line => { // 指定行（源码行号）在镜像层内容坐标里的顶部位置（含折行，精确）
      const map = api.ensureMap(), ip2 = inner.current;
      if (!map || !ip2) return null;
      const v = el.value;
      const pos = line ? v.split('\n').slice(0, line).join('\n').length + 1 : 0;
      const L = map.lines.find(x => x.s === pos);
      return L ? L.el.getBoundingClientRect().top - ip2.getBoundingClientRect().top : null;
    };
    api.offsetFromPoint = (x, y) => (api.ensureMap() ? offsetFromPoint(api, x, y) : null);
    el.__mirrorApi = api;
    const track = () => {
      const s = Math.max(el.selectionStart || 0, 0), e = Math.max(el.selectionEnd || s, s);
      const c = el.value.slice(0, s).split('\n').length - 1;
      setSel(p => (p[0] === c && p[1] === s && p[2] === e ? p : [c, s, e])); // 值不变不触发重渲染
    };
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    const onDocSel = () => { if (document.activeElement === el) track(); };
    const onScroll = () => el.dispatchEvent(new Event('scroll')); // 滚动主体换成镜像层，转发给旧的 textarea 监听方
    sc.addEventListener('scroll', onScroll);
    el.addEventListener('input', track);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    document.addEventListener('selectionchange', onDocSel);
    track();
    setFocused(document.activeElement === el);
    // —— 鼠标接管：点击定位 / 拖选 / 双击选词（textarea 已指针穿透） ——
    const place = (a, b) => { el.focus({preventScroll: true}); el.setSelectionRange(a, b); };
    const onDown = e => {
      if (e.button !== 0) return;
      const t = e.target;
      if (t !== inner.current && !inner.current.contains(t)) return; // 滚动条等放行
      const o = api.offsetFromPoint(e.clientX, e.clientY);
      if (o == null) {
        const r = inner.current.getBoundingClientRect();
        if (e.clientY < r.top + 2) { place(0, 0); e.preventDefault(); }
        else if (e.clientY > r.bottom - 2) { const n = el.value.length; place(n, n); e.preventDefault(); }
        return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - api.dblT < 350 && api.dblO === o) { // 双击选词
        const [a, b] = wordRangeAt(el.value, o);
        place(a, b);
        api.dblT = 0;
        return;
      }
      api.dblT = now; api.dblO = o;
      const anchor = e.shiftKey
        ? (el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd) || o
        : o;
      api.drag = true;
      const apply = head => place(Math.min(anchor, head), Math.max(anchor, head));
      apply(o);
      const move = ev => {
        const h = api.offsetFromPoint(ev.clientX, ev.clientY);
        if (h != null) apply(h);
      };
      const up = () => {
        api.drag = false;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
    const onCtx = () => el.focus({preventScroll: true}); // 右键菜单以 textarea 为焦点（可粘贴）
    sc.addEventListener('mousedown', onDown);
    sc.addEventListener('contextmenu', onCtx);
    return () => {
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('mousedown', onDown);
      sc.removeEventListener('contextmenu', onCtx);
      el.removeEventListener('input', track);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
      document.removeEventListener('selectionchange', onDocSel);
      if (el.__mirrorApi === api) delete el.__mirrorApi;
    };
  }, [taRef]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="line-mirror" ref={box}>
    {degraded && <div className="lm-degraded" role="status">已切换为纯文本模式（正文过长，保证打字流畅）<em>Plain text mode for long text</em></div>}
    <div className="lm-inner" ref={inner} aria-hidden="true" dangerouslySetInnerHTML={{__html: html}}/>
    <div className="lm-selbox" ref={selBox} aria-hidden="true"/>
    <i className="lm-caret" ref={caretEl} aria-hidden="true"/>
  </div>;
}

// 镜像层逐行渲染缓存：打字只改动光标附近一两行，其余行直接复用上次的 HTML 串，
// 长文逐键成本从「全篇词法 + 字符串拼接」降到「一两行的词法」。键含源码偏移（上方内容一变，
// 下方行偏移整体后移、键自然失配，不会串位）；选区相交中的行（至多一两行）不缓存。
const LM_CACHE = new Map();
const LM_CACHE_MAX = 12000;

// 镜像层降级阈值：超过此长度的正文切换为纯文本映射模式（无语法高亮，保证打字流畅）
const MIRROR_DEGRADE_LIMIT = 200_000;

// 镜像层 HTML 生成（纯函数，便于离线校验）：sel = [光标行号, 选区起点, 选区终点]。
// 隐藏符号不进 DOM（零宽锚点占位，宽度真正回收）；每个可见段带 data-s、行盒带 data-s0/data-ln 供坐标映射。
export function buildMirrorHtml(text, sel) {
  const [cur, ss, se] = sel || [0, 0, 0];
  const src = String(text || '');
  // 超长正文降级：跳过词法（每次按键全篇正则扫描是数千行长文掉帧的根因），
  // 只保留逐行映射锚点——光标 / 点击 / 拖选仍可用，只是没有语法高亮与行内富显示
  if (src.length > MIRROR_DEGRADE_LIMIT) {
    let off = 0;
    return src.split('\n').map(l => {
      const lineStart = off; off += l.length + 1;
      return `<div class="lm-line" data-s0="${lineStart}" data-ln="${l.length}">${esc(l) || '&#8203;'}</div>`;
    }).join('');
  }
  const inRegion = (s, e) => ss <= e && se >= s; // 光标/选区与片段相交（含边缘）→ 片段的语法符号显形
  const T = (raw, at) => raw ? `<span data-s="${at}">${esc(raw)}</span>` : '';
  const Z = at => `<i class="lm-z" data-s="${at}"></i>`; // 隐藏符号处的零宽锚点
  const mk = (raw, at, on) => on ? `<i class="lm-mk on" data-s="${at}">${esc(raw)}</i>` : Z(at);
  // 单遍扫描行内片段（原始文本上匹配，避免实体还原；成对片段之外的原样字符照常显示）
  const walk = (s, base) => {
    const out = [];
    let last = 0, m;
    const re = new RegExp(INLINE_SRC, 'g');
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(T(s.slice(last, m.index), base + last));
      const t = m[0], at = base + m.index, end = at + t.length, on = inRegion(at, end);
      if (t.startsWith('![')) { // dataURL 图片：镜像层直接渲染成缩略图（base64 太长，源码模式会毁排版；
        // 整行选中/删除仍可用，光标经零宽锚点落在图片前后）
        const src2 = /\((data:[^)\s]+)\)/.exec(t)?.[1] || '';
        const alt = /^!\[([^\]\n]*)\]/.exec(t)?.[1] || '';
        out.push(`<i class="lm-z" data-s="${at}"></i><img class="lm-img" src="${esc(src2)}" alt="${esc(alt || '图片')}" data-s="${at}" data-e="${end}"/>`);
      } else if (t.startsWith('<span')) { // 彩色文字：首尾标签是语法符号，内容继续 token 化
        const openLen = t.indexOf('>') + 1;
        out.push(mk(t.slice(0, openLen), at, on) + `<span style="color:${m[1]}">`
          + walk(t.slice(openLen, t.length - 7), at + openLen) + '</span>' + mk('</span>', end - 7, on));
      } else if (t.startsWith('<u>')) { // 下划线：同彩色文字，首尾标签是语法符号，内容继续 token 化
        out.push(mk('<u>', at, on) + '<u>' + walk(t.slice(3, -4), at + 3) + '</u>' + mk('</u>', end - 4, on));
      } else if (t.startsWith('[[')) {
        out.push(mk('[[', at, on) + '<span class="lm-a">' + walk(t.slice(2, -2), at + 2) + '</span>' + mk(']]', end - 2, on));
      } else if (t.startsWith('==')) {
        out.push(mk('==', at, on) + '<mark>' + walk(t.slice(2, -2), at + 2) + '</mark>' + mk('==', end - 2, on));
      } else if (t.startsWith('**') || t.startsWith('__')) {
        const d = t.slice(0, 2);
        out.push(mk(d, at, on) + '<span class="lm-b">' + walk(t.slice(2, -2), at + 2) + '</span>' + mk(d, end - 2, on));
      } else if (t.startsWith('~~')) {
        out.push(mk('~~', at, on) + '<span class="lm-s">' + walk(t.slice(2, -2), at + 2) + '</span>' + mk('~~', end - 2, on));
      } else if (t[0] === '*') {
        out.push(mk('*', at, on) + '<span class="lm-i">' + walk(t.slice(1, -1), at + 1) + '</span>' + mk('*', end - 1, on));
      } else { // 行内代码：hiCode 直接吃原始文本（自带转义，带 data-s 映射），镜像层里色块仍隐藏
        out.push(mk('`', at, on) + '<span class="lm-c">' + hiCode(t.slice(1, -1), '', at + 1) + '</span>' + mk('`', end - 1, on));
      }
      last = m.index + t.length;
    }
    if (last < s.length) out.push(T(s.slice(last), base + last));
    return out.join('');
  };
  // 单行渲染：fence/lang 是「进入该行前」的围栏状态（围栏内整行走阅读式高亮）
  const renderLine = (l, lineStart, fence, lang, lineOn) => {
    const fenceM = /^\s*```/.exec(l);
    let inner;
    if (fence && !fenceM) {
      inner = hiCode(l, lang, lineStart); // 围栏内：阅读式语法高亮（带映射）
    } else {
      // 行首标记：标题 / 引用 / 围栏声明整体显隐；列表符号保留可见充当项目符号
      const pre = fenceM ? /^(\s*```[^\s`]*`*)/.exec(l) : /^((?:#{1,6}|>)\s|\s*>\s?)/.exec(l);
      let head = '', rest = l, at = lineStart;
      if (pre && pre[1]) {
        head = mk(pre[1], lineStart, lineOn);
        rest = l.slice(pre[1].length); at = lineStart + pre[1].length;
      }
      inner = head + walk(rest, at);
    }
    return inner;
  };
  const lines = src.split('\n');
  // 第一遍只算各行的围栏进入状态（便宜的正则），第二遍按缓存渲染
  const fenceState = new Array(lines.length);
  let fence = false, lang = '';
  for (let i = 0; i < lines.length; i++) {
    fenceState[i] = {fence, lang};
    const fm = /^\s*```/.exec(lines[i]);
    if (fm) {
      if (!fence) { fence = true; lang = (lines[i].match(/^\s*```([^\s`]*)/) || ['', ''])[1]; }
      else { fence = false; lang = ''; }
    }
  }
  const out = [];
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], lineStart = off; off += l.length + 1;
    const st = fenceState[i];
    const lineOn = i === cur; // 行首标记随光标所在行显形
    // 本行结束后的围栏状态（决定本行样式：lm-code / 引用 / 标题分级）
    let pf = st.fence, pl = st.lang;
    const fenceM = /^\s*```/.exec(l);
    if (fenceM) {
      if (!pf) { pf = true; pl = (l.match(/^\s*```([^\s`]*)/) || ['', ''])[1]; }
      else { pf = false; pl = ''; }
    }
    // 选区与整行的相交态：全外 '0' / 全内 '1' 可缓存，相交中的行每次现算
    const lineEnd = lineStart + l.length;
    const inter = (se < lineStart || ss > lineEnd) ? '0' : (ss <= lineStart && se >= lineEnd) ? '1' : '';
    let inner;
    if (inter) {
      const key = `${lineStart}|${st.fence ? 1 : 0}|${st.lang}|${lineOn ? 1 : 0}|${inter}|${l}`;
      inner = LM_CACHE.get(key);
      if (inner === undefined) {
        inner = renderLine(l, lineStart, st.fence, st.lang, lineOn);
        if (LM_CACHE.size >= LM_CACHE_MAX) LM_CACHE.clear();
        LM_CACHE.set(key, inner);
      }
    } else {
      inner = renderLine(l, lineStart, st.fence, st.lang, lineOn);
    }
    const h = !fenceM && !pf ? headingAt(lines, i) : null; // 标题分级（ATX + Setext），与大纲 / 导入同口径
    const cls = ['lm-line', h ? `lm-h lm-h${h.level}` : '',
      !fenceM && !pf && /^\s*>/.test(l) ? 'lm-quote' : '',
      (fenceM || pf) ? 'lm-code' : ''].filter(Boolean).join(' ');
    out.push(`<div class="${cls}" data-s0="${lineStart}" data-ln="${l.length}">${inner || '&#8203;'}</div>`);
  }
  return out.join('');
}

export function ArticleView({work, graph, onChange, onClose, onGo, onOpenContent, onEditInfo, onMakeMap, eyebrow = ['ARTICLE', '文章全文'], exportKind = 'works', progressId = ''}) {
  // 落盘位置如实显示：桌面版连库时编辑实时写回知识库 .md，网页版才存浏览器
  const savedNote = capable() && getRoot() ? '已实时写入知识库' : '已保存到此浏览器';
  const [mode, setMode] = useState('edit');
  // 专注模式：隐藏头部信息与页脚，正文区占满（浮层本身已全屏，这里是榨出最后的可视空间）
  const [focusMode, setFocusMode] = useState(false);
  const area = useRef(null);
  const previewRef = useRef(null);
  const {on: pluginOn} = usePlugins();
  const {on: net} = useNetwork();
  const titles = useMemo(() => graph.nodes
    .filter(n => CONTENT.has(n.kind) && n.id !== 'post:' + work.id)
    .map(n => ({id: n.id, title: n.path?.split('/').pop().replace(/\.md$/, '') || n.title, short: n.short || n.title, kind: n.kind})), [graph, work.id]);
  const heads = useMemo(() => headingMap(graph), [graph]);
  const wiki = useWikiComplete({titles, areaRef: area, onChange: body => onChange({body}), headings: heads});
  // preview / previewMode 传入后，大纲目录（toc 插件）在预览模式同样可用：
  // 阅读区导入的书籍动辄几百页，没有目录无法快速跳章节
  const fx = useEditorEnhancers({area, value: work.body, onChange: body => onChange({body}), wiki, title: work.title, titles, preview: previewRef, previewMode: mode === 'preview' ? 'preview' : 'edit', docId: exportKind + ':' + work.id});
  const html = useMemo(() => mode === 'preview' ? renderMarkdown(work.body) : '', [mode, work.body]);
  // —— 文内查找（⌘F）：预览模式正文命中高亮 + 上一个 / 下一个 ——
  const [find, setFind] = useState(null); // {q, total, idx} | null
  const findInput = useRef(null);
  const findTimer = useRef(null);
  const runFind = q => {
    clearTimeout(findTimer.current);
    findTimer.current = setTimeout(() => {
      const box = previewRef.current;
      clearFindMarks(box);
      if (!q) { setFind(f => (f ? {...f, total: 0, idx: -1} : f)); return; }
      const total = markFindHits(box, q);
      setFind(f => ({q, total, idx: total ? 0 : -1}));
      if (total) focusFindHit(box, 0);
    }, 180); // 长书逐键全量走查 DOM 不便宜，防抖一下
  };
  const stepFind = dir => {
    if (!find?.total) return;
    const idx = (find.idx + dir + find.total) % find.total;
    setFind({...find, idx});
    focusFindHit(previewRef.current, idx);
  };
  const closeFind = () => { clearTimeout(findTimer.current); clearFindMarks(previewRef.current); setFind(null); };
  // ⌘F / Ctrl+F 唤出查找（焦点在窗口任意处均可）；编辑模式不拦截
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f' && mode === 'preview') {
        e.preventDefault();
        setFind(f => f ?? {q: '', total: 0, idx: -1});
        setTimeout(() => findInput.current?.select(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);
  // 正文重渲染（切预览 / 翻译插入等）后旧高亮随 innerHTML 消失，计数一并归零；朗读段落快照同样失效
  useEffect(() => {
    if (mode !== 'preview') return;
    ttsStop();
    setFind(f => (f && (f.total || f.idx >= 0) ? {...f, total: 0, idx: -1} : f));
  }, [html, mode]);
  useEffect(() => () => { clearTimeout(findTimer.current); clearFindMarks(previewRef.current); }, []);
  // —— 本地语音朗读（预览模式）：系统语音离线朗读，逐段跟随高亮，可暂停 / 调语速 ——
  // 段落快照存在 ref；paused 不进朗读 effect 的依赖，暂停走原生 pause/resume——
  // 否则 effect 重跑的 cleanup 会 cancel 掉正在暂停的语音
  const TTS_RATES = [1, 1.25, 1.5, 0.75];
  const [tts, setTts] = useState(null); // {idx, rate}
  const [ttsPaused, setTtsPaused] = useState(false);
  const ttsEls = useRef([]);
  const ttsGen = useRef(0);
  // —— 朗读音色：列出系统全部语音（中文排前，婷婷/升级版优先做默认），选择持久化并可试听 ——
  // 系统里装了更好的音色（如 macOS 的婷婷升级版）会自动出现在这里；想要短视频风格的
  // 女声，到 系统设置→辅助功能→朗读内容→系统声音→管理声音 安装后即可选用
  const TTS_VOICE_KEY = CONFIG.storagePrefix + '-tts-voice-v1';
  const [ttsVoices, setTtsVoices] = useState(() => { try { return window.speechSynthesis?.getVoices?.() || []; } catch { return []; } });
  const [ttsVoiceURI, setTtsVoiceURI] = useState(() => { try { return localStorage.getItem(TTS_VOICE_KEY) || ''; } catch { return ''; } });
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const up = () => setTtsVoices([...speechSynthesis.getVoices()]);
    speechSynthesis.onvoiceschanged = up;
    up();
    return () => { speechSynthesis.onvoiceschanged = null; };
  }, []);
  const voiceSorted = useMemo(() => [...ttsVoices].sort((a, b) => (/^zh/i.test(b.lang) ? 1 : 0) - (/^zh/i.test(a.lang) ? 1 : 0)), [ttsVoices]);
  const ttsVoicePick = () => ttsVoices.find(v => v.voiceURI === ttsVoiceURI)
    || ttsVoices.find(v => /婷婷|Tingting/i.test(v.name))
    || ttsVoices.find(v => /^zh[-_]CN/i.test(v.lang)) || null;
  const ttsPreview = () => {
    if (!('speechSynthesis' in window)) return;
    ttsGen.current++; // cancel 会异步派发 end：不推进代数，朗读中的旧 onend 会把试听当成「念完」跳段
    try { speechSynthesis.cancel(); } catch {}
    if (ttsPaused) { try { speechSynthesis.resume(); } catch {} } // 暂停态 speak 只入队不发声
    const u = new SpeechSynthesisUtterance('你好，这是当前语音的试听。');
    const v = ttsVoicePick();
    if (v) { u.voice = v; u.lang = v.lang || 'zh-CN'; } else u.lang = 'zh-CN';
    speechSynthesis.speak(u);
  }; // 换段 / 改语速会 cancel 当前语音并触发异步 onend：代数守卫拦住过期回调
  const ttsStop = () => {
    try { window.speechSynthesis?.cancel(); } catch {}
    ttsEls.current.forEach(el => el.classList.remove('tts-reading')); // 主动停止时高亮不随 effect 清理，这里必须显式摘掉
    ttsEls.current = [];
    setTts(null); setTtsPaused(false);
  };
  const ttsStart = () => {
    const box = previewRef.current;
    if (!box || !('speechSynthesis' in window)) return;
    const els = [...box.querySelectorAll('p, li, h1, h2, h3, h4, blockquote')].filter(el => el.textContent.trim());
    if (!els.length) return;
    ttsEls.current = els;
    setTts({idx: 0, rate: 1});
  };
  const ttsPauseToggle = () => {
    if (!tts) return;
    if (ttsPaused) { try { speechSynthesis.resume(); } catch {} setTtsPaused(false); }
    else { try { speechSynthesis.pause(); } catch {} setTtsPaused(true); }
  };
  useEffect(() => {
    if (!tts) return;
    const els = ttsEls.current;
    els.forEach((el, i) => el.classList.toggle('tts-reading', i === tts.idx));
    const cur = els[tts.idx];
    if (!cur) { ttsStop(); return; } // 全部念完
    cur.scrollIntoView({block: 'center'});
    const gen = ++ttsGen.current;
    const u = new SpeechSynthesisUtterance(cur.textContent);
    u.lang = 'zh-CN';
    u.rate = tts.rate;
    const picked = ttsVoicePick();
    if (picked) { u.voice = picked; u.lang = picked.lang || 'zh-CN'; }
    // 被 cancel 的语音（调速 / 换段）也会异步派发 end：代数不匹配说明是过期回调，不推进
    u.onend = () => { if (ttsGen.current === gen) setTts(t => (t ? {...t, idx: t.idx + 1} : null)); };
    u.onerror = () => { if (ttsGen.current === gen) setTts(t => (t ? {...t, idx: t.idx + 1} : null)); };
    speechSynthesis.speak(u);
    return () => { try { speechSynthesis.cancel(); } catch {} }; // 换段 / 改语速 / 卸载时停掉上一段
  }, [tts?.idx, tts?.rate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { try { window.speechSynthesis?.cancel(); } catch {} }, []);
  useEffect(() => { if (mode !== 'preview') ttsStop(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // —— 反向链接：哪些内容用 [[双链]] 指向了这篇（编辑时无需去分析栏翻找）——
  const selfGid = useMemo(() => ['post', 'reading', 'archive', 'draft', 'note'].map(k => k + ':' + work.id).find(x => graph.index.has(x)) || null, [graph, work.id]);
  const backlinks = useMemo(() => selfGid
    ? graph.links.filter(l => l.kind === 'wiki' && l.t === selfGid).map(l => graph.index.get(l.s)).filter(Boolean)
    : [], [graph, selfGid]);
  // —— 阅读进度：预览模式打开时回到上次位置，滚动时节流记录百分比（关闭时兜底再存一次）——
  const pctRef = useRef(null);
  const [progressBar, setProgressBar] = useState(null); // 0-1，底部进度条显示（独立于节流保存）
  useEffect(() => {
    if (mode !== 'preview' || !progressId) return;
    const box = previewRef.current;
    if (!box) return;
    let sc = null;
    // 等渲染完成再定位（Mermaid / 图片回填会改变高度，双 rAF 足够覆盖绝大多数排版）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const b = previewRef.current;
      if (!b) return;
      sc = findScroller(b);
      const saved = readProgress(progressId);
      const span = scrollSpanOf(sc);
      if (saved && saved.pct > 0.02 && span > 4) { sc.scrollTop = saved.pct * span; pctRef.current = saved.pct; setProgressBar(saved.pct); }
      else { pctRef.current = 0; setProgressBar(0); }
    }));
    let timer = null;
    let rafPb = 0;
    const onScroll = () => {
      // 进度条同步更新（rAF 包一层防高频 setState），保存仍走 600ms 节流
      if (!rafPb) rafPb = requestAnimationFrame(() => {
        rafPb = 0;
        const s2 = sc;
        if (s2) { const sp2 = scrollSpanOf(s2); if (sp2 > 4) setProgressBar(Math.min(1, Math.max(0, s2.scrollTop / sp2))); }
      });
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const s = sc;
        if (!s || !progressId) return;
        const span = scrollSpanOf(s);
        const pct = span > 4 ? Math.min(1, Math.max(0, s.scrollTop / span)) : 1;
        if (pctRef.current !== pct) { pctRef.current = pct; saveProgress(progressId, pct); }
      }, 600);
    };
    window.addEventListener('scroll', onScroll, {passive: true, capture: true}); // 容器不定：捕获模式全监听
    box.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      if (rafPb) cancelAnimationFrame(rafPb);
      window.removeEventListener('scroll', onScroll, {capture: true});
      box.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
      // 关闭兜底：现读滚动容器最终位置（节流窗内的最后一段位移也要存上）
      const s = sc || (previewRef.current ? findScroller(previewRef.current) : null);
      const span = scrollSpanOf(s);
      if (progressId && s && span > 4) saveProgress(progressId, Math.min(1, Math.max(0, s.scrollTop / span)));
      else if (progressId && pctRef.current != null) saveProgress(progressId, pctRef.current);
    };
  }, [mode, progressId, work.id]);
  // Mermaid 图表：预览渲染后把 .mermaid 块画成 SVG（语法错误回退为普通代码块，不崩）
  useEffect(() => {
    if (mode !== 'preview' || !previewRef.current) return;
    const nodes = previewRef.current.querySelectorAll('pre.mermaid:not([data-processed])');
    if (!nodes.length) return;
    nodes.forEach(n => n.setAttribute('data-processed', '1'));
    mermaid.run({nodes}).catch(() => { /* 语法错误：保留原文代码块 */ });
  }, [mode, html]);
  // 双链解析：与 graph.js 的 byName 规则一致（nameIndex 统一实现）。
  const byName = useMemo(() => nameIndex(graph.nodes), [graph]);
  const wikiCount = (String(work.body).match(/\[\[([^\]\n]+)\]\]/g) || []).length;
  // —— 沉浸式翻译（immersive 插件 + 顶栏联网开关，二者都打开才发请求） ——
  const [trans, setTrans] = useState({phase: 'idle', done: 0, total: 0}); // idle | running | done
  const [hint, setHint] = useState('');
  const immersive = pluginOn('immersive');
  // 卸载后仍在跑的异步任务（翻译两路 worker / 导出提示定时器）必须先判存活，不能再 setState
  const alive = useRef(true);
  const hintTimer = useRef(null);
  useEffect(() => () => { alive.current = false; clearTimeout(hintTimer.current); }, []);
  useEffect(() => { if (mode !== 'preview') { setTrans({phase: 'idle', done: 0, total: 0}); setHint(''); } }, [mode]);
  const runTranslate = async () => {
    if (!net) { setHint('先打开顶栏联网开关 · Turn on the network switch in the top bar first'); return; }
    const root = previewRef.current;
    if (!root || trans.phase === 'running') return;
    setHint('');
    // 只翻顶层段落（p / 标题 / 列表项），跳过代码块与已是中文的段落
    const nodes = [...root.querySelectorAll('p, h1, h2, h3, h4, li')]
      .filter(el => !el.parentElement.closest('p, h1, h2, h3, h4, li'));
    const queue = nodes.filter(el => isTranslatable(el.textContent));
    if (!queue.length) { setHint('没有需要翻译的外语段落 · Nothing foreign to translate'); return; }
    setTrans({phase: 'running', done: 0, total: queue.length});
    const out = [];
    let done = 0, failed = 0;
    // 两路并发 + 每次请求间隔 120ms：免费翻译接口没有明确配额，打太快只会大面积限流失败
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const worker = async () => {
      while (queue.length) {
        if (!alive.current) return; // 视图已关闭：停止取任务、不再 setState
        const el = queue.shift();
        try { out.push([el, await translateText(el.textContent)]); } catch { out.push([el, null]); failed += 1; }
        done += 1;
        if (!alive.current) return; // await 期间被卸载：跳过本轮 setState 与后续请求
        setTrans(t => ({...t, done}));
        if (queue.length) await sleep(120);
      }
    };
    await Promise.all([worker(), worker()]);
    if (!alive.current) return; // 卸载后 out 里的 DOM 节点已失效，不能再写
    for (const [el, text] of out) {
      if (!text || !el.isConnected || el.querySelector('.md-trans')) continue;
      const span = document.createElement('span');
      span.className = 'md-trans';
      span.textContent = text;
      el.appendChild(span);
    }
    setTrans(t => ({...t, phase: 'done'}));
    if (failed) setHint(`完成，${failed} 段翻译失败（服务不可用或限流），可稍后重试 · ${failed} failed`);
  };
  const restoreTrans = () => {
    previewRef.current?.querySelectorAll('.md-trans').forEach(s => s.remove());
    setTrans({phase: 'idle', done: 0, total: 0});
    setHint('');
  };
  const onPreviewClick = e => {
    const a = e.target.closest('.md-wikilink');
    if (!a) return;
    // 块引用 [[笔记#小节]]：目标是当前这篇时滚动到对应小节，否则跳到目标内容
    // （双链就地打开目标内容：作品→作品库、笔记→方法库……；概念目标由 openContent 落到工作台图谱；
    //   未传 onOpenContent 时回退图谱定位）
    const {id, anchor} = resolveTarget(byName, a.dataset.target);
    if (!id) return;
    const selfId = ['post', 'reading', 'archive', 'draft', 'note'].map(k => k + ':' + work.id).find(x => graph.index.has(x));
    if (anchor && id === selfId) { scrollToAnchor(previewRef.current, anchor); return; }
    (onOpenContent || onGo)(id);
  };
  // —— 单篇导出：桌面版选目录写 .md；网页版浏览器直接下载 ——
  const [expHint, setExpHint] = useState('');
  const doExport = async () => {
    if (expHint === 'busy') return;
    setExpHint('busy');
    try {
      const dirMap = {works: '02-作品库', drafts: '03-创作台/正在写', readings: '06-阅读区', archives: '07-档案区'};
      const rel = `${dirMap[exportKind] || '02-作品库'}/${safeName(work.title)}.md`;
      const where = await exportFiles([{rel, body: serialize(exportKind, work)}]);
      if (!alive.current) return;
      setExpHint(where === 'download' ? '已下载 Exported' : where ? `已导出到「${where.replace(/\/+$/, '').split('/').pop()}」` : '');
    } catch { if (alive.current) setExpHint('导出失败 Export failed'); }
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => { if (alive.current) setExpHint(''); }, 2600);
  };
  return <section className={`article-view glass${focusMode ? ' focused' : ''}`} role="region" aria-label={eyebrow[1]}>
    {focusMode && <button className="icon-btn av-unfocus" onClick={() => setFocusMode(false)} title="退出专注 Exit focus" aria-label="退出专注模式"><Icon name="close" size={14}/></button>}
    <header className="av-head">
      <div className="av-title">
        <p className="eyebrow">{eyebrow[0]} <span>{eyebrow[1]}</span></p>
        <h2>{work.title}</h2>
        <p className="av-meta">{work.metaLine || `${String(work.date || '').slice(0, 10)} 首发 · 编辑于 ${work.updatedAt || work.date || ''}${work.direction ? ` · ${work.direction}` : ''} · ${(work.tags || []).length} 个标签`}</p>
      </div>
      <div className="av-actions">
        <div className="seg" role="group" aria-label="编辑或预览">
          {[['edit', '编辑', 'Edit'], ['preview', '预览', 'Preview']].map(([k, zh, en]) =>
            <button key={k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{zh}<em>{en}</em></button>)}
        </div>
        <button type="button" className={`av-focus${focusMode ? ' on' : ''}`} aria-pressed={focusMode}
          title="隐藏头部信息与页脚，正文占满 · Hide header/footer and maximize the text area" onClick={() => setFocusMode(v => !v)}>专注 <em>Focus</em></button>
        {mode === 'preview' && 'speechSynthesis' in window && <>
          {tts
            ? <>
              <button type="button" className="pill ghost" onClick={ttsStop} title="停止朗读 · Stop">停止 <em>Stop</em></button>
              <button type="button" className="pill ghost" onClick={ttsPauseToggle} title={ttsPaused ? '继续朗读 · Resume' : '暂停朗读 · Pause'}>{ttsPaused ? '继续' : '暂停'} <em>{ttsPaused ? 'Resume' : 'Pause'}</em></button>
              <button type="button" className="pill ghost" title="循环切换语速 · Cycle speed"
                onClick={() => setTts(t => ({...t, rate: TTS_RATES[(TTS_RATES.indexOf(t.rate) + 1) % TTS_RATES.length]}))}>语速 ×{tts.rate} <em>Rate</em></button>
              <label className="tts-voice" title="选择朗读音色（中文排前；想要更好听的女声，可在系统的语音管理里安装更多音色）· Voice">
                <select value={voiceSorted.some(v => v.voiceURI === ttsVoiceURI) ? ttsVoiceURI : ''} aria-label="朗读音色 Voice"
                  onChange={e => { setTtsVoiceURI(e.target.value); try { localStorage.setItem(TTS_VOICE_KEY, e.target.value); } catch {} }}>
                  <option value="">自动（优先中文女声）</option>
                  {voiceSorted.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name}（{v.lang}）</option>)}
                </select>
              </label>
              <button type="button" className="pill ghost" onClick={ttsPreview} title="用当前音色试听一句话 · Preview">试听 <em>试听</em></button>
            </>
            : <button type="button" className="pill ghost" onClick={ttsStart} title="用系统本地语音朗读正文（离线）· Read aloud with the local system voice">朗读 <em>TTS</em></button>}
        </>}
        {mode === 'preview' && immersive && <>
          <button className="pill ghost av-trans" onClick={trans.phase === 'running' ? undefined : trans.phase === 'done' ? restoreTrans : runTranslate}
            disabled={trans.phase === 'running'} aria-label="沉浸式翻译 Immersive translate">
            <Icon name="outlink" size={13}/>
            {trans.phase === 'running' ? `翻译中 ${trans.done}/${trans.total}` : trans.phase === 'done' ? '收起译文 Restore' : '沉浸翻译 Translate'}
          </button>
          {hint && <span className="av-trans-hint" role="status">{hint}</span>}
        </>}
        {expHint && <span className="av-trans-hint" role="status">{expHint === 'busy' ? '导出中… Exporting' : expHint}</span>}
        {onMakeMap && <button className="icon-btn" onClick={() => onMakeMap(exportKind, work)} title="从标题结构生成思维导图（已生成过则更新）· Make mind map" aria-label="生成思维导图"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="6" cy="6" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="6" cy="18" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="18" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M8.2 7 15.4 11M8.2 17 15.4 13" fill="none" stroke="currentColor" strokeWidth="1.6"/></svg></button>}
        <button className="icon-btn" onClick={doExport} disabled={expHint === 'busy'} title="导出为 Markdown Export as Markdown" aria-label="导出为 Markdown"><Icon name="save" size={15}/></button>
        {onEditInfo && <button className="icon-btn" onClick={onEditInfo} title="编辑文章信息 Edit article info" aria-label="编辑文章信息"><Icon name="draft" size={15}/></button>}
        <button className="icon-btn" onClick={onClose} aria-label="收起文章全文"><Icon name="close" size={15}/></button>
      </div>
    </header>
    {mode === 'preview' && find && <div className="av-findbar" role="search" aria-label="文内查找 Find in document">
      <Icon name="search" size={13}/>
      <input ref={findInput} value={find.q} placeholder="文内查找 · Find in document（Enter 下一个 / Shift+Enter 上一个）"
        onChange={e => { setFind({...find, q: e.target.value}); runFind(e.target.value); }}
        onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') closeFind(); }}/>
      <span className="av-find-count">{find.total ? `${find.idx + 1}/${find.total}` : find.q ? '无匹配' : ''}</span>
      <button className="icon-btn av-find-prev" onClick={() => stepFind(-1)} disabled={find.total < 2} aria-label="上一个命中"><Icon name="chevron" size={13}/></button>
      <button className="icon-btn" onClick={() => stepFind(1)} disabled={find.total < 2} aria-label="下一个命中"><Icon name="chevron" size={13}/></button>
      <button className="icon-btn" onClick={closeFind} aria-label="关闭查找"><Icon name="close" size={13}/></button>
    </div>}
    {backlinks.length > 0 && <div className="av-backlinks" role="group" aria-label={`反向链接 ${backlinks.length} 条 Backlinks`}>
      <span className="av-bl-label"><Icon name="back" size={12}/>反链 <em>{backlinks.length}</em></span>
      <div className="chip-row">{backlinks.slice(0, 10).map(n => n && <button key={n.id} className="chip" style={{'--kc': 'var(--gold)'}}
        title={`打开《${n.title}》`} onClick={() => (onOpenContent || onGo)(n.id)}>{n.short || n.title}</button>)}
        {backlinks.length > 10 && <span className="chip static">+{backlinks.length - 10}</span>}
      </div>
    </div>}
    {mode === 'edit' && fx.bar}
    {mode === 'edit' ? <div className="editor-area hybrid">
      <LineMirror text={work.body} taRef={area}/>
      <textarea ref={area} value={work.body} aria-label="文章正文（Markdown）"
        placeholder="用 Markdown 书写… 输入 [[ 链接其他文章、行首 / 插入模板 Type [[ to link, / for blocks"
        onChange={e => { onChange({body: e.target.value}); fx.onInput(e.target); wiki.check(e.target); }}
        onClick={e => wiki.check(e.target)}
        onKeyDown={fx.onKeyDown} onBlur={fx.onBlur}/>
      {wiki.suggest && <WikiSuggest suggest={wiki.suggest} pick={wiki.pick} setPick={wiki.setPick} insert={wiki.insert}/>}
      {fx.menu}
      {fx.ask}
      {fx.toc}
    </div> : <div className="editor-area hybrid" style={{position: 'relative'}}>
      <article className="md-preview" ref={previewRef} onClick={onPreviewClick} dangerouslySetInnerHTML={{__html: html}}/>
      {fx.toc}
      {progressId && <div className="reading-progress" role="progressbar" aria-label={`阅读进度 ${Math.round((progressBar || 0) * 100)}%`}
        title={`已读 ${Math.round((progressBar || 0) * 100)}% · 拖动快进`}>
        <div className="reading-progress-track" onClick={e => {
          const track = e.currentTarget;
          const rect = track.getBoundingClientRect();
          const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          const sc2 = previewRef.current ? findScroller(previewRef.current) : null;
          if (sc2) { const span2 = scrollSpanOf(sc2); if (span2 > 4) { sc2.scrollTop = pct * span2; setProgressBar(pct); saveProgress(progressId, pct); } }
        }}>
          <div className="reading-progress-fill" style={{width: `${(progressBar || 0) * 100}%`}}/>
        </div>
        <span className="reading-progress-label">{Math.round((progressBar || 0) * 100)}%</span>
      </div>}
    </div>}
    <footer className="av-foot">
      <span>{String(work.body || '').length} 字 <em>chars</em> · {wikiCount} 个双链 <em>wikilinks</em>{fx.badges(work.body).map((b, i) => <React.Fragment key={i}> · {b.zh} <em>{b.en}</em></React.Fragment>)} · {savedNote} <em>{capable() && getRoot() ? 'Written to vault' : 'Saved locally'}</em></span>
      <span className="av-hint"><Icon name="pulse" size={12}/>双链与标签会自动汇入图谱 <em>Links feed the graph</em></span>
    </footer>
  </section>;
}
