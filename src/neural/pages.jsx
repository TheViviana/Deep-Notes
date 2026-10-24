import React, {useEffect, useMemo, useRef, useState} from 'react';
import {KINDS, CONTENT, MODULES, nameIndex, neighbors, latent, LINK_EN} from './graph';
import {Icon} from './icons';
import {Analysis, Count} from './Analysis';
import {ArticleView, LineMirror, renderMarkdown, readProgress} from './ArticleView';
import {useWikiComplete, WikiSuggest, resolveTarget, scrollToAnchor, headingMap} from './wiki';
import {useEditorEnhancers} from './plugins';
import {conceptExtras, setConceptExtra, conceptReview, gradeConcept, paraCards, paraReview, deleteParaCard, gradePara} from './conceptStore';
import {parseDocFile} from './docImport';
import {CONFIG} from '../config';
import {T} from './theme';

// 视图状态（专注 / 阅读 / 对照）存本机 localStorage，跨会话记忆。
function useLocalState(key, init) {
  const [v, set] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) ?? init; } catch { return init; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }, [key, v]);
  return [v, set];
}
// 双链点击解析：与 graph.js 的 byName 规则一致（标题 / 路径文件名，忽略大小写）。
const FILE_KIND_ZH = {post: ['文章', 'Posts'], draft: ['草稿', 'Drafts'], note: ['方法笔记', 'Notes']};
const dayOfTs = ts => { const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

export function PageHead({zh, en, sub, subEn, children}) {
  return <header className="page-head">
    <div><p className="eyebrow">{en.toUpperCase()} <span>{zh}</span></p><h1>{sub}</h1><p className="page-sub">{subEn}</p></div>
    {children && <div className="page-head-actions">{children}</div>}
  </header>;
}

// —— 作品库 Works ——
export function Library({graph, works, selected, setSelected, openArticle, setOpenArticle, onNewWork, onUpdateWork, onDeleteWork, onGo, onJumpContent, onAction, onBody, onNoteTitle, onConcept, concepts, onLinkify, onMakeMap}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('date');
  const charsOf = p => (p.body || '').length;
  const updatedOf = p => p.updatedAt || p.date || '';
  const linksOf = p => { const id = 'post:' + p.id; return graph.links.reduce((s, l) => s + (l.kind === 'wiki' && (l.s === id || l.t === id) ? 1 : 0), 0); };
  const keyOf = {chars: charsOf, links: linksOf};
  const rows = works.filter(p => p.title.toLowerCase().includes(q.toLowerCase())).sort((a, b) =>
    sort === 'date' ? b.date.localeCompare(a.date) : sort === 'updated' ? updatedOf(b).localeCompare(updatedOf(a)) : keyOf[sort](b) - keyOf[sort](a));
  const order = [...works].sort((a, b) => a.date.localeCompare(b.date));
  const node = graph.index.get('post:' + selected) || graph.index.get('post:' + rows[0]?.id);
  const total = works.reduce((s, p) => s + charsOf(p), 0);
  const max = Math.max(0, ...works.map(charsOf));
  const openWork = works.find(w => w.id === openArticle) || null;
  // 打开文章后滚动定位：文章视图在长列表下方，不滚动会像「按钮没反应」
  useEffect(() => {
    if (!openArticle) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => document.querySelector('.article-view')?.scrollIntoView({block: 'start', behavior: smooth ? 'smooth' : 'auto'}));
  }, [openArticle]);
  const kpis = [['文章', 'Articles', works.length], ['总字数', 'Words', total], ['双链', 'Wikilinks', graph.links.filter(l => l.kind === 'wiki').length], ['双向共振', 'Mutual', graph.links.filter(l => l.both).length]];
  return <div className="page page-library">
    <PageHead zh="作品库" en="Works" sub="每篇文章，都是网络里的一个节点。" subEn="Every article is a node in the network — length and links side by side.">
      <button className="pill primary" onClick={onNewWork}><Icon name="plus" size={15}/>新建文章 <em>New article</em></button>
    </PageHead>
    <section className="kpi-band glass">{kpis.map(([zh, en, v]) => <div key={zh}><span>{zh} <em>{en}</em></span><strong><Count value={v}/></strong></div>)}</section>
    <div className="library-layout">
      <section className="works-col">
        <div className="toolbar-row">
          <label className="search"><Icon name="search" size={15}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索文章… Search articles" aria-label="搜索文章"/></label>
          <div className="seg" role="group" aria-label="排序">{[['date', '最新', 'Latest'], ['chars', '字数', 'Length'], ['links', '双链', 'Links'], ['updated', '更新', 'Updated']].map(([k, zh, en]) => <button key={k} className={sort === k ? 'active' : ''} onClick={() => setSort(k)}>{zh}<em>{en}</em></button>)}</div>
        </div>
        <div className="works-grid">{rows.map((p, i) => {
          const n = graph.index.get('post:' + p.id);
          if (!n) return null; // 图谱用的是延迟数据，新建文章的节点下一帧跟上
          const on = node?.id === n.id;
          return <button key={p.id} className={`work-card ${on ? 'active' : ''}`} onClick={() => { setSelected(p.id); setOpenArticle(null); }} style={{animationDelay: i * 60 + 'ms'}}>
            <span className="wc-cover">{n.cover ? <img src={n.cover} alt="" loading="lazy"/> : <span className="wc-fallback" style={{'--h': (order.indexOf(p) * 47) % 360}}><b>{p.title}</b><small>{p.direction ? p.direction : '图文 · Post'}</small></span>}<span className="wc-index">#{String(order.indexOf(p) + 1).padStart(2, '0')}</span></span>
            <span className="wc-body">
              <span className="wc-date">{updatedOf(p).slice(0, 10)}{p.direction ? ` · ${p.direction}` : ''} · {n.tags.length} topics</span>
              <span className="wc-title">{p.title}</span>
              <span className="wc-bar"><i style={{'--w': charsOf(p) / (max || 1)}}/></span>
              <span className="wc-stats"><span>字数<em>Chars</em><b>{charsOf(p).toLocaleString('zh-CN')}</b></span><span>双链<em>Links</em><b>{linksOf(p)}</b></span><span>⇄<em>Mutual</em><b>{n.mutual}</b></span></span>
            </span>
          </button>;
        })}</div>
        {!rows.length && <div className="empty"><Icon name="search" size={30}/><p>没有找到这篇文章 <em>No match</em></p><button className="pill" onClick={() => setQ('')}>清空搜索 <em>Clear</em></button></div>}
        <p className="source-line"><Icon name="info" size={13}/>{works.length} 篇文章保存在此浏览器，可导入知识库整体替换 <em>Saved locally</em>。</p>
      </section>
      {node && <aside className="library-analysis" key={node.id}><Analysis graph={graph} node={node} module={MODULES[0]} onGo={onGo} onAction={onAction} onClose={() => setSelected(null)} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={concepts} onLinkify={onLinkify}/></aside>}
    </div>
    {openWork && <ArticleView key={openWork.id} work={openWork} graph={graph} onChange={patch => onUpdateWork(openWork.id, patch)} onClose={() => setOpenArticle(null)} onGo={onGo} onOpenContent={onJumpContent} onEditInfo={() => onAction({type: 'editWork', id: openWork.id})} onMakeMap={onMakeMap}/>}
  </div>;
}

// —— 创作台 Drafts ——
function MiniGraph({graph, node, focus}) {
  const nb = neighbors(graph, node.id);
  const all = [...nb.mutual.map(x => ({...x, dir: 'both'})), ...nb.out.map(x => ({...x, dir: 'out'})), ...nb.back.map(x => ({...x, dir: 'in'}))].slice(0, 16);
  const R = 92, C = 120;
  return <svg className="mini-graph" viewBox="0 0 240 240" role="img" aria-label={`${all.length} 条连接`}>
    <defs><radialGradient id="mg-core"><stop offset="0" stopColor={T.mini.glow0}/><stop offset=".5" stopColor={T.mini.core}/><stop offset="1" stopColor={T.mini.core} stopOpacity="0"/></radialGradient></defs>
    {all.map((x, i) => {
      const a = i / Math.max(all.length, 1) * Math.PI * 2 - Math.PI / 2, n = graph.index.get(x.id);
      const px = C + Math.cos(a) * R, py = C + Math.sin(a) * R;
      return <g key={x.id} style={{'--d': i * 60 + 'ms'}} className={`mg-link dir-${x.dir}${focus && x.dir !== focus ? ' dim' : ''}`}>
        <line x1={C} y1={C} x2={px} y2={py} stroke={x.dir === 'both' ? T.mini.mutual : KINDS[n.kind].color}/>
        <circle cx={px} cy={py} r={n.kind === 'ghost' ? 3.5 : 4.5} fill={n.kind === 'ghost' ? 'none' : KINDS[n.kind].color} stroke={KINDS[n.kind].color} strokeDasharray={n.kind === 'ghost' ? '2 2' : undefined}/>
        {x.dir !== 'in' && <circle r="2.2" fill={T.mini.pulseOut} className="mg-pulse"><animateMotion dur={2 + i % 3 * .4 + 's'} repeatCount="indefinite" path={`M${C},${C} L${px},${py}`}/></circle>}
        {x.dir !== 'out' && <circle r="2" fill={T.mini.pulseIn} className="mg-pulse"><animateMotion dur={2.4 + i % 2 * .5 + 's'} repeatCount="indefinite" path={`M${px},${py} L${C},${C}`}/></circle>}
      </g>;
    })}
    <circle cx={C} cy={C} r="26" fill="url(#mg-core)"/>
    <circle cx={C} cy={C} r="8" fill={T.mini.dot}/>
  </svg>;
}

