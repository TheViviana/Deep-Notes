// 文章全文视图：在页面下方展开，Markdown 编辑 / 预览，[[ 双链自动汇入图谱。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {marked} from 'marked';
import {CONTENT} from './graph';
import {Icon} from './icons';
import {useWikiComplete, WikiSuggest} from './wiki';
import {useEditorEnhancers, usePlugins, useNetwork} from './plugins';
import {isTranslatable, translateText} from './translate';

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
export function hiCode(code, lang = '') {
  const out = [];
  let last = 0, m;
  const re = hiRegex(lang);
  re.lastIndex = 0;
  while ((m = re.exec(String(code)))) {
    if (m.index > last) out.push(esc(code.slice(last, m.index)));
    const cls = m[1] ? 'tk-h' : m[2] ? 'tk-s' : m[3] ? 'tk-c' : m[4] ? 'tk-k' : m[5] ? 'tk-n' : m[6] ? 'tk-p' : 'tk-t';
    out.push(`<i class="${cls}">${esc(m[0])}</i>` + (m[1] ? `<b class="tk-sw" style="background:${m[1]}"></b>` : ''));
    last = m.index + m[0].length;
  }
  out.push(esc(code.slice(last)));
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
      return `<a class="md-wikilink" data-target="${esc((target || '').trim())}">${esc((alias || target || '').trim())}</a>`;
    })
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  // 用捕获组 split：奇数段是 ```围栏``` 或 `行内代码`，保持原样；偶数段才替换双链
  const src = String(md || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((seg, i) => i % 2 ? seg : wiki(seg)).join('');
  return marked.parse(src);
}

// —— Live Preview 式镜像层（对齐 Obsidian）：正文恒按语义渲染（加粗 / 颜色 / 高亮 / 行内代码），
// 语法符号（#、**、<span…>、[[ ]] 等）默认完全隐藏 —— 用 opacity:0 占位，字符不消、逐字对齐不破，
// 光标或选区落在所属片段内（行首标记 #、>、``` 则随光标所在行）时才显形，可点进片段像源码一样编辑。
// 正文仍是同一个 textarea：双链补全 / 斜杠菜单 / 格式栏 / 打字机模式全部无感；
// textarea 文字透明，光标与选区仍由它绘制。
export function LineMirror({text, taRef}) {
  const [sel, setSel] = useState([0, 0, 0]); // [光标行号, 选区起点, 选区终点]
  const box = useRef(null);
  useEffect(() => {
    const el = taRef.current, m = box.current;
    if (!el || !m) return;
    // 排版属性对齐（padding 里已含大纲目录的右缩进；white-space 手动设为逐行折行一致）
    const cs = getComputedStyle(el);
    for (const k of ['fontSize', 'lineHeight', 'fontFamily', 'fontWeight', 'letterSpacing', 'wordSpacing',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'overflowWrap'])
      m.style[k] = cs[k];
    m.style.whiteSpace = 'pre-wrap';
    const track = () => {
      const s = Math.max(el.selectionStart || 0, 0), e = Math.max(el.selectionEnd || s, s);
      const c = el.value.slice(0, s).split('\n').length - 1;
      setSel(p => (p[0] === c && p[1] === s && p[2] === e ? p : [c, s, e])); // 值不变不触发重渲染
    };
    const sync = () => { if (box.current) box.current.scrollTop = el.scrollTop; };
    const on = (ev, fn) => el.addEventListener(ev, fn), off = (ev, fn) => el.removeEventListener(ev, fn);
    for (const ev of ['input', 'click', 'keyup', 'select', 'focus']) on(ev, track);
    on('scroll', sync);
    sync(); track();
    return () => { for (const ev of ['input', 'click', 'keyup', 'select', 'focus']) off(ev, track); off('scroll', sync); };
  }, [taRef]);
  // 文本变化重渲染后强制对齐滚动位置（innerHTML 重建会重置 scrollTop）
  useEffect(() => { const el = taRef.current, m = box.current; if (el && m) m.scrollTop = el.scrollTop; });
  const html = useMemo(() => buildMirrorHtml(text, sel), [text, sel]);
  return <div className="line-mirror" ref={box} aria-hidden="true" dangerouslySetInnerHTML={{__html: html}}/>;
}

