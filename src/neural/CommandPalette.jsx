// 全局命令面板（Cmd/Ctrl + K 唤起）：全文搜索、快速新建、模块跳转、知识库导入导出。
// 纯本地检索（标题 + 正文匹配），不联网；键盘 ↑↓ / Enter / Esc 全程可操作。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CONTENT, KINDS} from './graph';
import {Icon} from './icons';
import {tagsOf} from './vaultRules';

const KIND_ICON = {post: 'works', note: 'methods', idea: 'idea', draft: 'draft', reading: 'book', archive: 'archive', concept: 'concept'};
// 内容类型筛选：全部 / 六类内容；配合正则可做「只在我读过的书里找」这类精确检索
const KIND_FILTERS = [['all', '全部 All'], ['post', '文章'], ['note', '笔记'], ['draft', '草稿'], ['reading', '阅读'], ['archive', '档案'], ['idea', '选题']];

export function CommandPalette({open, onClose, graph, actions, onOpenContent}) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(0);
  const [kind, setKind] = useState('all');
  const listRef = useRef(null);

  useEffect(() => { if (open) { setQ(''); setPick(0); setKind('all'); } }, [open]);

  const items = useMemo(() => {
    if (!open) return [];
    const k = q.trim();
    // 正则模式：输入形如 /关键词/ 或 /关键词/i —— 标题 + 正文全文匹配（带 g 标志会被剥掉，.test 无状态；
    // 无效正则退回普通文本匹配，空结果时输入框下方给出提示）
    let re = null;
    const rm = k.match(/^\/(.+)\/([gimsu]*)$/);
    if (rm) { try { re = new RegExp(rm[1], rm[2].replace(/g/g, '')); } catch { re = null; } }
    // #标签 过滤：查询里的 #词 摘出来按内容标签过滤（正则模式不解析）；剩余文本继续全文匹配。
    // 只输 #标签 时列出带该标签的全部内容；标签与关键词可叠加（先按标签收窄再按文本匹配）。
    const tagTokens = [];
    let textQuery = k;
    if (!re) textQuery = k.replace(/(?:^|\s)#([^\s#]+)/g, (_, t) => { tagTokens.push(t.toLowerCase()); return ' '; }).trim();
    const plain = textQuery.toLowerCase();
    const acts = tagTokens.length ? [] : actions.filter(a => !textQuery
      || a.zh.toLowerCase().includes(plain) || String(a.en || '').toLowerCase().includes(plain));
    if (!k) return acts;
    // 有关键词时：标题命中排前、按连接度排序的内容结果 + 剩余可用命令
    const hit = n => {
      if (kind !== 'all' && n.kind !== kind) return false;
      // 标签口径与 vaultRules.tagsOf 一致：显式标签 ∪ 正文 #话题——正文里打了 #话题 的作品也能被 #标签 搜到
      if (tagTokens.length) {
        const eff = tagsOf({tags: n.tags || []}, n.body || '');
        if (!tagTokens.every(t => eff.some(x => x.toLowerCase().includes(t)))) return false;
      }
      if (re) return re.test(String(n.title)) || re.test(String(n.text || ''));
      if (!plain) return tagTokens.length > 0; // 纯 #标签 查询：标签命中即入选
      const t = String(n.title).toLowerCase(), x = String(n.text || '').toLowerCase();
      return t.includes(plain) || x.includes(plain);
    };
    const hits = graph.nodes
      .filter(n => (CONTENT.has(n.kind) || n.kind === 'concept') && hit(n))
      .sort((a, b) => (String(b.title).toLowerCase().includes(plain) ? 1 : 0) - (String(a.title).toLowerCase().includes(plain) ? 1 : 0) || (b.in || 0) - (a.in || 0))
      .slice(0, 8)
      .map(n => ({type: 'content', id: n.id, zh: n.short || n.title, en: KINDS[n.kind].label, icon: KIND_ICON[n.kind] || 'file', group: '内容 Content'}));
    return [...hits, ...acts];
  }, [open, q, kind, actions, graph]);

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
          placeholder="搜索内容或输入命令… 支持 /正则/、#标签 与按类型筛选 · Search, /regex/, #tag, filter by kind" aria-label="搜索内容或命令"/>
      </div>
      <div className="palette-filters" role="group" aria-label="按内容类型筛选 Filter by kind">
        {KIND_FILTERS.map(([k, zh]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setPick(0); }}>{zh}</button>)}
      </div>
      <div className="palette-list" ref={listRef} role="listbox" aria-label="命令与结果">
        {items.map((it, i) => <button key={(it.type === 'content' ? 'c:' : 'a:') + (it.id || it.zh) + i}
          role="option" aria-selected={i === pick} className={`palette-item${i === pick ? ' on' : ''}`}
          onMouseEnter={() => setPick(i)} onClick={() => run(it)}>
          <i className="pi-icon" style={{'--kc': it.type === 'content' ? 'var(--text-2)' : undefined}}><Icon name={it.icon || 'file'} size={14}/></i>
          <span className="pi-zh">{it.zh}<em>{it.en}</em></span>
          {it.group && <small className="pi-group">{it.group}</small>}
        </button>)}
        {!items.length && <p className="palette-empty">{/^\/.+\/[gimsu]*$/.test(q.trim()) ? '正则表达式无效或没有匹配 · Invalid regex or no match' : '没有匹配的命令或内容 <em>No match</em>'}</p>}
      </div>
      <p className="palette-foot">↑↓ 选择 <em>navigate</em> · Enter 执行 <em>run</em> · Esc 关闭 <em>close</em> · ⌘K 呼出 <em>toggle</em></p>
    </section>
  </div>;
}
