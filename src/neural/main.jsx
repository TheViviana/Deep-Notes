import React, {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {seedIdeas, seedDrafts, seedReadings, seedArchives, snapshot, concepts as CONCEPTS, notes as SEED_NOTES} from '../data';
import {useWorks, seedWorks, monthWorks, normalizeWork, nowStamp, toInputDateTime, fromInputDateTime, parseTags} from './worksStore';
import {pickVaultFolder, pickMdFiles, parseVault} from './importer';
import {capable, getRoot, setRoot, getTarget, setTarget, queueSync, flush, flushSyncNow, chooseDir, readVaultFiles, prepareCopy, resolveRels, setErrorHandler, serialize, exportFiles, shortId, pathOf, hasPendingWrites, retryPending, clearPendingWrites, pendingReady} from './fileStore';
import {CONFIG, asset} from '../config';
import {buildGraph, forceLayout, stats, KINDS, CONTENT} from './graph';
import {renderMarkdown} from './ArticleView';
import {Home} from './Home';
import {Library, Drafts, Ideas, Methods, Readings, Archives, Concepts} from './pages';
import {Intro} from './Intro';
import {Count} from './Analysis';
import {Icon} from './icons';
import {PluginList, useNetwork, usePlugins, TocPanel, parseOutline} from './plugins';
import {isTranslatable, translateText} from './translate';
import {aiRuntime, AiFab} from './ai';
import {CommandPalette} from './CommandPalette';
import {conceptExtras} from './conceptStore';
import {useVaultImages, resolveAllInDoc} from './images';
import {resolveTarget, scrollToAnchor} from './wiki';
import {T} from './theme';
import './neural.css';

// 选题、草稿与目标保存在当前浏览器（localStorage）。
// 写入防抖：打字等高频变更若每次都同步序列化全量数据（大库 + 粘贴图后可达数 MB）会卡顿，
// 静默 300ms 后再写，UI 保持跟手；窗口关闭前的最后一次输入由 flushPendingSaves 同步补写。
// 防抖窗口内的待写数据登记进 pendingSaves，写失败不再静默（全局提示条 + console 留痕可排查）。
const pendingSaves = new Map(); // key -> 防抖窗口内尚未落盘的值
const STORAGE_ERR = '本地存储写入失败（空间可能已满），近期修改也许没有保存 · localStorage write failed';
// —— localStorage 水位检测与写满降级（审计 H2）——
// 配额各浏览器不同（一般 5–10MB），按多数下限保守估成 5MB 字符数。全量快照（-data-backup-v1）
// 是唯一可牺牲的写入：空间紧张时先停快照、清快照腾位保正文——正文键是数据本体，永远优先。
const BACKUP_KEY = CONFIG.storagePrefix + '-data-backup-v1';
const STORAGE_LIMIT = 5 * 1024 * 1024;
let storageStrapped = false; // 降级标记：true = 已触发写满降级，本轮会话暂停快照写入
let snapshotSkipped = false; // 水位预检跳过快照只提示一次，不反复打扰
function storageUsage() {
  let n = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + (localStorage.getItem(k) || '').length; } } catch {}
  return n;
}
// 带降级的统一写入：写满先清全量快照腾位重试一次（快照可由下次成功保存重建，正文不可丢）；
// 再失败说明连正文都放不下了，提示用户尽快导出备份。返回是否成功。
function trySaveLocal(key, val) {
  try { localStorage.setItem(key, val); return true; }
  catch (err) {
    console.warn('localStorage 写入失败 · Save failed:', key, err);
    try { localStorage.removeItem(BACKUP_KEY); } catch {}
    try {
      localStorage.setItem(key, val);
      if (!storageStrapped) { storageStrapped = true; showGlobalNotice('本地存储空间已满：数据快照已暂停以保证正文保存，建议 ⌘K「导出全部 Markdown」尽快备份 · Storage full'); }
      return true;
    } catch (err2) {
      storageStrapped = true;
      showGlobalNotice(STORAGE_ERR + '，建议 ⌘K「导出全部 Markdown」尽快备份 · Export backup advised');
      return false;
    }
  }
}
function flushPendingSaves() {
  for (const [key, v] of pendingSaves) trySaveLocal(key, JSON.stringify(v));
  pendingSaves.clear();
}
function useSaved(key, fallback) {
  const [v, set] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } });
  useEffect(() => {
    pendingSaves.set(key, v);
    const t = setTimeout(() => {
      pendingSaves.delete(key);
      trySaveLocal(key, JSON.stringify(v));
    }, 300);
    return () => clearTimeout(t);
  }, [key, v]);
  return [v, set];
}

// —— 全局提示条（非 React，挂在 body 上）：localStorage 写失败 / 未捕获异常等
// 不该再只进 console——用户必须能看到「东西可能没存上」。同类提示 10s 内只出现一次。 ——
let noticeEl = null, noticeTimer = null, lastNoticeAt = 0;
function showGlobalNotice(msg) {
  const now = Date.now();
  if (noticeEl?.style.display !== 'none' && now - lastNoticeAt < 10000) return;
  lastNoticeAt = now;
  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.setAttribute('role', 'alert');
    noticeEl.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;'
      + 'max-width:min(92vw,640px);padding:10px 14px;border-radius:10px;background:#2b2620;color:#f0e6d2;'
      + 'border:1px solid #6b5a3e;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.45);display:flex;gap:10px;align-items:center;';
    document.body.appendChild(noticeEl);
  }
  noticeEl.style.display = 'flex';
  const text = document.createElement('span');
  text.textContent = msg;
  const reload = document.createElement('button');
  reload.textContent = '重新加载 Reload';
  reload.style.cssText = 'flex:none;padding:3px 10px;border-radius:7px;border:1px solid #8a7a58;background:transparent;color:#f0e6d2;cursor:pointer;font-size:12px;';
  reload.onclick = () => location.reload();
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭提示 Close notice');
  close.style.cssText = 'flex:none;padding:2px 8px;border:none;background:transparent;color:#bfae8e;cursor:pointer;font-size:15px;';
  close.onclick = () => { noticeEl.style.display = 'none'; };
  noticeEl.replaceChildren(text, reload, close);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.style.display = 'none'; }, 30000);
}
window.addEventListener('error', () => showGlobalNotice('页面出现异常，建议重新加载 · Unexpected error, reload recommended'));
window.addEventListener('unhandledrejection', () => showGlobalNotice('页面出现异常，建议重新加载 · Unexpected error, reload recommended'));

// —— 渲染层兜底：任何组件抛错都不再白屏，给出错误摘要与重载入口（数据都在本机，重载即恢复） ——
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = {error: null}; }
  static getDerivedStateFromError(error) { return {error}; }
  componentDidCatch(error) { console.warn('界面异常已兜底 · Render error:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div role="alert" style={{minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 14, background: '#141414', color: '#e8e2d4', textAlign: 'center',
      fontFamily: '-apple-system, "PingFang SC", sans-serif', padding: 24}}>
      <h1 style={{fontSize: 20, margin: 0, fontWeight: 600}}>界面出现异常 · Something went wrong</h1>
      <p style={{maxWidth: 560, margin: 0, opacity: .75, fontSize: 13, lineHeight: 1.7, wordBreak: 'break-all'}}>
        {String(this.state.error?.message || this.state.error)}
        <br/>你的数据仍安全保存在本机（浏览器与知识库文件夹），重新加载即可继续使用。
        <br/><em>Your data stays safe on this machine. Reload to continue.</em>
      </p>
      <button onClick={() => location.reload()} style={{padding: '8px 22px', borderRadius: 999,
        border: '1px solid #6b5a3e', background: 'transparent', color: '#e8b45a', cursor: 'pointer', fontSize: 14}}>
        重新加载 Reload
      </button>
    </div>;
  }
}
// 删除确认的落地说明：桌面版连着知识库时删除会写盘（移入 .trash，30 天后自动清掉），网页版只动浏览器数据
const deleteScopeNote = () => capable() && getRoot()
  ? '桌面版会同步把该文件移入知识库的 .trash（30 天后自动清理）。'
  : '此操作只影响当前浏览器。';

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

