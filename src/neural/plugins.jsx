// 插件系统：效仿 Obsidian 的核心插件——内置、本地运行、可随时开关、不联网。
// 插件通过扩展点增强编辑器（斜杠命令、打字机模式）与展示（双链体检、阅读时长）。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {CONFIG} from '../config';

// —— 内置插件清单 ——
export const BUILTIN_PLUGINS = [
  {id: 'slash', icon: 'send', name: '斜杠命令', en: 'Slash commands',
    desc: '在编辑器行首输入 / 快速插入标题、列表、双链等 Markdown 片段。',
    descEn: 'Type / at line start to insert Markdown blocks.'},
  {id: 'typewriter', icon: 'file', name: '打字机模式', en: 'Typewriter mode',
    desc: '输入时让光标所在行保持屏幕中央，长文写作更专注。',
    descEn: 'Keep the caret line vertically centered while typing.'},
  {id: 'linkcheck', icon: 'link', name: '双链体检', en: 'Link checker',
    desc: '在对话坞一键扫描未创建的 [[双链]]，创建同名内容后自动接通。',
    descEn: 'Scan unresolved wikilinks from the dock.'},
  {id: 'readingtime', icon: 'pulse', name: '阅读时长', en: 'Reading time',
    desc: '按中文每分钟约 400 字估算文章与草稿的阅读时间。',
    descEn: 'Estimate reading time in editor footers.'},
  {id: 'toolbar', icon: 'grid', name: '格式工具栏', en: 'Format toolbar',
    desc: '编辑器上方的 Word 式工具栏：标题、加粗、高亮、列表、表格、双链，点一下就应用到选区。',
    descEn: 'A Word-style formatting bar above the editor, applied to the current selection.'},
  {id: 'toc', icon: 'methods', name: '大纲目录', en: 'Outline TOC',
    desc: '在编辑器右侧悬浮显示 H1–H4 标题大纲，点击跳转，滚动时高亮当前位置。',
    descEn: 'A floating H1–H4 outline on the right; click to jump, highlights as you scroll.'},
  {id: 'templates', icon: 'draft', name: '模板库', en: 'Templates',
    desc: '内置原子笔记、读书笔记、观察记录等本地模板，支持 <%= date %> <%= time %> <%= title %> 变量。',
    descEn: 'Local note templates with date/time/title variables, applied at the cursor.'},
  {id: 'immersive', icon: 'outlink', name: '沉浸式翻译', en: 'Immersive Translate',
    desc: '预览页一键生成双语对照：外语段落下方插入中文译文。仅在顶栏联网开关打开时才访问翻译服务。',
    descEn: 'Bilingual reading in preview; calls the translation service only while the top-bar network switch is on.'},
  {id: 'ai', icon: 'agent', name: 'AI 助手', en: 'AI assistant',
    desc: '接入你自己的 OpenAI 兼容 API（DeepSeek / OpenAI / OpenRouter / 硅基流动 / Ollama 本地）。仅当顶栏联网开关与本插件同时打开才会请求；API key 只存本机，AI 可读写你的文章、草稿与笔记。',
    descEn: 'Bring your own OpenAI-compatible API. Requests fire only when both the network switch and this plugin are on; keys stay local.'},
];

// —— 联网开关：默认断网，数据不出本机；只有它打开时，联网型插件（沉浸式翻译）才会发起请求 ——
const NET_KEY = CONFIG.storagePrefix + '-network-v1';
function loadNet() { try { return JSON.parse(localStorage.getItem(NET_KEY)) === true; } catch { return false; } }
let netOn = loadNet();
const netSubs = new Set();
export function useNetwork() {
  const [on, setOn] = useState(netOn);
  useEffect(() => { const f = v => setOn(v); netSubs.add(f); return () => { netSubs.delete(f); }; }, []);
  return {
    on,
    toggle: () => {
      netOn = !netOn;
      try { localStorage.setItem(NET_KEY, JSON.stringify(netOn)); } catch {}
      for (const f of netSubs) f(netOn);
    },
  };
}
export const isNetworkOn = () => netOn;

