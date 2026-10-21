// 全局命令面板（Cmd/Ctrl + K 唤起）：全文搜索、快速新建、模块跳转、知识库导入导出。
// 纯本地检索（标题 + 正文匹配），不联网；键盘 ↑↓ / Enter / Esc 全程可操作。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CONTENT, KINDS} from './graph';
import {Icon} from './icons';

const KIND_ICON = {post: 'works', note: 'methods', idea: 'idea', draft: 'draft', reading: 'book', archive: 'archive', concept: 'concept'};

export function CommandPalette({open, onClose, graph, actions, onOpenContent}) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(0);
  const listRef = useRef(null);

  useEffect(() => { if (open) { setQ(''); setPick(0); } }, [open]);

  const items = useMemo(() => {
    if (!open) return [];
    const k = q.trim().toLowerCase();
    const acts = actions.filter(a => !k
      || a.zh.toLowerCase().includes(k) || String(a.en || '').toLowerCase().includes(k));
    if (!k) return acts;
    // 有关键词时：标题命中排前、按连接度排序的内容结果 + 剩余可用命令
    const hits = graph.nodes
      .filter(n => (CONTENT.has(n.kind) || n.kind === 'concept')
        && (String(n.title).toLowerCase().includes(k) || String(n.text || '').toLowerCase().includes(k)))
      .sort((a, b) => (String(b.title).toLowerCase().includes(k) ? 1 : 0) - (String(a.title).toLowerCase().includes(k) ? 1 : 0) || (b.in || 0) - (a.in || 0))
      .slice(0, 8)
      .map(n => ({type: 'content', id: n.id, zh: n.short || n.title, en: KINDS[n.kind].label, icon: KIND_ICON[n.kind] || 'file', group: '内容 Content'}));
    return [...hits, ...acts];
  }, [open, q, actions, graph]);

  useEffect(() => { if (pick >= items.length) setPick(0); }, [items.length, pick]);
  useEffect(() => { listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({block: 'nearest'}); }, [pick]);

  if (!open) return null;
  const run = item => {
    if (!item) return;
    onClose();
    if (item.type === 'content') onOpenContent(item.id);
    else item.run();
  };
  const onKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPick(p => (p + 1) % Math.max(items.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPick(p => (p - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1)); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(items[pick]); }
    else if (e.key === 'Escape') onClose();
  };
  return <div className="veil palette-veil" onClick={onClose}>
    <section className="palette glass" role="dialog" aria-modal="true" aria-label="命令面板 Command palette"
      onClick={e => e.stopPropagation()} onKeyDown={onKey}>
      <div className="palette-input">
        <Icon name="search" size={15}/>
        <input autoFocus value={q} onChange={e => { setQ(e.target.value); setPick(0); }}
          placeholder="搜索内容或输入命令… Search or type a command" aria-label="搜索内容或命令"/>
      </div>
      <div className="palette-list" ref={listRef} role="listbox" aria-label="命令与结果">
        {items.map((it, i) => <button key={(it.type === 'content' ? 'c:' : 'a:') + (it.id || it.zh) + i}
          role="option" aria-selected={i === pick} className={`palette-item${i === pick ? ' on' : ''}`}
          onMouseEnter={() => setPick(i)} onClick={() => run(it)}>
          <i className="pi-icon" style={{'--kc': it.type === 'content' ? 'var(--text-2)' : undefined}}><Icon name={it.icon || 'file'} size={14}/></i>
          <span className="pi-zh">{it.zh}<em>{it.en}</em></span>
          {it.group && <small className="pi-group">{it.group}</small>}
        </button>)}
        {!items.length && <p className="palette-empty">没有匹配的命令或内容 <em>No match</em></p>}
      </div>
      <p className="palette-foot">↑↓ 选择 <em>navigate</em> · Enter 执行 <em>run</em> · Esc 关闭 <em>close</em> · ⌘K 呼出 <em>toggle</em></p>
    </section>
  </div>;
}