// —— 闪念箱：随手记想法，自动按天分组；一键转草稿 / 方法笔记沉淀进知识库 ——
function InboxPanel({items, setItems, onToDraft, onToNote, onDaily, onClose}) {
  const [q, setQ] = useState('');
  const add = () => {
    const t = q.trim(); if (!t) return;
    setItems([{id: 'i-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: t, ts: Date.now()}, ...items]);
    setQ('');
  };
  const dayOf = ts => { const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const timeOf = ts => { const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
  const today = dayOf(Date.now()), yest = dayOf(Date.now() - 864e5);
  const groups = [];
  for (const it of items) {
    const k = dayOf(it.ts), g = groups[groups.length - 1];
    if (g && g.k === k) g.list.push(it); else groups.push({k, list: [it]});
  }
  return <aside className="inbox-panel glass" role="complementary" aria-label="闪念箱 Inbox">
    <header>
      <h3>闪念箱 <em>Inbox</em><b>{items.length}</b></h3>
      <div>
        <button className="pill" onClick={onDaily}>今日笔记 <em>Daily</em></button>
        <button className="icon-btn" onClick={onClose} aria-label="收起闪念箱"><Icon name="close" size={14}/></button>
      </div>
    </header>
    <div className="inbox-input">
      <textarea value={q} onChange={e => setQ(e.target.value)} rows={2} aria-label="记录闪念"
        placeholder="随手记一条想法…（Enter 保存）"
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); add(); } }}/>
      <button className="pill primary" onClick={add} disabled={!q.trim()}>记下 <em>Save</em></button>
    </div>
    <div className="inbox-list">
      {groups.map(g => <div key={g.k}>
        <p className="inbox-day">{g.k === today ? '今天 Today' : g.k === yest ? '昨天 Yesterday' : g.k}</p>
        {g.list.map(it => <div key={it.id} className="inbox-item">
          <p>{it.text}</p>
          <footer>
            <small>{timeOf(it.ts)}</small>
            <span>
              <button onClick={() => onToDraft(it.id)}>转草稿 <em>Draft</em></button>
              <button onClick={() => onToNote(it.id)}>转笔记 <em>Note</em></button>
              <button className="del" onClick={() => setItems(items.filter(x => x.id !== it.id))} aria-label="删除闪念"><Icon name="trash" size={12}/></button>
            </span>
          </footer>
        </div>)}
      </div>)}
      {!items.length && <p className="empty-line">还没有闪念，随手记一条吧 <em>Nothing captured yet</em></p>}
    </div>
  </aside>;
}

export function Drafts({graph, drafts, setDrafts, active, setActive, onNew, onDelete, onGo, onJumpContent, works, notes, onMove, inbox, setInbox, onFlashToDraft, onFlashToNote, onDaily}) {
  const draft = drafts.find(d => d.id === active) || drafts[0];
  const area = useRef(null);
  const pv = useRef(null); // 阅读模式渲染容器（浮动目录在阅读下跳转/高亮用）
  const [legend, setLegend] = useState(null); // null=全部 · 'out'|'in'|'both' 只看该类连接
  // —— 编辑器视图：专注（隐藏左右卡片）/ 阅读（Markdown 渲染）/ 对照（双文件分屏，对照面板固定在左），可自由叠加 ——
  const [focusMode, setFocusMode] = useLocalState(CONFIG.storagePrefix + '-drafts-focus-v1', false);
  const [readMode, setReadMode] = useLocalState(CONFIG.storagePrefix + '-drafts-read-v1', false);
  const [cmp, setCmp] = useLocalState(CONFIG.storagePrefix + '-drafts-compare-v1', {on: false, id: ''});
  const [splitPct, setSplitPct] = useLocalState(CONFIG.storagePrefix + '-drafts-split-v1', 50); // 对照分屏左栏宽度（25–75%）
  const [dragSplit, setDragSplit] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false); // 闪念箱抽屉
  // 左侧草稿列表可收起：收起后正文区左移占满，方便边读边开思维导图浮动窗
  const [listHidden, setListHidden] = useLocalState(CONFIG.storagePrefix + '-drafts-list-v1', false);
  const change = (key, value) => setDrafts(drafts.map(d => d.id === draft.id ? {...d, [key]: value} : d));
  const titles = useMemo(() => graph.nodes.filter(n => CONTENT.has(n.kind) && n.id !== 'draft:' + draft?.id).map(n => ({id: n.id, title: n.path?.split('/').pop().replace(/\.md$/, '') || n.title, short: n.short || n.title, kind: n.kind})), [graph, draft?.id]);
  const heads = useMemo(() => headingMap(graph), [graph]);
  const wiki = useWikiComplete({titles, areaRef: area, onChange: body => change('body', body), headings: heads});
  const fx = useEditorEnhancers({area, value: draft?.body, onChange: body => change('body', body), wiki, title: draft?.title, titles, preview: pv, previewMode: readMode ? 'preview' : 'edit', docId: 'draft:' + draft?.id});
  const node = draft && graph.index.get('draft:' + draft.id);
  const nb = node ? neighbors(graph, node.id) : null;
  const wikiLinks = node ? graph.links.filter(l => l.kind === 'wiki' && l.s === node.id).map(l => graph.index.get(l.t)) : [];
  // 专注（隐藏两侧卡片）与对照（编辑区内部分屏）作用层级不同，可以同时开启
  const cmpOn = !!cmp?.on;
  // 专注模式动画：进入由 .focused 的 CSS 动画播放；退出时先挂 unfocusing 类让两侧卡片滑回，播完再摘掉
  const focusFx = useRef(null);
  const [unfocusing, setUnfocusing] = useState(false);
  const toggleFocus = () => {
    const next = !focusMode;
    setFocusMode(next);
    clearTimeout(focusFx.current);
    if (next) setUnfocusing(false);
    else { setUnfocusing(true); focusFx.current = setTimeout(() => setUnfocusing(false), 360); }
  };
  useEffect(() => () => clearTimeout(focusFx.current), []);
  const toggleCompare = () => setCmp(c => ({on: !c?.on, id: c?.id || ''}));
  // 对照文件清单：文章 + 其他草稿 + 方法笔记
  const files = useMemo(() => [
    ...(works || []).map(w => ({id: 'post:' + w.id, title: w.title, kind: 'post', body: w.body})),
    ...drafts.filter(d => d.id !== draft?.id).map(d => ({id: 'draft:' + d.id, title: d.title || '未命名草稿', kind: 'draft', body: d.body})),
    ...(notes || []).map(n => ({id: 'note:' + n.id, title: n.title, kind: 'note', body: n.body})),
  ], [works, drafts, draft?.id, notes]);
  const cmpTarget = cmpOn ? files.find(f => f.id === cmp.id) || null : null;
  const byName = useMemo(() => nameIndex(graph.nodes), [graph]);
  // 阅读模式与对照栏共用：渲染 + [[双链]] 点击跳转（阅读模式 TOC 依赖编辑器滚动，故隐藏）
  const readHtml = useMemo(() => readMode && draft ? renderMarkdown(draft.body) : '', [readMode, draft]);
  const cmpHtml = useMemo(() => cmpTarget ? renderMarkdown(cmpTarget.body) : '', [cmpTarget]);
  const jumpWiki = e => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    // 块引用 [[笔记#小节]]：目标是当前这篇时滚动到对应小节，否则跳到目标内容
    // （双链就地打开目标内容：作品→作品库、笔记→方法库……；无 onJumpContent 时回退图谱定位）
    const {id, anchor} = resolveTarget(byName, a.dataset.target);
    if (!id) return;
    if (anchor && node && id === node.id) { scrollToAnchor(pv.current, anchor); return; }
    (onJumpContent || onGo)(id);
  };
  // 可拖动分割线：拖动调左栏宽度（钳制 25–75%），双击恢复对半，左右方向键微调
  const onDividerDown = e => {
    e.preventDefault();
    const rect = e.currentTarget.parentElement.getBoundingClientRect();
    setDragSplit(true);
    const move = ev => setSplitPct(Math.round(Math.min(75, Math.max(25, (ev.clientX - rect.left) / rect.width * 100))));
    const stop = () => { setDragSplit(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };
  const onDividerKey = e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSplitPct(v => Math.max(25, v - 2)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSplitPct(v => Math.min(75, v + 2)); }
  };
  return <div className="page page-drafts">
    <PageHead zh="创作台" en="Drafts" sub="把灵感，写成下一篇。" subEn="Write with [[links]] — every link grows a backlink.">
      <button className="pill" onClick={() => setInboxOpen(v => !v)}>闪念箱{inbox.length ? ` · ${inbox.length}` : ''} <em>Inbox</em></button>
      <button className="pill primary" onClick={() => onNew()}><Icon name="plus" size={15}/>新建草稿 <em>New draft</em></button>
    </PageHead>
    {inboxOpen && <InboxPanel items={inbox} setItems={setInbox} onToDraft={onFlashToDraft} onToNote={onFlashToNote} onDaily={onDaily} onClose={() => setInboxOpen(false)}/>}
    <div className={`drafts-layout${focusMode ? ' focused' : ''}${unfocusing ? ' unfocusing' : ''}${listHidden ? ' list-hidden' : ''}`}>
      {listHidden && <button className="list-rail glass" aria-label="展开草稿列表" aria-expanded="false"
        title="展开草稿列表 · Show draft list" onClick={() => setListHidden(false)}><Icon name="chevron" size={14}/></button>}
      <aside className="draft-list glass">
        <h3>我的草稿 <em>My drafts</em><b>{drafts.length}</b>
          <button className="list-toggle" aria-label="收起草稿列表" title="收起列表，正文区左移占满（边栏再点可展开） · Collapse list" onClick={() => setListHidden(true)}><Icon name="chevron" size={12}/></button>
        </h3>
        {drafts.map(d => <button key={d.id} className={d.id === draft?.id ? 'active' : ''} onClick={() => setActive(d.id)}>
          <i/><span>{d.title || '未命名草稿'}<small>{(d.body || '').length} 字 chars · {graph.index.get('draft:' + d.id)?.deg || 0} 连接 links</small></span>
        </button>)}
        {!drafts.length && <p className="empty-line">还没有草稿 <em>No drafts yet</em></p>}
      </aside>
      {draft ? <section className="editor glass">
        <div className="editor-meta">
          <span>03-创作台 / 正在写 <em>Writing</em></span>
          <span className="editor-tools" role="group" aria-label="编辑器视图 Editor views">
            {onMove && <button type="button" title="把这篇草稿移到其他模块（作品库 / 方法库 / 选题池） · Move this draft to another module" onClick={() => onMove(draft.id)}>移动到 <em>Move</em></button>}
            <button type="button" className={focusMode ? 'on' : ''} aria-pressed={focusMode}
              title="隐藏左右卡片，编辑区占满，可与对照/阅读叠加 · Hide side cards and widen the editor; stacks with Compare/Read" onClick={toggleFocus}>专注 <em>Focus</em></button>
            <button type="button" className={cmpOn ? 'on' : ''} aria-pressed={cmpOn}
              title="与另一个文件并排对照阅读（面板在左侧），可与专注/阅读叠加 · Compare with another file (pane on the left); stacks with Focus/Read" onClick={toggleCompare}>对照 <em>Compare</em></button>
            <button type="button" className={readMode ? 'on' : ''} aria-pressed={readMode}
              title="用渲染视图阅读，双链可点击 · Read the rendered view" onClick={() => setReadMode(v => !v)}>阅读 <em>Read</em></button>
          </span>
          <span><Icon name="check" size={13}/>已保存到此浏览器 <em>Saved locally</em></span>
        </div>
        <input className="editor-title" value={draft.title} onChange={e => change('title', e.target.value)} placeholder="给这篇内容一个标题 Title" aria-label="草稿标题"/>
        {!readMode && fx.bar}
        <div className={`editor-area ${cmpOn ? 'split' : ''}`} style={cmpOn ? {'--cmp-split': `${splitPct}%`} : undefined}>
          {cmpOn && <aside className="compare-pane">
            <header className="cmp-head">
              <select value={cmp.id || ''} aria-label="选择对照文件 Pick a file to compare" onChange={e => setCmp({...cmp, id: e.target.value})}>
                <option value="">选择文件… Pick a file</option>
                {['post', 'draft', 'note'].map(k => {
                  const group = files.filter(f => f.kind === k);
                  return group.length ? <optgroup key={k} label={`${FILE_KIND_ZH[k][0]} ${FILE_KIND_ZH[k][1]}`}>
                    {group.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
                  </optgroup> : null;
                })}
              </select>
              <button className="icon-btn" aria-label="关闭对照 Close compare" onClick={toggleCompare}><Icon name="close" size={13}/></button>
            </header>
            {cmpTarget
              ? <article className="md-preview cmp-view" onClick={jumpWiki} dangerouslySetInnerHTML={{__html: cmpHtml}}/>
              : <p className="empty-line">选一个文件，和当前草稿并排阅读。<em>Pick a file to read side by side.</em></p>}
          </aside>}
          {cmpOn && <div className={`cmp-divider ${dragSplit ? 'drag' : ''}`} role="separator" aria-orientation="vertical"
            aria-label="调整分屏宽度 Resize split" aria-valuenow={Math.round(splitPct)} aria-valuemin={25} aria-valuemax={75}
            tabIndex={0} title="拖动调整宽度 · 双击恢复对半 Drag to resize · double-click to reset"
            onPointerDown={onDividerDown} onDoubleClick={() => setSplitPct(50)} onKeyDown={onDividerKey}/>}
          <div className="editor-main hybrid">
            {readMode
              ? (String(draft.body || '').trim()
                ? <article ref={pv} className="md-preview read-view" onClick={jumpWiki} dangerouslySetInnerHTML={{__html: readHtml}}/>
                : <p className="empty-line">还没有内容可阅读，切回编辑写点什么。 <em>Nothing to read yet — switch back to edit.</em></p>)
              : <>
                <LineMirror text={draft.body} taRef={area}/>
                <textarea ref={area} value={draft.body}
                  onChange={e => { change('body', e.target.value); fx.onInput(e.target); wiki.check(e.target); }} onClick={e => wiki.check(e.target)}
                  onKeyDown={fx.onKeyDown} onBlur={fx.onBlur}/>
                {wiki.suggest && <WikiSuggest suggest={wiki.suggest} pick={wiki.pick} setPick={wiki.setPick} insert={wiki.insert}/>}
                {fx.menu}
                {fx.ask}
              </>}
          </div>
          {fx.toc}
        </div>
        <footer className="editor-foot">
          <span>{(draft.body || '').length} 字 <em>chars</em> · {wikiLinks.length} 个双链 <em>wikilinks</em>{fx.badges(draft.body).map((b, i) => <React.Fragment key={i}> · {b.zh} <em>{b.en}</em></React.Fragment>)}</span>
          <button className="pill ghost danger" onClick={() => onDelete(draft.id)}><Icon name="trash" size={14}/>删除 <em>Delete</em></button>
        </footer>
      </section> : <section className="editor glass empty"><p>新建一篇草稿开始写作 <em>Create a draft to begin</em></p></section>}
      {node && <aside className="draft-links glass">
        <h3><Icon name="pulse" size={15}/>神经连接 <em>Neural links</em></h3>
        <MiniGraph graph={graph} node={node} focus={legend}/>
        <div className="dl-legend" role="group" aria-label="按连接类型筛选 Filter by link type">
          {[['out', '出链', 'Out', nb.out.length], ['in', '反链', 'In', nb.back.length], ['both', '双向', 'Mutual', nb.mutual.length]].map(([k, zh, en, n]) =>
            <button key={k} type="button" className={legend === k ? 'on' : ''} aria-pressed={legend === k}
              title={legend === k ? '点击恢复全部 · Click to show all' : `只看${zh} · Show ${en} only`}
              onClick={() => setLegend(v => v === k ? null : k)}>
              <i className={k}/>{zh} <em>{en}</em> {n}
            </button>)}
        </div>
        {[['[[双链]]', 'Wikilinks', wikiLinks.map(n => n.id), 'out'], ['提及概念', 'Concepts', nb.out.filter(x => graph.index.get(x.id).kind === 'concept').map(x => x.id), 'out'], ['双向共振', 'Resonance', nb.mutual.map(x => x.id), 'both'], ['反链 · 来源', 'Backlinks', nb.back.map(x => x.id), 'in']].filter(([, , ids, dir]) => (!legend || dir === legend) && ids.length).map(([zh, en, ids]) => <div className="dl-group" key={zh}>
          <p>{zh} <em>{en}</em></p>
          <div className="chip-row">{ids.map(id => { const n = graph.index.get(id); const go = CONTENT.has(n.kind) || n.kind === 'concept'; return go ? <button key={id} className="chip" style={{'--kc': KINDS[n.kind].color}} onClick={() => onGo(id)}>{n.short || n.title}</button> : <span key={id} className={`chip static ${n.kind === 'ghost' ? 'ghost' : ''}`} style={{'--kc': KINDS[n.kind].color}}>{n.short || n.title}</span>; })}</div>
        </div>)}
        {!node.deg && <p className="empty-line">写下内容或 [[链接]] 后，这里会长出连接。<em>Links appear as you write.</em></p>}
      </aside>}
    </div>
  </div>;
}

// —— 选题池 Ideas ——
const LANES = [['待写', 'To write'], ['待扩展', 'To expand'], ['已转草稿', 'Drafted']];
const PRI = {高: ['High', 'high'], 中: ['Medium', 'mid'], 低: ['Low', 'low']};

// —— 方法库 Methods：左侧笔记列表按二级分类分组（可折叠、可拖拽归类、分类可增删改），右侧就地编辑 ——
export function Methods({graph, notes, setNotes, selected, setSelected, onGo, onJumpContent, onNew, onDelete, onUpdate, onMove, onMerge, folders, dragging, setDragging, onMoveToFolder, onCreateFolder, onRenameFolder, onDeleteFolder}) {
  const note = notes.find(n => n.id === selected) || notes[0];
  const area = useRef(null);
  const pv = useRef(null); // 阅读模式渲染容器（浮动目录在阅读下跳转/高亮用）
  const [q, setQ] = useState('');
  const [readMode, setReadMode] = useState(false);
  const [merging, setMerging] = useState(false); // 合并弹窗：两篇笔记拼一篇
  const [mergeA, setMergeA] = useState('');
  const [mergeB, setMergeB] = useState('');
  // 专注模式：与创作台同一套机制（隐藏左列表 + focusIn 动画 + 退出滑回），位置单独持久化
  const [focusMode, setFocusMode] = useLocalState(CONFIG.storagePrefix + '-methods-focus-v1', false);
  // 左侧笔记列表可收起：收起后正文区左移占满，方便边读边开思维导图浮动窗
  const [listHidden, setListHidden] = useLocalState(CONFIG.storagePrefix + '-methods-list-v1', false);
  const focusFx = useRef(null);
  const [unfocusing, setUnfocusing] = useState(false);
  const toggleFocus = () => {
    const next = !focusMode;
    setFocusMode(next);
    clearTimeout(focusFx.current);
    if (next) setUnfocusing(false);
    else { setUnfocusing(true); focusFx.current = setTimeout(() => setUnfocusing(false), 360); }
  };
  useEffect(() => () => clearTimeout(focusFx.current), []);
  const change = (key, value) => { if (note) onUpdate(note.id, {[key]: value}); };
  // 反向链接：编辑时直接看到哪些笔记用 [[双链]] 指向本篇（与 ArticleView 的反链栏同一口径）
  const selfNode = note && graph.index.get('note:' + note.id);
  const backlinks = useMemo(() => selfNode
    ? graph.links.filter(l => l.kind === 'wiki' && l.t === selfNode.id).map(l => graph.index.get(l.s)).filter(Boolean)
    : [], [graph, selfNode]);
  const titles = useMemo(() => graph.nodes.filter(n => CONTENT.has(n.kind) && n.id !== 'note:' + note?.id).map(n => ({id: n.id, title: n.title, short: n.short || n.title, kind: n.kind})), [graph, note?.id]);
  const heads = useMemo(() => headingMap(graph), [graph]);
  const wiki = useWikiComplete({titles, areaRef: area, onChange: body => change('body', body), headings: heads});
  const fx = useEditorEnhancers({area, value: note?.body, onChange: body => change('body', body), wiki, title: note?.title, titles, preview: pv, previewMode: readMode ? 'preview' : 'edit', docId: 'note:' + note?.id});
  const readHtml = useMemo(() => readMode && note ? renderMarkdown(note.body) : '', [readMode, note]);
  const byName = useMemo(() => nameIndex(graph.nodes), [graph]);
  const jumpWiki = e => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    // 块引用 [[笔记#小节]]：目标是当前这篇时滚动到对应小节，否则跳到目标内容
    // （双链就地打开目标内容；无 onJumpContent 时回退图谱定位）
    const {id, anchor} = resolveTarget(byName, a.dataset.target);
    if (!id) return;
    if (anchor && note && id === 'note:' + note.id) { scrollToAnchor(pv.current, anchor); return; }
    (onJumpContent || onGo)(id);
  };
  const rows = notes.filter(n => (n.title + ' ' + (n.path || '')).toLowerCase().includes(q.toLowerCase()));
  const subOf = n => (n.path || '').split('/')[1] || '笔记';
  // —— 二级分类：path 第二段推导 + 手动新建的空分类（folders）；搜索时空分类隐藏 ——
  const allFolders = useMemo(() => {
    const names = [];
    for (const n of notes) { const f = subOf(n); if (!names.includes(f)) names.push(f); }
    for (const f of folders || []) if (!names.includes(f)) names.push(f);
    return names;
  }, [notes, folders]);
  const groups = useMemo(
    () => allFolders.map(name => ({name, items: rows.filter(n => subOf(n) === name)})).filter(g => g.items.length || !q.trim()),
    [allFolders, rows, q]);
  const [collapsed, setCollapsed] = useState({});
  const [hover, setHover] = useState(null);       // 拖拽悬停的分类
  const [renaming, setRenaming] = useState(null); // {from, value} 正在重命名的分类
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const toggle = f => setCollapsed(c => ({...c, [f]: !c[f]}));
  const commitRename = () => {
    const {from, value} = renaming || {};
    const t = (value || '').trim();
    if (t && t !== from && onRenameFolder) onRenameFolder(from, t);
    setRenaming(null);
  };
  const commitCreate = () => {
    const t = newName.trim();
    if (t && onCreateFolder) onCreateFolder(t);
    setCreating(false); setNewName('');
  };
  const startDrag = (n, e) => {
    if (!setDragging) return;
    e.dataTransfer.setData('text/plain', n.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragging({kind: 'note', id: n.id});
  };
  return <div className="page page-methods">
    <PageHead zh="方法库" en="Methods" sub="方法可复用，笔记会长出连接。" subEn="Reusable methods — every note grows links in the graph.">
      {notes.length >= 2 && <button className="pill" onClick={() => { setMerging(true); setMergeA(note?.id || notes[0].id); setMergeB(notes.find(n => n.id !== (note?.id || notes[0].id))?.id || ''); }} title="把两篇笔记合并成一篇 · Merge two notes"><Icon name="draft" size={15}/>合并 <em>Merge</em></button>}
      <button className="pill primary" onClick={onNew}><Icon name="plus" size={15}/>新建笔记 <em>New note</em></button>
    </PageHead>
    <div className={`drafts-layout methods-page${focusMode ? ' focused' : ''}${unfocusing ? ' unfocusing' : ''}${listHidden ? ' list-hidden' : ''}`}>
      {listHidden && <button className="list-rail glass" aria-label="展开笔记列表" aria-expanded="false"
        title="展开笔记列表 · Show note list" onClick={() => setListHidden(false)}><Icon name="chevron" size={14}/></button>}
      <aside className="draft-list glass">
        <h3>方法笔记 <em>Method notes</em><b>{notes.length}</b>
          <button className="list-toggle" aria-label="收起笔记列表" title="收起列表，正文区左移占满（边栏再点可展开） · Collapse list" onClick={() => setListHidden(true)}><Icon name="chevron" size={12}/></button>
        </h3>
        <label className="search"><Icon name="search" size={14}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索笔记… Search notes" aria-label="搜索方法笔记"/></label>
        {groups.map(g => {
          const open = !collapsed[g.name];
          const hi = dragging?.kind === 'note' && hover === g.name;
          return <div key={g.name} className={`m-folder${open ? '' : ' closed'}${hi ? ' drop-hi' : ''}`}
            onDragOver={e => { if (dragging?.kind !== 'note') return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setHover(g.name); }}
            onDragLeave={() => setHover(h => h === g.name ? null : h)}
            onDrop={e => {
              if (dragging?.kind !== 'note') return;
              e.preventDefault(); setHover(null);
              onMoveToFolder(dragging.id, g.name); // 同分类重复投放由 main.jsx 去重，纯 state 更新无刷新
              setDragging(null);
            }}>
            <div className="m-folder-head">
              <button className="m-folder-name" onClick={() => toggle(g.name)} aria-expanded={open} title="点击折叠 / 展开该分类">
                <Icon name="chevron" size={11}/><span className="m-folder-title">{g.name}</span><b>{g.items.length}</b>
              </button>
              {g.name !== '未分类' && <span className="m-folder-tools">
                <button title="重命名分类 Rename folder" aria-label={`重命名分类 ${g.name}`} onClick={() => setRenaming({from: g.name, value: g.name})}><Icon name="draft" size={12}/></button>
                <button title="删除分类 Delete folder" aria-label={`删除分类 ${g.name}`} onClick={() => onDeleteFolder(g.name)}><Icon name="close" size={12}/></button>
              </span>}
            </div>
            {open && (renaming?.from === g.name
              ? <input className="m-folder-rename" autoFocus value={renaming.value} maxLength={24} aria-label="分类名称 Folder name"
                  onChange={e => setRenaming({from: g.name, value: e.target.value})}
                  onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenaming(null); }}
                  onBlur={commitRename}/>
              : g.items.map(n => <button key={n.id} draggable={!!setDragging}
                  className={`m-item${n.id === note?.id ? ' active' : ''}${dragging?.id === n.id ? ' dragging' : ''}`}
                  onClick={() => setSelected(n.id)}
                  onDragStart={e => startDrag(n, e)} onDragEnd={() => setDragging?.(null)}
                  title="拖到其他分类或顶部导航即可移动 Drag to a folder or the top nav">
                  <i/><span>{n.title || '未命名笔记'}<small>{(n.body || '').length} 字 chars · {graph.index.get('note:' + n.id)?.deg || 0} 连接 links</small></span>
                </button>))}
          </div>;
        })}
        {!groups.length && <p className="empty-line">没有匹配的笔记 <em>No match</em></p>}
        {creating ? <input className="m-folder-rename" autoFocus value={newName} maxLength={24}
            placeholder="分类名称，回车确认 Folder name" aria-label="新建分类 New folder name"
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') commitCreate(); else if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
            onBlur={commitCreate}/>
          : <button className="m-folder-add" onClick={() => { setCreating(true); setNewName(''); }}>
              <Icon name="plus" size={13}/>新建分类 <em>New folder</em>
            </button>}
      </aside>
      {note ? <section className="editor glass">
        <div className="editor-meta">
          <span className="folder-chip">
            <select value={subOf(note)} aria-label="所属分类，选择即移动 Folder" title="选择即移动到该分类 · Pick to move"
              onChange={e => onMoveToFolder && onMoveToFolder(note.id, e.target.value)}>
              {allFolders.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <em>Folder</em>
          </span>
          <span className="editor-tools" role="group" aria-label="编辑器视图 Editor views">
            <button type="button" className={focusMode ? 'on' : ''} aria-pressed={focusMode}
              title="隐藏左侧列表，编辑区占满 · Hide the list and widen the editor" onClick={toggleFocus}>专注 <em>Focus</em></button>
            <button type="button" className={readMode ? 'on' : ''} aria-pressed={readMode}
              title="用渲染视图阅读，双链可点击 · Read the rendered view" onClick={() => setReadMode(v => !v)}>阅读 <em>Read</em></button>
            {onMove && <button type="button" title="把这篇笔记移到其他模块（作品库 / 创作台 / 选题池） · Move this note to another module" onClick={() => onMove(note.id)}>移动到 <em>Move</em></button>}
            <button type="button" onClick={() => onDelete(note.id)}>删除 <em>Delete</em></button>
          </span>
          <span><Icon name="check" size={13}/>已保存到此浏览器 <em>Saved locally</em></span>
        </div>
        <input className="editor-title" value={note.title} onChange={e => change('title', e.target.value)} placeholder="给这篇笔记一个标题 Title" aria-label="笔记标题"/>
        {backlinks.length > 0 && <div className="av-backlinks" role="group" aria-label={`反向链接 ${backlinks.length} 条 Backlinks`}>
          <span className="av-bl-label"><Icon name="back" size={12}/>反链 <em>{backlinks.length}</em></span>
          <div className="chip-row">{backlinks.slice(0, 10).map(n => n && <button key={n.id} className="chip" style={{'--kc': 'var(--gold)'}}
            title={`打开《${n.title}》`} onClick={() => (onJumpContent || onGo)(n.id)}>{n.short || n.title}</button>)}
            {backlinks.length > 10 && <span className="chip static">+{backlinks.length - 10}</span>}
          </div>
        </div>}
        {!readMode && fx.bar}
        <div className="editor-area hybrid">
          {readMode
            ? <article ref={pv} className="md-preview" onClick={jumpWiki} dangerouslySetInnerHTML={{__html: readHtml}}/>
            : <>
              <LineMirror text={note.body} taRef={area}/>
              <textarea ref={area} className="editor-input" value={note.body || ''}
                onChange={e => { change('body', e.target.value); fx.onInput(e.target); wiki.check(e.target); }}
                onClick={e => wiki.check(e.target)} onKeyDown={fx.onKeyDown} onBlur={fx.onBlur}
                placeholder="写方法、记流程，用 [[双链]] 连到别的笔记…" aria-label="笔记正文"/>
              {wiki.suggest && <WikiSuggest suggest={wiki.suggest} pick={wiki.pick} setPick={wiki.setPick} insert={wiki.insert}/>}
              {fx.menu}
              {fx.ask}
            </>}
          {fx.toc}
        </div>
      </section> : <section className="editor glass"><p className="empty-line">还没有方法笔记，点右上角新建。 <em>No notes yet.</em></p></section>}
    </div>
    {merging && <div className="veil" onClick={() => setMerging(false)}>
      <section className="modal glass" role="dialog" aria-modal="true" aria-label="合并笔记 Merge notes" onClick={e => e.stopPropagation()}>
        <header><h2>合并笔记 <em>Merge notes</em></h2><button className="icon-btn" onClick={() => setMerging(false)} aria-label="关闭弹窗"><Icon name="close" size={16}/></button></header>
        <div className="about">
          <p className="quiet">把第二篇合并进第一篇：正文按序拼接、[[双链]]随正文归并，生成一篇新笔记（归入第一篇所在分类）；原两篇移入回收站（30 天内可找回）。<em>Bodies are concatenated into a new note; originals go to .trash.</em></p>
          <div className="form-row">
            <label>第一篇（保留其分类） <em>Into</em>
              <select value={mergeA} aria-label="第一篇笔记" onChange={e => { setMergeA(e.target.value); if (e.target.value === mergeB) setMergeB(notes.find(n => n.id !== e.target.value)?.id || ''); }}>
                {notes.map(n => <option key={n.id} value={n.id}>{n.title || '未命名笔记'}</option>)}
              </select></label>
            <label>第二篇 <em>From</em>
              <select value={mergeB} aria-label="第二篇笔记" onChange={e => setMergeB(e.target.value)}>
                {notes.filter(n => n.id !== mergeA).map(n => <option key={n.id} value={n.id}>{n.title || '未命名笔记'}</option>)}
              </select></label>
          </div>
          <div className="form-actions">
            <button className="pill ghost" onClick={() => setMerging(false)}>取消 <em>Cancel</em></button>
            <button className="pill primary" disabled={!mergeA || !mergeB || mergeA === mergeB} onClick={() => { setMerging(false); if (onMerge) onMerge(mergeA, mergeB); }}><Icon name="draft" size={14}/>合并 <em>Merge</em></button>
          </div>
        </div>
      </section>
    </div>}
  </div>;
}

