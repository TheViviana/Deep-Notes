import React, {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {seedIdeas, seedDrafts, seedReadings, seedArchives, snapshot, concepts as CONCEPTS, notes as SEED_NOTES} from '../data';
import {useWorks, seedWorks, monthWorks, normalizeWork, nowStamp, toInputDateTime, fromInputDateTime, parseTags} from './worksStore';
import {pickVaultFolder, parseVault} from './importer';
import {capable, getRoot, setRoot, queueSync, flush, chooseDir, readVaultFiles, prepareCopy, resolveRels, setErrorHandler} from './fileStore';
import {CONFIG, asset} from '../config';
import {buildGraph, forceLayout, stats, KINDS, CONTENT} from './graph';
import {renderMarkdown} from './ArticleView';
import {Home} from './Home';
import {Library, Drafts, Ideas, Methods, Readings, Archives} from './pages';
import {Intro} from './Intro';
import {Count} from './Analysis';
import {Icon} from './icons';
import {PluginList, useNetwork, usePlugins, TocPanel, parseOutline} from './plugins';
import {isTranslatable, translateText} from './translate';
import {aiRuntime, AiFab} from './ai';
import {T} from './theme';
import './neural.css';

// 选题、草稿与目标保存在当前浏览器（localStorage）。
function useSaved(key, fallback) {
  const [v, set] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }, [key, v]);
  return [v, set];
}