// 镜像层 HTML 生成（纯函数，便于离线校验）：sel = [光标行号, 选区起点, 选区终点]。
export function buildMirrorHtml(text, sel) {
  const [cur, ss, se] = sel || [0, 0, 0];
  const inRegion = (s, e) => ss <= e && se >= s; // 光标/选区与片段相交（含边缘）→ 片段的语法符号显形
  const mk = (raw, on) => `<i class="lm-mk${on ? ' on' : ''}">${esc(raw)}</i>`;
  // 单遍扫描行内片段（原始文本上匹配，避免实体还原；成对片段之外的原样字符照常显示）
  const walk = (s, base) => {
    const out = [];
    let last = 0, m;
    const re = new RegExp(INLINE_SRC, 'g');
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(esc(s.slice(last, m.index)));
      const t = m[0], at = base + m.index, end = at + t.length, on = inRegion(at, end);
      if (t.startsWith('<span')) { // 彩色文字：首尾标签是语法符号，内容继续 token 化
        const openLen = t.indexOf('>') + 1;
        out.push(mk(t.slice(0, openLen), on) + `<span style="color:${m[1]}">`
          + walk(t.slice(openLen, t.length - 7), at + openLen) + '</span>' + mk(t.slice(t.length - 7), on));
      } else if (t.startsWith('[[')) {
        out.push(mk('[[', on) + '<span class="lm-a">' + walk(t.slice(2, -2), at + 2) + '</span>' + mk(']]', on));
      } else if (t.startsWith('==')) {
        out.push(mk('==', on) + '<mark>' + walk(t.slice(2, -2), at + 2) + '</mark>' + mk('==', on));
      } else if (t.startsWith('**') || t.startsWith('__')) {
        out.push(mk(t.slice(0, 2), on) + '<span class="lm-b">' + walk(t.slice(2, -2), at + 2) + '</span>' + mk(t.slice(0, 2), on));
      } else if (t.startsWith('~~')) {
        out.push(mk('~~', on) + '<span class="lm-s">' + walk(t.slice(2, -2), at + 2) + '</span>' + mk('~~', on));
      } else if (t[0] === '*') {
        out.push(mk('*', on) + '<span class="lm-i">' + walk(t.slice(1, -1), at + 1) + '</span>' + mk('*', on));
      } else { // 行内代码：hiCode 直接吃原始文本（自带转义），色块宽度为零
        out.push(mk('`', on) + '<span class="lm-c">' + hiCode(t.slice(1, -1), '') + '</span>' + mk('`', on));
      }
      last = m.index + t.length;
    }
    if (last < s.length) out.push(esc(s.slice(last)));
    return out.join('');
  };
  let fence = false, lang = '', off = 0; // 是否处于 ``` 围栏内（跨行状态）与围栏声明的语言
  return String(text || '').split('\n').map((l, i) => {
    const lineStart = off; off += l.length + 1;
    const lineOn = i === cur; // 行首标记随光标所在行显形
    const fenceM = /^\s*```/.exec(l);
    let inner;
    if (fence && !fenceM) {
      inner = hiCode(l, lang); // 围栏内：阅读式语法高亮
    } else {
      // 行首标记：标题 / 引用 / 围栏声明整体显隐；列表符号保留可见充当项目符号
      const pre = fenceM ? /^(\s*```[^\s`]*`*)/.exec(l) : /^((?:#{1,6}|>)\s|\s*>\s?)/.exec(l);
      let head = '', rest = l, at = lineStart;
      if (pre && pre[1]) {
        head = mk(pre[1], lineOn);
        rest = l.slice(pre[1].length); at += pre[1].length;
      }
      inner = head + walk(rest, at);
    }
    if (fenceM) {
      if (!fence) { fence = true; lang = (l.match(/^\s*```([^\s`]*)/) || ['', ''])[1]; }
      else { fence = false; lang = ''; }
    }
    const cls = ['lm-line', !fenceM && !fence && /^#{1,6}\s/.test(l) ? 'lm-h' : '',
      !fenceM && !fence && /^\s*>/.test(l) ? 'lm-quote' : '',
      (fenceM || fence) ? 'lm-code' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}">${inner || '&#8203;'}</div>`;
  }).join('');
}

export function ArticleView({work, graph, onChange, onClose, onGo, onEditInfo}) {
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
  const wiki = useWikiComplete({titles, areaRef: area, onChange: body => onChange({body})});
  const fx = useEditorEnhancers({area, value: work.body, onChange: body => onChange({body}), wiki, title: work.title});
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
    const hit = byName.get((a.dataset.target || '').toLowerCase());
    if (hit) onGo(hit.id);
  };
  return <section className={`article-view glass${focusMode ? ' focused' : ''}`} role="region" aria-label="文章全文">
    {focusMode && <button className="icon-btn av-unfocus" onClick={() => setFocusMode(false)} title="退出专注 Exit focus" aria-label="退出专注模式"><Icon name="close" size={14}/></button>}
    <header className="av-head">
      <div className="av-title">
        <p className="eyebrow">ARTICLE <span>文章全文</span></p>
        <h2>{work.title}</h2>
        <p className="av-meta">{work.date.slice(0, 10)} 首发 · 编辑于 {work.updatedAt || work.date}{work.direction ? ` · ${work.direction}` : ''} · {work.tags.length} 个标签</p>
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
      {fx.toc}
    </div> : <article className="md-preview" ref={previewRef} onClick={onPreviewClick} dangerouslySetInnerHTML={{__html: html}}/>}
    <footer className="av-foot">
      <span>{work.body.length} 字 <em>chars</em> · {wikiCount} 个双链 <em>wikilinks</em>{fx.badges(work.body).map((b, i) => <React.Fragment key={i}> · {b.zh} <em>{b.en}</em></React.Fragment>)} · 已保存到此浏览器 <em>Saved locally</em></span>
      <span className="av-hint"><Icon name="pulse" size={12}/>双链与标签会自动汇入图谱 <em>Links feed the graph</em></span>
    </footer>
  </section>;
}