// —— 阅读区 Readings：放别人写好的内容，自己拿来阅读（可批注编辑），左侧分类目录管理 ——
export function Readings({graph, readings, selected, setSelected, openReading, setOpenReading, onGo, onJumpContent, onAction, onNew, onUpdate, onDelete, readFolders, dragging, setDragging, onMoveToFolder, onCreateFolder, onRenameFolder, onDeleteFolder, onLinkify, onImportFiles, onMakeMap}) {
  const [q, setQ] = useState('');
  const [curFolder, setCurFolder] = useState(null); // null = 全部；「未分类」是删除分类时的兜底去处
  // 左侧分类目录可收起：收起后内容区左移占满，方便边读边开思维导图浮动窗
  const [listHidden, setListHidden] = useLocalState(CONFIG.storagePrefix + '-readings-list-v1', false);
  const [renaming, setRenaming] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [hover, setHover] = useState(null); // 拖拽悬停的分类
  const folderOf = r => r.folder || '未分类';
  // —— 本地文件导入：PDF / HTML / Markdown / TXT → 阅读条目（docImport.js 离线解析） ——
  const fileRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const onPickFiles = async e => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length || typeof onImportFiles !== 'function') return;
    setImporting(true);
    const ok = []; const errors = []; // 失败原因透传给调用方提示，不让用户只看到「失败了」却不知道为什么
    for (const f of files) { try { ok.push(await parseDocFile(f)); } catch (err) { errors.push(`${f.name}: ${err?.message || err}`); } }
    setImporting(false);
    onImportFiles(ok, errors);
  };
  // 分类目录：阅读条目的 folder 字段推导 ∪ 手动新建的空分类（-read-folders-v1）
  const allFolders = useMemo(() => {
    const names = [];
    for (const r of readings) { const f = folderOf(r); if (!names.includes(f)) names.push(f); }
    for (const f of readFolders || []) if (!names.includes(f)) names.push(f);
    return names;
  }, [readings, readFolders]);
  const rows = readings
    .filter(r => (!curFolder || folderOf(r) === curFolder) && ((r.title || '') + ' ' + (r.author || '') + ' ' + (r.source || '')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const cur = readings.find(r => r.id === openReading) || null;
  const node = graph.index.get('reading:' + (openReading ?? selected ?? rows[0]?.id));
  // ArticleView 的兼容对象：date 必须是字符串、tags 必须是数组；metaLine 覆盖「首发/编辑于/标签」文案
  const asWork = r => ({...r, date: r.date || '', tags: [], metaLine: `${String(r.date || '').slice(0, 10)} 收藏 · ${r.author || '佚名'}${r.source ? ' · ' + r.source : ''}`});
  // 打开阅读后滚动定位：全文视图在列表下方，不滚动会像「按钮没反应」
  useEffect(() => {
    if (!openReading) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => document.querySelector('.article-view')?.scrollIntoView({block: 'start', behavior: smooth ? 'smooth' : 'auto'}));
  }, [openReading]);
  const commitRename = () => {
    const {from, value} = renaming || {};
    const t = (value || '').trim();
    if (t && t !== from && onRenameFolder) onRenameFolder(from, t);
    setRenaming(null);
  };
  const commitCreate = () => {
    const t = newName.trim();
    if (t && onCreateFolder) onCreateFolder(t);
    setCreating(false); setNewName('');
  };
  const startDrag = (r, e) => {
    if (!setDragging) return;
    e.dataTransfer.setData('text/plain', r.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragging({kind: 'reading', id: r.id});
  };
  return <div className="page page-readings">
    <PageHead zh="阅读区" en="Readings" sub="别人的好内容，收进自己的网络。" subEn="Reading list — others' words, linked into your graph.">
      <button className="pill" onClick={() => fileRef.current?.click()} disabled={importing} title="支持 PDF / Word(.docx) / HTML / Markdown / TXT（离线解析）">{importing ? '解析中…' : '导入文件'} <em>Import</em></button>
      <button className="pill primary" onClick={onNew}><Icon name="plus" size={15}/>添加阅读 <em>New reading</em></button>
    </PageHead>
    <input ref={fileRef} type="file" accept=".pdf,.docx,.html,.htm,.md,.markdown,.txt" multiple hidden onChange={onPickFiles} aria-hidden="true"/>
    <div className={`library-layout readings-layout${listHidden ? ' list-hidden' : ''}`}>
      {listHidden && <button className="list-rail glass" aria-label="展开分类目录" aria-expanded="false"
        title="展开分类目录 · Show folders" onClick={() => setListHidden(false)}><Icon name="chevron" size={14}/></button>}
      <aside className="read-folders glass" aria-label="阅读分类目录">
        <h3>分类 <em>Folders</em>
          <button className="list-toggle" aria-label="收起分类目录" title="收起分类目录，内容区左移占满（边栏再点可展开） · Collapse folders" onClick={() => setListHidden(true)}><Icon name="chevron" size={12}/></button>
        </h3>
        <div className={`rf-row${curFolder == null ? ' active' : ''}`}>
          <button className="rf-name" onClick={() => setCurFolder(null)}><Icon name="book" size={12}/><span>全部阅读</span><b>{readings.length}</b></button>
        </div>
        {allFolders.map(name => {
          const count = readings.filter(r => folderOf(r) === name).length;
          const hi = dragging?.kind === 'reading' && hover === name;
          return <div key={name} className={`rf-wrap${hi ? ' drop-hi' : ''}`}
            onDragOver={e => { if (dragging?.kind !== 'reading') return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setHover(name); }}
            onDragLeave={() => setHover(h => h === name ? null : h)}
            onDrop={e => {
              if (dragging?.kind !== 'reading') return;
              e.preventDefault(); setHover(null);
              onMoveToFolder(dragging.id, name); // 同分类重复投放由 main.jsx 去重，纯 state 更新无刷新
              setDragging(null);
            }}>
            {renaming?.from === name
              ? <input className="rf-rename" autoFocus value={renaming.value} maxLength={24} aria-label="分类名称 Folder name"
                  onChange={e => setRenaming({from: name, value: e.target.value})}
                  onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenaming(null); }}
                  onBlur={commitRename}/>
              : <div className={`rf-row${curFolder === name ? ' active' : ''}`}>
                  <button className="rf-name" onClick={() => setCurFolder(curFolder === name ? null : name)} title="点击筛选该分类，卡片可拖进来归类">
                    <Icon name="book" size={12}/><span>{name}</span><b>{count}</b>
                  </button>
                  {name !== '未分类' && <span className="rf-tools">
                    <button title="重命名分类 Rename folder" aria-label={`重命名分类 ${name}`} onClick={() => setRenaming({from: name, value: name})}><Icon name="draft" size={12}/></button>
                    <button title="删除分类 Delete folder" aria-label={`删除分类 ${name}`} onClick={() => onDeleteFolder(name)}><Icon name="close" size={12}/></button>
                  </span>}
                </div>}
          </div>;
        })}
        {creating ? <input className="rf-rename" autoFocus value={newName} maxLength={24}
            placeholder="分类名称，回车确认 Folder name" aria-label="新建分类 New folder name"
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') commitCreate(); else if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
            onBlur={commitCreate}/>
          : <button className="rf-add" onClick={() => { setCreating(true); setNewName(''); }}>
              <Icon name="plus" size={12}/>新建分类 <em>New folder</em>
            </button>}
        <p className="rf-hint">把阅读卡片拖到分类上即可归类，拖到顶部导航可移动到其他模块 <em>Drag cards onto a folder or the top nav</em></p>
      </aside>
      <section className="works-col">
        <div className="toolbar-row">
          <label className="search"><Icon name="search" size={15}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索标题、作者或来源… Search" aria-label="搜索阅读条目"/></label>
        </div>
        <div className="read-list">{rows.map(r => {
          const on = (openReading ?? selected) === r.id;
          return <div key={r.id} className={`read-card glass ${on ? 'active' : ''}${dragging?.id === r.id ? ' dragging' : ''}`} draggable={!!setDragging}
            onDragStart={e => startDrag(r, e)} onDragEnd={() => setDragging?.(null)}
            onClick={() => { setSelected(r.id); setOpenReading(r.id); }} role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(r.id); setOpenReading(r.id); } }}>
            <span className="rc-body">
              <span className="rc-title">{r.title || '未命名阅读'}</span>
              <span className="rc-sub">{curFolder == null && folderOf(r) !== '未分类' ? `${folderOf(r)} · ` : ''}{r.author || '佚名'}{r.source ? ` · ${r.source}` : ''} · {String(r.date || '').slice(0, 10) || '未标日期'} · {(r.body || '').length.toLocaleString('zh-CN')} 字{readProgress(r.id) ? ` · 读至 ${Math.round(readProgress(r.id).pct * 100)}%` : ''}</span>
            </span>
            <span className="rc-tools">
              <button className="icon-btn" title="删除这条阅读 Delete" aria-label={`删除 ${r.title || '未命名阅读'}`}
                onClick={e => { e.stopPropagation(); onDelete(r.id); }}><Icon name="trash" size={13}/></button>
            </span>
          </div>;
        })}</div>
        {!rows.length && <div className="empty"><Icon name="book" size={30}/><p>还没有收藏的阅读 <em>Nothing here yet</em></p><button className="pill" onClick={() => setQ('')}>清空搜索 <em>Clear</em></button></div>}
        <p className="source-line"><Icon name="info" size={13}/>{readings.length} 条阅读保存在此浏览器，正文可批注，[[双链]] 会汇入图谱 <em>Saved locally</em>。</p>
      </section>
      {node && <aside className="library-analysis" key={node.id}><Analysis graph={graph} node={node} module={MODULES.find(m => m.id === 'readings')} onGo={onGo} onAction={onAction} onClose={() => setSelected(null)} onLinkify={onLinkify}/></aside>}
    </div>
    {cur && <ArticleView key={cur.id} work={asWork(cur)} graph={graph} onChange={p => onUpdate(cur.id, p)} onClose={() => setOpenReading(null)} onGo={onGo} onOpenContent={onJumpContent} eyebrow={['READING', '阅读全文']} exportKind="readings" progressId={cur.id} onMakeMap={onMakeMap}/>}
  </div>;
}

