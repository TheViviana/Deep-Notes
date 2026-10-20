import React, {useEffect, useMemo, useState} from 'react';
import {KINDS, CONTENT, MODULES, neighbors, latent, askGraph, LINK_KINDS, LINK_EN} from './graph';
import {Icon} from './icons';

const fmt = (v, d = 0) => v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('zh-CN', {minimumFractionDigits: d, maximumFractionDigits: d});
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Count({value, decimals = 0, suffix = ''}) {
  const [v, setV] = useState(reducedMotion() ? value : 0);
  useEffect(() => {
    if (value == null || reducedMotion()) { setV(value); return; }
    let raf; const t0 = performance.now();
    const run = now => { const p = Math.min(1, (now - t0) / 1000); setV(value * (1 - Math.pow(1 - p, 3))); if (p < 1) raf = requestAnimationFrame(run); };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmt(v, decimals)}{value != null && suffix}</>;
}

function Bars({bars}) {
  const max = Math.max(...bars.map(b => b.v || 0), 1e-6);
  return <div className="bars" aria-hidden="true">{bars.map((b, i) => <i key={i} className={b.on ? 'on' : ''} title={b.label} style={{'--h': Math.max(.06, (b.v || 0) / max), animationDelay: 120 + i * 28 + 'ms'}}/>)}</div>;
}

function Metric({label, en, value, decimals = 1, suffix = '%', level, delta, deltaEn, bars}) {
  return <section className="an-metric">
    <header><span>{label} <em>{en}</em></span>{level && <b className={`lvl lvl-${level[2]}`}>{level[0]} <em>{level[1]}</em></b>}</header>
    <div className="an-metric-body">
      <strong><Count value={value} decimals={decimals} suffix={suffix}/></strong>
      {delta && <small className={delta.startsWith('-') ? 'down' : 'up'}>{delta}<em>{deltaEn}</em></small>}
      <Bars bars={bars}/>
    </div>
  </section>;
}

function Tiles({tiles}) {
  return <div className="an-tiles">{tiles.map(([icon, v, zh, en, d], i) => <div className="an-tile" key={zh} style={{animationDelay: 200 + i * 70 + 'ms'}}>
    <span className="t-icon"><Icon name={icon} size={16}/></span>
    <strong>{typeof v === 'number' ? <Count value={v} decimals={d || 0}/> : v}</strong>
    <p>{zh}<em>{en}</em></p>
  </div>)}</div>;
}

function Chip({graph, id, onGo, sub}) {
  const n = graph.index.get(id);
  if (!n) return null;
  const go = CONTENT.has(n.kind) || n.kind === 'concept';
  const body = <>{n.short || n.title}{sub && <small>{sub}</small>}</>;
  return go ? <button className="chip" style={{'--kc': KINDS[n.kind].color}} onClick={() => onGo(id)}>{body}</button>
    : <span className={`chip static ${n.kind === 'ghost' ? 'ghost' : ''}`} style={{'--kc': KINDS[n.kind].color}}>{body}</span>;
}

// —— 双向链接编辑：直接增删改正文里的 [[双链]]，图谱随之重推导；支持未创建目标（ghost） ——
const bodyOf = node => node.kind === 'post' ? (node.post.body || '') : node.kind === 'note' ? (node.body || '') : node.kind === 'draft' ? (node.draft.body || '') : '';
const WIKI_RE = /\[\[([^\[\]\n]+)\]\]/g;
function parseWikis(body) {
  const list = [];
  for (const m of String(body || '').matchAll(WIKI_RE)) {
    const inner = m[1], i = inner.indexOf('|');
    list.push({raw: m[0], target: (i >= 0 ? inner.slice(0, i) : inner).trim(), alias: i >= 0 ? inner.slice(i + 1).trim() : ''});
  }
  return list;
}
const patchBody = (body, raw, next) => { const i = body.indexOf(raw); return i < 0 ? body : body.slice(0, i) + next + body.slice(i + raw.length); };

function WikiEditor({graph, node, onBody, onNoteTitle, onAction}) {
  const body = bodyOf(node);
  const wikis = parseWikis(body);
  const [mode, setMode] = useState(null); // {type:'add'} | {type:'rename', raw}
  const [val, setVal] = useState('');
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleVal, setTitleVal] = useState('');
  // 名称 → 节点 id：与图谱内 byName 同规则（标题 + path 文件名，小写）。
  const nameMap = useMemo(() => {
    const m = new Map();
    for (const n of graph.nodes) {
      m.set(String(n.title).toLowerCase(), n.id);
      if (n.path) m.set(n.path.split('/').pop().replace(/\.md$/, '').toLowerCase(), n.id);
    }
    return m;
  }, [graph]);
  const resolve = name => nameMap.get(name.toLowerCase());
  const save = next => { onBody(node.kind, node.id, next); setMode(null); setVal(''); };
  const addWiki = () => {
    const t = val.trim();
    if (t) save(body.trim() ? body.replace(/\s*$/, '') + '\n\n' + `[[${t}]]` : `[[${t}]]`);
    else setMode(null);
  };
  const candidates = useMemo(() => {
    if (mode?.type !== 'add') return [];
    const q = val.trim().toLowerCase();
    const out = [];
    for (const n of graph.nodes.values()) {
      if (!CONTENT.has(n.kind) || n.id === node.id) continue;
      const name = n.short || n.title;
      if (!q || name.toLowerCase().includes(q)) out.push(name);
      if (out.length >= 6) break;
    }
    return out;
  }, [mode, val, graph, node.id]);
  return <div className="link-ed">
    {node.kind === 'note' && <div className="le-title">
      {titleEditing
        ? <span className="le-edit on"><input autoFocus value={titleVal} onChange={e => setTitleVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && titleVal.trim()) { onNoteTitle(node.id, titleVal); setTitleEditing(false); } if (e.key === 'Escape') setTitleEditing(false); }} placeholder="笔记标题…"/><button className="le-ok" onClick={() => { if (titleVal.trim()) { onNoteTitle(node.id, titleVal); setTitleEditing(false); } }}><Icon name="check" size={12}/></button></span>
        : <><span className="le-name">标题：<b>{node.title}</b></span><button className="le-btn" title="重命名笔记" onClick={() => { setTitleVal(node.title); setTitleEditing(true); }}><Icon name="draft" size={12}/></button></>}
    </div>}
    <div className="le-list">
      {!wikis.length && <p className="quiet">正文里还没有 [[双链]]，添加后即刻入图。 <em>No wikilinks yet</em></p>}
      {wikis.map((w, i) => {
        const dup = wikis.filter(x => x.target.toLowerCase() === w.target.toLowerCase()).length;
        if (mode?.type === 'rename' && mode.raw === w.raw) return <span className="le-edit on" key={i}>
          <input autoFocus value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && val.trim()) save(patchBody(body, w.raw, `[[${val.trim()}${w.alias ? '|' + w.alias : ''}]]`)); if (e.key === 'Escape') setMode(null); }} placeholder="新的目标名称…"/>
          <button className="le-ok" onClick={() => val.trim() && save(patchBody(body, w.raw, `[[${val.trim()}${w.alias ? '|' + w.alias : ''}]]`))}><Icon name="check" size={12}/></button>
        </span>;
        // ghost 节点（图谱里的虚线占位）也算「未创建」——可重命名、删除，或一键创建为文章/笔记
        const t0 = resolve(w.target);
        const tNode = t0 && graph.index.get(t0);
        const hit = tNode && tNode.kind !== 'ghost';
        return <span className="le-row" key={i}>
          <button className={`le-name ${hit ? '' : 'le-ghost'}`} title={hit ? '在图谱中打开' : '未创建——点击改名，或用右侧按钮一键创建'} onClick={() => { if (hit) onGo(t0); else { setMode({type: 'rename', raw: w.raw}); setVal(w.target); } }}>{w.target}{!hit && <em>未创建</em>}{dup > 1 && <em>×{dup}</em>}</button>
          {w.alias && <span className="le-alias">「{w.alias}」</span>}
          <span className="le-ops">
            {!hit && <>
              <button className="le-btn" title={`创建文章「${w.target}」`} onClick={() => onAction({type: 'newFromGhost', kind: 'post', title: w.target})}><Icon name="file" size={12}/></button>
              <button className="le-btn" title={`创建方法笔记「${w.target}」`} onClick={() => onAction({type: 'newFromGhost', kind: 'note', title: w.target})}><Icon name="methods" size={12}/></button>
            </>}
            <button className="le-btn" title="重命名目标" onClick={() => { setMode({type: 'rename', raw: w.raw}); setVal(w.target); }}><Icon name="draft" size={12}/></button>
            <button className="le-btn" title="删除该双链" onClick={() => save(patchBody(body, w.raw, w.alias || ''))}><Icon name="close" size={12}/></button>
          </span>
        </span>;
      })}
    </div>
    {mode?.type === 'add'
      ? <div className="le-edit on">
          <input autoFocus value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addWiki(); if (e.key === 'Escape') setMode(null); }} placeholder="目标名：选已有内容，或输入新名称…"/>
          <button className="le-ok" onClick={addWiki}><Icon name="check" size={12}/></button>
          {candidates.length > 0 && <span className="le-cands">{candidates.map(c => <button key={c} onClick={() => { setVal(c); save(body.trim() ? body.replace(/\s*$/, '') + '\n\n' + `[[${c}]]` : `[[${c}]]`); }}>{c}</button>)}</span>}
        </div>
      : <button className="le-add" onClick={() => { setMode({type: 'add'}); setVal(''); }}><Icon name="plus" size={12}/>添加双链 <em>Add link</em></button>}
    <p className="quiet">改动会写回正文并保存；未创建的链接可一键创建为文章或笔记，反链请到来源内容里改。 <em>Edits are saved to the body</em></p>
  </div>;
}