// —— 导出 PDF：把正文排成打印版 HTML 塞进隐藏 iframe，调起系统打印（目标选「另存为 PDF」）。
// 全程本地渲染，不新增联网出口；Electron 桌面版与浏览器通用 ——
function printArticle({title, meta, html}) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const iframe = document.createElement('iframe');
  // 审计 M4：禁脚本沙箱——iframe 只承担排版打印，不执行任何 JS；同源访问保留给
  // doc.write 与 resolveAllInDoc（引用图解析），allow-modals 放行 win.print() 调系统打印
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>'
    + 'body{font:13px/1.9 -apple-system,"PingFang SC","Segoe UI",sans-serif;color:#222;max-width:700px;margin:0 auto;padding:36px 20px;}'
    + 'h1{font-size:22px;margin:0 0 4px;}.meta{color:#888;font-size:11px;margin-bottom:22px;}'
    + '.md h1,.md h2,.md h3,.md h4{margin:1.4em 0 .5em;line-height:1.4;}.md h1{font-size:19px;}.md h2{font-size:16.5px;}.md h3{font-size:15px;}'
    + '.md p{margin:.6em 0;}.md ul,.md ol{margin:.6em 0;padding-left:1.5em;}'
    + '.md blockquote{margin:.8em 0;padding:2px 14px;border-left:3px solid #bbb;color:#555;}'
    + '.md pre{background:#f5f5f2;padding:10px 12px;border-radius:6px;overflow:auto;font-size:12px;}'
    + '.md code{background:#f5f5f2;padding:1px 4px;border-radius:3px;font-size:12px;}.md pre code{padding:0;background:none;}'
    + '.md pre i,.md code i{font-style:normal;}'
    + '.md a{color:#4a6fa5;text-decoration:none;}.md img{max-width:100%;}'
    + '.md table{border-collapse:collapse;}.md th,.md td{border:1px solid #ccc;padding:4px 8px;}'
    + '.md hr{border:0;border-top:1px solid #ddd;margin:1.4em 0;}'
    + '</style></head><body><h1>' + esc(title) + '</h1><p class="meta">' + esc(meta) + ' · Deep Notes</p><div class="md">' + html + '</div></body></html>');
  doc.close();
  const win = iframe.contentWindow;
  let done = false;
  const cleanup = () => { if (done) return; done = true; setTimeout(() => iframe.remove(), 100); };
  win.onafterprint = cleanup;
  // 知识库引用图先解析完（vault:asset 读文件转 dataURL）再排版打印
  (resolveAllInDoc(doc).catch(() => {})).then(() => {
    win.focus(); win.print(); setTimeout(cleanup, 60000); // 60s 兜底回收
  });
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
    // 块引用 [[笔记#小节]]：目标是当前这篇时滚动到对应小节，否则跳到目标内容
    const {id, anchor} = resolveTarget(byName, a.dataset.target);
    if (!id) return;
    if (anchor && id === r.id) { scrollToAnchor(box.current, anchor); return; }
    onGo(id);
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
// 初始页面取自 URL hash；概念网络不在 navs（顶栏独立入口）但同样是合法页面
const PAGES = [...navs.map(n => n[0]), 'concepts'];
const initialPage = () => { const h = location.hash.slice(1); return PAGES.includes(h) ? h : 'home'; };

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
  // 知识库引用图（![[名字]] / 相对路径）：所有 .md-preview 里新出现的 <img> 自动经 vault:asset 回填
  useVaultImages();
  const [page, setPage] = useState(initialPage);
  const [goal, setGoal] = useSaved(CONFIG.storagePrefix + '-goal-v1', 8);
  const [works, setWorks] = useWorks();
  const [wsName, setWsName] = useSaved(CONFIG.storagePrefix + '-workspace-v1', CONFIG.workspace);
  const [ideas, setIdeas] = useSaved(CONFIG.storagePrefix + '-ideas-v1', seedIdeas);
  const [drafts, setDrafts] = useSaved(CONFIG.storagePrefix + '-drafts-v1', seedDrafts);
  const [snap, setSnap] = useSaved(CONFIG.storagePrefix + '-snapshot-v1', snapshot);
  const [kbConcepts, setKbConcepts] = useSaved(CONFIG.storagePrefix + '-concepts-v1', CONCEPTS);
  const [notes, setNotes] = useSaved(CONFIG.storagePrefix + '-notes-v1', SEED_NOTES);
  const [inbox, setInbox] = useSaved(CONFIG.storagePrefix + '-inbox-v1', []); // 闪念箱：随手记的想法
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
  // 目标弹窗（点写作计划圆环打开）也要显示本月篇数；Snapshot 内的同名变量作用域不覆盖这里
  const monthPosts = useMemo(() => monthWorks(works), [works]);
  const [toast, setToast] = useState('');
  const [palette, setPalette] = useState(false); // ⌘K 全局命令面板
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  // 手动概念关键词（概念内页编辑）并入词表：与导入概念按名字合并去重，随图谱一起参与正文提及匹配
  const extras = conceptExtras.use();
  const mergedConcepts = useMemo(() => kbConcepts.map(([n, terms]) => {
    const t = extras[n]?.terms;
    return t?.length ? [n, [...new Set([...(terms || []), ...t])]] : [n, terms || []];
  }), [kbConcepts, extras]);
  const slowWorks = useDeferredValue(works);
  const slowDrafts = useDeferredValue(drafts);
  const graph = useMemo(() => buildGraph({works: slowWorks, notes, ideas, drafts: slowDrafts, readings, archives, concepts: mergedConcepts}), [slowWorks, notes, ideas, slowDrafts, readings, archives, mergedConcepts]);
  const layout = useMemo(() => forceLayout(graph), [graph]);

  useEffect(() => { history.replaceState(null, '', page === 'home' ? location.pathname : '#' + page); window.scrollTo({top: 0}); }, [page]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); }, [toast]);
  // ⌘K / Ctrl+K 呼出全局命令面板（输入框聚焦时同样生效，浏览器默认行为已阻止）
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // —— 桌面版文件夹知识库：内容变化全局 diff 后写回 .md（导入时已在原库旁建好副本并 setRoot） ——
  // 不侵入各处 CRUD：每次渲染对比上一份快照，新增/修改 → 写文件，删除 → 移入 .trash。
  const prevContent = useRef(null);
  useEffect(() => {
    const cur = {works, notes, drafts, readings, archives, ideas};
    const prev = prevContent.current;
    prevContent.current = cur;
    if (!capable() || !getRoot()) return;
    if (!prev) return; // 首次渲染只记录快照；导入流程会主动全量写入
    for (const kind of ['works', 'notes', 'drafts', 'readings', 'archives', 'ideas']) {
      const pv = prev[kind], cv = cur[kind];
      const pmap = new Map(pv.map(x => [x.id, x]));
      const cmap = new Map(cv.map(x => [x.id, x]));
      const removed = pv.filter(x => !cmap.has(x.id));
      // 新路径按新数组、旧路径按旧数组分别消歧：同名标题的消歧短码跟内容绑定，
      // 混用会算错旧文件位置——删除/重命名时错删同名文件、留下真孤儿
      const relMap = resolveRels(kind, cv);
      const oldRelMap = resolveRels(kind, pv);
      const newRelSet = new Set(relMap.values());
      for (const x of cv) queueSync(kind, x, pmap.get(x.id) || null, relMap, oldRelMap);
      for (const x of removed) {
        // 路径被新内容接管（重导入后下标式 id 整体移位、同位置换了主人）时不进 .trash，
        // 由接管者直接覆写——否则每次重导入都整库「先 trash 再重写」，是之前丢笔记的根因
        if (newRelSet.has(oldRelMap.get(x.id))) continue;
        queueSync(kind, null, x, relMap, oldRelMap);
      }
    }
  }, [works, notes, drafts, readings, archives, ideas]);
  // 写盘失败提示（权限不足 / 磁盘满等）；队列由 flush 触发，这里只负责把错误带给用户
  useEffect(() => {
    setErrorHandler(failed => setToast(`知识库写盘失败（${failed.length} 个文件），内容仍保存在浏览器 · Disk write failed`));
    return () => setErrorHandler(null);
  }, []);
  // 退出前尽力把防抖队列写完（800ms 内关闭窗口的场景）：localStorage 与知识库写盘都走同步通道——
  // beforeunload 里异步 IPC 可能页面先卸载根本发不出去，同步 sendSync / setItem 才可靠
  useEffect(() => {
    const bye = () => { flushPendingSaves(); if (capable()) flushSyncNow(); };
    window.addEventListener('beforeunload', bye);
    return () => window.removeEventListener('beforeunload', bye);
  }, []);

  // —— 挂起写：上次会话有重试后仍失败的写盘操作 ——
  // 此刻自动同步会用旧文件夹内容覆盖浏览器里更新的数据，必须先由用户裁决（重试 / 放弃）
  const [pendingWrites, setPendingWrites] = useState(() => capable() && !!getRoot() && hasPendingWrites());
  // 挂起记录随写盘结果实时增减（本轮写盘失败留底 / 成功补写或重试成功清除），横幅状态跟随
  useEffect(() => {
    const sync = () => setPendingWrites(capable() && !!getRoot() && hasPendingWrites());
    window.addEventListener('deepnotes-pending-changed', sync);
    return () => window.removeEventListener('deepnotes-pending-changed', sync);
  }, []);
  async function retryPendingWrites() {
    const n = await retryPending();
    if (!hasPendingWrites()) {
      setPendingWrites(false);
      setToast(n ? `写盘成功，挂起的 ${n} 个文件已落盘 · Flushed` : '没有待写盘的内容 · Nothing pending');
      if (n) setTimeout(() => syncRef.current?.(), 400); // 补跑被跳过的自动同步
    } else setToast('仍有文件写盘失败（磁盘已满或权限不足？）· Still failing');
  }
  function dropPendingWrites() {
    if (!window.confirm('放弃这些未写盘的修改？磁盘上将保留旧内容，浏览器里的最新版本不再尝试写盘。')) return;
    clearPendingWrites();
    setPendingWrites(false);
    setToast('已放弃挂起的写盘任务 · Discarded pending writes');
  }

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
    if (!window.confirm(`删除选题「${it?.title || '未命名选题'}」？${deleteScopeNote()}`)) return;
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
    if (!window.confirm(`删除草稿「${d?.title || '未命名草稿'}」？${deleteScopeNote()}`)) return;
    const rest = drafts.filter(x => x.id !== id);
    setDrafts(rest); setActive(rest[0]?.id); setToast('草稿已删除 · Draft deleted');
  }
  // —— 闪念箱：随手记自动带日期，一键沉淀为草稿 / 方法笔记，转出后从闪念箱移除 ——
  const dayOf = ts => { const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  function flashToDraft(id) {
    const it = inbox.find(x => x.id === id); if (!it) return;
    newDraft((it.text.split('\n')[0] || '闪念').slice(0, 18), `${it.text}\n\n（来自闪念箱 ${dayOf(it.ts)}）`);
    setInbox(list => list.filter(x => x.id !== id));
  }
  function flashToNote(id) {
    const it = inbox.find(x => x.id === id); if (!it) return;
    const t = (it.text.split('\n')[0] || '闪念笔记').slice(0, 24).replace(/[/\\]/g, '·');
    setNotes(ns => [{id: 'note-' + Date.now(), title: t, path: `05-方法库 methods/闪念/${t}.md`, body: `${it.text}\n`}, ...ns]);
    setInbox(list => list.filter(x => x.id !== id));
    setToast('已转入方法笔记 · Saved to methods');
  }
  // 每日笔记：以当天日期命名的草稿，已存在就直接打开
  function openDaily() {
    const t = `${dayOf(Date.now())} 每日笔记`;
    const exist = drafts.find(x => x.title === t);
    if (exist) { setActive(exist.id); setPage('drafts'); setToast('已打开今日笔记 · Daily note opened'); }
    else newDraft(t, `# ${t}\n\n## 今天\n\n- \n\n## 闪念沉淀\n\n- \n`);
  }
  // —— 未链接提及：把他篇正文里以纯文本提到该标题的位置转成 [[双链]]（已存在的 [[ ]] 段不动） ——
  function linkifyMentions(name) {
    const t = String(name || '').trim();
    if (t.length < 2) { setToast('名称太短，不做替换 · Too short to link'); return; }
    let n = 0;
    const conv = body => String(body || '').split(/(\[\[[^\]]*\]\])/g).map(seg => seg.startsWith('[[') ? seg
      : seg.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), () => { n++; return `[[${t}]]`; })).join('');
    setWorks(ws => ws.map(x => x.title !== t ? {...x, body: conv(x.body)} : x));
    setNotes(ns => ns.map(x => x.title !== t ? {...x, body: conv(x.body)} : x));
    setDrafts(ds => ds.map(x => x.title !== t ? {...x, body: conv(x.body)} : x));
    setReadings(rs => rs.map(x => x.title !== t ? {...x, body: conv(x.body)} : x));
    setArchives(as => as.map(x => x.title !== t ? {...x, body: conv(x.body)} : x));
    setToast(n ? `已在正文中接通 ${n} 处 [[${t}]] · Linked` : '没有找到可转换的提及 · No plain mentions');
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
    if (!window.confirm(`删除方法笔记「${n?.title || '未命名'}」？${deleteScopeNote()}`)) return;
    const rest = notes.filter(x => x.id !== id);
    setNotes(rest);
    setMethSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
    // 空分类自动清理：最后一条笔记离开，分类列表里的空分类一并移除
    const folder = subOf(n);
    if (folder && !rest.some(x => subOf(x) === folder) && folders.includes(folder)) setFolders(fs => fs.filter(f => f !== folder));
    setToast('方法笔记已删除 · Note deleted');
  }
  // —— 方法库二级分类：拖拽/下拉只改 path 第二段，id 不变，选中态与编辑器原地保持（无刷新） ——
  // 桌面版由全局 diff 自动「旧路径 rename 到新路径 + 内容变更时写盘」（vault:move 原子移动，自带建目录）。
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
    const src = subOf(n);
    setNotes(ns => ns.map(x => x.id === id ? {...x, path: notePathIn(x, folder)} : x));
    // 原分类因此空了就自动移除，不留空分类
    if (!notes.some(x => x.id !== id && subOf(x) === src) && folders.includes(src)) setFolders(fs => fs.filter(f => f !== src));
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
  // —— 本地文件导入阅读区：PDF / HTML / Markdown / TXT 已由 docImport.js 离线解析成条目 ——
  function importReadingItems(items, failed = []) {
    // failed 兼容两种形态：旧的失败个数（number）与新的失败原因列表（string[]，含文件名与报错）
    const errs = Array.isArray(failed) ? failed : [];
    const n = errs.length || (Number(failed) || 0);
    if (!items.length) { setToast(errs.length ? `导入失败：${errs[0]}` : '导入失败 · Import failed'); return; }
    const made = items.map((it, i) => ({id: 'reading-' + Date.now() + '-' + i, title: it.title || '未命名阅读', author: '', source: it.source || '本地文件', date: dayOf(Date.now()), body: it.body || ''}));
    setReadings(rs => [...made, ...rs]);
    setReadSel(made[0].id);
    setPage('readings');
    setToast(`已导入 ${made.length} 个文件到阅读区${n ? `，${n} 个失败${errs[0] ? `：${errs[0]}` : ''}` : ''} · Imported`);
  }
  function deleteReading(id) {
    const r = readings.find(x => x.id === id);
    if (!window.confirm(`删除阅读「${r?.title || '未命名阅读'}」？正文与批注会一起删除，${deleteScopeNote()}`)) return;
    const rest = readings.filter(x => x.id !== id);
    setReadings(rest);
    setReadSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
    setReadOpen(o => o === id ? null : o);
    // 空分类自动清理：最后一条阅读离开，分类列表里的空分类一并移除
    const folder = readFolderOf(r);
    if (folder && !rest.some(x => readFolderOf(x) === folder) && readFolders.includes(folder)) setReadFolders(fs => fs.filter(f => f !== folder));
    setToast('阅读条目已删除 · Reading deleted');
  }
  // —— 阅读区左侧分类：拖拽/下拉只改 folder 字段，id 不变，选中态原地保持（无刷新） ——
  const READ_TRASH_FOLDER = '未分类'; // 删除非空分类时的兜底去处
  const readFolderOf = r => r.folder || READ_TRASH_FOLDER;
  function moveReadingToFolder(id, folder) {
    if (!folder) return;
    const r = readings.find(x => x.id === id);
    if (!r || readFolderOf(r) === folder) return; // 同分类重复投放：原地不动
    const src = readFolderOf(r);
    setReadings(rs => rs.map(x => x.id === id ? {...x, folder} : x));
    // 原分类因此空了就自动移除，不留空分类
    if (!readings.some(x => x.id !== id && readFolderOf(x) === src) && readFolders.includes(src)) setReadFolders(fs => fs.filter(f => f !== src));
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
    if (!window.confirm(`删除档案「${a?.title || '未命名档案'}」？正文会一起删除，${deleteScopeNote()}`)) return;
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
      const src = subOf(n);
      const rest = notes.filter(x => x.id !== id);
      setNotes(rest);
      // 移走后原分类空了就自动移除，不留空分类
      if (!rest.some(x => subOf(x) === src) && folders.includes(src)) setFolders(fs => fs.filter(f => f !== src));
    } else if (fromKind === 'draft') {
      const d = drafts.find(x => x.id === id); if (!d) return;
      moved = {title: d.title, body: d.body || ''};
      setDrafts(ds => { const rest = ds.filter(x => x.id !== id); setActive(a => a === id ? rest[0]?.id : a); return rest; });
    } else if (fromKind === 'reading') {
      const r = readings.find(x => x.id === id); if (!r) return;
      moved = {title: r.title, body: r.body || ''};
      const src = readFolderOf(r);
      const rest = readings.filter(x => x.id !== id);
      setReadings(rest);
      if (!rest.some(x => readFolderOf(x) === src) && readFolders.includes(src)) setReadFolders(fs => fs.filter(f => f !== src));
      setReadOpen(o => o === id ? null : o);
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
    if (!window.confirm(`删除文章「${w?.title || '未命名文章'}」？正文与主信息会一起删除，${deleteScopeNote()}`)) return;
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
    // 审计 M2：与 delete_file 一致，AI 改写也要二次确认——不能静默覆盖用户正文且无版本历史
    const cur = aiRead(gid);
    if (!cur) return {error: '找不到文件'};
    if (title !== undefined || body !== undefined) {
      const what = [title !== undefined ? '标题' : null, body !== undefined ? '正文' : null].filter(Boolean).join('和');
      const bodyInfo = body !== undefined ? `，正文 ${String(cur.body || '').length} → ${String(body).length} 字` : '';
      if (!window.confirm(`AI 请求修改「${cur.title || gid}」的${what}${bodyInfo}，确认？`)) return {ok: false, title: cur.title, cancelled: true};
    }
    const patch = {};
    if (title !== undefined) patch.title = String(title);
    if (body !== undefined) patch.body = String(body);
    if (kind === 'post') { updateWork(id, patch); return {ok: true, title: patch.title}; }
    if (kind === 'draft') {
      setDrafts(ds => ds.map(x => x.id === id ? {...x, ...patch} : x));
      return {ok: true, title: patch.title};
    }
    if (kind === 'note') {
      const safeTitle = patch.title ? patch.title.trim().replace(/[/\\]/g, '·') : patch.title; // 文件名安全化
      setNotes(ns => ns.map(x => x.id === id ? {...x, ...patch, ...(safeTitle ? {path: x.path.replace(/[^/]+$/, safeTitle + '.md')} : {})} : x));
      return {ok: true, title: patch.title};
    }
    return {error: '未知类型 ' + kind};
  };
  const aiRemove = gid => {
    const [kind, id] = String(gid).split(':');
    const t = aiRead(gid)?.title || gid;
    if (!window.confirm(`AI 请求删除「${t}」，确认删除？${deleteScopeNote()}`)) return {ok: false, title: t, cancelled: true};
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
  // 非破坏性增量：任何整体替换（导入 / 自动同步 / 切示例 / 恢复快照）之前，先把当前内容
  // 完整存一份快照到 localStorage，⌘K「恢复数据快照」可随时回退；快照超限则跳过（尽力而为）。
  const FILES_KEY = CONFIG.storagePrefix + '-vault-files-v1'; // 上次同步/导入时的知识库文件数，用于拒绝不完整覆盖
  const saveSnapshot = () => {
    // 审计 H2：写满降级——空间紧张（storageStrapped）时暂停快照，正文键永远优先；
    // 快照只是回滚手段，空间缓解（重启后自动重试）即恢复
    if (storageStrapped) return;
    try {
      // 水位预检：现有占用（扣除将被替换的旧快照）+ 新快照超过保守水位线（约 5MB 字符）
      // 就放弃本次快照并提示一次——正文保存不受影响，⌘K「恢复数据快照」本轮缺位
      const payload = JSON.stringify({at: nowStamp(), snap, works, notes, ideas, drafts, readings, archives, concepts: kbConcepts});
      let old = ''; try { old = localStorage.getItem(BACKUP_KEY) || ''; } catch {}
      if (storageUsage() - old.length + payload.length > STORAGE_LIMIT) {
        if (!snapshotSkipped) { snapshotSkipped = true; showGlobalNotice('本地存储空间紧张，本次跳过数据快照（正文保存不受影响），建议 ⌘K「导出全部 Markdown」备份 · Snapshot skipped'); }
        return;
      }
      // snap：当前知识库信息（账号 / 导入日期 / 来源）一并入快照，恢复后「关于」显示才不串库
      localStorage.setItem(BACKUP_KEY, payload);
    } catch {
      storageStrapped = true;
      // 快照太大超出 localStorage 配额时放弃主流程不受影响，但必须让用户知道「恢复快照」会缺位
      showGlobalNotice('数据快照保存失败（本地存储空间不足），⌘K「恢复数据快照」将不可用 · Snapshot save failed');
    }
  };
  function adoptData(data, msg, keepFolders = false) {
    // 概念词表合并而非覆盖：应用内改过的关键词与手动增删的概念（current）优先，
    // 词表里没有的（导入 / 同步带回的新词）补进来。直接覆盖会抹掉用户在概念内页的全部修改。
    // 代价（v1 接受）：应用内删除 / 改名的概念会在下次同步时被词表带回。
    const mergeConcepts = (incoming, current) => {
      const map = new Map((Array.isArray(current) ? current : []).map(([n, t]) => [n, t]));
      for (const [n, t] of (Array.isArray(incoming) ? incoming : [])) if (!map.has(n)) map.set(n, t);
      return [...map];
    };
    saveSnapshot();
    setWorks(data.works); setNotes(data.notes ?? SEED_NOTES); setIdeas(data.ideas); setDrafts(data.drafts);
    setReadings(data.readings ?? seedReadings);
    setArchives(data.archives ?? seedArchives);
    setSnap(data.snapshot); setKbConcepts(mergeConcepts(data.concepts, kbConcepts));
    // keepFolders：自动同步 / 恢复快照不是「换库」，应用内手动建的空分类原样保留；
    // 全量导入 / 切回示例才是彻底替换，手动空分类随内容一起清掉
    if (!keepFolders) { setFolders([]); setReadFolders([]); }
    setLibSel(data.works[0]?.id ?? null); setActive(data.drafts[0]?.id);
    setReadSel(null); setReadOpen(null); setArcSel(null); setArcOpen(null);
    setFocus({mod: null, sel: null}); setOpenArticle(null); setPage('home');
    setModal(null); setToast(msg);
  }
  function restoreSnapshot() {
    setPalette(false); setModal(null);
    let bak; // bak：备份内容；用 bak 而非 snap 命名，避免遮蔽外层的知识库信息 state
    try { bak = JSON.parse(localStorage.getItem(BACKUP_KEY)); } catch {}
    if (!bak || !Array.isArray(bak.works)) { setToast('没有可恢复的数据快照 · No snapshot'); return; }
    if (!window.confirm(`恢复 ${bak.at} 的数据快照？当前内容会先另存一份新快照（可再恢复回来），桌面版会写回知识库文件夹。`)) return;
    adoptData({
      works: bak.works, notes: bak.notes ?? SEED_NOTES, ideas: bak.ideas ?? [], drafts: bak.drafts ?? [],
      readings: bak.readings ?? [], archives: bak.archives ?? [],
      snapshot: bak.snap ?? snapshot, concepts: Array.isArray(bak.concepts) ? bak.concepts : CONCEPTS,
    }, `已恢复 ${bak.at} 的数据快照 · Snapshot restored`, true);
  }
  async function importVault(target = 'auto') {
    setModal(null);
    // 桌面版经主进程选目录读文件；网页版走浏览器目录选择器。两种来源都转成同一套 File 列表解析。
    let files, srcDir = null, unreadable = [];
    if (capable()) {
      srcDir = await chooseDir();
      if (!srcDir) return;
      try {
        const res = readVaultFiles(srcDir, await window.deepnotes.vault.read(srcDir));
        files = res.files; unreadable = res.unreadable;
      } catch { setToast('读取文件夹失败 · Failed to read folder'); return; }
    } else {
      files = await pickVaultFolder();
      if (!files) return;
    }
    // iCloud / 网盘未下载的文件读不出内容：继续导入会把它们当「已删除」写回（移进 .trash），必须先中止
    if (unreadable.length) {
      setToast(`有 ${unreadable.length} 个文件暂时读不到（可能未从 iCloud 下载），已取消导入以防误删；请先在访达里把文件下载完整再试 · Import aborted`);
      return;
    }
    let data;
    try { data = await parseVault(files, target); } catch { setToast('解析失败，请确认选择的是 Markdown 文件夹 · Parse failed'); return; }
    if (!data.counts.all) { setToast('所选文件夹里没有 Markdown 笔记 · No markdown notes'); return; }
    const where = target === 'auto'
      ? `文章 ${data.counts.works}、方法笔记 ${data.counts.notes}、选题 ${data.counts.ideas}、草稿 ${data.counts.drafts}、阅读 ${data.counts.readings || 0}、档案 ${data.counts.archives || 0}`
      : `全部 ${data.counts.all} 个文件将作为「${{works: '作品库', methods: '方法库', ideas: '选题池', drafts: '创作台', readings: '阅读区', archives: '档案区'}[target]}」的内容导入`;
    const srcName = srcDir ? srcDir.replace(/\/+$/, '').split('/').pop() : data.vault;
    const reuse = srcDir && / - Deep Notes$/i.test(srcName); // 已是 Deep Notes 专属库：直接用，不再复制副本
    const desktopNote = srcDir ? `\n\n桌面版${reuse
      ? `直接使用「${srcName}」作为你的知识库文件夹（名称已带 Deep Notes 专属后缀，不再新建副本）：之后的编辑会实时写回该文件夹。`
      : `会在「${srcName}」旁新建「${srcName} - Deep Notes」副本作为你的知识库文件夹（副本初始为空，导入完成后按结果生成 .md）：之后的编辑会实时写回副本，原文件夹内容保持不变。`}` : '';
    const ok = window.confirm(`将从「${srcName}」导入：${where}。${desktopNote}\n\n这会替换当前浏览器里的全部文章、选题和草稿，确定继续吗？`);
    if (!ok) return;
    let copyDir = null;
    if (srcDir) {
      setTarget(target);
      const copy = await prepareCopy(srcDir);
      if (copy?.ok) {
        await setRoot(copy.dir); copyDir = copy.dir; // await：先把旧队列写进旧库再换根目录
        window.deepnotes?.vault?.watch?.(copy.dir); // 新库开始监听外部改动
      }
      else { await setRoot(null); window.deepnotes?.vault?.watch?.(null); setToast('无法创建知识库副本，本次导入只保存在浏览器 · Copy failed'); }
    }
    adoptData(data, `已导入知识库：文章 ${data.counts.works} · 笔记 ${data.counts.notes} · 选题 ${data.counts.ideas} · 草稿 ${data.counts.drafts}${data.counts.readings ? ` · 阅读 ${data.counts.readings}` : ''}${data.counts.archives ? ` · 档案 ${data.counts.archives}` : ''}${copyDir ? ` · 已写入「${copyDir.replace(/\/+$/, '').split('/').pop()}」` : ''}`);
    try { localStorage.setItem(FILES_KEY, String(data.counts.all)); } catch {} // 文件数基线：自动同步的「拒绝不完整覆盖」以此为参照
  }

  // —— 导入选定内容：挑一个或多个 .md 文件，合并进指定模块（同标题更新，其余追加），其他模块不动 ——
  // 与整库导入不同：不换知识库、不清空现有内容，操作前照样先存快照，可从 ⌘K 恢复
  const MERGE_ZH = {works: '作品库', methods: '方法库', ideas: '选题池', drafts: '创作台', readings: '阅读区', archives: '档案区'};
  async function importFiles(target) {
    setModal(null);
    const files = await pickMdFiles();
    if (!files) return;
    let data;
    try { data = await parseVault(files, target); } catch { setToast('解析失败，请确认选的是 Markdown 文件 · Parse failed'); return; }
    const fresh = {works: data.works, methods: data.notes, ideas: data.ideas, drafts: data.drafts, readings: data.readings, archives: data.archives}[target] || [];
    if (!data.counts.all || !fresh.length) { setToast('所选文件里没有可识别的 Markdown 内容 · Nothing to import'); return; }
    saveSnapshot(); // 写前快照，⌘K「恢复数据快照」可回退本次合并
    const canon = s => String(s || '').trim().toLowerCase();
    let replaced = 0;
    // 同标题视为同一条：保留原 id（选中态 / 反向链接不断）。replaceFields 列出的字段才被文件
    // 覆盖，且空值不覆盖（空 body / 空 author 不会抹掉现有内容）——应用内手工维护的
    // 数据（作品指标、阅读分类、笔记路径）不在列表里，合并永远不会清掉它们。
    const hasVal = v => v !== '' && v != null && !(Array.isArray(v) && !v.length);
    const mergeByTitle = (list, items, reid, replaceFields) => {
      const out = [...list];
      const idx = new Map();
      out.forEach((x, i) => { const k = canon(x.title); if (k && !idx.has(k)) idx.set(k, i); });
      const adds = [];
      for (const f of items) {
        const i = idx.get(canon(f.title));
        if (i == null) adds.push(f);
        else {
          replaced++;
          out[i] = replaceFields
            ? {...out[i], ...Object.fromEntries(replaceFields.filter(k => hasVal(f[k])).map(k => [k, f[k]])), id: out[i].id}
            : {...out[i], ...f, id: out[i].id};
        }
      }
      return reid ? [...out, ...adds.map((x, i) => reid(x, i))] : [...out, ...adds];
    };
    if (target === 'works') {
      const base = works.reduce((m, w) => Math.max(m, Number(String(w.id).match(/^w(\d+)$/)?.[1]) || 0), 0);
      setWorks(mergeByTitle(works, fresh, (x, i) => ({...x, id: 'w' + (base + fresh.length + i + 1)}), ['title', 'date', 'direction', 'media', 'tags', 'body']));
    } else if (target === 'methods') {
      // 新笔记的 path 不能和现有笔记撞车（同 path 会互相覆盖一个文件）；撞了就在文件名后追加 id 短码。
      // 替换同名条目不动 path：文件原地更新，不会在知识库里搬家。
      const usedPaths = new Set(notes.map(x => x.path));
      const rePath = f => {
        let p = f.path, guard = 0;
        while (usedPaths.has(p) && guard++ < 8) p = p.replace(/\.md$/, `--${shortId(f.id)}.md`);
        usedPaths.add(p);
        return {...f, path: p};
      };
      const base = notes.reduce((m, n) => Math.max(m, Number(String(n.id).match(/^n(?:ote-)?(\d+)$/)?.[1]) || 0), 0);
      setNotes(mergeByTitle(notes, fresh.map(rePath), (x, i) => ({...x, id: 'n' + (base + fresh.length + i + 1)}), ['title', 'body']));
    } else if (target === 'ideas') {
      const base = ideas.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
      setIdeas(mergeByTitle(ideas, fresh, (x, i) => ({...x, id: base + fresh.length + i + 1}), ['title', 'platform', 'priority', 'status', 'note']));
    } else if (target === 'drafts') {
      setDrafts(mergeByTitle(drafts, fresh, (x, i) => ({...x, id: 'draft-' + Date.now() + '-' + i}), ['title', 'body']));
    } else if (target === 'readings') {
      setReadings(mergeByTitle(readings, fresh, (x, i) => ({...x, id: 'reading-' + Date.now() + '-' + i}), ['title', 'date', 'author', 'source', 'folder', 'body']));
    } else if (target === 'archives') {
      setArchives(mergeByTitle(archives, fresh, (x, i) => ({...x, id: 'archive-' + Date.now() + '-' + i}), ['title', 'date', 'body']));
    }
    setToast(`已导入 ${fresh.length} 条到「${MERGE_ZH[target]}」${replaced ? `（更新 ${replaced} 条同名）` : ''} · Imported`);
  }
  async function resetToSample() {
    if (!window.confirm('切回虚构示例数据？当前浏览器里的文章、选题和草稿会被清空替换。')) return;
    await setRoot(null); // 桌面版停用文件夹写回（先把待写队列写进旧库）；盘上已有的知识库副本原样保留
    window.deepnotes?.vault?.watch?.(null); // 停止文件监听
    adoptData({works: seedWorks(), notes: SEED_NOTES, ideas: seedIdeas, drafts: seedDrafts, readings: seedReadings, archives: seedArchives, snapshot, concepts: CONCEPTS}, '已切回示例数据 · Sample data restored');
  }

  // —— 导出全部 Markdown：按模块目录序列化成 .md；桌面版选目录逐文件落盘，网页版合并成一个文件下载 ——
  // 路径与知识库写盘共用同一套规则（resolveRels 同名标题消歧），导出的文件夹可直接当 Obsidian 库用。
  async function exportVault() {
    setPalette(false); setModal(null);
    const files = [];
    for (const [kind, items] of [['works', works], ['notes', notes], ['drafts', drafts], ['readings', readings], ['archives', archives]]) {
      const rels = resolveRels(kind, items);
      for (const x of items) { const rel = rels.get(x.id); if (rel) files.push({rel, body: serialize(kind, x)}); }
    }
    if (ideas.length) files.push({rel: '04-选题池/选题池.md', body: '---\ntitle: 选题池\n---\n\n' + ideas.map(i => `## ${i.title || '未命名选题'}\n\n- 平台：${i.platform || '—'} · 优先级：${i.priority} · 状态：${i.status}\n- 备注：${i.note || ''}`).join('\n\n')});
    if (!files.length) { setToast('还没有可导出的内容 · Nothing to export'); return; }
    try {
      const where = await exportFiles(files);
      setToast(where === 'download' ? `已导出 ${files.length} 条内容（合并为一个文件） · Exported` : where ? `已导出 ${files.length} 个文件到「${where.replace(/\/+$/, '').split('/').pop()}」 · Exported` : '');
    } catch { setToast('导出失败 · Export failed'); }
  }

  // —— 导出当前内容：正在看的那篇（文章全文 / 草稿 / 方法笔记 / 阅读 / 档案）——
  // 「正在看」= 已打开全文视图的那篇；没开全文就是列表里选中的那篇。
  const currentItem = () => {
    const pick = (list, id) => list.find(x => x.id === id) || null;
    if (page === 'library') return {kind: 'works', item: pick(works, openArticle || libSel)};
    if (page === 'methods') return {kind: 'notes', item: pick(notes, methSel)};
    if (page === 'drafts') return {kind: 'drafts', item: pick(drafts, active)};
    if (page === 'readings') return {kind: 'readings', item: pick(readings, readOpen || readSel)};
    if (page === 'archives') return {kind: 'archives', item: pick(archives, arcOpen || arcSel)};
    return null;
  };
  const curItem = currentItem();
  // PDF 页眉的元信息行：按模块挑代表性字段
  const curMeta = ({kind, item: it}) => {
    if (kind === 'works') return [String(it.date || '').slice(0, 16), it.direction, (it.tags || []).map(t => '#' + t).join(' ')].filter(Boolean).join(' · ');
    if (kind === 'notes') return it.path || '方法笔记';
    if (kind === 'readings') return [it.author, it.source, String(it.date || '').slice(0, 10)].filter(Boolean).join(' · ');
    return String(it.date || '').slice(0, 10) || ({drafts: '草稿 Draft', archives: '档案 Archive'}[kind] || '');
  };
  async function exportCurrentMd() {
    const cur = currentItem(); if (!cur?.item) return;
    setPalette(false); setModal(null);
    const rel = resolveRels(cur.kind, [cur.item]).get(cur.item.id);
    if (!rel) { setToast('这条内容没有可导出的文件名 · Nothing to export'); return; }
    try {
      const where = await exportFiles([{rel, body: serialize(cur.kind, cur.item)}]);
      setToast(where === 'download' ? `已下载《${cur.item.title}》 · Exported` : where ? `已导出到「${where.replace(/\/+$/, '').split('/').pop()}」 · Exported` : '');
    } catch { setToast('导出失败 · Export failed'); }
  }
  function exportCurrentPdf() {
    const cur = currentItem(); if (!cur?.item) return;
    setModal(null);
    printArticle({title: cur.item.title || '未命名', meta: curMeta(cur), html: renderMarkdown(cur.item.body || '')});
  }

  // 桌面版打开软件自动同步：已连接知识库文件夹时重新读取文件夹内容（文件夹是唯一事实来源，
  // 应用内的编辑本来就会写回文件夹）。选题池同样落盘（04-选题池），随文件夹全量对齐。
  // 比对只看会写进文件的字段（忽略 updatedAt / capturedAt 等应用内字段），完全一致时静默返回。
  // 非破坏性增量保护：
  // 1) 有挂起写（上次写盘失败留底）时整体跳过——此刻同步会用旧文件夹内容覆盖浏览器里更新的数据；
  // 2) 文件数骤减（磁盘休眠 / 网盘未下载完 / 库被临时移走）时拒绝同步——「缺失」会被当成删除写回；
  // 3) iCloud 占位等「存在但读不到」的文件只排除出删除判定，对应内容原样保留，其余文件照常同步。
  const syncSeq = useRef(0);
  const syncFromVault = useCallback(async () => {
    if (!capable() || !getRoot()) return;
    await pendingReady; // IndexedDB 兜底的挂起写先灌回内存，再判定是否跳过同步（防覆盖）
    if (hasPendingWrites()) { setToast('上次有未写盘的修改，已跳过自动同步以防覆盖 · Sync skipped'); return; }
    const seq = ++syncSeq.current;
    const root = getRoot();
    let files, unreadable = [];
    try {
      const res = readVaultFiles(root, await window.deepnotes.vault.read(root));
      files = res.files; unreadable = res.unreadable;
    } catch { return; }
    let data;
    try { data = await parseVault(files, getTarget()); } catch { return; }
    if (seq !== syncSeq.current || !data.counts.all) return;
    const lastCount = Math.max(Number(localStorage.getItem(FILES_KEY) || 0),
      works.length + notes.length + drafts.length + readings.length + archives.length + ideas.length);
    // 读不到的文件计入应读数：iCloud 占位不算「库被清空」
    if (data.counts.all + unreadable.length < lastCount * 0.7) {
      setToast(`知识库文件数量骤减（${lastCount} → ${data.counts.all}），已跳过自动同步以防误删；若确属有意删除，请重新导入一次该知识库 · Sync skipped`);
      return;
    }
    const fp = (x, keys) => JSON.stringify(keys.map(k => x?.[k] ?? null));
    const eq = (a, b, keys) => a.length === b.length && a.every((x, i) => fp(x, keys) === fp(b[i], keys));
    const same =
      eq(works, data.works || [], ['id', 'title', 'date', 'direction', 'tags', 'body', 'media', 'views', 'likes', 'comments', 'saves', 'follows', 'shares', 'impressions', 'ctr', 'duration']) &&
      eq(notes, data.notes || [], ['id', 'title', 'path', 'body']) &&
      eq(drafts, data.drafts || [], ['id', 'title', 'body', 'source']) &&
      eq(readings, data.readings || [], ['id', 'title', 'author', 'source', 'folder', 'date', 'body']) &&
      eq(archives, data.archives || [], ['id', 'title', 'date', 'body']) &&
      // 选题按业务字段判等（不含 id：导入端按出现顺序编号，顺序不代表库变更）
      eq(ideas, data.ideas || [], ['title', 'platform', 'priority', 'status', 'note']) &&
      // 概念按名字判等：关键词 / 顺序差异不算库变更（概念由笔记推导且应用内可编辑，不落盘，
      // 若按整词表比较，每次启动都会判「有变化」触发一次全库重写）
      (data.concepts || []).every(([n]) => kbConcepts.some(([k]) => k === n));
    if (same) {
      if (unreadable.length) setToast(`知识库有 ${unreadable.length} 个文件暂时读不到（可能未从 iCloud 下载），相关内容保持原样 · Sync partial`);
      return; // 文件夹没有变化就不打扰
    }
    // iCloud 占位：读不到的文件不参与删除判定，对应内容原样保留（与当前 state 同引用，
    // diff 写回时不会重写它们），其余内容照常对齐。选题不保留：数字 id 与读回内容必然撞车，
    // 保留副本还会对占位路径发起写盘；文件从 iCloud 下载完成后选题自然回来。
    let keepOld = null;
    if (unreadable.length) {
      const ghost = new Set(unreadable);
      const relOfItem = (kind, x) => pathOf(kind, x) || '';
      const cur = {works, notes, drafts, readings, archives};
      keepOld = {};
      for (const kind of Object.keys(cur)) {
        const fresh = new Set((data[kind] || []).map(x => relOfItem(kind, x)));
        keepOld[kind] = (cur[kind] || []).filter(x => { const r = relOfItem(kind, x); return r && ghost.has(r) && !fresh.has(r); });
      }
    }
    const next = {
      works: keepOld ? [...(data.works || []), ...keepOld.works] : (data.works || []),
      notes: keepOld ? [...(data.notes ?? SEED_NOTES), ...keepOld.notes] : (data.notes ?? SEED_NOTES),
      ideas: data.ideas || [],
      drafts: keepOld ? [...(data.drafts || []), ...keepOld.drafts] : (data.drafts || []),
      readings: keepOld ? [...(data.readings ?? seedReadings), ...keepOld.readings] : (data.readings ?? seedReadings),
      archives: keepOld ? [...(data.archives ?? seedArchives), ...keepOld.archives] : (data.archives ?? seedArchives),
      snapshot: data.snapshot, concepts: data.concepts,
    };
    adoptData(next, `已同步知识库变更：文章 ${data.counts.works} · 笔记 ${data.counts.notes} · 选题 ${data.counts.ideas} · 草稿 ${data.counts.drafts}${data.counts.readings ? ` · 阅读 ${data.counts.readings}` : ''}${data.counts.archives ? ` · 档案 ${data.counts.archives}` : ''}${unreadable.length ? `（另有 ${unreadable.length} 个文件暂时读不到，已保持原样）` : ''}`, true);
    try { localStorage.setItem(FILES_KEY, String(data.counts.all + unreadable.length)); } catch {} // 文件数基线含占位文件
  }, [works, notes, ideas, drafts, readings, archives, kbConcepts, snap]);
  // 挂载跑一次自动同步，并开始监听外部改动：主进程 fs.watch 防抖 2s → 渲染层再防抖 3s → 同一比对
  // （应用自己写盘引发的回环只是多一次便宜的全量比对，无变化时静默，无害）
  const syncRef = useRef(syncFromVault);
  syncRef.current = syncFromVault;
  useEffect(() => {
    syncRef.current();
    const v = window.deepnotes?.vault;
    const root = getRoot();
    if (v?.watch && root) v.watch(root); // 换库 / 断开由 importVault 与切示例流程重设
    if (v?.onChanged) {
      let t = null;
      v.onChanged(() => { clearTimeout(t); t = setTimeout(() => syncRef.current(), 3000); });
      return () => clearTimeout(t);
    }
  }, []);

  const openInGraph = id => { const n = graph.index.get(id); const mod = {post: 'works', note: 'methods', idea: 'ideas', draft: 'drafts', reading: 'readings', archive: 'archives', concept: 'concepts'}[n?.kind]; if (mod) { setFocus({mod, sel: id}); setPage('home'); } };

  // 命令面板：按图谱 id 直达对应内容的编辑 / 阅读视图（面板自身会先关闭）
  const openContent = id => {
    const [kind, raw] = String(id).split(':');
    if (kind === 'post') { setLibSel(raw); setOpenArticle(raw); setPage('library'); return; }
    if (kind === 'note') { setMethSel(raw); setPage('methods'); return; }
    if (kind === 'draft') { setActive(raw); setPage('drafts'); return; }
    if (kind === 'reading') { setReadSel(raw); setReadOpen(raw); setPage('readings'); return; }
    if (kind === 'archive') { setArcSel(raw); setArcOpen(raw); setPage('archives'); return; }
    if (kind === 'idea') { const it = ideas.find(x => String(x.id) === String(raw)); if (it) editIdea(it); return; }
    openInGraph(id); // concept 与其余类型：回工作台图谱选中
  };

  // 命令面板动作清单：新建 / 跳转 / 数据导入导出（内容搜索由面板按 graph 自行匹配）
  const MODULE_ICON = {home: 'home', library: 'works', methods: 'methods', drafts: 'draft', ideas: 'idea', readings: 'book', archives: 'archive'};
  const paletteActions = [
    {group: '新建 New', icon: 'works', zh: '新建文章', en: 'New article', run: () => newWork()},
    {group: '新建 New', icon: 'methods', zh: '新建方法笔记', en: 'New note', run: addNote},
    {group: '新建 New', icon: 'draft', zh: '新建草稿', en: 'New draft', run: () => newDraft()},
    {group: '新建 New', icon: 'idea', zh: '添加选题', en: 'New idea', run: () => editIdea({id: Math.max(0, ...ideas.map(i => i.id)) + 1, title: '', platform: '小红书', priority: '中', status: '待写', note: ''})},
    {group: '新建 New', icon: 'book', zh: '新建阅读条目', en: 'New reading', run: newReading},
    {group: '新建 New', icon: 'archive', zh: '新建档案', en: 'New archive', run: newArchive},
    ...navs.map(([id, zh, en]) => ({group: '跳转 Go', icon: MODULE_ICON[id], zh: `打开${zh}`, en: `Go to ${en}`, run: () => setPage(id)})),
    {group: '跳转 Go', icon: 'concept', zh: '打开概念网络', en: 'Go to Concepts', run: () => setPage('concepts')},
    {group: '数据 Data', icon: 'file', zh: '导入知识库文件夹', en: 'Import vault folder', run: () => setModal('import')},
    {group: '数据 Data', icon: 'outlink', zh: '导入选定内容', en: 'Import selected files', run: () => setModal('import-files')},
    {group: '数据 Data', icon: 'save', zh: '导出全部 Markdown', en: 'Export all Markdown', run: exportVault},
    {group: '数据 Data', icon: 'replay', zh: '恢复数据快照', en: 'Restore data snapshot', run: restoreSnapshot},
    {group: '数据 Data', icon: 'replay', zh: '切回示例数据', en: 'Reset to sample', run: resetToSample},
  ];
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
        <Home graph={graph} layout={layout} focus={focus} setFocus={setFocus} onAction={onAction} onAbout={() => setModal('about')} reduced={reduced} name={wsName} onRename={setWsName} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={kbConcepts} onLinkify={linkifyMentions}/>
        <Snapshot goal={goal} onGoal={() => { setGoalInput(String(goal)); setModal('goal'); }} ideas={ideas} drafts={drafts} works={works} notes={notes} onIdea={editIdea} onDraft={id => { setActive(id); setPage('drafts'); }} onLibrary={id => { if (typeof id === 'string') setLibSel(id); setPage('library'); }} snap={snap} graph={graph}/>
      </>}
      {page === 'library' && <Library graph={graph} works={works} selected={libSel} setSelected={setLibSel} openArticle={openArticle} setOpenArticle={setOpenArticle} onNewWork={newWork} onUpdateWork={updateWork} onDeleteWork={deleteWork} onGo={openInGraph} onAction={onAction} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={kbConcepts} onLinkify={linkifyMentions}/>}
      {page === 'methods' && <Methods graph={graph} notes={notes} setNotes={setNotes} selected={methSel} setSelected={setMethSel} onGo={openInGraph} onNew={addNote} onDelete={deleteNote} onUpdate={updateNote} onMove={id => setModal({move: {kind: 'note', id}})} folders={folders} dragging={dragging} setDragging={setDragging} onMoveToFolder={moveNoteToFolder} onCreateFolder={createFolder} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder}/>}
      {page === 'drafts' && <Drafts graph={graph} drafts={drafts} setDrafts={setDrafts} active={active} setActive={setActive} onNew={() => newDraft()} onDelete={deleteDraft} onGo={openInGraph} works={works} notes={notes} onMove={id => setModal({move: {kind: 'draft', id}})} inbox={inbox} setInbox={setInbox} onFlashToDraft={flashToDraft} onFlashToNote={flashToNote} onDaily={openDaily}/>}
      {page === 'ideas' && <Ideas graph={graph} ideas={ideas} onEdit={editIdea} onGraph={openInGraph} onNew={() => editIdea({id: Math.max(0, ...ideas.map(i => i.id)) + 1, title: '', platform: '小红书', priority: '中', status: '待写', note: ''})}/>}
      {page === 'readings' && <Readings graph={graph} readings={readings} selected={readSel} setSelected={setReadSel} openReading={readOpen} setOpenReading={setReadOpen} onGo={openInGraph} onAction={onAction} onNew={newReading} onUpdate={updateReading} onDelete={deleteReading} readFolders={readFolders} dragging={dragging} setDragging={setDragging} onMoveToFolder={moveReadingToFolder} onCreateFolder={createReadingFolder} onRenameFolder={renameReadingFolder} onDeleteFolder={deleteReadingFolder} onLinkify={linkifyMentions} onImportFiles={importReadingItems}/>}
      {page === 'archives' && <Archives graph={graph} archives={archives} selected={arcSel} setSelected={setArcSel} openArchive={arcOpen} setOpenArchive={setArcOpen} onGo={openInGraph} onAction={onAction} onNew={newArchive} onUpdate={updateArchive} onDelete={deleteArchive} onLinkify={linkifyMentions}/>}
      {page === 'concepts' && <Concepts graph={graph} onGo={openInGraph}/>}
    </main>

    <footer className="site-foot">
      <button onClick={() => setModal('about')}><Icon name="info" size={13}/>{snap.source === '导入自本地笔记' ? `当前展示导入的本地知识库（${snap.capturedAt} 导入）` : '当前展示的是虚构示例数据，可在「关于」里导入你的知识库'} <em>{snap.source === '导入自本地笔记' ? 'Imported vault' : 'Sample data'}</em></button>
      <span>{CONFIG.footer.zh}<em>{CONFIG.footer.en}</em></span>
    </footer>

    {pendingWrites && <div className="toast glass" role="alert" style={{position: 'fixed', top: 14, bottom: 'auto', left: '50%', transform: 'translateX(-50%)', zIndex: 90, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', maxWidth: 'min(94vw, 760px)'}}>
      上次有文件未成功写盘，已暂停自动同步以防覆盖你的编辑。
      <button className="pill" onClick={retryPendingWrites}>重试写盘 <em>Retry</em></button>
      <button className="pill ghost" onClick={dropPendingWrites}>放弃 <em>Discard</em></button>
    </div>}
    {toast && <div className="toast glass" role="status"><Icon name="check" size={15}/>{toast}</div>}
    {/* AI 助手浮动入口：工作台已有 dock 常驻对话，其余页面用右下角按钮唤起同一个会话 */}
    {page !== 'home' && <AiFab/>}

    {/* ⌘K 全局命令面板：全文搜索 + 新建 / 跳转 / 导入导出 */}
    <CommandPalette open={palette} onClose={() => setPalette(false)} graph={graph} actions={paletteActions} onOpenContent={openContent}/>

    {modal === 'about' && <Modal title="关于这份数据" en="About the data" onClose={close}>
      <div className="about">
        <div className="form-actions">
          <button className="pill primary" onClick={() => setModal('import')}><Icon name="file" size={14}/>导入知识库文件夹 <em>Import vault</em></button>
          <button className="pill" onClick={() => setModal('import-files')}><Icon name="outlink" size={14}/>导入选定内容 <em>Import files</em></button>
          <button className="pill" disabled={!curItem} title={curItem ? `导出《${curItem.item.title}》` : '先打开一篇内容 · Open a piece first'} onClick={exportCurrentMd}><Icon name="save" size={14}/>导出当前 · Markdown <em>MD</em></button>
          <button className="pill" disabled={!curItem} title={curItem ? `打印 / 另存 PDF《${curItem.item.title}》` : '先打开一篇内容 · Open a piece first'} onClick={exportCurrentPdf}><Icon name="outlink" size={14}/>导出当前 · PDF <em>Print</em></button>
          <button className="pill ghost" onClick={resetToSample}>切回示例数据 <em>Reset</em></button>
        </div>
        <p className="quiet">随时按 <kbd>⌘K</kbd>（Windows 为 <kbd>Ctrl K</kbd>）呼出命令面板：全文搜索、新建、跳转、导出全部 Markdown、恢复数据快照都在那里。「导入选定内容」挑几个 .md 文件合并进某个模块（同标题更新、其余追加，不动其他内容），整体替换请用「导入知识库文件夹」；「导出当前」是正在看的那篇（文章全文 / 草稿 / 方法笔记 / 阅读 / 档案），PDF 经系统打印对话框「另存为 PDF」。任何整体替换之前都会自动存一份快照，可从 ⌘K 恢复。<em>Press ⌘K anywhere; imports are snapshotted first and reversible.</em></p>
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
    {/* 导入选定内容：挑几个 .md 文件合并进指定模块，同标题更新、其余追加，不动其他模块 */}
    {modal === 'import-files' && <Modal title="导入选定内容" en="Import files" onClose={close}>
      <div className="about import-pick">
        <p>挑选一个或多个 Markdown 文件，合并进所选模块：同标题的条目按文件内容更新（空字段不覆盖现有内容），其余追加，其他模块不受影响。<em>Pick one or more .md files to merge into a module. Same-title items are updated in place, others appended.</em></p>
        <div className="form-actions import-targets">
          <button className="pill primary" onClick={() => importFiles('works')}><Icon name="works" size={14}/>到作品库 <em>As works</em></button>
          <button className="pill" onClick={() => importFiles('methods')}><Icon name="methods" size={14}/>到方法库 <em>As notes</em></button>
          <button className="pill" onClick={() => importFiles('ideas')}><Icon name="idea" size={14}/>到选题池 <em>As ideas</em></button>
          <button className="pill" onClick={() => importFiles('drafts')}><Icon name="draft" size={14}/>到创作台 <em>As drafts</em></button>
          <button className="pill" onClick={() => importFiles('readings')}><Icon name="book" size={14}/>到阅读区 <em>As readings</em></button>
          <button className="pill" onClick={() => importFiles('archives')}><Icon name="archive" size={14}/>到档案区 <em>As archives</em></button>
        </div>
        <p className="quiet">frontmatter 里的 author / source / date / folder / tags 照常识别；阅读区条目带上 folder 字段会自动归入对应分类。合并前会自动存数据快照，可从 ⌘K 恢复。<em>Frontmatter is honored; a snapshot is saved first.</em></p>
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

createRoot(document.getElementById('root')).render(<ErrorBoundary><Intro/><App/></ErrorBoundary>);