// —— 档案区 Archives：放创作者自己的个人档案（简介、回顾、清单等），与阅读区同构，双链汇入图谱 ——
export function Archives({graph, archives, selected, setSelected, openArchive, setOpenArchive, onGo, onJumpContent, onAction, onNew, onUpdate, onDelete, onLinkify, onMakeMap}) {
  const [q, setQ] = useState('');
  const rows = archives.filter(a => ((a.title || '') + ' ' + (a.body || '')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const cur = archives.find(a => a.id === openArchive) || null;
  const node = graph.index.get('archive:' + (openArchive ?? selected ?? rows[0]?.id));
  const asWork = a => ({...a, date: a.date || '', tags: [], metaLine: `${String(a.date || '').slice(0, 10) || '未标日期'} 收档 · 个人档案`});
  // 打开档案后滚动定位：全文视图在列表下方，不滚动会像「按钮没反应」
  useEffect(() => {
    if (!openArchive) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => document.querySelector('.article-view')?.scrollIntoView({block: 'start', behavior: smooth ? 'smooth' : 'auto'}));
  }, [openArchive]);
  return <div className="page page-archives">
    <PageHead zh="档案区" en="Archives" sub="关于自己的资料，归档进同一张网络。" subEn="Personal archives — your own records, linked into the graph.">
      <button className="pill primary" onClick={onNew}><Icon name="plus" size={15}/>新建档案 <em>New archive</em></button>
    </PageHead>
    <div className="library-layout">
      <section className="works-col">
        <div className="toolbar-row">
          <label className="search"><Icon name="search" size={15}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索档案… Search archives" aria-label="搜索档案"/></label>
        </div>
        <div className="read-list">{rows.map(a => {
          const on = (openArchive ?? selected) === a.id;
          return <div key={a.id} className={`read-card glass ${on ? 'active' : ''}`} onClick={() => { setSelected(a.id); setOpenArchive(a.id); }} role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(a.id); setOpenArchive(a.id); } }}>
            <span className="rc-body">
              <span className="rc-title">{a.title || '未命名档案'}</span>
              <span className="rc-sub">{String(a.date || '').slice(0, 10) || '未标日期'} · {(a.body || '').length.toLocaleString('zh-CN')} 字</span>
            </span>
            <span className="rc-tools">
              <button className="icon-btn" title="删除这份档案 Delete" aria-label={`删除 ${a.title || '未命名档案'}`}
                onClick={e => { e.stopPropagation(); onDelete(a.id); }}><Icon name="trash" size={13}/></button>
            </span>
          </div>;
        })}</div>
        {!rows.length && <div className="empty"><Icon name="archive" size={30}/><p>还没有档案 <em>Nothing here yet</em></p><button className="pill" onClick={() => setQ('')}>清空搜索 <em>Clear</em></button></div>}
        <p className="source-line"><Icon name="info" size={13}/>{archives.length} 份档案保存在此浏览器，正文里的 [[双链]] 会汇入图谱 <em>Saved locally</em>。</p>
      </section>
      {node && <aside className="library-analysis" key={node.id}><Analysis graph={graph} node={node} module={MODULES.find(m => m.id === 'archives')} onGo={onGo} onAction={onAction} onClose={() => setSelected(null)} onLinkify={onLinkify}/></aside>}
    </div>
    {cur && <ArticleView key={cur.id} work={asWork(cur)} graph={graph} onChange={p => onUpdate(cur.id, p)} onClose={() => setOpenArchive(null)} onGo={onGo} onOpenContent={onJumpContent} eyebrow={['ARCHIVE', '档案全文']} exportKind="archives" onMakeMap={onMakeMap}/>}
  </div>;
}