// —— 概念词表编辑：重命名概念、增删关键词、删除概念（图谱的提及与共振随之重算） ——
function ConceptEditor({node, concepts, onConcept}) {
  const terms = (concepts || []).find(([n]) => n === node.title)?.[1] || [];
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(node.title);
  const [kw, setKw] = useState('');
  return <div className="link-ed">
    <div className="le-title">
      {renaming
        ? <span className="le-edit on"><input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { onConcept(node.title, {name}); setRenaming(false); } if (e.key === 'Escape') setRenaming(false); }} placeholder="概念名…"/><button className="le-ok" onClick={() => { if (name.trim()) { onConcept(node.title, {name}); setRenaming(false); } }}><Icon name="check" size={12}/></button></span>
        : <><span className="le-name">概念：<b>{node.title}</b></span><button className="le-btn" title="重命名概念" onClick={() => { setName(node.title); setRenaming(true); }}><Icon name="draft" size={12}/></button></>}
    </div>
    <div className="chip-row">{terms.map(t => <span key={t} className="chip static">{t}<button className="le-x" title="删除关键词" onClick={() => onConcept(node.title, {keywords: terms.filter(x => x !== t)})}><Icon name="close" size={10}/></button></span>)}
      {!terms.length && <p className="quiet">还没有关键词。 <em>No keywords</em></p>}
    </div>
    <span className="le-edit">
      <input value={kw} onChange={e => setKw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && kw.trim()) { onConcept(node.title, {keywords: [...new Set([...terms, kw.trim().toLowerCase()])]}); setKw(''); } }} placeholder="新增关键词，回车添加…"/>
      <button className="le-ok" onClick={() => { if (kw.trim()) { onConcept(node.title, {keywords: [...new Set([...terms, kw.trim().toLowerCase()])]}); setKw(''); } }}><Icon name="plus" size={12}/></button>
    </span>
    <button className="le-del" onClick={() => { if (window.confirm(`删除概念「${node.title}」？它的提及与共振连线会一并消失。`)) onConcept(node.title, {delete: true}); }}><Icon name="trash" size={12}/>删除概念 <em>Delete concept</em></button>
  </div>;
}

