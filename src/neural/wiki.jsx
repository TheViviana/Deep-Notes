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
    // end 一并捕获：插入时的切割终点固定为补全菜单打开时的选区，不随实时光标漂移
    setSuggest({q: m[1], start: el.selectionStart - m[1].length, end: el.selectionEnd, list}); setPick(0);
  };
  const insert = t => {
    const el = areaRef.current, s = live.current.suggest.start, e = live.current.suggest.end ?? el.selectionStart;
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