// 概念网络内页：全部概念一张清单（模块「还有 x 条」跳到这里）。
// 每张概念卡可展开编辑（定义 + 手动关键词，存独立键不随导入覆盖）；
// 页头「开始复习」进入闪卡模式（到期优先，忘了 / 模糊 / 记得三档调度），
// 复习分「概念卡 / 段落卡」两类：段落卡来自编辑器选中文本一键存卡（格式栏「存为闪卡」）。
// 点击概念回到工作台图谱选中它。
export function Concepts({graph, onGo, onJumpContent}) {
  const [q, setQ] = useState('');
  const extras = conceptExtras.use();   // {概念名: {text, terms}}
  const review = conceptReview.use();   // {概念名: {due, ivl, ef, reps}}
  const pcs = paraCards.use();          // {卡片id: {id, text, source, ts}}
  const prev = paraReview.use();        // {卡片id: {due, ivl, ef, reps}}
  const [tab, setTab] = useState('concept'); // 复习哪一类卡
  const [editing, setEditing] = useState(null);  // 正在展开编辑的概念名
  const [draftText, setDraftText] = useState(''); // 定义草稿
  const [termDraft, setTermDraft] = useState(''); // 关键词输入
  const [rev, setRev] = useState(null); // 复习会话 {tab, queue, i, flipped}
  const names = useMemo(() => nameIndex(graph.nodes), [graph]); // 来源标题 → 节点 id
  const linkedOf = c => graph.links.filter(l => (l.a === c.id || l.b === c.id) && l.kind === 'mention')
    .map(l => graph.index.get(l.a === c.id ? l.b : l.a)?.title).filter(Boolean);
  const rows = graph.nodes.filter(n => n.kind === 'concept' && (!q || n.title.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (b.in || 0) - (a.in || 0) || a.title.localeCompare(b.title, 'zh-CN'));
  const paraRows = useMemo(() => Object.values(pcs)
    .filter(c => !q || String(c.text || '').toLowerCase().includes(q.toLowerCase()) || (c.source || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.ts - a.ts), [pcs, q]);
  const now = Date.now();
  const dueKey = tab === 'concept' ? (c => review[c.title]?.due || 0) : (c => prev[c.id]?.due || 0);
  const list = tab === 'concept' ? rows : paraRows;
  const dueCount = list.filter(c => dueKey(c) <= now).length;
  const toggleEdit = c => {
    if (editing === c) { setEditing(null); return; }
    setEditing(c);
    setDraftText(extras[c]?.text || '');
    setTermDraft('');
  };
  const addTerm = name => {
    const t = termDraft.trim();
    if (!t) return;
    const cur = extras[name]?.terms || [];
    if (!cur.includes(t)) setConceptExtra(name, {terms: [...cur, t]});
    setTermDraft('');
  };
  const removeTerm = (name, t) => setConceptExtra(name, {terms: (extras[name]?.terms || []).filter(x => x !== t)});
  // 复习队列：到期优先，其次按最近到期时间；一次把全部卡片排进去，不设上限
  const startReview = () => {
    if (!list.length) return;
    const due = list.filter(c => dueKey(c) <= now);
    const rest = list.filter(c => dueKey(c) > now).sort((a, b) => dueKey(a) - dueKey(b));
    setRev({tab, queue: [...due, ...rest], i: 0, flipped: false});
  };
  const grade = g => {
    const card = rev.queue[rev.i];
    if (rev.tab === 'concept') gradeConcept(card.title, g);
    else gradePara(card.id, g);
    setRev(r => ({...r, i: r.i + 1, flipped: false}));
  };
  // 复习弹窗：Esc 结束本轮
  useEffect(() => {
    if (!rev) return;
    const onKey = e => { if (e.key === 'Escape') setRev(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rev]);
  const done = rev && rev.i >= rev.queue.length; // 本轮全部过完 → 总结页
  return <div className="page page-concepts">
    <PageHead zh="概念网络" en="Concepts" sub="全部概念，以及它们出现在哪些内容里。" subEn="Every concept and where it shows up.">
      <button className="pill primary" onClick={startReview} disabled={!list.length}>
        <Icon name="replay" size={15}/>开始复习 <em>Review{dueCount ? ` · ${dueCount} due` : ''}</em>
      </button>
    </PageHead>
    <div className="library-layout">
      <section className="works-col">
        <div className="toolbar-row">
          <label className="search"><Icon name="search" size={15}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索卡片… Search cards" aria-label="搜索卡片"/></label>
          <div className="seg" role="group" aria-label="闪卡类型 Card type">
            <button className={tab === 'concept' ? 'active' : ''} onClick={() => setTab('concept')}>概念卡<em>{rows.length}</em></button>
            <button className={tab === 'para' ? 'active' : ''} onClick={() => setTab('para')}>段落卡<em>{paraRows.length}</em></button>
          </div>
        </div>
        {tab === 'para' && <div className="read-list">{paraRows.map(c => {
          const due = (prev[c.id]?.due || 0) <= now;
          const to = c.source ? names.get(c.source.toLowerCase()) : null;
          return <div key={c.id} className="read-card glass concept-card para-card">
            <span className="rc-body">
              <span className="rc-title-row">
                {to
                  ? <button className="rc-title as-link" onClick={() => (onJumpContent || onGo)(to)} title="打开原文 · Open source">{c.source}</button>
                  : <span className="rc-title">{c.source || '未命名'}</span>}
                {due && <span className="rc-due">待复习 <em>due</em></span>}
                <button className="icon-btn rc-edit" aria-label="删除卡片 Delete card" title="删除卡片 Delete" onClick={() => deleteParaCard(c.id)}><Icon name="trash" size={13}/></button>
              </span>
              <p className="rc-def rc-para">{c.text}</p>
              <span className="rc-sub">{dayOfTs(c.ts)} 存入 · saved</span>
            </span>
          </div>;
        })}</div>}
        {tab === 'para' && !paraRows.length && <div className="empty"><Icon name="spark" size={30}/><p>还没有段落卡 <em>No cards yet</em></p><p className="source-line">在编辑器里选中一段文字，点格式栏的「存为闪卡」 <em>Select text → Save flashcard</em></p></div>}
        {tab === 'concept' && <div className="read-list">{rows.map(c => {
          const linked = linkedOf(c);
          const ex = extras[c.title] || {};
          const open = editing === c.title;
          return <div key={c.id} className={`read-card glass concept-card${open ? ' editing' : ''}`}>
            <span className="rc-body">
              <span className="rc-title-row">
                <button className="rc-title as-link" onClick={() => onGo(c.id)} title="回到工作台，在图谱里查看它的位置 · View in graph">{c.title}</button>
                {(review[c.title]?.due || 0) <= now && <span className="rc-due">待复习 <em>due</em></span>}
                <button className="icon-btn rc-edit" aria-label={open ? '收起编辑 Collapse' : '编辑定义与关键词 Edit'} aria-expanded={open} onClick={() => toggleEdit(c.title)}>
                  <Icon name={open ? 'close' : 'draft'} size={13}/>
                </button>
              </span>
              <span className="rc-sub">提及 {c.in || 0} 次{linked.length ? ' · ' + linked.slice(0, 4).join('、') : ''}</span>
              {(ex.text || open) && <p className="rc-def">{ex.text || <>还没有定义，写一句它是什么。<em>No definition yet.</em></>}</p>}
              {ex.terms?.length > 0 && <div className="chip-row">{ex.terms.map(t => <span key={t} className="chip static" style={{'--kc': KINDS.concept.color}}>{t}</span>)}</div>}
              {open && <div className="concept-edit" onClick={e => e.stopPropagation()}>
                <textarea value={draftText} rows={2} aria-label={`定义 ${c.title}`}
                  placeholder="用一句话定义这个概念… Define it in one line"
                  onChange={e => setDraftText(e.target.value)}/>
                <div className="concept-edit-row">
                  <input value={termDraft} aria-label={`新增关键词 ${c.title}`}
                    placeholder="加关键词，回车确认 Add a keyword"
                    onChange={e => setTermDraft(e.target.value)}
                    onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); addTerm(c.title); } }}/>
                  <button className="icon-btn" aria-label="添加关键词 Add keyword" onClick={() => addTerm(c.title)}><Icon name="plus" size={13}/></button>
                </div>
                {ex.terms?.length > 0 && <div className="chip-row">{ex.terms.map(t => <button key={t} className="chip" style={{'--kc': KINDS.concept.color}}
                  title="点击移除 Click to remove" onClick={() => removeTerm(c.title, t)}><Icon name="close" size={10}/>{t}</button>)}</div>}
                <div className="concept-edit-actions">
                  {(ex.text || ex.terms?.length) ? <button className="pill ghost" onClick={() => { setConceptExtra(c.title, {delete: true}); setDraftText(''); }}>清除 <em>Clear</em></button> : <span/>}
                  <button className="pill primary" onClick={() => { setConceptExtra(c.title, {text: draftText}); setEditing(null); }}><Icon name="check" size={13}/>保存 <em>Save</em></button>
                </div>
              </div>}
            </span>
          </div>;
        })}</div>}
        {tab === 'concept' && !rows.length && <div className="empty"><Icon name="concept" size={30}/><p>还没有概念 <em>No concepts yet</em></p><p className="source-line">给文章或笔记加 #标签，概念就会自动汇入网络 <em>Use #tags</em></p></div>}
        <p className="source-line"><Icon name="info" size={13}/>{tab === 'concept'
          ? <>共 {rows.length} 个概念；点击概念名回到工作台，在图谱里查看它的位置；定义与关键词只存在本机 <em>Click to view in graph</em>。</>
          : <>共 {paraRows.length} 张段落卡；复习调度与概念卡同一条间隔曲线，进度只存在本机 <em>Scheduling stays local</em>。</>}</p>
      </section>
    </div>
    {rev && !done && rev.tab === 'para' && (() => {
      const card = rev.queue[rev.i];
      const to = card.source ? names.get(card.source.toLowerCase()) : null;
      return <div className="review-veil" role="dialog" aria-modal="true" aria-label="段落复习 Paragraph review">
        <div className="review-card glass">
          <header className="review-head">
            <span>{rev.i + 1} / {rev.queue.length} · 到期优先 <em>due first</em></span>
            <button className="icon-btn" aria-label="结束复习 End review" onClick={() => setRev(null)}><Icon name="close" size={14}/></button>
          </header>
          <button className={`review-face${rev.flipped ? ' back' : ''}`} onClick={() => setRev(r => (r ? {...r, flipped: !r.flipped} : null))}
            aria-label={rev.flipped ? '点击回到正面 Flip back' : '点击翻面看答案 Reveal answer'}>
            {rev.flipped
              ? <>
                <span className="rev-hint">来自「{card.source || '未命名'}」 <em>from</em></span>
                <p className="rev-para">{card.text}</p>
                {to && <span className="rev-links as-link" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRev(null); (onJumpContent || onGo)(to); } }} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setRev(null); (onJumpContent || onGo)(to); }}>打开原文 <em>Open source</em></span>}
              </>
              : <>
                <span className="rev-hint">回想这段内容 <em>Recall this passage</em></span>
                <span className="rev-title">{card.source || '未命名'}</span>
                <span className="rev-para rev-cue">{String(card.text || '').slice(0, 60)}{String(card.text || '').length > 60 ? '…' : ''}</span>
                <span className="rev-tip">点击卡片显示全文 <em>Click to reveal</em></span>
              </>}
          </button>
          {rev.flipped && <div className="review-grade" role="group" aria-label="给这次回忆打分 Grade recall">
            <button className="pill ghost" onClick={() => grade(0)}>忘了 <em>Forgot</em></button>
            <button className="pill" onClick={() => grade(1)}>模糊 <em>Fuzzy</em></button>
            <button className="pill primary" onClick={() => grade(2)}>记得 <em>Got it</em></button>
          </div>}
        </div>
      </div>;
    })()}
    {rev && !done && rev.tab === 'concept' && (() => {
      const c = rev.queue[rev.i];
      const linked = linkedOf(c);
      const ex = extras[c.title] || {};
      return <div className="review-veil" role="dialog" aria-modal="true" aria-label="概念复习 Concept review">
        <div className="review-card glass">
          <header className="review-head">
            <span>{rev.i + 1} / {rev.queue.length} · 到期优先 <em>due first</em></span>
            <button className="icon-btn" aria-label="结束复习 End review" onClick={() => setRev(null)}><Icon name="close" size={14}/></button>
          </header>
          <button className={`review-face${rev.flipped ? ' back' : ''}`} onClick={() => setRev(r => (r ? {...r, flipped: !r.flipped} : null))}
            aria-label={rev.flipped ? '点击回到正面 Flip back' : '点击翻面看答案 Reveal answer'}>
            {rev.flipped
              ? <>
                <span className="rev-title">{c.title}</span>
                <p className="rev-def">{ex.text || <>还没有定义 —— 可以去概念页补一句。<em>No definition yet.</em></>}</p>
                {ex.terms?.length > 0 && <div className="chip-row">{ex.terms.map(t => <span key={t} className="chip static" style={{'--kc': KINDS.concept.color}}>{t}</span>)}</div>}
                {linked.length > 0 && <span className="rev-links">出现在 {linked.slice(0, 6).join('、')}{linked.length > 6 ? ' 等' : ''}</span>}
              </>
              : <>
                <span className="rev-hint">它是什么？回想定义与关键词 <em>What is it? Recall, then flip</em></span>
                <span className="rev-title">{c.title}</span>
                <span className="rev-tip">点击卡片显示答案 <em>Click to reveal</em></span>
              </>}
          </button>
          {rev.flipped && <div className="review-grade" role="group" aria-label="给这次回忆打分 Grade recall">
            <button className="pill ghost" onClick={() => grade(0)}>忘了 <em>Forgot</em></button>
            <button className="pill" onClick={() => grade(1)}>模糊 <em>Fuzzy</em></button>
            <button className="pill primary" onClick={() => grade(2)}>记得 <em>Got it</em></button>
          </div>}
        </div>
      </div>;
    })()}
    {done && <div className="review-veil" role="dialog" aria-modal="true" aria-label="复习完成 Review done">
      <div className="review-card glass done">
        <Icon name="check" size={30}/>
        <h3>本轮复习完成 <em>Round finished</em></h3>
        <p>「忘了」的卡片明天会再出现，间隔复习记得更牢。<em>Forgotten cards return tomorrow.</em></p>
        <button className="pill primary" onClick={() => setRev(null)}>好的 <em>Done</em></button>
      </div>
    </div>}
  </div>;
}