// —— 开关状态：localStorage + 订阅（设置面板与各处使用点保持同步） ——
const PLUGINS_KEY = CONFIG.storagePrefix + '-plugins-v1';
function loadDisabled() {
  try { const v = JSON.parse(localStorage.getItem(PLUGINS_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
}
let disabled = loadDisabled();
const subs = new Set();
function writeDisabled(next) {
  disabled = next;
  try { localStorage.setItem(PLUGINS_KEY, JSON.stringify(next)); } catch {}
  for (const f of subs) f(next);
}
export function usePlugins() {
  const [d, setD] = useState(disabled);
  useEffect(() => { const f = v => setD(v); subs.add(f); return () => { subs.delete(f); }; }, []);
  return {
    disabled: d,
    on: id => !d.includes(id),
    toggle: id => writeDisabled(d.includes(id) ? d.filter(x => x !== id) : [...d, id]),
  };
}

// —— 斜杠命令表：snippet 中 ¦ 表示插入后光标落点 ——
const SLASH_COMMANDS = [
  {q: 'h1', label: '一级标题', en: 'Heading 1', snippet: '# ¦'},
  {q: 'h2', label: '二级标题', en: 'Heading 2', snippet: '## ¦'},
  {q: 'bold', label: '加粗', en: 'Bold', snippet: '**加粗文字**¦'},
  {q: 'list', label: '列表', en: 'List', snippet: '- ¦'},
  {q: 'quote', label: '引用', en: 'Quote', snippet: '> ¦'},
  {q: 'code', label: '代码块', en: 'Code block', snippet: '```\n¦\n```'},
  {q: 'link', label: '双链', en: 'Wikilink', snippet: '[[¦]]'},
  {q: 'hr', label: '分隔线', en: 'Divider', snippet: '\n---\n¦'},
];
const slashFilter = q => SLASH_COMMANDS.filter(c =>
  c.label.includes(q) || c.q.includes(q.toLowerCase()) || c.en.toLowerCase().includes(q.toLowerCase()));

// 斜杠候选菜单：样式沿用 .suggest
export function SlashMenu({list, pick, insert}) {
  return <div className="suggest glass" role="listbox" aria-label="插入模板">
    <p>插入 Markdown <em>Insert block</em></p>
    {list.map((c, i) => <button key={c.q} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''}
      onMouseDown={e => { e.preventDefault(); insert(c); }} style={{'--kc': 'var(--gold)'}}>
      <i/>{c.label}<small>{c.en}</small>
    </button>)}
    {!list.length && <span className="none">没有匹配的模板 <em>No match</em></span>}
  </div>;
}

// —— 双链体检（linkcheck 插件）：扫描未创建的 [[双链]]，对话坞展示 ——
export function linkCheck(graph) {
  const ghosts = new Map();
  for (const l of graph.links) {
    if (l.kind !== 'wiki') continue;
    const t = graph.index.get(l.t);
    if (t?.kind !== 'ghost') continue;
    const g = ghosts.get(l.t) || {node: t, sources: []};
    const s = graph.index.get(l.s);
    if (s) g.sources.push(s);
    ghosts.set(l.t, g);
  }
  if (!ghosts.size) return [{title: '双链体检通过', en: 'All links resolve', tone: 'ok',
    text: '所有 [[双链]] 都指向已创建的内容，图谱没有断链。继续用 [[ 链接新想法吧。'}];
  const list = [...ghosts.values()].slice(0, 6);
  return [
    {title: `发现 ${ghosts.size} 个未创建的双链`, en: 'Unresolved wikilinks', tone: 'warn',
      text: `${ghosts.size} 个 [[ ]] 目标还没有对应内容。创建同名文章或笔记后会自动接通，图谱中的虚线节点就是它们。`,
      items: list.map(g => g.node.id), names: list.map(g => g.node.short || g.node.title),
      meta: list.map(g => `${g.sources.length} 处引用`)},
    ...list.map(g => ({title: g.node.short || g.node.title, en: 'Linked from', tone: 'info',
      text: `被引用 ${g.sources.length} 次：${g.sources.map(x => x.short || x.title).slice(0, 4).join('、')}${g.sources.length > 4 ? ' 等' : ''}。`})),
  ];
}

// —— 阅读时长（readingtime 插件） ——
export const readingTime = text => {
  const chars = String(text || '').replace(/\s/g, '').length;
  const min = Math.max(1, Math.round(chars / 400));
  return {zh: `约 ${min} 分钟读完`, en: 'reading'};
};

// —— 模板库（templates 插件）：源自 Obsidian Templater 的本地化替代，无网络、无 AI ——
export const TEMPLATES = [
  {q: 'atomic', label: '原子笔记', en: 'Atomic note', body: '# <%= title %>\n\n> 一句话主张：\n\n## 展开\n\n- \n\n## 来源\n\n- \n\n## 相关\n\n- [[ ]]\n'},
  {q: 'article', label: '文章骨架', en: 'Article skeleton', body: '# <%= title %>\n\n## 开场\n\n\n## 核心观点\n\n- \n\n## 操作示例\n\n1. \n\n## 结尾\n\n- [[ ]]\n'},
  {q: 'book', label: '读书笔记', en: 'Book note', body: '# 《<%= title %>》\n\n- 作者：\n- 状态：在读\n\n## 核心论点\n\n- \n\n## 摘录\n\n> \n\n## 我的思考\n\n- [[ ]]\n'},
  {q: 'profile', label: '人物档案', en: 'Profile', body: '# <%= title %>\n\n- 领域：\n- 立场：\n\n## 背景\n\n- \n\n## 关键观点\n\n- \n\n## 与我的关系\n\n- [[ ]]\n'},
  {q: 'observe', label: '观察记录', en: 'Observation', body: '# <%= title %>\n\n- 日期：<%= date %>\n\n## 现象\n\n- \n\n## 细节\n\n- \n\n## 猜想\n\n- \n\n## 下一步\n\n- [ ] \n'},
  {q: 'weekly', label: '每周回顾', en: 'Weekly review', body: '# <%= date %> 周记\n\n## 本周完成\n\n- [ ] \n\n## 数据\n\n- 文章：\n- 字数：\n\n## 下周计划\n\n- [ ] \n\n## 想法沉淀\n\n- [[ ]]\n'},
];
// 变量渲染：<%= title %> <%= date %> <%= time %>，其余保持原样。
export function renderTemplate(body, title) {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return String(body)
    .replace(/<%=\s*title\s*%>/g, () => String(title || ''))
    .replace(/<%=\s*date\s*%>/g, date)
    .replace(/<%=\s*time\s*%>/g, time);
}

// —— 自定义模板：与六个内置模板并存，保存在 localStorage；菜单里可「把当前正文存为模板」，插件管理里可增删改 ——
const TPL_KEY = CONFIG.storagePrefix + '-templates-v1';
function loadTpls() { try { const v = JSON.parse(localStorage.getItem(TPL_KEY)); return Array.isArray(v) ? v : []; } catch { return []; } }
let userTpls = loadTpls();
const tplSubs = new Set();
const notifyTpls = () => { try { localStorage.setItem(TPL_KEY, JSON.stringify(userTpls)); } catch {} for (const f of tplSubs) f(userTpls); };
export function useUserTemplates() {
  const [list, setList] = useState(userTpls);
  useEffect(() => { const f = v => setList(v); tplSubs.add(f); return () => { tplSubs.delete(f); }; }, []);
  return [list, next => { userTpls = Array.isArray(next) ? next : []; notifyTpls(); }];
}
const newTpl = (label, body) => ({id: 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label, en: 'Custom', body});

// —— 文字颜色：插入选区包裹 <span style="color:…">，阅读/预览原样渲染，镜像层同步染色 ——
const INK_COLORS = [
  ['#e05d5d', '红'], ['#e0913d', '橙'], ['#d4b13d', '黄'], ['#7fae5a', '绿'],
  ['#5b8fc9', '蓝'], ['#9a7fd1', '紫'], ['#d48fb0', '粉'], ['default', '默认'],
];

// —— 大纲解析（toc 插件）：提取 H1–H4 标题行，跳过代码块 ——
export function parseOutline(text) {
  const out = [];
  let fence = false;
  String(text || '').split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const m = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
      if (m) out.push({level: m[1].length, text: m[2].trim(), line: i});
    }
  });
  return out;
}

