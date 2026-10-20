import React, {useEffect, useMemo, useRef, useState} from 'react';
import {KINDS, CONTENT, MODULES, neighbors, latent, LINK_EN} from './graph';
import {Icon} from './icons';
import {Analysis, Count} from './Analysis';
import {ArticleView, LineMirror, renderMarkdown} from './ArticleView';
import {useWikiComplete, WikiSuggest} from './wiki';
import {useEditorEnhancers} from './plugins';
import {CONFIG} from '../config';
import {T} from './theme';

// 视图状态（专注 / 阅读 / 对照）存本机 localStorage，跨会话记忆。
function useLocalState(key, init) {
  const [v, set] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) ?? init; } catch { return init; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }, [key, v]);
  return [v, set];
}
// 双链点击解析：与 graph.js 的 byName 规则一致（标题 / 路径文件名，忽略大小写）。
function nameIndex(graph) {
  const m = new Map();
  for (const n of graph.nodes) {
    if (!CONTENT.has(n.kind)) continue;
    m.set(String(n.title).toLowerCase(), n.id);
    if (n.path) m.set(n.path.split('/').pop().replace(/\.md$/, '').toLowerCase(), n.id);
  }
  return m;
}
const FILE_KIND_ZH = {post: ['文章', 'Posts'], draft: ['草稿', 'Drafts'], note: ['方法笔记', 'Notes']};

export function PageHead({zh, en, sub, subEn, children}) {
  return <header className="page-head">
    <div><p className="eyebrow">{en.toUpperCase()} <span>{zh}</span></p><h1>{sub}</h1><p className="page-sub">{subEn}</p></div>
    {children && <div className="page-head-actions">{children}</div>}
  </header>;
}

// —— 作品库 Works ——
export function Library({graph, works, selected, setSelected, openArticle, setOpenArticle, onNewWork, onUpdateWork, onDeleteWork, onGo, onAction, onBody, onNoteTitle, onConcept, concepts}) {
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
      {node && <aside className="library-analysis" key={node.id}><Analysis graph={graph} node={node} module={MODULES[0]} onGo={onGo} onAction={onAction} onClose={() => setSelected(null)} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={concepts}/></aside>}
    </div>
    {openWork && <ArticleView key={openWork.id} work={openWork} graph={graph} onChange={patch => onUpdateWork(openWork.id, patch)} onClose={() => setOpenArticle(null)} onGo={onGo} onEditInfo={() => onAction({type: 'editWork', id: openWork.id})}/>}
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

export function Drafts({graph, drafts, setDrafts, active, setActive, onNew, onDelete, onGo, works, notes, onMove}) {
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
  const change = (key, value) => setDrafts(drafts.map(d => d.id === draft.id ? {...d, [key]: value} : d));
  const titles = useMemo(() => graph.nodes.filter(n => CONTENT.has(n.kind) && n.id !== 'draft:' + draft?.id).map(n => ({id: n.id, title: n.path?.split('/').pop().replace(/\.md$/, '') || n.title, short: n.short || n.title, kind: n.kind})), [graph, draft?.id]);
  const wiki = useWikiComplete({titles, areaRef: area, onChange: body => change('body', body)});
  const fx = useEditorEnhancers({area, value: draft?.body, onChange: body => change('body', body), wiki, title: draft?.title, preview: pv, previewMode: readMode ? 'preview' : 'edit'});
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
  const byName = useMemo(() => nameIndex(graph), [graph]);
  // 阅读模式与对照栏共用：渲染 + [[双链]] 点击跳转（阅读模式 TOC 依赖编辑器滚动，故隐藏）
  const readHtml = useMemo(() => readMode && draft ? renderMarkdown(draft.body) : '', [readMode, draft]);
  const cmpHtml = useMemo(() => cmpTarget ? renderMarkdown(cmpTarget.body) : '', [cmpTarget]);
  const jumpWiki = e => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    const id = byName.get(String(a.dataset.target).toLowerCase());
    if (id) onGo(id);
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
      <button className="pill primary" onClick={() => onNew()}><Icon name="plus" size={15}/>新建草稿 <em>New draft</em></button>
    </PageHead>
    <div className={`drafts-layout${focusMode ? ' focused' : ''}${unfocusing ? ' unfocusing' : ''}`}>
      <aside className="draft-list glass">
        <h3>我的草稿 <em>My drafts</em><b>{drafts.length}</b></h3>
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
export function Methods({graph, notes, setNotes, selected, setSelected, onGo, onNew, onDelete, onUpdate, onMove, folders, dragging, setDragging, onMoveToFolder, onCreateFolder, onRenameFolder, onDeleteFolder}) {
  const note = notes.find(n => n.id === selected) || notes[0];
  const area = useRef(null);
  const pv = useRef(null); // 阅读模式渲染容器（浮动目录在阅读下跳转/高亮用）
  const [q, setQ] = useState('');
  const [readMode, setReadMode] = useState(false);
  // 专注模式：与创作台同一套机制（隐藏左列表 + focusIn 动画 + 退出滑回），位置单独持久化
  const [focusMode, setFocusMode] = useLocalState(CONFIG.storagePrefix + '-methods-focus-v1', false);
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
  const titles = useMemo(() => graph.nodes.filter(n => CONTENT.has(n.kind) && n.id !== 'note:' + note?.id).map(n => ({id: n.id, title: n.title, short: n.short || n.title, kind: n.kind})), [graph, note?.id]);
  const wiki = useWikiComplete({titles, areaRef: area, onChange: body => change('body', body)});
  const fx = useEditorEnhancers({area, value: note?.body, onChange: body => change('body', body), wiki, title: note?.title, preview: pv, previewMode: readMode ? 'preview' : 'edit'});
  const readHtml = useMemo(() => readMode && note ? renderMarkdown(note.body) : '', [readMode, note]);
  const byName = useMemo(() => nameIndex(graph), [graph]);
  const jumpWiki = e => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    const id = byName.get(String(a.dataset.target).toLowerCase());
    if (id) onGo(id);
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
      <button className="pill primary" onClick={onNew}><Icon name="plus" size={15}/>新建笔记 <em>New note</em></button>
    </PageHead>
    <div className={`drafts-layout methods-page${focusMode ? ' focused' : ''}${unfocusing ? ' unfocusing' : ''}`}>
      <aside className="draft-list glass">
        <h3>方法笔记 <em>Method notes</em><b>{notes.length}</b></h3>
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
            </>}
          {fx.toc}
        </div>
      </section> : <section className="editor glass"><p className="empty-line">还没有方法笔记，点右上角新建。 <em>No notes yet.</em></p></section>}
    </div>
  </div>;
}