export function Ideas({graph, ideas, onEdit, onNew, onGraph}) {
  return <div className="page page-ideas">
    <PageHead zh="选题池" en="Ideas" sub="下一篇，从这里开始。" subEn="Ideas linked to what you have already published.">
      <button className="pill primary" onClick={onNew}><Icon name="plus" size={15}/>添加选题 <em>New idea</em></button>
    </PageHead>
    <div className="lanes">{LANES.map(([zh, en], li) => {
      const list = ideas.filter(i => i.status === zh);
      return <section className="lane glass" key={zh} style={{animationDelay: li * 90 + 'ms'}}>
        <header><span className={`lane-dot l${li}`}/>{zh} <em>{en}</em><b>{list.length}</b></header>
        {list.map((idea, i) => {
          const n = graph.index.get('idea:' + idea.id);
          const lat = n ? latent(graph, n.id) : [];
          const works = lat.filter(x => graph.index.get(x.id).kind === 'post');
          const [pen, pc] = PRI[idea.priority] || PRI['中'];
          return <article className={`idea-card pri-${pc}`} key={idea.id} style={{animationDelay: li * 90 + i * 70 + 140 + 'ms'}}>
            <div className="ic-top"><span className="ic-pri"><i/>{idea.priority} <em>{pen}</em></span><span className="ic-plat">{idea.platform}</span></div>
            <h3>{idea.title || '未命名选题'}</h3>
            <p>{idea.note || '还没有创作备注。'}</p>
            {n?.shared?.length > 0 && <div className="chip-row">{n.shared.slice(0, 5).map(c => <span key={c} className="chip static" style={{'--kc': KINDS.concept.color}}>{c}</span>)}</div>}
            <div className="ic-reach"><Icon name="link" size={13}/>{works.length ? <>可延伸 {works.length} 篇作品 <em>builds on {works.length} works</em></> : <>暂无关联作品 <em>No related works</em></>}</div>
            <footer>
              <button className="pill ghost" disabled={!n} onClick={() => n && onGraph(n.id)}><Icon name="concept" size={14}/>图谱 <em>Graph</em></button>
              <button className="pill" onClick={() => onEdit(idea)}>编辑 <em>Edit</em><Icon name="chevron" size={13}/></button>
            </footer>
          </article>;
        })}
        {!list.length && <p className="empty-line">这个状态下还没有选题 <em>Nothing here yet</em></p>}
      </section>;
    })}</div>
  </div>;
}
