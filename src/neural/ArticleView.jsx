// 文章全文视图：在页面下方展开，Markdown 编辑 / 预览，[[ 双链自动汇入图谱。
import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {marked} from 'marked';
import {CONTENT} from './graph';
import {Icon} from './icons';
import {useWikiComplete, WikiSuggest, resolveTarget, scrollToAnchor, headingMap} from './wiki';
import {useEditorEnhancers, usePlugins, useNetwork} from './plugins';
import {isTranslatable, translateText} from './translate';
import {serialize, exportFiles, safeName} from './fileStore';

marked.setOptions({gfm: true, breaks: true});

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
marked.use({renderer: {
  code({text, lang}) { return `<pre><code class="hl">${hiCode(text, lang)}</code></pre>`; },
  codespan({text}) { return `<code class="hl">${hiCode(text, '')}</code>`; },
}});

// 镜像层行内片段（彩色 span / 双链 / 高亮 / 加粗 / 斜体 / 删除线 / 行内代码）。
// walk 递归处理嵌套片段，每个 walk 实例化独立正则（共享 lastIndex 会互相踩踏）。
const INLINE_SRC = '<span style="color:(#[0-9a-fA-F]{3,8})">[\\s\\S]*?<\\/span>'
  + '|\\[\\[[^\\]\\n]+\\]\\]|==[^=\\n]+==|\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__|~~[^~\\n]+~~|\\*[^*\\n]+\\*(?!\\*)|`[^`\\n]+`';

// Markdown 渲染：先把 [[双链]] 替换成带 data-target 的内联 <a>（内容已转义），再交给 marked。
// 同时供创作台阅读模式与对照分屏复用。围栏代码块与行内代码里的 [[..]] 不做替换（与 Obsidian 一致）。
export function renderMarkdown(md) {
  const wiki = seg => seg
    .replace(/\[\[([^\]\n]+)\]\]/g, (_, t) => {
      const [target, alias] = t.split('|');
      const raw = (target || '').trim();
      const [name, anchor] = raw.split('#');
      // 块引用 [[笔记#小节]] 显示为「笔记 › 小节」；别名优先
      const label = (alias || '').trim()
        || (anchor ? `${(name || '').trim()} › ${anchor.trim()}` : raw);
      return `<a class="md-wikilink" data-target="${esc(raw)}">${esc(label)}</a>`;
    })
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  // 用捕获组 split：奇数段是 ```围栏``` 或 `行内代码`，保持原样；偶数段才替换双链
  const src = String(md || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((seg, i) => i % 2 ? seg : wiki(seg)).join('');
  return marked.parse(src);
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
    <div className="lm-inner" ref={inner} aria-hidden="true" dangerouslySetInnerHTML={{__html: html}}/>
    <div className="lm-selbox" ref={selBox} aria-hidden="true"/>
    <i className="lm-caret" ref={caretEl} aria-hidden="true"/>
  </div>;
}

