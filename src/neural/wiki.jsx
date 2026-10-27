// [[ 双链补全：文章全文编辑器与创作台草稿编辑器共用的输入辅助。
// 输入 [[名称# 时列出该笔记正文的小节（块引用双链）；↑↓ 选择、Enter 插入、Esc 关闭。
import React, {useRef, useState} from 'react';
import {KINDS, CONTENT} from './graph';
import {parseOutline} from './plugins';

// 输入 [[ 后按标题 / 短标题过滤候选：↑↓ 选择、Enter 插入、Esc 关闭。
// titles: [{id, title, short, kind}]；areaRef 指向 textarea；onChange 接收插入后的完整文本；
// headings: Map（小写标题 → [{text}] 小节清单），输入 # 时列出目标笔记的正文小节。
export function useWikiComplete({titles, areaRef, onChange, headings}) {
  const [suggest, setSuggest] = useState(null);
  const [pick, setPick] = useState(0);
  const live = useRef(null); live.current = {suggest, pick, titles, headings};

  const check = el => {
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(/\[\[([^\]\n]*)$/);
    if (!m) { setSuggest(null); return; }
    const raw = m[1];
    const hash = raw.indexOf('#');
    let list;
    if (hash >= 0 && live.current.headings) {
      // 块引用补全：[[笔记名#小节 —— 先按名称筛笔记，再列其正文小节
      const nq = raw.slice(0, hash).toLowerCase(), hq = raw.slice(hash + 1).toLowerCase();
      list = live.current.titles
        .filter(t => t.title.toLowerCase().includes(nq) || String(t.short || '').toLowerCase().includes(nq))
        .slice(0, 4)
        .flatMap(t => (live.current.headings.get(String(t.title).toLowerCase()) || [])
          .filter(h => h.text.toLowerCase().includes(hq))
          .map(h => ({id: t.id + '#' + h.text, title: t.title + '#' + h.text, short: (t.short || t.title) + ' › ' + h.text, kind: t.kind})))
        .slice(0, 7);
    } else {
      const q = raw.toLowerCase();
      list = live.current.titles.filter(t =>
        t.title.toLowerCase().includes(q) || String(t.short || '').toLowerCase().includes(q)).slice(0, 7);
    }
    // end 一并捕获：插入时的切割终点固定为补全菜单打开时的选区，不随实时光标漂移
    setSuggest({q: raw, start: el.selectionStart - raw.length, end: el.selectionEnd, list}); setPick(0);
  };
  const insert = t => {
    const el = areaRef.current, sug = live.current.suggest;
    if (!el || !sug) return;
    const s = sug.start, e = sug.end ?? el.selectionStart;
    // 偏移校验：菜单打开时的 [[ 上下文已不在此处（切换草稿/笔记后 textarea 被程序化换值，
    // 无 input 事件、菜单残留），按旧偏移切割新正文会把双链插错位置——直接关菜单不误插
    if (el.value.slice(s - 2, s) !== '[[' || el.value.slice(s, s + sug.q.length) !== sug.q) { setSuggest(null); return; }
    // 光标校验：菜单打开后光标被方向键 / 鼠标挪走（无 input 事件，菜单不收起），
    // Enter 会把双链插回旧偏移并拽走光标——光标不在补全区间时关菜单、不拦截
    if (el.selectionStart < s || el.selectionStart > s + sug.q.length + 1) { setSuggest(null); return; }
    const value = el.value.slice(0, s) + t.title + ']]' + el.value.slice(e).replace(/^\]\]/, '');
    const pos = s + t.title.length + 2;
    onChange(value); setSuggest(null);
    // 光标恢复带值守卫：回调迟到（用户已继续输入）时不再拽光标，避免后续输入落到过期位置
    requestAnimationFrame(() => { el.focus({preventScroll: true}); if (el.value === value) el.setSelectionRange(pos, pos); });
  };
  const onKeyDown = e => {
    const s = live.current.suggest;
    if (!s?.list.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setPick((live.current.pick + 1) % s.list.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((live.current.pick - 1 + s.list.length) % s.list.length); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); insert(s.list[live.current.pick]); }
    // Tab 与 Enter 同为确认选中：外层编辑器把 Tab 也交给补全（见 plugins.jsx 拦截列表），
    // 这里不处理的话 Tab 既不缩进也不选中，焦点直接跳出输入框
    else if (e.key === 'Tab') { e.preventDefault(); insert(s.list[live.current.pick]); }
    else if (e.key === 'Escape') setSuggest(null);
  };
  return {suggest, pick, check, insert, onKeyDown, setSuggest};
}

// 候选下拉：样式沿用创作台 .suggest。
export function WikiSuggest({suggest, pick, setPick, insert}) {
  return <div className="suggest glass" role="listbox" aria-label="链接建议">
    <p>链接到笔记 <em>Link to note</em>{suggest.q && <> · “{suggest.q}”</>}</p>
    {suggest.list.map((t, i) => <button key={t.id} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={e => { e.preventDefault(); insert(t); }} style={{'--kc': KINDS[t.kind].color}}><i/>{t.short}<small>{KINDS[t.kind].label} {KINDS[t.kind].en}</small></button>)}
    {!suggest.list.length && <span className="none">没有匹配，将成为未创建的笔记 <em>Will be unresolved</em></span>}
  </div>;
}

// —— 块引用双链（[[笔记#小节]]）共用工具 ——
// 拆分 data-target：前段按 byName 解析成节点 id，后段是目标小节标题。
export function resolveTarget(byName, target) {
  const [rawName, anchor] = String(target || '').split('#');
  return {id: byName.get((rawName || '').trim().toLowerCase()) || null, anchor: (anchor || '').trim()};
}
// 在渲染容器里滚动到与 anchor 匹配的标题（完全相等优先，其次包含）；找不到返回 false。
export function scrollToAnchor(root, anchor) {
  if (!root || !anchor) return false;
  const list = root.querySelectorAll('h1,h2,h3,h4');
  for (const h of list) if (h.textContent.trim() === anchor) { h.scrollIntoView({block: 'start'}); return true; }
  for (const h of list) if (h.textContent.trim().includes(anchor)) { h.scrollIntoView({block: 'start'}); return true; }
  return false;
}
// 全库小节索引：小写标题 → [{text, line}]，供块引用补全（headingMap）与 AI 建议共用。
// 同时注册 path 文件名键：创作台补全列表用文件名当 title（改名 / 消歧后与标题不同），
// 只按标题注册会让 [[文件名#小节]] 补全静默落空
export function headingMap(graph) {
  const m = new Map();
  for (const n of graph.nodes) {
    if (!CONTENT.has(n.kind) || !n.body) continue;
    const hs = parseOutline(n.body);
    if (!hs.length) continue;
    m.set(String(n.title).toLowerCase(), hs);
    const fn = n.path?.split('/').pop()?.replace(/\.md$/, '');
    if (fn && fn.toLowerCase() !== String(n.title).toLowerCase()) m.set(fn.toLowerCase(), hs);
  }
  return m;
}