function Modal({title, en, onClose, children, wide}) {
  const ref = useRef(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus({preventScroll: true});
    const key = e => {
      if (e.key === 'Escape' && !e.isComposing) closeRef.current();
      if (e.key === 'Tab') {
        const list = [...ref.current.querySelectorAll('button,input,textarea,select,a[href]')].filter(n => !n.disabled);
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (before?.isConnected) before.focus({preventScroll: true}); };
  }, []);
  return <div className="veil" onClick={onClose}>
    <section ref={ref} tabIndex={-1} className={`modal glass ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <header><h2>{title} <em>{en}</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" size={16}/></button></header>
      {children}
    </section>
  </div>;
}

// 「阅读全文」弹窗：默认渲染成阅读视图（双链可点击跳转），右上角可切回 Markdown 原文查看符号。
// 大纲目录（toc 插件开启时）悬浮在右侧：点击滚动到对应标题。
// 沉浸式翻译（immersive 插件 + 顶栏联网开关，二者都打开才发请求）与文章预览同一套交互。
function ReadFull({r, graph, onClose, onGo}) {
  const [src, setSrc] = useState(false);
  const box = useRef(null);
  const {disabled} = usePlugins();
  const net = useNetwork().on;
  const immersive = !disabled.includes('immersive'); // 与其他位置一致：大纲目录由 toc 插件开关控制
  const tocOn = !disabled.includes('toc');
  const [trans, setTrans] = useState({phase: 'idle', done: 0, total: 0}); // idle | running | done
  const [hint, setHint] = useState('');
  useEffect(() => { setTrans({phase: 'idle', done: 0, total: 0}); setHint(''); }, [src, r]);
  const outline = useMemo(() => src || !tocOn ? [] : parseOutline(r.body), [src, tocOn, r.body]);
  const jumpHead = line => {
    if (!box.current) return;
    const list = box.current.querySelectorAll('h1,h2,h3,h4');
    const idx = outline.findIndex(h => h.line === line);
    if (idx >= 0 && list[idx]) list[idx].scrollIntoView({block: 'start'});
  };
  const html = useMemo(() => renderMarkdown(r.body), [r.body]);
  const byName = useMemo(() => {
    const m = new Map();
    for (const n of graph.nodes) {
      if (!CONTENT.has(n.kind)) continue;
      m.set(String(n.title).toLowerCase(), n.id);
      if (n.path) m.set(n.path.split('/').pop().replace(/\.md$/, '').toLowerCase(), n.id);
    }
    return m;
  }, [graph]);
  const jump = e => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    const id = byName.get((a.dataset.target || '').toLowerCase());
    if (id) onGo(id);
  };
  const runTranslate = async () => {
    if (!net) { setHint('先打开顶栏联网开关 · Turn on the network switch in the top bar first'); return; }
    const root = box.current;
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
    box.current?.querySelectorAll('.md-trans').forEach(s => s.remove());
    setTrans({phase: 'idle', done: 0, total: 0});
    setHint('');
  };
  return <Modal title={r.short || r.title} en={KINDS[r.kind].en} onClose={onClose} wide>
    <div className="reader">
      <div className="reader-bar">
        <p className="quiet">{r.path || KINDS[r.kind].label}{hint ? ` · ${hint}` : ''}</p>
        {!src && immersive && <button className="pill ghost av-trans" onClick={trans.phase === 'running' ? undefined : trans.phase === 'done' ? restoreTrans : runTranslate}
          disabled={trans.phase === 'running'} aria-label="沉浸式翻译 Immersive translate">
          {trans.phase === 'running' ? `翻译中 ${trans.done}/${trans.total}` : trans.phase === 'done' ? '收起译文 Restore' : '沉浸翻译 Translate'}
        </button>}
        <button className="pill ghost" onClick={() => setSrc(v => !v)}>
          {src ? <>阅读模式 <em>Rendered</em></> : <>查看原文 <em>Source</em></>}
        </button>
      </div>
      {src ? <pre>{r.body}</pre>
        : <article ref={box} className="md-preview" onClick={jump} dangerouslySetInnerHTML={{__html: html}}/>}
      {!src && tocOn && outline.length > 0 && <TocPanel outline={outline} cur={-1} jump={jumpHead}/>}
    </div>
  </Modal>;
}

const navs = [['home', '工作台', 'Workspace'], ['library', '作品库', 'Works'], ['methods', '方法库', 'Methods'], ['drafts', '创作台', 'Drafts'], ['ideas', '选题池', 'Ideas'], ['readings', '阅读区', 'Readings'], ['archives', '档案区', 'Archives']];
// 移动目标的模块名（toast 与弹窗共用）
const MOVE_ZH = {works: '作品库', methods: '方法库', drafts: '创作台', ideas: '选题池', readings: '阅读区', archives: '档案区'};
const MOVE_EN = {works: 'Works', methods: 'Methods', drafts: 'Drafts', ideas: 'Ideas', readings: 'Readings', archives: 'Archives'};
// 各类内容的常驻模块（移动弹窗里禁用当前所在项）
const HOME_OF = {post: 'works', note: 'methods', draft: 'drafts', idea: 'ideas', reading: 'readings', archive: 'archives'};
const initialPage = () => { const h = location.hash.slice(1); return navs.some(n => n[0] === h) ? h : 'home'; };

// 联网开关：默认断网；打开后仅「沉浸式翻译」插件会访问翻译服务，其余功能依然全本地。
function NetSwitch() {
  const {on, toggle} = useNetwork();
  return <button className={`net-switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={toggle}
    title={on ? '联网已开启：仅沉浸式翻译插件会访问翻译服务 · Network on (translation only)'
      : '断网模式：所有数据不出本机 · Network off, local only'}
    aria-label={on ? '关闭联网，回到全本地模式 Network off' : '打开联网，允许翻译插件访问翻译服务 Network on'}>
    <i aria-hidden="true"/>{on ? '联网' : '断网'} <em>{on ? 'Online' : 'Offline'}</em>
  </button>;
}

// 知识库快照：文章数、笔记数、全库总字数、双链与概念数量，配合内容总览表。
// 「总字数」统计全部内容（文章 + 笔记 + 草稿），导入笔记后也会随之变化。
function Snapshot({goal, onGoal, ideas, drafts, works, notes, onIdea, onDraft, onLibrary, snap, graph}) {
  const allChars = [...works, ...notes, ...drafts].reduce((s, p) => s + (p.body || '').length, 0);
  const links = graph.links.filter(l => l.kind === 'wiki').length;
  const conceptCount = graph.nodes.filter(n => n.kind === 'concept').length;
  const stats4 = [['文章', 'Articles', works.length], ['笔记', 'Notes', notes.length], ['总字数', 'Words', allChars], ['双链', 'Wikilinks', links]];
  const max = Math.max(0, ...works.map(p => (p.body || '').length));
  const linksOf = id => graph.links.reduce((s, l) => s + (l.kind === 'wiki' && (l.s === 'post:' + id || l.t === 'post:' + id) ? 1 : 0), 0);
  const monthPosts = monthWorks(works);
  return <section className="snapshot" aria-label="知识库数据快照">
    <div className="snapshot-head"><p className="eyebrow">SNAPSHOT <span>知识库快照</span></p><p className="quiet">{snap.source} · {snap.capturedAt} <em>Local only</em></p></div>
    <div className="kpi-band glass">{stats4.map(([zh, en, v]) => <div key={zh}><span>{zh} <em>{en}</em></span><strong><Count value={v}/></strong></div>)}</div>
    <div className="snapshot-grid">
      <section className="glass card perf">
        <header><h2>内容总览 <em>Content</em></h2><button className="text-btn" onClick={onLibrary}>全部文章 <em>All articles</em><Icon name="arrow" size={14}/></button></header>
        <table><thead><tr><th>文章 <em>Article</em></th><th>字数 <em>Words</em></th><th>双链 <em>Links</em></th><th>更新 <em>Updated</em></th></tr></thead>
          <tbody>{[...works].sort((a, b) => (b.updatedAt || b.date).localeCompare(a.updatedAt || a.date)).slice(0, 6).map(p => <tr key={p.id} onClick={() => onLibrary(p.id)}><td><span className="t-title">{p.title}</span><span className="t-bar"><i style={{'--w': (p.body || '').length / (max || 1)}}/></span></td><td>{(p.body || '').length.toLocaleString('zh-CN')}</td><td>{linksOf(p.id)}</td><td>{(p.updatedAt || p.date || '').slice(0, 10)}</td></tr>)}</tbody></table>
        {!works.length && <p className="quiet">还没有文章，去作品库新建或导入知识库 <em>No articles yet</em></p>}
        {works.length > 0 && <p className="quiet">最近 6 篇 · 共 {works.length} 篇 · 按最近更新排序 <em>Latest 6 of {works.length}</em></p>}
      </section>
      <section className="glass card plan">
        <header><h2>写作计划 <em>Plan</em></h2></header>
        <div className="plan-body">
          <button className="ring" onClick={onGoal} aria-label={`修改目标，本月 ${monthPosts.length} 篇，目标 ${goal} 篇`}>
            <svg viewBox="0 0 180 180"><defs><linearGradient id="ring-g" x1="0" x2="1"><stop offset="0" stopColor={T.ring[0]}/><stop offset="1" stopColor={T.ring[1]}/></linearGradient></defs><circle cx="90" cy="90" r="72" className="track"/><circle cx="90" cy="90" r="72" className="value" strokeDasharray={`${Math.min(monthPosts.length / goal, 1) * 452.39} 452.39`}/></svg>
            <span><strong>{monthPosts.length}</strong>/{goal}<small>本月目标 Goal</small></span>
          </button>
          <div className="plan-ideas"><h3>下一篇写什么 <em>Up next</em></h3>{ideas.slice(0, 3).map((idea, i) => <button key={idea.id} onClick={() => onIdea(idea)}><b>{i + 1}</b><span>{idea.title}</span></button>)}</div>
        </div>
        <button className="plan-draft" onClick={() => onDraft(drafts[0]?.id)}><Icon name="draft" size={15}/>继续创作 <em>Continue</em><span>{drafts[0]?.title || '开始第一篇草稿'}</span><Icon name="arrow" size={15}/></button>
      </section>
    </div>
  </section>;
}

function App() {
  const [page, setPage] = useState(initialPage);
  const [goal, setGoal] = useSaved(CONFIG.storagePrefix + '-goal-v1', 8);
  const [works, setWorks] = useWorks();
  const [wsName, setWsName] = useSaved(CONFIG.storagePrefix + '-workspace-v1', CONFIG.workspace);
  const [ideas, setIdeas] = useSaved(CONFIG.storagePrefix + '-ideas-v1', seedIdeas);
  const [drafts, setDrafts] = useSaved(CONFIG.storagePrefix + '-drafts-v1', seedDrafts);
  const [snap, setSnap] = useSaved(CONFIG.storagePrefix + '-snapshot-v1', snapshot);
  const [kbConcepts, setKbConcepts] = useSaved(CONFIG.storagePrefix + '-concepts-v1', CONCEPTS);
  const [notes, setNotes] = useSaved(CONFIG.storagePrefix + '-notes-v1', SEED_NOTES);
  const [readings, setReadings] = useSaved(CONFIG.storagePrefix + '-readings-v1', seedReadings);
  const [archives, setArchives] = useSaved(CONFIG.storagePrefix + '-archives-v1', seedArchives);
  // 方法库二级分类：path 第二段推导 + 手动新建的空分类（-folders-v1 只存空分类，导入/切回示例时清空）
  const [folders, setFolders] = useSaved(CONFIG.storagePrefix + '-folders-v1', []);
  // 阅读区左侧分类：reading.folder 推导 + 手动新建的空分类（-read-folders-v1 只存空分类，导入/切回示例时清空）
  const [readFolders, setReadFolders] = useSaved(CONFIG.storagePrefix + '-read-folders-v1', []);
  // 方法库列表拖拽中的内容（分类间平移 + 拖到顶栏导航跨模块移动）
  const [dragging, setDragging] = useState(null);
  const [dragNav, setDragNav] = useState(null);
  const [methSel, setMethSel] = useState(null);
  const [active, setActive] = useState(() => drafts[0]?.id);
  const [focus, setFocus] = useState({mod: null, sel: null});
  const [libSel, setLibSel] = useState(works[1]?.id ?? works[0]?.id);
  const [openArticle, setOpenArticle] = useState(null);
  const [readSel, setReadSel] = useState(null);
  const [readOpen, setReadOpen] = useState(null);
  const [arcSel, setArcSel] = useState(null);
  const [arcOpen, setArcOpen] = useState(null);
  const [editingWork, setEditingWork] = useState(null);
  const [workIsNew, setWorkIsNew] = useState(false);
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [goalInput, setGoalInput] = useState(String(goal));
  const [toast, setToast] = useState('');
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const slowWorks = useDeferredValue(works);
  const slowDrafts = useDeferredValue(drafts);
  const graph = useMemo(() => buildGraph({works: slowWorks, notes, ideas, drafts: slowDrafts, readings, archives, concepts: kbConcepts}), [slowWorks, notes, ideas, slowDrafts, readings, archives, kbConcepts]);
  const layout = useMemo(() => forceLayout(graph), [graph]);

  useEffect(() => { history.replaceState(null, '', page === 'home' ? location.pathname : '#' + page); window.scrollTo({top: 0}); }, [page]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); }, [toast]);

  // —— 桌面版文件夹知识库：内容变化全局 diff 后写回 .md（导入时已在原库旁建好副本并 setRoot） ——
  // 不侵入各处 CRUD：每次渲染对比上一份快照，新增/修改 → 写文件，删除 → 移入 .trash。
  const prevContent = useRef(null);
  useEffect(() => {
    const cur = {works, notes, drafts, readings, archives};
    const prev = prevContent.current;
    prevContent.current = cur;
    if (!capable() || !getRoot()) return;
    if (!prev) return; // 首次渲染只记录快照；导入流程会主动全量写入
    for (const kind of ['works', 'notes', 'drafts', 'readings', 'archives']) {
      const pv = prev[kind], cv = cur[kind];
      const pmap = new Map(pv.map(x => [x.id, x]));
      const cmap = new Map(cv.map(x => [x.id, x]));
      const removed = pv.filter(x => !cmap.has(x.id));
      const relMap = resolveRels(kind, [...cv, ...removed]); // 同名标题消歧，旧条目也参与算旧路径
      for (const x of cv) queueSync(kind, x, pmap.get(x.id) || null, relMap);
      for (const x of removed) queueSync(kind, null, x, relMap);
    }
  }, [works, notes, drafts, readings]);
  // 写盘失败提示（权限不足 / 磁盘满等）；队列由 flush 触发，这里只负责把错误带给用户
  useEffect(() => {
    setErrorHandler(failed => setToast(`知识库写盘失败（${failed.length} 个文件），内容仍保存在浏览器 · Disk write failed`));
    return () => setErrorHandler(null);
  }, []);
  // 退出前尽力把防抖队列写完（800ms 内关闭窗口的场景）
  useEffect(() => {
    if (!capable()) return;
    const bye = () => { flush(); };
    window.addEventListener('beforeunload', bye);
    return () => window.removeEventListener('beforeunload', bye);
  }, []);

  const close = useCallback(() => setModal(null), []);
  function newDraft(title = '未命名草稿', body = '', source) {
    const id = 'draft-' + Date.now();
    setDrafts(d => [{id, title, body, source}, ...d]);
    setActive(id); setPage('drafts'); setModal(null);
    setToast('草稿已创建，只保存在此浏览器 · Draft saved locally');
  }
  function editIdea(idea) { setEditing({...idea}); setModal('idea'); }
  function saveIdea() {
    if (!editing.title.trim()) return;
    setIdeas(ideas.some(i => i.id === editing.id) ? ideas.map(i => i.id === editing.id ? editing : i) : [...ideas, editing]);
    setModal(null); setToast('选题已保存 · Idea saved');
  }
  function deleteIdea(id) {
    const it = ideas.find(x => x.id === id);
    if (!window.confirm(`删除选题「${it?.title || '未命名选题'}」？此操作只影响当前浏览器。`)) return;
    setIdeas(ideas.filter(x => x.id !== id));
    setModal(null); setToast('选题已删除 · Idea deleted');
  }
  function toDraft(idea) {
    const existing = drafts.find(d => d.source === idea.id);
    if (existing) { setActive(existing.id); setPage('drafts'); setModal(null); setToast('已打开关联草稿 · Linked draft opened'); return; }
    // 转草稿后选题自动移出选题池：草稿的 source 仍记录来源，可从草稿分析栏跳回查看
    setIdeas(is => is.filter(x => String(x.id) !== String(idea.id)));
    newDraft(idea.title, `【根据选题创建的写作提纲，未调用 AI】\n\n创作方向：${idea.note}\n\n开场：\n\n核心观点：\n\n操作示例：\n\n结尾：`, idea.id);
    setToast('已转为草稿，选题已移出选题池 · Drafted, idea removed');
  }
  function deleteDraft(id) {
    const d = drafts.find(x => x.id === id);
    if (!window.confirm(`删除草稿「${d?.title || '未命名草稿'}」？此操作只影响当前浏览器。`)) return;
    const rest = drafts.filter(x => x.id !== id);
    setDrafts(rest); setActive(rest[0]?.id); setToast('草稿已删除 · Draft deleted');
  }
  // —— 方法笔记 CRUD：重命名同步 path 文件名；新建/删除都只影响本浏览器 ——
  function updateNote(id, patch) {
    setNotes(ns => ns.map(n => {
      if (n.id !== id) return n;
      const next = {...n, ...patch};
      if (patch.title != null) {
        const safe = (patch.title.trim() || '未命名').replace(/[/\\]/g, '·').slice(0, 60);
        next.path = String(n.path || '').replace(/[^/]+\.md$/, `${safe}.md`);
      }
      return next;
    }));
  }
  function addNote() {
    const id = 'note-' + Date.now();
    const t = '新建方法笔记';
    setNotes(ns => [{id, title: t, path: `05-方法库 methods/新建/${t}.md`, body: `# ${t}\n\n`}, ...ns]);
    setMethSel(id); setPage('methods');
    setToast('方法笔记已创建，保存在此浏览器 · Note created');
  }
  function deleteNote(id) {
    const n = notes.find(x => x.id === id);
    if (!window.confirm(`删除方法笔记「${n?.title || '未命名'}」？此操作只影响当前浏览器。`)) return;
    const rest = notes.filter(x => x.id !== id);
    setNotes(rest);
    setMethSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
    setToast('方法笔记已删除 · Note deleted');
  }
  // —— 方法库二级分类：拖拽/下拉只改 path 第二段，id 不变，选中态与编辑器原地保持（无刷新） ——
  // 桌面版由全局 diff 自动「旧路径移入 .trash + 新路径写盘」（vault:write 自带建目录）。
  const TRASH_FOLDER = '未分类'; // 删除非空分类时的兜底去处
  const subOf = n => (n.path || '').split('/')[1] || '笔记';
  const notePathIn = (n, folder) => {
    const parts = String(n.path || '').split('/');
    if (parts.length < 3) return `05-方法库 methods/${folder}/${(n.title || '未命名').replace(/[/\\]/g, '·').slice(0, 60)}.md`;
    parts[1] = folder;
    return parts.join('/');
  };
  function moveNoteToFolder(id, folder) {
    if (!folder) return;
    const n = notes.find(x => x.id === id);
    if (!n || subOf(n) === folder) return; // 同分类重复投放：原地不动
    setNotes(ns => ns.map(x => x.id === id ? {...x, path: notePathIn(x, folder)} : x));
    setToast(`已移入「${folder}」 · Moved to ${folder}`);
  }
  function createFolder(name) {
    const t = String(name || '').trim().replace(/[/\\]/g, '·').slice(0, 24);
    if (!t) return;
    setFolders(fs => fs.includes(t) ? fs : [...fs, t]);
    setToast(`分类「${t}」已创建 · Folder created`);
  }
  function renameFolder(from, name) {
    const t = String(name || '').trim().replace(/[/\\]/g, '·').slice(0, 24);
    if (!t || t === from) return;
    setNotes(ns => ns.map(n => subOf(n) === from ? {...n, path: notePathIn(n, t)} : n));
    setFolders(fs => fs.map(f => f === from ? t : f));
    setToast(`分类已重命名为「${t}」 · Folder renamed`);
  }
  function deleteFolder(name) {
    if (name === TRASH_FOLDER) { setToast('「未分类」是兜底分类，不能删除 · Keep "未分类"'); return; }
    const count = notes.filter(n => subOf(n) === name).length;
    const ok = count
      ? window.confirm(`删除分类「${name}」？其中 ${count} 篇笔记将移入「${TRASH_FOLDER}」。`)
      : window.confirm(`删除空分类「${name}」？`);
    if (!ok) return;
    setNotes(ns => ns.map(n => subOf(n) === name ? {...n, path: notePathIn(n, TRASH_FOLDER)} : n));
    setFolders(fs => fs.filter(f => f !== name));
    setToast(`分类「${name}」已删除 · Folder deleted`);
  }
  // —— 阅读区 CRUD：收藏别人写好的内容，可批注编辑；标题/作者/来源/日期 ——
  function newReading() {
    const id = 'reading-' + Date.now();
    setReadings(rs => [{id, title: '新建阅读', author: '', source: '', date: nowStamp().slice(0, 10), body: ''}, ...rs]);
    setReadSel(id); setReadOpen(id); setPage('readings');
    setToast('阅读条目已创建，粘贴或写入正文 · Reading created');
  }
  function updateReading(id, patch) {
    setReadings(rs => rs.map(r => r.id === id ? {...r, ...patch, updatedAt: nowStamp()} : r));
  }
  function deleteReading(id) {
    const r = readings.find(x => x.id === id);
    if (!window.confirm(`删除阅读「${r?.title || '未命名阅读'}」？正文与批注会一起删除，此操作只影响当前浏览器。`)) return;
    const rest = readings.filter(x => x.id !== id);
    setReadings(rest);
    setReadSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
    setReadOpen(o => o === id ? null : o);
    setToast('阅读条目已删除 · Reading deleted');
  }
  // —— 阅读区左侧分类：拖拽/下拉只改 folder 字段，id 不变，选中态原地保持（无刷新） ——
  const READ_TRASH_FOLDER = '未分类'; // 删除非空分类时的兜底去处
  const readFolderOf = r => r.folder || READ_TRASH_FOLDER;
  function moveReadingToFolder(id, folder) {
    if (!folder) return;
    const r = readings.find(x => x.id === id);
    if (!r || readFolderOf(r) === folder) return; // 同分类重复投放：原地不动
    setReadings(rs => rs.map(x => x.id === id ? {...x, folder} : x));
    setToast(`已移入「${folder}」 · Moved to ${folder}`);
  }
  function createReadingFolder(name) {
    const t = String(name || '').trim().replace(/[/\\]/g, '·').slice(0, 24);
    if (!t) return;
    setReadFolders(fs => fs.includes(t) ? fs : [...fs, t]);
    setToast(`分类「${t}」已创建 · Folder created`);
  }
  function renameReadingFolder(from, name) {
    const t = String(name || '').trim().replace(/[/\\]/g, '·').slice(0, 24);
    if (!t || t === from) return;
    setReadings(rs => rs.map(r => readFolderOf(r) === from ? {...r, folder: t} : r));
    setReadFolders(fs => fs.map(f => f === from ? t : f));
    setToast(`分类已重命名为「${t}」 · Folder renamed`);
  }
  function deleteReadingFolder(name) {
    if (name === READ_TRASH_FOLDER) { setToast('「未分类」是兜底分类，不能删除 · Keep "未分类"'); return; }
    const count = readings.filter(r => readFolderOf(r) === name).length;
    const ok = count
      ? window.confirm(`删除分类「${name}」？其中 ${count} 篇阅读将移入「${READ_TRASH_FOLDER}」。`)
      : window.confirm(`删除空分类「${name}」？`);
    if (!ok) return;
    setReadings(rs => rs.map(r => readFolderOf(r) === name ? {...r, folder: READ_TRASH_FOLDER} : r));
    setReadFolders(fs => fs.filter(f => f !== name));
    setToast(`分类「${name}」已删除 · Folder deleted`);
  }
  // —— 档案区 CRUD：创作者自己的个人档案（简介、回顾、清单等），同样参与双链与图谱 ——
  function newArchive() {
    const id = 'archive-' + Date.now();
    setArchives(as => [{id, title: '新建档案', date: nowStamp().slice(0, 10), body: ''}, ...as]);
    setArcSel(id); setArcOpen(id); setPage('archives');
    setToast('档案已创建，写入你的个人内容 · Archive created');
  }
  function updateArchive(id, patch) {
    setArchives(as => as.map(a => a.id === id ? {...a, ...patch, updatedAt: nowStamp()} : a));
  }
  function deleteArchive(id) {
    const a = archives.find(x => x.id === id);
    if (!window.confirm(`删除档案「${a?.title || '未命名档案'}」？正文会一起删除，此操作只影响当前浏览器。`)) return;
    const rest = archives.filter(x => x.id !== id);
    setArchives(rest);
    setArcSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
    setArcOpen(o => o === id ? null : o);
    setToast('档案已删除 · Archive deleted');
  }
  // —— 跨模块移动：文章 / 笔记 / 草稿 / 选题 / 阅读 / 档案 六类内容互通，标题与正文一起带走，可随时移回 ——
  // id 可能带图谱前缀（如 'note:xxx'，来自分析栏的节点），也可能是原始 id，统一剥掉前缀再查找
  function moveContent(fromKind, rawId, toKind) {
    if (fromKind === toKind) return;
    const raw = String(rawId || '');
    const id = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const stamp = nowStamp();
    let moved = null;
    if (fromKind === 'post') {
      const w = works.find(x => x.id === id); if (!w) return;
      moved = {title: w.title, body: w.body || '', tags: w.tags || []};
      setWorks(ws => ws.filter(x => x.id !== id));
    } else if (fromKind === 'note') {
      const n = notes.find(x => x.id === id); if (!n) return;
      moved = {title: n.title, body: n.body || ''};
      setNotes(ns => ns.filter(x => x.id !== id));
    } else if (fromKind === 'draft') {
      const d = drafts.find(x => x.id === id); if (!d) return;
      moved = {title: d.title, body: d.body || ''};
      setDrafts(ds => { const rest = ds.filter(x => x.id !== id); setActive(a => a === id ? rest[0]?.id : a); return rest; });
    } else if (fromKind === 'reading') {
      const r = readings.find(x => x.id === id); if (!r) return;
      moved = {title: r.title, body: r.body || ''};
      setReadings(rs => { const rest = rs.filter(x => x.id !== id); setReadOpen(o => o === id ? null : o); return rest; });
    } else if (fromKind === 'archive') {
      const a = archives.find(x => x.id === id); if (!a) return;
      moved = {title: a.title, body: a.body || ''};
      setArchives(as => { const rest = as.filter(x => x.id !== id); setArcOpen(o => o === id ? null : o); return rest; });
    } else if (fromKind === 'idea') {
      const it = ideas.find(x => String(x.id) === String(id)); if (!it) return;
      moved = {title: it.title, body: it.note || ''};
      setIdeas(is => is.filter(x => String(x.id) !== String(id)));
    }
    if (!moved) return;
    if (toKind === 'works') setWorks(ws => [normalizeWork({...moved, date: stamp, tags: moved.tags || []}), ...ws]);
    else if (toKind === 'methods') setNotes(ns => [{id: 'note-' + Date.now(), title: moved.title, path: `05-方法库 methods/新建/${moved.title}.md`, body: moved.body}, ...ns]);
    else if (toKind === 'drafts') setDrafts(ds => [{id: 'draft-' + Date.now(), title: moved.title, body: moved.body, source: null}, ...ds]);
    else if (toKind === 'ideas') setIdeas(is => [...is, {id: Math.max(0, ...is.map(x => Number(x.id) || 0)) + 1, title: moved.title, platform: '', priority: '中', status: '待写', note: moved.body.slice(0, 120)}]);
    else if (toKind === 'readings') setReadings(rs => [{id: 'reading-' + Date.now(), title: moved.title, author: '', source: '', date: stamp.slice(0, 10), body: moved.body}, ...rs]);
    else if (toKind === 'archives') setArchives(as => [{id: 'archive-' + Date.now(), title: moved.title, date: stamp.slice(0, 10), body: moved.body}, ...as]);
    setModal(null);
    setToast(`已移动到${MOVE_ZH[toKind]} · Moved to ${MOVE_EN[toKind]}`);
  }
  // —— 文章 CRUD：主信息 = 标题、发布日期、研究方向、标签；编辑日期自动记录 ——
  function newWork(title = '未命名文章') {
    const w = normalizeWork({title, date: nowStamp(), tags: [], body: ''});
    setWorks(ws => [w, ...ws]);
    setLibSel(w.id); setPage('library'); setOpenArticle(null);
    setEditingWork(w); setWorkIsNew(true); setModal('work');
    setToast('文章已创建，保存在此浏览器 · Article created locally');
  }
  function updateWork(id, patch) {
    setWorks(ws => ws.map(w => w.id === id ? {...w, ...patch, updatedAt: nowStamp()} : w));
  }
  function saveWork() {
    if (!editingWork?.title.trim()) return;
    setWorks(ws => ws.map(w => w.id === editingWork.id ? normalizeWork({...editingWork, updatedAt: nowStamp()}) : w));
    setModal(null); setToast('文章信息已保存 · Article info saved');
  }
  function deleteWork(id) {
    const w = works.find(x => x.id === id);
    if (!window.confirm(`删除文章「${w?.title || '未命名文章'}」？正文与主信息会一起删除，此操作只影响当前浏览器。`)) return;
    const rest = works.filter(x => x.id !== id);
    setWorks(rest);
    setLibSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
    setOpenArticle(a => a === id ? null : a);
    setModal(null); setToast('文章已删除 · Article deleted');
  }
  const onAction = useCallback(a => {
    if (a.type === 'page') { if (a.page === 'library') setLibSel(a.id); if (a.page === 'methods') setMethSel(String(a.id || '').replace(/^note:/, '')); if (a.page === 'drafts') setActive(a.id); setPage(a.page); }
    if (a.type === 'read') setModal({read: graph.index.get(a.id)});
    if (a.type === 'move') setModal({move: {kind: a.kind, id: a.id}});
    if (a.type === 'editIdea') editIdea(a.idea);
    if (a.type === 'ideaToDraft') toDraft(a.idea);
    if (a.type === 'openArticle') { setLibSel(a.id); setOpenArticle(a.id); if (page !== 'library') setPage('library'); }
    if (a.type === 'openReading') { setReadSel(a.id); setReadOpen(a.id); if (page !== 'readings') setPage('readings'); }
    if (a.type === 'openArchive') { setArcSel(a.id); setArcOpen(a.id); if (page !== 'archives') setPage('archives'); }
    if (a.type === 'editWork') { const w = works.find(x => x.id === a.id); if (w) { setEditingWork(w); setWorkIsNew(false); setModal('work'); } }
    // 未创建的 [[双链]] 一键创建：文章走「编辑信息」弹窗，方法笔记就地新建并跳到方法库
    if (a.type === 'newFromGhost') {
      const t = String(a.title || '').trim();
      if (!t) return;
      if (a.kind === 'note') {
        const id = 'note-' + Date.now();
        const safe = t.replace(/[/\\]/g, '·');
        setNotes(ns => [{id, title: t, path: `05-方法库 methods/新建/${safe}.md`, body: `# ${t}\n`}, ...ns]);
        setFocus({mod: 'methods', sel: 'note:' + id}); setPage('home');
        setToast('方法笔记已创建，双链已接通 · Note created');
      } else {
        newWork(t);
      }
    }
  }, [graph, drafts, ideas, works, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // —— 右栏编辑：双向链接直接改写正文，笔记标题与概念词表就地更新，全部落在本浏览器 ——
  function onBody(kind, gid, body) {
    if (kind === 'post') updateWork(gid.slice(5), {body});
    else if (kind === 'note') setNotes(ns => ns.map(n => 'note:' + n.id === gid ? {...n, body} : n));
    else if (kind === 'draft') setDrafts(ds => ds.map(d => 'draft:' + d.id === gid ? {...d, body} : d));
  }
  function onNoteTitle(gid, title) {
    const t = title.trim().replace(/[/\\]/g, '·'); // 文件名安全化，与 updateNote 一致
    if (!t) return;
    setNotes(ns => ns.map(n => 'note:' + n.id === gid ? {...n, title: t, path: n.path.replace(/[^/]+$/, t + '.md')} : n));
    setToast('笔记标题已更新 · Note renamed');
  }
  function onConcept(name, patch) {
    setKbConcepts(list => {
      if (patch.delete) return list.filter(([n]) => n !== name);
      return list.map(([n, kws]) => n === name ? [patch.name?.trim() || n, patch.keywords ?? kws] : [n, kws]);
    });
    setToast(patch.delete ? '概念已删除 · Concept removed' : '概念词表已更新 · Concept updated');
  }

  // —— AI 助手文件工具：全部走现有 store（localStorage），图谱随数据自动重建 ——
  const aiList = () => [
    ...works.map(w => ({id: 'post:' + w.id, kind: 'post', title: w.title, chars: (w.body || '').length})),
    ...drafts.map(d => ({id: 'draft:' + d.id, kind: 'draft', title: d.title, chars: (d.body || '').length})),
    ...notes.map(n => ({id: 'note:' + n.id, kind: 'note', title: n.title, chars: (n.body || '').length})),
  ];
  const aiRead = gid => {
    const [kind, id] = String(gid).split(':');
    if (kind === 'post') { const w = works.find(x => x.id === id); return w && {id: gid, kind: 'post', title: w.title, tags: w.tags, body: w.body}; }
    if (kind === 'draft') { const d = drafts.find(x => x.id === id); return d && {id: gid, kind: 'draft', title: d.title, body: d.body}; }
    if (kind === 'note') { const n = notes.find(x => x.id === id); return n && {id: gid, kind: 'note', title: n.title, path: n.path, body: n.body}; }
    return null;
  };
  const aiSearch = q => {
    const k = String(q || '').toLowerCase();
    return aiList().filter(f => String(f.title || '').toLowerCase().includes(k))
      .map(f => ({...f, snippet: (aiRead(f.id)?.body || '').slice(0, 200)}));
  };
  const aiCreate = (kind, {title, body = '', tags}) => {
    const t = String(title || '').trim() || '未命名';
    if (kind === 'post') {
      const w = normalizeWork({title: t, date: nowStamp(), tags: Array.isArray(tags) ? tags : [], body});
      setWorks(ws => [w, ...ws]); setToast(`AI 新建了文章「${t}」 · AI created a post`);
      return {id: 'post:' + w.id, title: t};
    }
    if (kind === 'note') {
      const id = 'note-' + Date.now(); const safe = t.replace(/[/\\]/g, '·');
      setNotes(ns => [{id, title: t, path: `05-方法库 methods/AI/${safe}.md`, body: body || `# ${t}\n`}, ...ns]);
      setToast(`AI 新建了方法笔记「${t}」 · AI created a note`);
      return {id: 'note:' + id, title: t};
    }
    const id = 'draft-' + Date.now();
    setDrafts(ds => [{id, title: t, body}, ...ds]);
    setToast(`AI 新建了草稿「${t}」 · AI created a draft`);
    return {id: 'draft:' + id, title: t};
  };
  const aiUpdate = (gid, {title, body}) => {
    const [kind, id] = String(gid).split(':');
    const patch = {};
    if (title !== undefined) patch.title = String(title);
    if (body !== undefined) patch.body = String(body);
    if (kind === 'post') { if (!works.some(x => x.id === id)) return {error: '找不到文件'}; updateWork(id, patch); return {ok: true, title: patch.title}; }
    if (kind === 'draft') {
      if (!drafts.some(x => x.id === id)) return {error: '找不到文件'};
      setDrafts(ds => ds.map(x => x.id === id ? {...x, ...patch} : x));
      return {ok: true, title: patch.title};
    }
    if (kind === 'note') {
      const n = notes.find(x => x.id === id); if (!n) return {error: '找不到文件'};
      const safeTitle = patch.title ? patch.title.trim().replace(/[/\\]/g, '·') : patch.title; // 文件名安全化
      setNotes(ns => ns.map(x => x.id === id ? {...x, ...patch, ...(safeTitle ? {path: x.path.replace(/[^/]+$/, safeTitle + '.md')} : {})} : x));
      return {ok: true, title: patch.title};
    }
    return {error: '未知类型 ' + kind};
  };
  const aiRemove = gid => {
    const [kind, id] = String(gid).split(':');
    const t = aiRead(gid)?.title || gid;
    if (!window.confirm(`AI 请求删除「${t}」，确认删除？此操作只影响当前浏览器。`)) return {ok: false, title: t, cancelled: true};
    if (kind === 'post') { deleteWork(id); return {ok: true, title: t}; }
    if (kind === 'draft') { const rest = drafts.filter(x => x.id !== id); setDrafts(rest); setActive(a => a === id ? rest[0]?.id : a); return {ok: true, title: t}; }
    if (kind === 'note') { setNotes(ns => ns.filter(x => x.id !== id)); return {ok: true, title: t}; }
    return {error: '未知类型 ' + kind};
  };
  const aiContext = () => {
    if (page === 'drafts') { const d = drafts.find(x => x.id === active) || drafts[0]; return {page: '创作台 Drafts', title: d?.title, excerpt: (d?.body || '').slice(0, 1000)}; }
    if (page === 'library') { const w = works.find(x => x.id === (openArticle || libSel)); return {page: '作品库 Works', title: w?.title, excerpt: (w?.body || '').slice(0, 1000)}; }
    const sel = focus?.sel && graph.index.get(focus.sel);
    return {page: '工作台 Workspace', title: sel?.title, excerpt: ''};
  };
  useEffect(() => {
    aiRuntime.ops = {list: aiList, read: aiRead, search: aiSearch, create: aiCreate, update: aiUpdate, remove: aiRemove};
    aiRuntime.getContext = aiContext;
  }); // 每次渲染同步最新数据引用，AI 工具永远读到当前状态

  // —— 知识库导入：软件内选文件夹解析 Markdown，替换当前数据（同样只存本浏览器） ——
  function adoptData(data, msg) {
    setWorks(data.works); setNotes(data.notes ?? SEED_NOTES); setIdeas(data.ideas); setDrafts(data.drafts);
    setReadings(data.readings ?? seedReadings);
    setArchives(data.archives ?? seedArchives);
    setSnap(data.snapshot); setKbConcepts(data.concepts); setFolders([]); setReadFolders([]);
    setLibSel(data.works[0]?.id ?? null); setActive(data.drafts[0]?.id);
    setReadSel(null); setReadOpen(null); setArcSel(null); setArcOpen(null);
    setFocus({mod: null, sel: null}); setOpenArticle(null); setPage('home');
    setModal(null); setToast(msg);
  }
  async function importVault(target = 'auto') {
    setModal(null);
    // 桌面版经主进程选目录读文件；网页版走浏览器目录选择器。两种来源都转成同一套 File 列表解析。
    let files, srcDir = null;
    if (capable()) {
      srcDir = await chooseDir();
      if (!srcDir) return;
      try { files = readVaultFiles(srcDir, await window.deepnotes.vault.read(srcDir)); }
      catch { setToast('读取文件夹失败 · Failed to read folder'); return; }
    } else {
      files = await pickVaultFolder();
      if (!files) return;
    }
    let data;
    try { data = await parseVault(files, target); } catch { setToast('解析失败，请确认选择的是 Markdown 文件夹 · Parse failed'); return; }
    if (!data.counts.all) { setToast('所选文件夹里没有 Markdown 笔记 · No markdown notes'); return; }
    const extra = Object.entries(data.truncated).filter(([, n]) => n).map(([k, n]) => ({files: '文件', works: '文章', notes: '笔记', readings: '阅读', archives: '档案'}[k] + ` 截断 ${n}`)).join('、');
    const where = target === 'auto'
      ? `文章 ${data.counts.works}、方法笔记 ${data.counts.notes}、选题 ${data.counts.ideas}、草稿 ${data.counts.drafts}、阅读 ${data.counts.readings || 0}、档案 ${data.counts.archives || 0}`
      : `全部 ${data.counts.all} 个文件将作为「${{works: '作品库', methods: '方法库', ideas: '选题池', drafts: '创作台', readings: '阅读区', archives: '档案区'}[target]}」的内容导入`;
    const srcName = srcDir ? srcDir.replace(/\/+$/, '').split('/').pop() : data.vault;
    const desktopNote = srcDir ? `\n\n桌面版会在「${srcName}」旁新建「${srcName} - Deep Notes」副本作为你的知识库文件夹（副本初始为空，导入完成后按结果生成 .md）：之后的编辑会实时写回副本，原文件夹内容保持不变。` : '';
    const ok = window.confirm(`将从「${srcName}」导入：${where}${extra ? '（' + extra + '）' : ''}。${desktopNote}\n\n这会替换当前浏览器里的全部文章、选题和草稿，确定继续吗？`);
    if (!ok) return;
    let copyDir = null;
    if (srcDir) {
      const copy = await prepareCopy(srcDir);
      if (copy?.ok) { await setRoot(copy.dir); copyDir = copy.dir; } // await：先把旧队列写进旧库再换根目录
      else { await setRoot(null); setToast('无法创建知识库副本，本次导入只保存在浏览器 · Copy failed'); }
    }
    adoptData(data, `已导入知识库：文章 ${data.counts.works} · 笔记 ${data.counts.notes} · 选题 ${data.counts.ideas} · 草稿 ${data.counts.drafts}${data.counts.readings ? ` · 阅读 ${data.counts.readings}` : ''}${data.counts.archives ? ` · 档案 ${data.counts.archives}` : ''}${copyDir ? ` · 已写入「${copyDir.replace(/\/+$/, '').split('/').pop()}」` : ''}`);
  }
  async function resetToSample() {
    if (!window.confirm('切回虚构示例数据？当前浏览器里的文章、选题和草稿会被清空替换。')) return;
    await setRoot(null); // 桌面版停用文件夹写回（先把待写队列写进旧库）；盘上已有的知识库副本原样保留
    adoptData({works: seedWorks(), notes: SEED_NOTES, ideas: seedIdeas, drafts: seedDrafts, readings: seedReadings, archives: seedArchives, snapshot, concepts: CONCEPTS}, '已切回示例数据 · Sample data restored');
  }

  const openInGraph = id => { const n = graph.index.get(id); const mod = {post: 'works', note: 'methods', idea: 'ideas', draft: 'drafts', reading: 'readings', archive: 'archives', concept: 'concepts'}[n?.kind]; if (mod) { setFocus({mod, sel: id}); setPage('home'); } };
  const s = stats(graph);

  return <div className={`neural page-${page}`}>
    <header className="topbar">
      <a className="brand" href={asset('')} onClick={e => { e.preventDefault(); setPage('home'); setFocus({mod: null, sel: null}); }}>
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 28" width="18" height="21"><path fill={T.logo[0]} d="m14 1 8 7-2 12-7 7-10-5L1 12 8 4Z"/><path fill={T.logo[1]} d="m14 1-3 10 2 16 7-7 2-12Z"/><path fill={T.logo[2]} d="m14 1-3 10 11-3Z"/><path fill={T.logo[3]} d="m1 12 10-1 2 16-10-5Z"/></svg></span>
        <span className="brand-text">{CONFIG.brand.name} <b>/ {CONFIG.brand.sub}</b><small>{CONFIG.brand.tagline} · {CONFIG.brand.taglineEn}</small></span>
      </a>
      <nav aria-label="主导航">{navs.map(([id, zh, en]) => {
        // 跨模块拖拽：方法库笔记 / 阅读区条目可直接拖到导航按钮上移动到对应模块（复用 moveContent，会换 id）
        const PAGE_KIND = {library: 'works', methods: 'methods', drafts: 'drafts', ideas: 'ideas', readings: 'readings', archives: 'archives'};
        const toKind = PAGE_KIND[id];
        const droppable = !!dragging && toKind && (dragging.kind === 'note' || dragging.kind === 'reading' || dragging.kind === 'archive') && HOME_OF[dragging.kind] !== toKind;
        return <button key={id} className={`${page === id ? 'active' : ''}${dragNav === id ? ' drop-target' : ''}`}
          aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}
          onDragOver={e => { if (!droppable) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragNav(id); }}
          onDragLeave={() => setDragNav(n => n === id ? null : n)}
          onDrop={e => {
            if (!droppable) return;
            e.preventDefault(); setDragNav(null);
            const d = dragging; setDragging(null);
            moveContent(d.kind, d.id, toKind);
            setPage(id); // 落到哪个模块就过去看，投放反馈更直观
          }}>
          {zh}<em>{en}</em>
        </button>;
      })}</nav>
      <div className="top-actions">
        <button className="pill primary" onClick={() => newDraft()}><Icon name="plus" size={14}/>新建草稿 <em>New</em></button>
        <NetSwitch/>
        <button className="icon-btn" onClick={() => setModal('plugins')} title="插件管理 Plug-ins" aria-label="插件管理 Plug-ins"><Icon name="spark" size={15}/></button>
        <button className="avatar" onClick={() => setModal('about')} aria-label="知识库信息与数据来源"><img src={asset(CONFIG.avatar)} alt=""/></button>
      </div>
    </header>

    <main>
      {page === 'home' && <>
        <Home graph={graph} layout={layout} focus={focus} setFocus={setFocus} onAction={onAction} onAbout={() => setModal('about')} reduced={reduced} name={wsName} onRename={setWsName} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={kbConcepts}/>
        <Snapshot goal={goal} onGoal={() => { setGoalInput(String(goal)); setModal('goal'); }} ideas={ideas} drafts={drafts} works={works} notes={notes} onIdea={editIdea} onDraft={id => { setActive(id); setPage('drafts'); }} onLibrary={id => { if (typeof id === 'string') setLibSel(id); setPage('library'); }} snap={snap} graph={graph}/>
      </>}
      {page === 'library' && <Library graph={graph} works={works} selected={libSel} setSelected={setLibSel} openArticle={openArticle} setOpenArticle={setOpenArticle} onNewWork={newWork} onUpdateWork={updateWork} onDeleteWork={deleteWork} onGo={openInGraph} onAction={onAction} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={kbConcepts}/>}
      {page === 'methods' && <Methods graph={graph} notes={notes} setNotes={setNotes} selected={methSel} setSelected={setMethSel} onGo={openInGraph} onNew={addNote} onDelete={deleteNote} onUpdate={updateNote} onMove={id => setModal({move: {kind: 'note', id}})} folders={folders} dragging={dragging} setDragging={setDragging} onMoveToFolder={moveNoteToFolder} onCreateFolder={createFolder} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder}/>}
      {page === 'drafts' && <Drafts graph={graph} drafts={drafts} setDrafts={setDrafts} active={active} setActive={setActive} onNew={() => newDraft()} onDelete={deleteDraft} onGo={openInGraph} works={works} notes={notes} onMove={id => setModal({move: {kind: 'draft', id}})}/>}
      {page === 'ideas' && <Ideas graph={graph} ideas={ideas} onEdit={editIdea} onGraph={openInGraph} onNew={() => editIdea({id: Math.max(0, ...ideas.map(i => i.id)) + 1, title: '', platform: '小红书', priority: '中', status: '待写', note: ''})}/>}
      {page === 'readings' && <Readings graph={graph} readings={readings} selected={readSel} setSelected={setReadSel} openReading={readOpen} setOpenReading={setReadOpen} onGo={openInGraph} onAction={onAction} onNew={newReading} onUpdate={updateReading} onDelete={deleteReading} readFolders={readFolders} dragging={dragging} setDragging={setDragging} onMoveToFolder={moveReadingToFolder} onCreateFolder={createReadingFolder} onRenameFolder={renameReadingFolder} onDeleteFolder={deleteReadingFolder}/>}
      {page === 'archives' && <Archives graph={graph} archives={archives} selected={arcSel} setSelected={setArcSel} openArchive={arcOpen} setOpenArchive={setArcOpen} onGo={openInGraph} onAction={onAction} onNew={newArchive} onUpdate={updateArchive} onDelete={deleteArchive}/>}
    </main>

    <footer className="site-foot">
      <button onClick={() => setModal('about')}><Icon name="info" size={13}/>{snap.source === '导入自本地笔记' ? `当前展示导入的本地知识库（${snap.capturedAt} 导入）` : '当前展示的是虚构示例数据，可在「关于」里导入你的知识库'} <em>{snap.source === '导入自本地笔记' ? 'Imported vault' : 'Sample data'}</em></button>
      <span>{CONFIG.footer.zh}<em>{CONFIG.footer.en}</em></span>
    </footer>

    {toast && <div className="toast glass" role="status"><Icon name="check" size={15}/>{toast}</div>}
    {/* AI 助手浮动入口：工作台已有 dock 常驻对话，其余页面用右下角按钮唤起同一个会话 */}
    {page !== 'home' && <AiFab/>}

    {modal === 'about' && <Modal title="关于这份数据" en="About the data" onClose={close}>
      <div className="about">
        <div className="form-actions">
          <button className="pill primary" onClick={() => setModal('import')}><Icon name="file" size={14}/>导入知识库文件夹 <em>Import vault</em></button>
          <button className="pill ghost" onClick={resetToSample}>切回示例数据 <em>Reset</em></button>
        </div>
        <p>知识库 <em>Vault</em>：<strong>{snap.account}</strong> · 导入日期 <em>Imported</em>：{snap.capturedAt}</p>
        <p>数据来源 <em>Source</em>：{snap.source}{snap.publishedFrom ? `；内容时间跨度 ${snap.publishedFrom} — ${snap.publishedTo}` : ''}。</p>
        {capable() && getRoot() && <p>文件夹知识库 <em>Vault folder</em>：<code>{getRoot()}</code><br/>编辑会实时写回此文件夹里的 .md 文件，被删除的内容移入 <code>.trash</code>；网页版则只保存在浏览器里。</p>}
        <hr/>
        <h3>图谱怎么来的 <em>How the graph is built</em></h3>
        <p>{snap.source === '导入自本地笔记' ? '全部由导入的本地笔记在浏览器中推导，不读取选择范围之外的文件：' : <>全部由 <code>src/data/sample.js</code> 里的资料在浏览器中推导，不读取外部 Obsidian 仓库：</>}</p>
        <ul>
          <li><b>[[双链]] Wikilinks</b>：文章、方法笔记与草稿正文中的双链；找不到对应笔记的记为「未创建」。</li>
          <li><b>话题 Topics</b>：文章正文里的 # 话题标签。</li>
          <li><b>正文提及 Mentions</b>：内容中出现概念词（导入时自动从重复出现的话题里提取），且至少两条内容提及才成为概念节点。</li>
          <li><b>双向共振 Resonance</b>：两条内容共同提及 ≥2 个概念，或选题与草稿互相记录。</li>
          <li><b>选题来源 Source</b>：草稿记录来源选题；选题状态为「已转草稿」时反向成立。</li>
        </ul>
        <p>作品库：{works.length} 篇文章<b>保存在此浏览器</b>{capable() && getRoot() ? '，并实时写回上面的知识库文件夹' : ''}，可自由新建、编辑、删除；导入知识库会整体替换，命令行导入（npm run import）仍然可用。</p>
        <p>当前：{s.content} 条内容 · {s.links} 条连接 · {s.mutual} 组双向 · {s.ghosts} 个未创建双链。</p>
        <p className="quiet">图谱分析是本地规则检索，未调用 AI。选题、草稿与目标保存在当前浏览器，不写入 Obsidian、不发布到平台。<em>Local rules only · no AI · nothing is published.</em></p>
      </div>
    </Modal>}
    {/* 导入去向选择：自动按文件夹分类，或全部归入指定模块；选定后再挑文件夹 */}
    {modal === 'import' && <Modal title="导入知识库" en="Import vault" onClose={close}>
      <div className="about import-pick">
        <p>先选这批笔记导入到哪里，再挑选一个 Markdown 文件夹（如 Obsidian 仓库）。导入会替换当前浏览器里的全部文章、选题和草稿。<em>Pick where the notes go, then choose a Markdown folder. Importing replaces all current content.</em></p>
        <div className="form-actions import-targets">
          <button className="pill primary" onClick={() => importVault('auto')}><Icon name="spark" size={14}/>按文件夹自动分类 <em>Auto by folder</em></button>
          <button className="pill" onClick={() => importVault('works')}><Icon name="works" size={14}/>全部到作品库 <em>As works</em></button>
          <button className="pill" onClick={() => importVault('methods')}><Icon name="methods" size={14}/>全部到方法库 <em>As notes</em></button>
          <button className="pill" onClick={() => importVault('ideas')}><Icon name="idea" size={14}/>全部到选题池 <em>As ideas</em></button>
          <button className="pill" onClick={() => importVault('drafts')}><Icon name="draft" size={14}/>全部到创作台 <em>As drafts</em></button>
          <button className="pill" onClick={() => importVault('readings')}><Icon name="book" size={14}/>全部到阅读区 <em>As readings</em></button>
          <button className="pill" onClick={() => importVault('archives')}><Icon name="archive" size={14}/>全部到档案区 <em>As archives</em></button>
        </div>
        <p className="quiet">「按文件夹自动分类」会根据文件夹名识别（作品 / 草稿 / 选题 / 方法），识别不了的一律放进方法库。<em>Unrecognized folders go to Methods.</em></p>
      </div>
    </Modal>}
    {modal === 'goal' && <Modal title="本月写作目标" en="Monthly goal" onClose={close}>
      <form className="form" onSubmit={e => { e.preventDefault(); const n = Number(goalInput); if (Number.isInteger(n) && n >= 1 && n <= 100) { setGoal(n); setModal(null); setToast('写作目标已更新 · Goal updated'); } }}>
        <p className="quiet">本月已新建 {monthPosts.length} 篇。目标只保存在当前浏览器。</p>
        <label>目标篇数 <em>Target</em><input autoFocus type="number" min="1" max="100" step="1" required value={goalInput} onChange={e => setGoalInput(e.target.value)}/></label>
        <div className="form-actions"><button type="button" className="pill ghost" onClick={close}>取消 <em>Cancel</em></button><button className="pill primary">保存目标 <em>Save</em></button></div>
      </form>
    </Modal>}
    {modal === 'idea' && editing && <Modal title="选题详情" en="Idea" onClose={close}>
      <div className="form">
        <p className="quiet">编辑后保存在此浏览器 <em>Saved locally</em></p>
        <label>选题标题 <em>Title</em><input autoFocus value={editing.title} onChange={e => setEditing({...editing, title: e.target.value})}/></label>
        <div className="form-row">
          <label>平台 <em>Platform</em><input value={editing.platform ?? ''} onChange={e => setEditing({...editing, platform: e.target.value})} placeholder="如：小红书"/></label>
          <label>优先级 <em>Priority</em><select value={editing.priority} onChange={e => setEditing({...editing, priority: e.target.value})}><option>高</option><option>中</option><option>低</option></select></label>
          <label>状态 <em>Status</em><select value={editing.status} onChange={e => setEditing({...editing, status: e.target.value})}><option>待写</option><option>待扩展</option><option>已转草稿</option></select></label>
        </div>
        <label>创作备注 <em>Brief</em><textarea value={editing.note} onChange={e => setEditing({...editing, note: e.target.value})}/></label>
        <div className="form-actions">
          <button className="pill ghost danger" onClick={() => deleteIdea(editing.id)}><Icon name="trash" size={14}/>删除 <em>Delete</em></button>
          <button className="pill ghost" disabled={!editing.title.trim()} onClick={saveIdea}>保存选题 <em>Save</em></button>
          <button className="pill primary" disabled={!editing.title.trim()} onClick={() => toDraft(editing)}><Icon name="draft" size={14}/>{drafts.some(d => d.source === editing.id) ? '打开关联草稿' : '转为草稿'} <em>{drafts.some(d => d.source === editing.id) ? 'Open draft' : 'To draft'}</em></button>
        </div>
        <p className="quiet">转为草稿只生成本地写作提纲，不模拟 AI 生成结果。</p>
      </div>
    </Modal>}
    {modal === 'work' && editingWork && (() => {
      const wikiLinks = graph.links.filter(l => l.kind === 'wiki' && l.s === 'post:' + editingWork.id).map(l => graph.index.get(l.t));
      // 数据指标手动编辑：数量留空按 0 记；时长（秒）留空表示无数据（null），与导入数据字段口径一致
      const num = (k, nullable) => e => {
        const v = e.target.value;
        setEditingWork({...editingWork, [k]: v === '' ? (nullable ? null : 0) : Number(v)});
      };
      return <Modal title={workIsNew ? '新建文章信息' : '编辑文章信息'} en="Article info" wide onClose={close}>
        <div className="form">
          <p className="quiet">标题、日期、研究方向与标签构成主信息；双链由正文 [[ ]] 推导，编辑日期保存时自动记录 <em>Main info · auto-dated</em></p>
          <label>标题 <em>Title</em><input autoFocus value={editingWork.title} onChange={e => setEditingWork({...editingWork, title: e.target.value})} placeholder="给文章一个标题"/></label>
          <div className="form-row">
            <label>发布日期 <em>Date</em><input type="datetime-local" value={toInputDateTime(editingWork.date)} onChange={e => setEditingWork({...editingWork, date: fromInputDateTime(e.target.value) || editingWork.date})}/></label>
            <label>研究方向 <em>Direction</em><input value={editingWork.direction} onChange={e => setEditingWork({...editingWork, direction: e.target.value})} placeholder="如：图谱可视化"/></label>
          </div>
          <label>标签 <em>Tags</em><input value={editingWork.tags.join(', ')} onChange={e => setEditingWork({...editingWork, tags: parseTags(e.target.value)})} placeholder="用逗号或顿号分隔，可带 #"/></label>
          <div className="form-row">
            <label>媒体 <em>Media</em><select value={editingWork.media || ''} onChange={e => setEditingWork({...editingWork, media: e.target.value || null})}>
              <option value="">图文 · Images</option><option value="images">图文 · Images</option><option value="video">视频 · Video</option>
            </select></label>
          </div>
          <p className="quiet">数据指标可随时手动修正，作品库与分析栏以这里为准；数量留空按 0 记，时长留空表示无数据 <em>Metrics · editable</em></p>
          <div className="form-metrics">
            <label>浏览 <em>Views</em><input type="number" min="0" value={editingWork.views ?? ''} onChange={num('views')}/></label>
            <label>点赞 <em>Likes</em><input type="number" min="0" value={editingWork.likes ?? ''} onChange={num('likes')}/></label>
            <label>评论 <em>Comments</em><input type="number" min="0" value={editingWork.comments ?? ''} onChange={num('comments')}/></label>
            <label>收藏 <em>Saves</em><input type="number" min="0" value={editingWork.saves ?? ''} onChange={num('saves')}/></label>
            <label>转发 <em>Shares</em><input type="number" min="0" value={editingWork.shares ?? ''} onChange={num('shares')}/></label>
            <label>涨粉 <em>Follows</em><input type="number" min="0" value={editingWork.follows ?? ''} onChange={num('follows')}/></label>
            <label>曝光 <em>Impressions</em><input type="number" min="0" value={editingWork.impressions ?? ''} onChange={num('impressions')}/></label>
            <label>点击率 <em>CTR</em><input type="number" min="0" step="0.001" value={editingWork.ctr ?? ''} onChange={num('ctr')}/></label>
            <label>时长·秒 <em>Duration</em><input type="number" min="0" value={editingWork.duration ?? ''} onChange={num('duration', true)}/></label>
          </div>
          <label>双链（来自正文） <em>Wikilinks from body</em></label>
          {wikiLinks.length ? <div className="chip-row">{wikiLinks.map(n => n && <span key={n.id} className={`chip static ${n.kind === 'ghost' ? 'ghost' : ''}`} style={{'--kc': KINDS[n.kind].color}}>{n.short || n.title}</span>)}</div>
            : <p className="quiet">正文还没有 [[双链]]。保存后点「打开文章」，在正文里输入 [[ 即可链接其他文章或笔记。</p>}
          <div className="form-actions">
            {!workIsNew && <button className="pill ghost danger" onClick={() => deleteWork(editingWork.id)}><Icon name="trash" size={14}/>删除 <em>Delete</em></button>}
            <button className="pill primary" disabled={!editingWork.title.trim()} onClick={saveWork}>保存 <em>Save</em></button>
          </div>
        </div>
      </Modal>;
    })()}
    {modal === 'plugins' && <Modal title="插件管理" en="Plug-ins" onClose={close}>
      <PluginList/>
    </Modal>}
    {modal?.read && <ReadFull r={modal.read} graph={graph} onClose={close} onGo={openInGraph}/>}
    {/* 跨模块移动：把文章 / 笔记 / 草稿 / 选题 移到另一个模块，标题正文一起带走 */}
    {modal?.move && (() => {
      const {kind, id} = modal.move, cur = HOME_OF[kind];
      return <Modal title="移动到" en="Move to" onClose={close}>
        <div className="about import-pick">
          <p>把这篇内容移到另一个模块，标题和正文一起带走，随时可以再移回来。<em>Move this item to another module — you can move it back anytime.</em></p>
          <div className="form-actions import-targets">
            {Object.entries(MOVE_ZH).map(([k, zh]) =>
              <button key={k} className="pill" disabled={k === cur} onClick={() => moveContent(kind, id, k)}>
                <Icon name={{works: 'works', methods: 'methods', drafts: 'draft', ideas: 'idea', readings: 'book', archives: 'archive'}[k]} size={14}/>{zh} <em>{MOVE_EN[k]}</em>
              </button>)}
          </div>
          <p className="quiet">当前所在：{MOVE_ZH[cur]}。<em>Currently in {MOVE_EN[cur]}.</em></p>
        </div>
      </Modal>;
    })()}
  </div>;
}

createRoot(document.getElementById('root')).render(<><Intro/><App/></>);