// —— 阅读区 Readings：放别人写好的内容，自己拿来阅读（可批注编辑），左侧分类目录管理 ——
export function Readings({graph, readings, selected, setSelected, openReading, setOpenReading, onGo, onAction, onNew, onUpdate, onDelete, readFolders, dragging, setDragging, onMoveToFolder, onCreateFolder, onRenameFolder, onDeleteFolder}) {
  const [q, setQ] = useState('');
  const [curFolder, setCurFolder] = useState(null); // null = 全部；「未分类」是删除分类时的兜底去处
  const [renaming, setRenaming] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [hover, setHover] = useState(null); // 拖拽悬停的分类
  const folderOf = r => r.folder || '未分类';
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
      <button className="pill primary" onClick={onNew}><Icon name="plus" size={15}/>添加阅读 <em>New reading</em></button>
    </PageHead>
    <div className="library-layout readings-layout">
      <aside className="read-folders glass" aria-label="阅读分类目录">
        <h3>分类 <em>Folders</em></h3>
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
              <span className="rc-sub">{curFolder == null && folderOf(r) !== '未分类' ? `${folderOf(r)} · ` : ''}{r.author || '佚名'}{r.source ? ` · ${r.source}` : ''} · {String(r.date || '').slice(0, 10) || '未标日期'} · {(r.body || '').length.toLocaleString('zh-CN')} 字</span>
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
      {node && <aside className="library-analysis" key={node.id}><Analysis graph={graph} node={node} module={MODULES.find(m => m.id === 'readings')} onGo={onGo} onAction={onAction} onClose={() => setSelected(null)}/></aside>}
    </div>
    {cur && <ArticleView key={cur.id} work={asWork(cur)} graph={graph} onChange={p => onUpdate(cur.id, p)} onClose={() => setOpenReading(null)} onGo={onGo} eyebrow={['READING', '阅读全文']}/>}
  </div>;
}

// —— 档案区 Archives：放创作者自己的个人档案（简介、回顾、清单等），与阅读区同构，双链汇入图谱 ——
export function Archives({graph, archives, selected, setSelected, openArchive, setOpenArchive, onGo, onAction, onNew, onUpdate, onDelete}) {
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
      {node && <aside className="library-analysis" key={node.id}><Analysis graph={graph} node={node} module={MODULES.find(m => m.id === 'archives')} onGo={onGo} onAction={onAction} onClose={() => setSelected(null)}/></aside>}
    </div>
    {cur && <ArticleView key={cur.id} work={asWork(cur)} graph={graph} onChange={p => onUpdate(cur.id, p)} onClose={() => setOpenArchive(null)} onGo={onGo} eyebrow={['ARCHIVE', '档案全文']}/>}
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
              <button className="pill ghost" onClick={() => onGraph(n.id)}><Icon name="concept" size={14}/>图谱 <em>Graph</em></button>
              <button className="pill" onClick={() => onEdit(idea)}>编辑 <em>Edit</em><Icon name="chevron" size={13}/></button>
            </footer>
          </article>;
        })}
        {!list.length && <p className="empty-line">这个状态下还没有选题 <em>Nothing here yet</em></p>}
      </section>;
    })}</div>
  </div>;
}
