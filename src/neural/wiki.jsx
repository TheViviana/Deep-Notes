// [[ 双链补全：文章全文编辑器与创作台草稿编辑器共用的输入辅助。
import React, {useRef, useState} from 'react';
import {KINDS} from './graph';

// 输入 [[ 后按标题 / 短标题过滤候选：↑↓ 选择、Enter 插入、Esc 关闭。
// titles: [{id, title, short, kind}]；areaRef 指向 textarea；onChange 接收插入后的完整文本。
export function useWikiComplete({titles, areaRef, onChange}) {
  const [suggest, setSuggest] = useState(null);
  const [pick, setPick] = useState(0);
  const live = useRef(null); live.current = {suggest, pick, titles};

  const check = el => {
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(/\[\[([^\]\n]*)$/);
    if (!m) { setSuggest(null); return; }
    const q = m[1].toLowerCase();
    const list = live.current.titles.filter(t =>
      t.title.toLowerCase().includes(q) || String(t.short || '').toLowerCase().includes(q)).slice(0, 7);
    setSuggest({q: m[1], start: el.selectionStart - m[1].length, list}); setPick(0);
  };
  const insert = t => {
    const el = areaRef.current, s = live.current.suggest.start, e = el.selectionStart;
    const value = el.value.slice(0, s) + t.title + ']]' + el.value.slice(e).replace(/^\]\]/, '');
    onChange(value); setSuggest(null);
    requestAnimationFrame(() => { el.focus(); const pos = s + t.title.length + 2; el.setSelectionRange(pos, pos); });
  };
  const onKeyDown = e => {
    const s = live.current.suggest;
    if (!s?.list.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setPick((live.current.pick + 1) % s.list.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((live.current.pick - 1 + s.list.length) % s.list.length); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); insert(s.list[live.current.pick]); }
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