function Links({graph, node, onGo, onBody, onNoteTitle, onConcept, concepts, onAction}) {
  const nb = useMemo(() => neighbors(graph, node.id), [graph, node.id]);
  const lat = useMemo(() => latent(graph, node.id).slice(0, 6), [graph, node.id]);
  const groups = [
    ['双向', 'Mutual', '⇄', nb.mutual.sort((a, b) => b.link.w - a.link.w), l => l.link.kind === 'resonance' ? `${l.link.w} 概念` : LINK_KINDS[l.link.kind]],
    ['出链', 'Outgoing', '→', nb.out, l => LINK_EN[l.link.kind]],
    ['反链', 'Backlinks', '←', nb.back, l => LINK_EN[l.link.kind]],
    ['二度关联', 'Latent', '⋯', lat, l => 'via ' + l.via.slice(0, 2).join('、')]
  ].filter(g => g[3].length);
  return <section className="an-section">
    <h3>双向链接 <em>Bidirectional links</em></h3>
    {groups.map(([zh, en, arrow, list, sub]) => <div className="link-group" key={zh}>
      <p><i>{arrow}</i>{zh} <em>{en}</em><b>{list.length}</b></p>
      <div className="chip-row">{list.slice(0, 14).map(l => <Chip key={l.id} graph={graph} id={l.id} onGo={onGo} sub={sub(l)}/>)}{list.length > 14 && <span className="chip static more">+{list.length - 14}</span>}</div>
    </div>)}
    {(node.kind === 'post' || node.kind === 'note' || node.kind === 'draft') && onBody && <WikiEditor graph={graph} node={node} onBody={onBody} onNoteTitle={onNoteTitle} onAction={onAction}/>}
    {node.kind === 'concept' && onConcept && <ConceptEditor node={node} concepts={concepts} onConcept={onConcept}/>}
  </section>;
}