// 镜像层 HTML 生成（纯函数，便于离线校验）：sel = [光标行号, 选区起点, 选区终点]。
// 隐藏符号不进 DOM（零宽锚点占位，宽度真正回收）；每个可见段带 data-s、行盒带 data-s0/data-ln 供坐标映射。
export function buildMirrorHtml(text, sel) {
  const [cur, ss, se] = sel || [0, 0, 0];
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
      if (t.startsWith('<span')) { // 彩色文字：首尾标签是语法符号，内容继续 token 化
        const openLen = t.indexOf('>') + 1;
        out.push(mk(t.slice(0, openLen), at, on) + `<span style="color:${m[1]}">`
          + walk(t.slice(openLen, t.length - 7), at + openLen) + '</span>' + mk('</span>', end - 7, on));
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
  let fence = false, lang = '', off = 0; // 是否处于 ``` 围栏内（跨行状态）与围栏声明的语言
  return String(text || '').split('\n').map((l, i) => {
    const lineStart = off; off += l.length + 1;
    const lineOn = i === cur; // 行首标记随光标所在行显形
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
    if (fenceM) {
      if (!fence) { fence = true; lang = (l.match(/^\s*```([^\s`]*)/) || ['', ''])[1]; }
      else { fence = false; lang = ''; }
    }
    const hm = !fenceM && !fence ? /^(#{1,6})\s/.exec(l) : null; // 标题分级：镜像层自由排版（不再迁就 textarea 等宽）
    const cls = ['lm-line', hm ? `lm-h lm-h${hm[1].length}` : '',
      !fenceM && !fence && /^\s*>/.test(l) ? 'lm-quote' : '',
      (fenceM || fence) ? 'lm-code' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-s0="${lineStart}" data-ln="${l.length}">${inner || '&#8203;'}</div>`;
  }).join('');
}

export function ArticleView({work, graph, onChange, onClose, onGo, onEditInfo, eyebrow = ['ARTICLE', '文章全文'], exportKind = 'works'}) {
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
  const fx = useEditorEnhancers({area, value: work.body, onChange: body => onChange({body}), wiki, title: work.title, titles});
  const html = useMemo(() => mode === 'preview' ? renderMarkdown(work.body) : '', [mode, work.body]);
  // 双链解析：与 graph.js 的 byName 规则一致（标题 / 路径文件名，忽略大小写）。
  const byName = useMemo(() => {
    const m = new Map();
    for (const n of graph.nodes) {
      if (!CONTENT.has(n.kind)) continue;
      m.set(String(n.title).toLowerCase(), n.id);
      if (n.path) m.set(n.path.split('/').pop().replace(/\.md$/, '').toLowerCase(), n.id);
    }
    return m;
  }, [graph]);
  const wikiCount = (String(work.body).match(/\[\[([^\]\n]+)\]\]/g) || []).length;
  // —— 沉浸式翻译（immersive 插件 + 顶栏联网开关，二者都打开才发请求） ——
  const [trans, setTrans] = useState({phase: 'idle', done: 0, total: 0}); // idle | running | done
  const [hint, setHint] = useState('');
  const immersive = pluginOn('immersive');
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
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const el = queue.shift();
        try { out.push([el, await translateText(el.textContent)]); } catch { out.push([el, null]); }
        done += 1;
        setTrans(t => ({...t, done}));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const [el, text] of out) {
      if (!text || !el.isConnected || el.querySelector('.md-trans')) continue;
      const span = document.createElement('span');
      span.className = 'md-trans';
      span.textContent = text;
      el.appendChild(span);
    }
    setTrans(t => ({...t, phase: 'done'}));
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
    const {id, anchor} = resolveTarget(byName, a.dataset.target);
    if (!id) return;
    const selfId = ['post', 'reading', 'archive', 'draft', 'note'].map(k => k + ':' + work.id).find(x => graph.index.has(x));
    if (anchor && id === selfId) { scrollToAnchor(previewRef.current, anchor); return; }
    onGo(id);
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
      setExpHint(where === 'download' ? '已下载 Exported' : where ? `已导出到「${where.replace(/\/+$/, '').split('/').pop()}」` : '');
    } catch { setExpHint('导出失败 Export failed'); }
    setTimeout(() => setExpHint(''), 2600);
  };
  return <section className={`article-view glass${focusMode ? ' focused' : ''}`} role="region" aria-label={eyebrow[1]}>
    {focusMode && <button className="icon-btn av-unfocus" onClick={() => setFocusMode(false)} title="退出专注 Exit focus" aria-label="退出专注模式"><Icon name="close" size={14}/></button>}
    <header className="av-head">
      <div className="av-title">
        <p className="eyebrow">{eyebrow[0]} <span>{eyebrow[1]}</span></p>
        <h2>{work.title}</h2>
        <p className="av-meta">{work.metaLine || `${work.date.slice(0, 10)} 首发 · 编辑于 ${work.updatedAt || work.date}${work.direction ? ` · ${work.direction}` : ''} · ${work.tags.length} 个标签`}</p>
      </div>
      <div className="av-actions">
        <div className="seg" role="group" aria-label="编辑或预览">
          {[['edit', '编辑', 'Edit'], ['preview', '预览', 'Preview']].map(([k, zh, en]) =>
            <button key={k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{zh}<em>{en}</em></button>)}
        </div>
        <button type="button" className={`av-focus${focusMode ? ' on' : ''}`} aria-pressed={focusMode}
          title="隐藏头部信息与页脚，正文占满 · Hide header/footer and maximize the text area" onClick={() => setFocusMode(v => !v)}>专注 <em>Focus</em></button>
        {mode === 'preview' && immersive && <>
          <button className="pill ghost av-trans" onClick={trans.phase === 'running' ? undefined : trans.phase === 'done' ? restoreTrans : runTranslate}
            disabled={trans.phase === 'running'} aria-label="沉浸式翻译 Immersive translate">
            <Icon name="outlink" size={13}/>
            {trans.phase === 'running' ? `翻译中 ${trans.done}/${trans.total}` : trans.phase === 'done' ? '收起译文 Restore' : '沉浸翻译 Translate'}
          </button>
          {hint && <span className="av-trans-hint" role="status">{hint}</span>}
        </>}
        {expHint && <span className="av-trans-hint" role="status">{expHint === 'busy' ? '导出中… Exporting' : expHint}</span>}
        <button className="icon-btn" onClick={doExport} disabled={expHint === 'busy'} title="导出为 Markdown Export as Markdown" aria-label="导出为 Markdown"><Icon name="save" size={15}/></button>
        {onEditInfo && <button className="icon-btn" onClick={onEditInfo} title="编辑文章信息 Edit article info" aria-label="编辑文章信息"><Icon name="draft" size={15}/></button>}
        <button className="icon-btn" onClick={onClose} aria-label="收起文章全文"><Icon name="close" size={15}/></button>
      </div>
    </header>
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
    </div> : <article className="md-preview" ref={previewRef} onClick={onPreviewClick} dangerouslySetInnerHTML={{__html: html}}/>}
    <footer className="av-foot">
      <span>{work.body.length} 字 <em>chars</em> · {wikiCount} 个双链 <em>wikilinks</em>{fx.badges(work.body).map((b, i) => <React.Fragment key={i}> · {b.zh} <em>{b.en}</em></React.Fragment>)} · 已保存到此浏览器 <em>Saved locally</em></span>
      <span className="av-hint"><Icon name="pulse" size={12}/>双链与标签会自动汇入图谱 <em>Links feed the graph</em></span>
    </footer>
  </section>;
}