// 大纲目录：平时自动收进编辑区右缘、只露一条竖线；悬停竖线（或面板）滑出，
// 离开约 .35s 后收回（用 hide 方向的 transition-delay 实现，纯 CSS 无需计时器）。
export function TocPanel({outline, cur, jump}) {
  return <div className="toc-dock">
    <i className="toc-rail" aria-hidden="true" data-n={outline.length}/>
    <nav className="toc-panel glass" aria-label="大纲目录 Outline">
      <p>大纲 <em>Outline</em></p>
      <div className="toc-list">{outline.map(h =>
        <button key={h.line} className={h.line === cur ? 'on' : ''} style={{'--lv': h.level - 1}}
          title={h.text} onClick={() => jump(h.line)}>{h.text}</button>)}
      </div>
    </nav>
  </div>;
}

// —— 编辑器增强：文章全文与创作台草稿共用 ——
// 用法：const fx = useEditorEnhancers({area, value, onChange, wiki, title});
// textarea: onKeyDown={fx.onKeyDown} onBlur={fx.onBlur} onChange 里追加 fx.onInput(e.target)
// 渲染 {fx.bar}（编辑区上方）、{fx.toc}（editor-area 内）、{fx.menu}；页脚追加 fx.badges(text)
export function useEditorEnhancers({area, value, onChange, wiki, title, preview, previewMode}) {
  const {on} = usePlugins();
  const [userTpls, setUserTpls] = useUserTemplates();
  const [menu, setMenu] = useState(null); // {q, start, pick}
  const [tplOpen, setTplOpen] = useState(false);
  const [clrOpen, setClrOpen] = useState(false);
  const [curLine, setCurLine] = useState(-1);
  const live = useRef(null); live.current = {menu};

  const tw = on('typewriter');
  useEffect(() => {
    const el = area.current;
    if (!tw || !el) return;
    const scroll = () => requestAnimationFrame(() => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
      const line = el.value.slice(0, el.selectionStart).split('\n').length - 1;
      el.scrollTop = Math.max(0, line * lh + lh / 2 - el.clientHeight / 2);
    });
    el.addEventListener('input', scroll);
    el.addEventListener('click', scroll);
    return () => { el.removeEventListener('input', scroll); el.removeEventListener('click', scroll); };
  }, [tw, area.current]); // eslint-disable-line react-hooks/exhaustive-deps

  // —— 格式应用：都走「改值 → onChange → 下一帧恢复光标」——
  const mutate = (next, selStart, selEnd) => {
    onChange(next);
    requestAnimationFrame(() => { const el = area.current; if (el) { el.focus(); el.setSelectionRange(selStart, selEnd); } });
  };
  // 包裹选区（toggle）：加粗 / 高亮 / 行内代码 / 双链…
  const wrap = (before, after, ph) => {
    const el = area.current; if (!el) return;
    const {selectionStart: s, selectionEnd: e, value: v} = el;
    const sel = v.slice(s, e);
    if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
      const inner = sel.slice(before.length, sel.length - after.length);
      mutate(v.slice(0, s) + inner + v.slice(e), s, s + inner.length);
    } else if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
      mutate(v.slice(0, s - before.length) + sel + v.slice(e + after.length), s - before.length, e - before.length);
    } else {
      const text = sel || ph;
      mutate(v.slice(0, s) + before + text + after + v.slice(e), s + before.length, s + before.length + text.length);
    }
  };
  // 行前缀（toggle，先剥掉旧前缀再套新的）：标题 / 引用 / 列表 / 任务
  const prefix = mk => {
    const el = area.current; if (!el) return;
    const {selectionStart: s, selectionEnd: e, value: v} = el;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const leEnd = v.indexOf('\n', e);
    const le = leEnd < 0 ? v.length : leEnd;
    const lines = v.slice(ls, le).split('\n');
    const markOf = i => (typeof mk === 'function' ? mk(i) : mk);
    // 只有存在非空行且它们全部已带前缀时才移除；空行 / 空选区一律视为「套上前缀」
    const all = lines.some(l => l.trim()) && lines.every((l, i) => l.startsWith(markOf(i)) || !l.trim());
    const next = lines.map((l, i) => {
      const stripped = l.replace(/^(\s*)(?:[-*+]\s+(?:\[[ x]\]\s+)?|\d+\.\s+|>\s+|#{1,6}\s+)?/, '$1');
      return all ? stripped : stripped.replace(/^(\s*)/, (m0, sp) => sp + markOf(i));
    }).join('\n');
    mutate(v.slice(0, ls) + next + v.slice(le), ls, ls + next.length);
  };
  // 光标处插入片段
  const insert = (text, back = 0) => {
    const el = area.current; if (!el) return;
    const {selectionStart: s, selectionEnd: e, value: v} = el;
    const lead = s > 0 && v[s - 1] !== '\n' && /\n/.test(text) ? '\n' : '';
    const t = lead + text;
    mutate(v.slice(0, s) + t + v.slice(e), s + t.length - back, s + t.length - back);
  };
  // 应用模板：空正文整体替换，否则插入光标处
  const applyTemplate = t => {
    const el = area.current; if (!el) return;
    const rendered = renderTemplate(t.body, title);
    const {selectionStart: s, value: v} = el;
    if (!v.trim()) mutate(rendered, rendered.length, rendered.length);
    else insert(rendered);
    setTplOpen(false);
  };
  // 清除颜色：剥掉选区上或紧贴选区的 <span style="color:…"> 包裹
  const stripColor = () => {
    const el = area.current; if (!el) return;
    const {selectionStart: s, selectionEnd: e, value: v} = el;
    const OPEN = /<span style="color:#[0-9a-fA-F]{3,8}">/;
    const whole = new RegExp('^(' + OPEN.source + ')([\\s\\S]*)</span>$').exec(v.slice(s, e));
    if (whole) { mutate(v.slice(0, s) + whole[2] + v.slice(e), s, s + whole[2].length); return; }
    const before = v.slice(0, s), after = v.slice(e);
    const mB = /(<span style="color:#[0-9a-fA-F]{3,8}">)$/.exec(before);
    if (mB && after.startsWith('</span>')) {
      const cut = s - mB[1].length;
      mutate(v.slice(0, cut) + v.slice(s, e) + v.slice(e + 7), cut, cut + (e - s));
      return;
    }
    const m = new RegExp(OPEN.source + '([\\s\\S]*?)</span>').exec(v.slice(s, e));
    if (m) { const at = s + m.index; mutate(v.slice(0, at) + m[1] + v.slice(at + m[0].length), at, at + m[1].length); }
  };
  const colorize = hex => {
    setClrOpen(false);
    if (hex === 'default') { stripColor(); return; }
    wrap(`<span style="color:${hex}">`, '</span>', '彩色文字');
  };

  // —— 大纲目录：解析标题 + 滚动高亮 + 点击跳转 ——
  const tocOn = on('toc');
  const outline = useMemo(() => tocOn ? parseOutline(value) : [], [value, tocOn]);
  const outlineRef = useRef(outline); outlineRef.current = outline;
  const metrics = () => {
    const el = area.current;
    const lh = el ? parseFloat(getComputedStyle(el).lineHeight) || 28 : 28;
    const pad = el ? parseFloat(getComputedStyle(el).paddingTop) || 0 : 0;
    return {lh, pad};
  };
  useEffect(() => {
    const el = area.current;
    if (!tocOn || previewMode === 'preview' || !el || !outline.length) return;
    const spy = () => {
      const {lh, pad} = metrics();
      const y = el.scrollTop + el.clientHeight * .35;
      let cur = -1;
      for (const h of outlineRef.current) if (pad + h.line * lh <= y) cur = h.line;
      setCurLine(cur);
    };
    spy();
    el.addEventListener('scroll', spy, {passive: true});
    return () => el.removeEventListener('scroll', spy);
  }, [tocOn, outline.length, previewMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // 阅读模式：监听渲染容器，高亮视口顶部最近的标题（大纲序号与渲染标题一一对应：代码块内标题两边都跳过）
  useEffect(() => {
    const box = preview?.current;
    if (!tocOn || previewMode !== 'preview' || !box || !outline.length) return;
    const spy = () => {
      const list = box.querySelectorAll('h1,h2,h3,h4');
      if (!list.length) return;
      const top = box.getBoundingClientRect().top;
      let idx = 0;
      list.forEach((t, i) => { if (t.getBoundingClientRect().top - top <= 48) idx = i; });
      setCurLine(outlineRef.current[idx] ? outlineRef.current[idx].line : -1);
    };
    spy();
    box.addEventListener('scroll', spy, {passive: true});
    return () => box.removeEventListener('scroll', spy);
  }, [tocOn, outline.length, previewMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const jumpTo = line => {
    // 阅读模式：滚动到渲染后的对应标题
    if (previewMode === 'preview') {
      const box = preview?.current;
      const idx = outlineRef.current.findIndex(h => h.line === line);
      const list = box ? box.querySelectorAll('h1,h2,h3,h4') : [];
      if (box && idx >= 0 && list[idx]) { list[idx].scrollIntoView({block: 'start'}); return; }
    }
    const el = area.current; if (!el) return;
    const {lh, pad} = metrics();
    el.scrollTop = Math.max(0, pad + line * lh - 14);
    const pos = line ? el.value.split('\n').slice(0, line).join('\n').length + 1 : 0;
    el.focus();
    el.setSelectionRange(pos, pos);
  };

  // 输入后检测行首 / 命令
  const slashCheck = el => {
    if (!el || !on('slash')) return;
    const m = el.value.slice(0, el.selectionStart).match(/(?:^|\n)\/([^\s\n]*)$/);
    setMenu(m ? {q: m[1], start: el.selectionStart - m[1].length - 1, pick: 0} : null);
  };
  const slashInsert = c => {
    const el = area.current, m = live.current.menu;
    if (!el || !m) return;
    const i = c.snippet.indexOf('¦');
    const snip = i >= 0 ? c.snippet.replace('¦', '') : c.snippet;
    const pos = i >= 0 ? m.start + i : m.start + snip.length;
    onChange(el.value.slice(0, m.start) + snip + el.value.slice(el.selectionStart));
    setMenu(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  };
  const slashKey = e => {
    const m = live.current.menu;
    if (!m) return false;
    const list = slashFilter(m.q);
    if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setMenu({...m, pick: (m.pick + 1) % list.length}); }
    else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setMenu({...m, pick: (m.pick - 1 + list.length) % list.length}); }
    else if (e.key === 'Enter' && !e.isComposing && list.length) { e.preventDefault(); slashInsert(list[m.pick % list.length]); }
    else if (e.key === 'Escape') setMenu(null);
    else return false;
    return true;
  };

  // —— 格式工具栏（toolbar + templates 插件） ——
  const btn = (label, en, glyph, act) =>
    <button key={label + en} className="fmt-btn" title={`${label} ${en}`} aria-label={`${label} ${en}`}
      onMouseDown={e => e.preventDefault()} onClick={act}>{glyph}</button>;
  const bar = (on('toolbar') || on('templates')) && <div className="fmt-bar glass" role="toolbar" aria-label="格式工具栏 Format toolbar">
    {on('toolbar') && <>
      {btn('二级标题', 'Heading 2', 'H2', () => prefix('## '))}
      {btn('三级标题', 'Heading 3', 'H3', () => prefix('### '))}
      <i className="fmt-sep" aria-hidden="true"/>
      {btn('加粗', 'Bold', <b>B</b>, () => wrap('**', '**', '加粗文字'))}
      {btn('斜体', 'Italic', <i>I</i>, () => wrap('*', '*', '斜体文字'))}
      {btn('删除线', 'Strikethrough', <s>S</s>, () => wrap('~~', '~~', '删除文字'))}
      {btn('下划线', 'Underline', <u>U</u>, () => wrap('<u>', '</u>', '下划线文字'))}
      {btn('高亮', 'Highlight', <mark>彩</mark>, () => wrap('==', '==', '高亮文字'))}
      <span className="clr-wrap">
        <button className="fmt-btn" title="文字颜色 Text color" aria-label="文字颜色 Text color" aria-expanded={clrOpen}
          onMouseDown={e => e.preventDefault()} onClick={() => setClrOpen(o => !o)}><span className="clr-glyph">A</span></button>
        {clrOpen && <div className="clr-menu glass" role="menu" aria-label="文字颜色 Text color">
          {INK_COLORS.map(([c, zh]) => <button key={c} role="menuitem" title={c === 'default' ? '清除颜色 Clear color' : zh}
            onMouseDown={e => e.preventDefault()} onClick={() => colorize(c)}>
            <i className="sw" style={c === 'default' ? undefined : {background: c}} aria-hidden="true"/>
            {c === 'default' ? <>默认 <em>Clear</em></> : zh}
          </button>)}
        </div>}
      </span>
      {btn('行内代码', 'Inline code', <code>{'</>'}</code>, () => wrap('`', '`', '代码'))}
      <i className="fmt-sep" aria-hidden="true"/>
      {btn('无序列表', 'Bullet list', '•', () => prefix('- '))}
      {btn('有序列表', 'Ordered list', '1.', () => prefix(i => `${i + 1}. `))}
      {btn('任务列表', 'Task list', '☑', () => prefix('- [ ] '))}
      {btn('引用', 'Quote', '❝', () => prefix('> '))}
      {btn('标注块', 'Callout', '！', () => insert('> [!note] 标题\n> 内容\n'))}
      <i className="fmt-sep" aria-hidden="true"/>
      {btn('双链', 'Wikilink', '[[]]', () => wrap('[[', ']]', '链接目标'))}
      {btn('代码块', 'Code block', '{}', () => insert('```\n\n```', 4))}
      {btn('表格', 'Table', '⊞', () => insert('| 列一 | 列二 |\n| --- | --- |\n|  |  |\n'))}
      {btn('分隔线', 'Divider', '—', () => insert('---\n'))}
    </>}
    {on('templates') && <span className="tpl-wrap">
      <button className="fmt-btn tpl-btn" aria-expanded={tplOpen} aria-label="插入模板 Templates"
        onMouseDown={e => e.preventDefault()} onClick={() => setTplOpen(o => !o)}><Icon name="draft" size={12}/>模板 <em>Tpl</em></button>
      {tplOpen && <div className="tpl-menu glass" role="menu" aria-label="模板列表 Templates">
        {TEMPLATES.map(t => <button key={t.q} role="menuitem" onMouseDown={e => e.preventDefault()} onClick={() => applyTemplate(t)}>
          <b>{t.label}</b><small>{t.en}</small>
        </button>)}
        {userTpls.length > 0 && <i className="tpl-sep" aria-hidden="true"/>}
        {userTpls.map(t => <span key={t.id} className="tpl-user">
          <button role="menuitem" onMouseDown={e => e.preventDefault()} onClick={() => applyTemplate(t)}><b>{t.label}</b><small>自定义 <em>custom</em></small></button>
          <button className="tpl-del" aria-label={`删除模板 ${t.label}`} title="删除模板 Delete" onMouseDown={e => e.preventDefault()} onClick={() => setUserTpls(userTpls.filter(x => x.id !== t.id))}><Icon name="close" size={11}/></button>
        </span>)}
        <i className="tpl-sep" aria-hidden="true"/>
        <button role="menuitem" className="tpl-save" disabled={!String(value || '').trim()}
          onMouseDown={e => e.preventDefault()}
          title="把编辑器当前正文保存为自定义模板，之后可在这里或「插件管理」里修改"
          onClick={() => { setUserTpls([...userTpls, newTpl(`自定义模板 ${userTpls.length + 1}`, value)]); setTplOpen(false); }}>
          <b>⊕ 存正文为模板</b><small>Save body as template</small>
        </button>
      </div>}
    </span>}
  </div>;

  return {
    onKeyDown: e => { if (on('slash') && slashKey(e)) return; wiki?.onKeyDown(e); },
    onInput: slashCheck,
    onBlur: () => { setMenu(null); setTplOpen(false); setClrOpen(false); },
    menu: on('slash') && menu && <SlashMenu list={slashFilter(menu.q)} pick={menu.pick} insert={slashInsert}/>,
    badges: text => on('readingtime') ? [readingTime(text)] : [],
    bar,
    toc: tocOn && outline.length ? <TocPanel outline={outline} cur={curLine} jump={jumpTo}/> : null,
  };
}

// —— 插件管理面板：放在「插件管理」弹窗里 ——
export function PluginList() {
  const {disabled, toggle} = usePlugins();
  const {on: net} = useNetwork();
  const [tpls, setTpls] = useUserTemplates();
  return <div className="plugins">
    <p className="quiet">全部内置、随时开关；默认断网，仅「沉浸式翻译」会在联网开关打开后访问翻译服务。<em>Built-in · offline by default; only Immersive Translate uses the network.</em></p>
    {BUILTIN_PLUGINS.map(p => {
      const off = disabled.includes(p.id);
      return <div className={`plugin-row ${off ? 'off' : ''}`} key={p.id}>
        <span className="p-icon"><Icon name={p.icon} size={15}/></span>
        <div className="p-body">
          <b>{p.name} <em>{p.en}</em>{p.id === 'immersive' && !net && <span className="p-flag">需联网 <em>needs network</em></span>}</b>
          <p>{p.desc}</p>
          <p className="p-en">{p.descEn}</p>
        </div>
        <button className={`switch ${off ? '' : 'on'}`} role="switch" aria-checked={!off}
          aria-label={`${off ? '启用' : '关闭'}${p.name}`} onClick={() => toggle(p.id)}><i/></button>
      </div>;
    })}
    <div className="tpl-mgr">
      <p className="eyebrow">自定义模板 <span>Custom templates</span></p>
      <p className="quiet">编辑器「模板」菜单里可把当前正文一键存为模板；支持 {'<%= title %> <%= date %> <%= time %>'} 变量，保存在本机。<em>Stored locally.</em></p>
      {tpls.map(t => <div className="tpl-edit" key={t.id}>
        <input value={t.label} aria-label="模板名称 Template name" placeholder="模板名称"
          onChange={e => setTpls(tpls.map(x => x.id === t.id ? {...x, label: e.target.value} : x))}/>
        <textarea value={t.body} rows={4} aria-label="模板内容 Template body" placeholder="模板内容，支持 [[双链]] 与变量"
          onChange={e => setTpls(tpls.map(x => x.id === t.id ? {...x, body: e.target.value} : x))}/>
        <button className="icon-btn" aria-label={`删除模板 ${t.label}`} title="删除模板 Delete"
          onClick={() => setTpls(tpls.filter(x => x.id !== t.id))}><Icon name="trash" size={13}/></button>
      </div>)}
      <button className="pill ghost" onClick={() => setTpls([...tpls, newTpl(`自定义模板 ${tpls.length + 1}`, '# <%= title %>\n\n')])}>
        <Icon name="plus" size={14}/>新建模板 <em>New template</em>
      </button>
    </div>
  </div>;
}