function Insights({items}) {
  if (!items.length) return null;
  return <section className="an-section">
    <h3><Icon name="spark" size={14}/>图谱分析 <em>Graph insights</em></h3>
    {items.map(([title, en, text, tone], i) => <article key={i} className={`insight tone-${tone || 'info'}`} style={{animationDelay: 380 + i * 90 + 'ms'}}>
      <h4>{title} <em>{en}</em></h4><p>{text}</p>
    </article>)}
  </section>;
}

function AskBox({graph, node, onGo}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  return <div className="an-ask">
    {res && <div className="an-ask-res">{res.map((c, i) => <div key={i} className={`ask-card mini tone-${c.tone}`}>
      <h4>{c.title} <em>{c.en}</em></h4><p>{c.text}</p>
      {c.items?.length > 0 && <div className="chip-row">{c.items.slice(0, 6).map(id => <Chip key={id} graph={graph} id={id} onGo={onGo}/>)}</div>}
    </div>)}</div>}
    <form onSubmit={e => { e.preventDefault(); if (q.trim()) setRes(askGraph(graph, q, node.id)); }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="追问这条内容… Ask about this note" aria-label="追问这条内容"/>
      <button aria-label="提交"><Icon name="send" size={15}/></button>
    </form>
    <div className="an-ask-foot"><span><Icon name="agent" size={13}/>我的图谱 <em>My graph</em></span><span><Icon name="spark" size={13}/>本地分析 <em>Local analysis</em></span></div>
  </div>;
}

const sharedConcepts = (a, b) => (a.shared || []).filter(x => (b.shared || []).includes(x));

function analyze(graph, node) {
  const C = graph.nodes.filter(n => CONTENT.has(n.kind));
  const nb = neighbors(graph, node.id);
  const d = {out: node.out - node.mutual, back: node.in - node.mutual, both: node.mutual};
  const top = [...nb.mutual].sort((a, b) => b.link.w - a.link.w)[0];
  const partner = top && graph.index.get(top.id);
  const resonance = partner ? [['双向共振最强', 'Strongest resonance', `与「${partner.short || partner.title}」互相呼应，共同提及：${sharedConcepts(node, partner).join('、') || LINK_KINDS[top.link.kind]}。`, 'gold']] : [];
  const connectivity = () => {
    const pct = 100 * C.filter(c => c.deg <= node.deg).length / C.length;
    const avg = C.reduce((s, c) => s + c.deg, 0) / C.length;
    const diff = node.deg - avg;
    return {label: '连接度', en: 'Connectivity', value: pct, decimals: 0, level: pct >= 80 ? ['枢纽', 'Hub', 'high'] : pct >= 50 ? ['活跃', 'Active', 'mid'] : ['边缘', 'Edge', 'low'],
      delta: `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} 条`, deltaEn: diff >= 0 ? 'above average' : 'below average',
      bars: [...C].sort((a, b) => a.deg - b.deg).map(c => ({v: c.deg, on: c.id === node.id, label: c.short}))};
  };

  if (node.kind === 'post') {
    const P = C.filter(n => n.kind === 'post');
    const p = node.post;
    const charsOf = x => (x.post.body || '').length;
    const chars = charsOf(node);
    const avg = P.reduce((s, x) => s + charsOf(x), 0) / (P.length || 1);
    const rank = [...P].sort((a, b) => charsOf(b) - charsOf(a)).indexOf(node) + 1;
    const ghosts = nb.out.filter(x => graph.index.get(x.id).kind === 'ghost');
    const ideas = latent(graph, node.id).filter(x => graph.index.get(x.id).kind === 'idea');
    return {
      badge: ['知识文章', 'Article'], status: `写于 ${p.date}${p.updatedAt ? ` · 更新于 ${p.updatedAt}` : ''} · ${node.tags.length} 个话题 topics`,
      action: ['打开文章', 'Open article', {type: 'openArticle', id: p.id}],
      action2: ['编辑信息', 'Edit info', {type: 'editWork', id: p.id}],
      action3: ['移动到…', 'Move', {type: 'move', kind: 'post', id: p.id}],
      metric: connectivity(),
      tiles: [['file', chars, '字数', 'Chars'], ['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual']],
      all: [['最近更新', 'Updated', p.updatedAt || '—'], ['研究方向', 'Direction', p.direction || '—'], ['首次创建', 'Created', p.date], ['话题标签', 'Topics', node.tags.length], ['字数排名', 'Length rank', `${rank}/${P.length}`], ['媒体', 'Media', p.media === 'video' ? '视频' : '图文']],
      insights: [
        ['体量对比', 'Length', P.length > 1 ? `字数排第 ${rank}/${P.length} 名，全库平均 ${Math.round(avg).toLocaleString('zh-CN')} 字${chars >= avg ? '，高于平均。' : '。'}` : '目前只有这一篇文章。', chars >= avg ? 'gold' : 'info'],
        ...resonance,
        ...(ghosts.length ? [['未创建的双链', 'Unresolved links', `${ghosts.length} 个 [[双链]] 指向尚未出现的笔记：${ghosts.slice(0, 3).map(x => graph.index.get(x.id).short).join('、')}${ghosts.length > 3 ? ' 等' : ''}。`, 'warn']] : []),
        ...(ideas.length ? [['可延伸选题', 'Next ideas', ideas.slice(0, 2).map(x => `「${graph.index.get(x.id).short}」（共享：${x.via.join('、')}）`).join('；'), 'info']] : []),
        ...(p.direction ? [['研究方向', 'Direction', p.direction, 'muted']] : [])
      ]
    };
  }
  if (node.kind === 'note') {
    const ghosts = nb.out.filter(x => graph.index.get(x.id).kind === 'ghost');
    return {
      badge: ['方法笔记', 'Method note'], status: node.path,
      action: ['打开编辑器', 'Open editor', {type: 'page', page: 'methods', id: node.id}],
      action2: ['阅读全文', 'Read note', {type: 'read', id: node.id}],
      action3: ['移动到…', 'Move', {type: 'move', kind: 'note', id: node.id}],
      metric: connectivity(),
      tiles: [['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual'], ['file', (node.body || '').length, '字数', 'Chars']],
      insights: [...resonance,
        ...(ghosts.length ? [['未创建的双链', 'Unresolved links', `${ghosts.length} 个 [[双链]] 指向尚未出现的笔记：${ghosts.slice(0, 3).map(x => graph.index.get(x.id).short).join('、')}${ghosts.length > 3 ? ' 等' : ''}。`, 'warn']] : []),
        ['提及概念', 'Concepts', node.shared.length ? node.shared.join('、') : '正文没有命中概念词。', 'info']]
    };
  }
  if (node.kind === 'reading') {
    const ghosts = nb.out.filter(x => graph.index.get(x.id).kind === 'ghost');
    return {
      badge: ['阅读收藏', 'Reading'], status: `${node.reading.author || '佚名'}${node.reading.source ? ' · ' + node.reading.source : ''}${node.reading.date ? ` · ${String(node.reading.date).slice(0, 10)}` : ''}`,
      action: ['打开阅读', 'Read', {type: 'openReading', id: node.reading.id}],
      action2: ['阅读全文', 'Read full', {type: 'read', id: node.id}],
      metric: connectivity(),
      tiles: [['file', (node.body || '').length, '字数', 'Chars'], ['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual']],
      insights: [...resonance,
        ...(ghosts.length ? [['未创建的双链', 'Unresolved links', `${ghosts.length} 个 [[双链]] 指向尚未出现的笔记：${ghosts.slice(0, 3).map(x => graph.index.get(x.id).short).join('、')}${ghosts.length > 3 ? ' 等' : ''}。`, 'warn']] : []),
        ['提及概念', 'Concepts', node.shared.length ? node.shared.join('、') : '正文没有命中概念词。', 'info']]
    };
  }
  if (node.kind === 'archive') {
    const ghosts = nb.out.filter(x => graph.index.get(x.id).kind === 'ghost');
    return {
      badge: ['个人档案', 'Archive'], status: String(node.archive.date || '').slice(0, 10) || '未标日期',
      action: ['打开档案', 'Open', {type: 'openArchive', id: node.archive.id}],
      action2: ['阅读全文', 'Read full', {type: 'read', id: node.id}],
      action3: ['移动到…', 'Move', {type: 'move', kind: 'archive', id: node.archive.id}],
      metric: connectivity(),
      tiles: [['file', (node.body || '').length, '字数', 'Chars'], ['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual']],
      insights: [...resonance,
        ...(ghosts.length ? [['未创建的双链', 'Unresolved links', `${ghosts.length} 个 [[双链]] 指向尚未出现的笔记：${ghosts.slice(0, 3).map(x => graph.index.get(x.id).short).join('、')}${ghosts.length > 3 ? ' 等' : ''}。`, 'warn']] : []),
        ['提及概念', 'Concepts', node.shared.length ? node.shared.join('、') : '正文没有命中概念词。', 'info']]
    };
  }
  if (node.kind === 'idea') {
    const I = C.filter(n => n.kind === 'idea');
    const reach = x => 100 * latent(graph, x.id).length / Math.max(1, C.length - 1);
    const lat = latent(graph, node.id);
    const posts = lat.filter(x => graph.index.get(x.id).kind === 'post');
    const notes = lat.filter(x => graph.index.get(x.id).kind === 'note').length + nb.mutual.filter(x => graph.index.get(x.id).kind === 'note').length;
    const hasDraft = [...nb.out, ...nb.back, ...nb.mutual].some(x => graph.index.get(x.id).kind === 'draft');
    return {
      badge: [`优先级 ${node.idea.priority}`, 'Priority'], status: `${node.idea.status} · ${node.idea.platform}`,
      action: hasDraft ? ['打开草稿', 'Open draft', {type: 'ideaToDraft', idea: node.idea}] : ['转为草稿', 'To draft', {type: 'ideaToDraft', idea: node.idea}],
      action2: ['编辑选题', 'Edit', {type: 'editIdea', idea: node.idea}],
      action3: ['移动到…', 'Move', {type: 'move', kind: 'idea', id: node.idea.id}],
      metric: {label: '延伸潜力', en: 'Reach', value: reach(node), decimals: 0, level: posts.length >= 2 ? ['强', 'Strong', 'high'] : posts.length ? ['中', 'Fair', 'mid'] : ['弱', 'Weak', 'low'],
        delta: `${posts.length} 篇作品`, deltaEn: 'related works', bars: I.map(x => ({v: reach(x), on: x === node, label: x.short}))},
      tiles: [['concept', node.shared.length, '提及概念', 'Concepts'], ['works', posts.length, '关联作品', 'Works'], ['methods', notes, '关联笔记', 'Notes'], ['draft', hasDraft ? 1 : 0, '草稿', 'Drafts']],
      insights: [
        ['创作备注', 'Brief', node.idea.note || '还没有备注。', 'info'],
        ...(posts.length ? [['可以延伸的作品', 'Builds on', posts.slice(0, 3).map(x => `「${graph.index.get(x.id).short}」`).join('、') + ` · 共享：${[...new Set(posts.flatMap(x => x.via))].join('、')}`, 'gold']] : []),
        ...resonance
      ]
    };
  }
  if (node.kind === 'draft') {
    const src = [...nb.out, ...nb.mutual].find(x => graph.index.get(x.id).kind === 'idea');
    return {
      badge: ['正在写', 'Writing'], status: src ? `来自选题「${graph.index.get(src.id).short}」` : '独立草稿 · Standalone',
      action: ['继续写作', 'Continue', {type: 'page', page: 'drafts', id: node.draft.id}],
      action3: ['移动到…', 'Move', {type: 'move', kind: 'draft', id: node.draft.id}],
      metric: connectivity(),
      tiles: [['file', (node.body || '').length, '字数', 'Chars'], ['idea', src ? 1 : 0, '来源选题', 'Source'], ['concept', node.shared.length, '提及概念', 'Concepts'], ['link', graph.links.filter(l => l.kind === 'wiki' && l.s === node.id).length, '双链', 'Wikilinks']],
      insights: [...resonance, ['提及概念', 'Concepts', node.shared.length ? node.shared.join('、') : '正文还没有命中概念词，可以在创作台用 [[ ]] 链接笔记。', 'info']]
    };
  }
  // concept
  const K = graph.nodes.filter(n => n.kind === 'concept');
  const who = nb.back.map(x => graph.index.get(x.id));
  const count = k => who.filter(n => n.kind === k).length;
  const ids = new Set(who.map(n => n.id));
  const inner = graph.links.filter(l => l.kind === 'resonance' && ids.has(l.a) && ids.has(l.b)).length;
  const co = K.filter(k => k !== node).map(k => [k, graph.links.filter(l => l.kind === 'mention' && l.t === k.id && ids.has(l.s)).length]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    badge: ['概念', 'Concept'], status: `被 ${who.length} 条内容提及 · mentioned by ${who.length}`,
    metric: {label: '覆盖率', en: 'Coverage', value: 100 * who.length / C.length, decimals: 0, level: who.length >= 5 ? ['核心', 'Core', 'high'] : who.length >= 3 ? ['常用', 'Common', 'mid'] : ['少见', 'Rare', 'low'],
      delta: `${who.length}/${C.length}`, deltaEn: 'notes', bars: [...K].sort((a, b) => a.in - b.in).map(k => ({v: k.in, on: k === node, label: k.title}))},
    tiles: [['works', count('post'), '作品', 'Works'], ['methods', count('note'), '方法笔记', 'Notes'], ['idea', count('idea'), '选题', 'Ideas'], ['draft', count('draft'), '草稿', 'Drafts']],
    insights: [
      ['内部共振', 'Inner resonance', `提及「${node.title}」的内容之间形成 ${inner} 组双向共振。`, inner ? 'gold' : 'info'],
      ['常一起出现', 'Co-occurs with', co.filter(x => x[1]).map(([k, n]) => `${k.title}（${n}）`).join('、') || '暂无', 'info']
    ]
  };
}

export function Analysis({graph, node, module, onGo, onAction, onClose, onBody, onNoteTitle, onConcept, concepts}) {
  const a = useMemo(() => analyze(graph, node), [graph, node]);
  const color = KINDS[node.kind].color;
  return <div className="analysis glass" style={{'--kc': color}} role="region" aria-label={`${node.title} 的分析`}>
    <p className="an-float">分析概览 <em>Analysis overview</em> · {module?.title} {module?.en}</p>
    <div className="an-scroll">
      <header className="an-head">
        <span className="an-cat"><span className="an-cat-icon"><Icon name={module?.icon || 'file'} size={15}/></span>{module?.title}<em>{module?.en}</em></span>
        <button className="icon-btn" onClick={onClose} aria-label="关闭分析"><Icon name="close" size={15}/></button>
      </header>
      <div className="an-title-row">
        <div>
          <h2>{node.short || node.title}</h2>
          {node.short && node.short !== node.title && <p className="an-full">{node.title}</p>}
        </div>
        {node.cover && <img className="an-cover" src={node.cover} alt=""/>}
      </div>
      <div className="an-status">
        <span className="badge">{a.badge[0]} <em>{a.badge[1]}</em></span>
        <p>{a.status}</p>
        <div className="an-actions">
          {a.action2 && <button className="an-explore ghost" onClick={() => onAction(a.action2[2])}>{a.action2[0]} <em>{a.action2[1]}</em></button>}
          {a.action3 && <button className="an-explore ghost" onClick={() => onAction(a.action3[2])}>{a.action3[0]} <em>{a.action3[1]}</em></button>}
          {a.action && <button className="an-explore" onClick={() => onAction(a.action[2])}>{a.action[0]} <em>{a.action[1]}</em><Icon name="chevron" size={13}/></button>}
        </div>
      </div>
      <Metric {...a.metric}/>
      <Tiles tiles={a.tiles}/>
      {a.all && <section className="an-section"><h3>全部指标 <em>All metrics</em></h3><div className="an-all">{a.all.map(([zh, en, v]) => <div key={zh}><span>{zh}<em>{en}</em></span><b>{v}</b></div>)}</div></section>}
      <Insights items={a.insights}/>
      {node.tags?.length > 0 && <section className="an-section"><h3>话题标签 <em>Topics</em></h3><div className="chip-row">{node.tags.map(t => <span key={t} className="chip static" style={{'--kc': KINDS.tag.color}}>#{t}</span>)}</div></section>}
      <Links graph={graph} node={node} onGo={onGo} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={concepts} onAction={onAction}/>
    </div>
    <AskBox graph={graph} node={node} onGo={onGo}/>
  </div>;
}
