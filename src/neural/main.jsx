import React, {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {seedIdeas, seedDrafts, seedReadings, seedArchives, snapshot, concepts as CONCEPTS, notes as SEED_NOTES} from '../data';
import {useWorks, seedWorks, monthWorks, normalizeWork, nowStamp, toInputDateTime, fromInputDateTime, parseTags, WORKS_KEY} from './worksStore';
import {pickVaultFolder, pickMdFiles, parseVault} from './importer';
import {capable, getRoot, setRoot, getTarget, setTarget, queueSync, flush, flushAll, flushSyncNow, chooseDir, readVaultFiles, prepareCopy, resolveRels, setErrorHandler, serialize, exportFiles, shortId, pathOf, uniqueNotePath, safeName, hasPendingWrites, retryPending, clearPendingWrites, pendingReady, snapshotBeforeAdopt, readFileSnapshot, loadMeta, patchMeta, VAULT_MODE, verifyIntegrity} from './fileStore';
import {sameVaultContent} from './vaultCompare';
import {CONFIG, asset} from '../config';
import {buildGraph, forceLayout, stats, KINDS, nameIndex} from './graph';
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
import {RecoveryModal} from './recovery';
import {conceptExtras, setConceptSink, hydrateConceptMeta} from './conceptStore';
import {useVaultImages, resolveAllInDoc} from './images';
import {totalChars, recordDaily, loadStats, dailyDeltas, streakDays, knownVaults} from './writingStats';
import {resolveTarget, scrollToAnchor} from './wiki';
import {T} from './theme';
import {Modal} from './Modal.jsx';
import {DailyRecall, ReplaceModal, PomodoroFab, loadPomoSettings} from './mainModals.jsx';
import {MindMapWindow, makeMapFromItem} from './MindMaps.jsx';
import {PrivateNotes} from './PrivateNotes.jsx';
import {playRing} from './ring.js';
import {noiseStart, noiseStop} from './noise.js';
import './neural.css';

// 选题、草稿与目标保存在当前浏览器（localStorage）——仅网页版 / 未连接知识库时如此。
// 磁盘唯一事实源（Obsidian 化）：桌面版已连接知识库时，内容只以盘上 .md 为准，localStorage
// 不再保存内容（VAULT_CONTENT_KEYS，编辑直接走 diff 队列写盘），启动直接读盘构建界面。
// 写入防抖：打字等高频变更若每次都同步序列化全量数据（大库 + 粘贴图后可达数 MB）会卡顿，
// 静默 300ms 后再写，UI 保持跟手；窗口关闭前的最后一次输入由 flushPendingSaves 同步补写。
// 防抖窗口内的待写数据登记进 pendingSaves，写失败不再静默（全局提示条 + console 留痕可排查）。
const pendingSaves = new Map(); // key -> 防抖窗口内尚未落盘的值
// 连接知识库时跳过 localStorage 的内容键。设置与纯界面状态键（写作目标、工作区名、闪念箱、
// 手动空分类）不在列表里，照常存 localStorage。
const VAULT_CONTENT_KEYS = new Set(['-ideas-v1', '-drafts-v1', '-notes-v1', '-readings-v1', '-archives-v1', '-concepts-v1', '-snapshot-v1'].map(k => CONFIG.storagePrefix + k));
const STORAGE_ERR = '本地存储写入失败（空间可能已满），近期修改也许没有保存 · localStorage write failed';
// —— localStorage 水位检测与写满降级（审计 H2）——
// 配额各浏览器不同（一般 5–10MB），按多数下限保守估成 5MB 字符数。全量快照（-data-backup-v1）
// 是唯一可牺牲的写入：空间紧张时先停快照、清快照腾位保正文——正文键是数据本体，永远优先。
const BACKUP_KEY = CONFIG.storagePrefix + '-data-backup-v1';
const STORAGE_LIMIT = 5 * 1024 * 1024;
let storageStrapped = false; // 降级标记：true = 已触发写满降级，本轮会话暂停快照写入
let snapshotSkipped = false; // 水位预检跳过快照只提示一次，不反复打扰
let usageCache = { at: 0, n: 0 };
function storageUsage() {
  const now = Date.now();
  // 2 秒内复用上次结果（审计 v2-⑥）：数 MB 数据下每次全量扫描都会构造大字符串，
  // 内存峰值与 GC 压力不小；调用点只有快照水位预检，短缓存足够新鲜
  if (now - usageCache.at < 2000) return usageCache.n;
  let n = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + (localStorage.getItem(k) || '').length; } } catch {}
  usageCache = { at: now, n };
  return n;
}
// 带降级的统一写入：写满先清全量快照腾位重试一次（快照可由下次成功保存重建，正文不可丢）；
// 再失败说明连正文都放不下了，提示用户尽快导出备份。返回是否成功。
function trySaveLocal(key, val) {
  try { localStorage.setItem(key, val); usageCache.at = 0; return true; } // 写入改变水位：缓存作废
  catch (err) {
    console.warn('localStorage 写入失败 · Save failed:', key, err);
    try { localStorage.removeItem(BACKUP_KEY); usageCache.at = 0; } catch {}
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
  // 磁盘唯一事实源：连接知识库时内容键跳过 localStorage（读写都不做），初始值用调用方给的
  // 空数组/空值占位，真正的内容在启动时从知识库扫描灌入（adoptData）。网页版 / 未连库时不变。
  // 审计 A3：diskMode 运行时判断（VAULT_MODE 是模块加载期常量，会话内「切回示例」后 root 已空，
  // 若仍按常量判定会同时关闭 localStorage 与写盘两条通道，编辑静默丢失）。
  const diskMode = VAULT_MODE && VAULT_CONTENT_KEYS.has(key) && !!getRoot();
  const [v, set] = useState(() => {
    if (diskMode) return fallback;
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  });
  useEffect(() => {
    if (diskMode) return;
    pendingSaves.set(key, v);
    const t = setTimeout(() => {
      pendingSaves.delete(key);
      trySaveLocal(key, JSON.stringify(v));
    }, 300);
    return () => clearTimeout(t);
  }, [key, v, diskMode]);
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
// 顶栏提示条作为渲染层公共通道：插件等独立模块不 import 主模块，统一走 window.showGlobalNotice
window.showGlobalNotice = showGlobalNotice;

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


// —— 独立的单文件 HTML 文档：打印版与「分享 HTML」共用同一套浅色排版样式（无脚本、不联网）——
function buildArticleHtml({title, meta, html, share}) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  // 视频播放器在打印版里无法播放，只会留下黑框：换成可读的引用说明（文件名保留，方便事后查找）
  let printable = String(html).replace(/<video[^>]*data-asset="([^"]*)"[^>]*>\s*<\/video>/g,
    (_, ref) => `<p class="video-ref">▶ 本地视频（请回到 Deep Notes 播放）：${esc(ref)}</p>`);
  // 分享文件在别的设备打开时读不到知识库里的图片：换成文字说明，避免破图
  if (share) printable = printable.replace(/<img[^>]*data-asset="([^"]*)"[^>]*>/g,
    (_, ref) => `<p class="video-ref">🖼 本地图片（请回到 Deep Notes 查看）：${esc(ref)}</p>`);
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>'
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
    + '.video-ref{color:#666;font-size:12px;background:#f5f5f2;border-left:3px solid #bbb;padding:6px 10px;margin:.8em 0;}'
    + '.md a.md-video-link{color:#4a6fa5;}.md a.md-video-link::after{content:"（本地视频）";color:#999;font-size:11px;}'
    + '</style></head><body><h1>' + esc(title) + '</h1><p class="meta">' + esc(meta) + ' · Deep Notes</p><div class="md">' + printable + '</div></body></html>';
}

// —— 导出 PDF：把正文排成打印版 HTML 塞进隐藏 iframe，调起系统打印（目标选「另存为 PDF」）。
// 全程本地渲染，不新增联网出口；Electron 桌面版与浏览器通用 ——
function printArticle({title, meta, html}) {
  const iframe = document.createElement('iframe');
  // 审计 M4：禁脚本沙箱——iframe 只承担排版打印，不执行任何 JS；同源访问保留给
  // doc.write 与 resolveAllInDoc（引用图解析），allow-modals 放行 win.print() 调系统打印
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write(buildArticleHtml({title, meta, html}));
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
function ReadFull({r, graph, onClose, onGo, onOpenContent}) {
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
  const byName = useMemo(() => nameIndex(graph.nodes), [graph]);
  const jump = e => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    // 块引用 [[笔记#小节]]：目标是当前这篇时滚动到对应小节，否则跳到目标内容
    const {id, anchor} = resolveTarget(byName, a.dataset.target);
    if (!id) return;
    if (anchor && id === r.id) { scrollToAnchor(box.current, anchor); return; }
    // 双链就地打开目标内容（与 ArticleView 一致）；跳到别篇后关掉弹窗，避免页面在弹窗背后切换
    (onOpenContent || onGo)(id);
    if (onOpenContent) onClose();
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
      {!src && tocOn && outline.length > 0 && <TocPanel outline={outline} cur={-1} jump={jumpHead} docId={r.id}/>}
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
const PAGES = [...navs.map(n => n[0]), 'concepts', 'private'];
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

// 闪念箱合并（盘上 meta ∪ 本机）：按 id 去重，本机优先，按时间倒序——换机拿到全部、
// 同机不丢最新一条；两条来源都在时不会互相覆盖出重复。
const mergeInbox = (incoming, local) => {
  const map = new Map();
  for (const x of (Array.isArray(incoming) ? incoming : [])) if (x?.id) map.set(x.id, x);
  for (const x of (Array.isArray(local) ? local : [])) if (x?.id) map.set(x.id, x);
  return [...map.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
};

// 手动空分类合并（盘上 meta ∪ 本机，审计 B8）：分类就是字符串数组，并集去重——
// 换机拿到全部手动空分类，本机新建的不丢；并集优先宁多勿丢，删除语义不做。
const mergeFolders = (incoming, local) => [...new Set(
  [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(local) ? local : [])]
    .filter(x => typeof x === 'string' && x.trim())
)].sort();

// —— 改名联动双链：标题从 A 改成 B 时，他篇正文里的 [[A]]（含 [[A|别名]]、[[A#小节]]）同步换成
// [[B]]——否则改名后旧双链当场变成断链。六类正文全部扫一遍，改动经全局 diff 自动写盘。
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');



function App() {
  // 知识库引用图（![[名字]] / 相对路径）：所有 .md-preview 里新出现的 <img> 自动经 vault:asset 回填
  useVaultImages();
  const [page, setPage] = useState(initialPage);
  const [goal, setGoal] = useSaved(CONFIG.storagePrefix + '-goal-v1', 8);
  const [works, setWorks] = useWorks();
  const [wsName, setWsName] = useSaved(CONFIG.storagePrefix + '-workspace-v1', CONFIG.workspace);
  const [ideas, setIdeas] = useSaved(CONFIG.storagePrefix + '-ideas-v1', VAULT_MODE ? [] : seedIdeas);
  const [drafts, setDrafts] = useSaved(CONFIG.storagePrefix + '-drafts-v1', VAULT_MODE ? [] : seedDrafts);
  const [snap, setSnap] = useSaved(CONFIG.storagePrefix + '-snapshot-v1', snapshot);
  const [kbConcepts, setKbConcepts] = useSaved(CONFIG.storagePrefix + '-concepts-v1', VAULT_MODE ? [] : CONCEPTS);
  const [notes, setNotes] = useSaved(CONFIG.storagePrefix + '-notes-v1', VAULT_MODE ? [] : SEED_NOTES);
  const [inbox, setInbox] = useSaved(CONFIG.storagePrefix + '-inbox-v1', []); // 闪念箱：随手记的想法
  const [readings, setReadings] = useSaved(CONFIG.storagePrefix + '-readings-v1', VAULT_MODE ? [] : seedReadings);
  const [archives, setArchives] = useSaved(CONFIG.storagePrefix + '-archives-v1', VAULT_MODE ? [] : seedArchives);
  // 方法库二级分类：path 第二段推导 + 手动新建的空分类（-folders-v1 只存空分类，导入/切回示例时清空）
  const [folders, setFolders] = useSaved(CONFIG.storagePrefix + '-folders-v1', []);
  // 阅读区左侧分类：reading.folder 推导 + 手动新建的空分类（-read-folders-v1 只存空分类，导入/切回示例时清空）
  const [readFolders, setReadFolders] = useSaved(CONFIG.storagePrefix + '-read-folders-v1', []);
  // 闪念箱 / 手动空分类随库走（B8）：启动灌入 meta 完成后的改动才回写（避免用初始空数组
  // 覆盖盘上的旧数据）；概念定义 / 段落闪卡的写入口在 conceptStore，这里注入同一个 meta 落盘器。
  const metaReady = useRef(false);
  useEffect(() => {
    setConceptSink((key, val) => patchMeta({[key]: val}));
    return () => setConceptSink(null);
  }, []);
  useEffect(() => {
    if (!metaReady.current) return;
    patchMeta({inbox});
  }, [inbox]);
  useEffect(() => {
    if (!metaReady.current) return;
    patchMeta({folders, readFolders}); // 空数组也写：导入 / 切示例清空分类时同步清掉盘上记录
  }, [folders, readFolders]);
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
  const [mmSel, setMmSel] = useState(null); // 从文章生成的导图：打开浮动窗口后要选中的 id
  const [mmOpen, setMmOpen] = useState(false); // 思维导图浮动窗口开关
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  // 手动概念关键词（概念内页编辑）并入词表：与导入概念按名字合并去重，随图谱一起参与正文提及匹配
  const extras = conceptExtras.use();
  const mergedConcepts = useMemo(() => kbConcepts.map(([n, terms]) => {
    const t = extras[n]?.terms;
    return t?.length ? [n, [...new Set([...(terms || []), ...t])]] : [n, terms || []];
  }), [kbConcepts, extras]);
  const slowWorks = useDeferredValue(works);
  const slowDrafts = useDeferredValue(drafts);
  // 六类内容全部延迟进图谱：works/drafts 之外，在方法笔记/阅读/档案/选题里打字也不必
  // 每个按键同步重算整张图（大库 O(n²) 力导向布局会把输入卡成「界面刷新」）
  const slowNotes = useDeferredValue(notes);
  const slowReadings = useDeferredValue(readings);
  const slowArchives = useDeferredValue(archives);
  const slowIdeas = useDeferredValue(ideas);
  const graph = useMemo(() => buildGraph({works: slowWorks, notes: slowNotes, ideas: slowIdeas, drafts: slowDrafts, readings: slowReadings, archives: slowArchives, concepts: mergedConcepts}), [slowWorks, slowNotes, slowIdeas, slowDrafts, slowReadings, slowArchives, mergedConcepts]);
  // 布局按「节点 + 连接」签名缓存：改定义 / 改正文 / 移动文件不改变图的拓扑，复用上一次
  // 布局结果（力导向迭代是 O(迭代×节点²)，大库重算一次要数秒，视觉上就是整体刷新）
  const layoutKey = useMemo(() => graph.nodes.map(n => n.id).join('\u0001') + '\u0002' + graph.links.map(l => l.a + '|' + l.b + '|' + l.kind).join('\u0001'), [graph]);
  const layoutCache = useRef({key: null, val: null});
  const layout = useMemo(() => {
    if (layoutCache.current.key === layoutKey) return layoutCache.current.val;
    layoutCache.current = {key: layoutKey, val: forceLayout(graph)};
    return layoutCache.current.val;
  }, [layoutKey, graph]);

  // 页面切换：保留各页面的滚动位置（sessionStorage，刷新后仍能回到上次位置），首次进入该页才回到顶部
  useEffect(() => {
    history.replaceState(null, '', page === 'home' ? location.pathname : '#' + page);
    const key = `dn-scroll-${page}`;
    const saved = sessionStorage.getItem(key);
    window.scrollTo({top: saved ? parseInt(saved, 10) || 0 : 0});
  }, [page]);
  // 离开页面时保存当前滚动位置
  useEffect(() => {
    const onLeave = () => { try { sessionStorage.setItem(`dn-scroll-${page}`, String(window.scrollY)); } catch (_) {} };
    window.addEventListener('beforeunload', onLeave);
    return () => { onLeave(); window.removeEventListener('beforeunload', onLeave); };
  }, [page]);
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
  // adoptThrough：adoptData 整体替换后的第一轮 diff 是否写透盘。导入 / 恢复快照 = true
  // （新副本要靠这轮全量写盘生成内容）；启动读盘与外部改动同步 = false——内存刚被盘上
  // 内容灌满，照常 diff 会把全库每个文件重写一遍（mtime 全变、iCloud 全量重传），必须抑制。
  const adoptThrough = useRef(true);
  useEffect(() => {
    const cur = {works, notes, drafts, readings, archives, ideas};
    const prev = prevContent.current;
    prevContent.current = cur;
    if (!adoptThrough.current) { adoptThrough.current = true; return; } // adopt 灌入不算编辑
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
    const bye = () => { flushPendingSaves(); if (capable()) flushSyncNow(); recordDaily(totalChars(contentRef.current)); };
    window.addEventListener('beforeunload', bye);
    return () => window.removeEventListener('beforeunload', bye);
  }, []);
  // 写作统计：内容变化后防抖 5 秒记一次当日全库字数快照（当日取最大值，删除不产生负增量）
  useEffect(() => {
    const t = setTimeout(() => recordDaily(totalChars({works, notes, drafts, readings, archives})), 5000);
    return () => clearTimeout(t);
  }, [works, notes, drafts, readings, archives]);

  // —— 挂起写：上次会话有重试后仍失败的写盘操作 ——
  // 此刻自动同步会用旧文件夹内容覆盖浏览器里更新的数据，必须先由用户裁决（重试 / 放弃）
  const [pendingWrites, setPendingWrites] = useState(() => capable() && !!getRoot() && hasPendingWrites());
  // 读盘门：磁盘唯一事实源模式下，首次读盘完成前界面不渲染——内存此时还是空占位，
  // 提前露出会让用户在假空库里误编辑（把示例/空内容写进真知识库）。Intro 开屏动画正好覆盖常规加载耗时。
  const [vaultReady, setVaultReady] = useState(!VAULT_MODE);
  // 挂起记录随写盘结果实时增减（本轮写盘失败留底 / 成功补写或重试成功清除），横幅状态跟随
  useEffect(() => {
    const sync = () => setPendingWrites(capable() && !!getRoot() && hasPendingWrites());
    window.addEventListener('deepnotes-pending-changed', sync);
    // 留底的 IndexedDB 兜底也写不进（审计 v2-⑧）：留底只在本会话内存里，用户必须知道
    const failNote = () => showGlobalNotice('挂起写盘留底失败（localStorage 与 IndexedDB 均不可用），未落盘的修改仅保留在本次会话内存中，请尽快重试写盘或导出备份 · Pending backup unavailable');
    window.addEventListener('deepnotes-pending-persist-failed', failNote);
    // 附属数据（概念定义 / 复习进度 / 闪念箱 / 空分类）写库失败：不静默，让用户知道这次改动没落盘
    const metaFail = () => showGlobalNotice('附属数据未能写入知识库（.deepnotes/meta.json 读写失败），本次的概念定义 / 复习进度等改动可能未保存 · Meta write failed');
    window.addEventListener('deepnotes-meta-write-failed', metaFail);
    // IndexedDB 补灌完成后再对齐一次（审计 v2-⑦）：补灌事件可能早于本监听器注册，只靠事件会漏
    pendingReady.then(sync).catch(() => {});
    return () => {
      window.removeEventListener('deepnotes-pending-changed', sync);
      window.removeEventListener('deepnotes-pending-persist-failed', failNote);
      window.removeEventListener('deepnotes-meta-write-failed', metaFail);
    };
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
    const t = (String(it.text || '').split('\n')[0] || '闪念笔记').slice(0, 24).replace(/[/\\]/g, '·');
    const nid = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
    const base = `05-方法库 methods/闪念/${t}.md`;
    // 路径分配必须进 updater 用最新 notes 查重：连续转两条闪念时渲染闭包里的 notes 是旧值，会撞路径
    setNotes(ns => [{id: nid, title: t, path: uniqueNotePath(base, noteTaken(ns, nid), nid), body: `${it.text}\n`}, ...ns]);
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
    // 计数在渲染期一次算完再提交（写进惰性 updater 会被 React 提前求值 / StrictMode 双调用打乱）
    let n = 0;
    const conv = body => String(body || '').split(/(\[\[[^\]]*\]\])/g).map(seg => seg.startsWith('[[') ? seg
      : seg.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), () => { n++; return `[[${t}]]` })).join('');
    const next = {
      works: works.map(x => x.title !== t ? {...x, body: conv(x.body)} : x),
      notes: notes.map(x => x.title !== t ? {...x, body: conv(x.body)} : x),
      drafts: drafts.map(x => x.title !== t ? {...x, body: conv(x.body)} : x),
      readings: readings.map(x => x.title !== t ? {...x, body: conv(x.body)} : x),
      archives: archives.map(x => x.title !== t ? {...x, body: conv(x.body)} : x),
    };
    setWorks(next.works); setNotes(next.notes); setDrafts(next.drafts);
    setReadings(next.readings); setArchives(next.archives);
    setToast(n ? `已在正文中接通 ${n} 处 [[${t}]] · Linked` : '没有找到可转换的提及 · No plain mentions');
  }
  // —— 方法笔记 CRUD：重命名同步 path 文件名；新建/删除都只影响本浏览器 ——
  // 方法笔记 path 分配：同一相对路径只属于一条笔记（否则写盘同键覆盖、正文静默丢失）。
  // 统一走 fileStore.uniqueNotePath：有冲突时追加 id 短码，再不行递增 -2.md。
  const noteTaken = (list, excludeId) => new Map(list.filter(x => x.id !== excludeId && x.path).map(x => [x.path, x.id]));
  // 改名联动双链：计数在 updater 外用当前闭包数组算（updater 里累加会在执行前就被读到，
  // 计数恒偏小——linkifyMentions 注释点名的同一反模式）；应用走函数式 updater 且
  // 未命中的条目保持原对象身份，不触发无谓的全量写盘
  const renameWikiRefs = (oldTitle, newTitle) => {
    const a = String(oldTitle || '').trim(), b = String(newTitle || '').trim();
    if (!a || !b || a === b) return 0;
    const re = new RegExp(`\\[\\[\\s*${escapeRe(a)}\\s*(#[^\\]|\\n]*)?(\\|[^\\]\\n]*)?\\]\\]`, 'g');
    const conv = body => String(body || '').replace(re, (_, anchor, alias) => `[[${b}${anchor || ''}${alias || ''}]]`);
    let n = 0;
    const cur = {works, notes, drafts, readings, archives};
    const setters = {works: setWorks, notes: setNotes, drafts: setDrafts, readings: setReadings, archives: setArchives};
    for (const kind of Object.keys(cur)) {
      const count = (cur[kind] || []).reduce((s, x) => s + ((String(x.body || '').match(re) || []).length), 0);
      if (!count) continue;
      n += count;
      setters[kind](list => (list || []).map(x => {
        const body = String(x.body || '');
        if (!body.includes('[[')) return x;
        const next = conv(body);
        return next === body ? x : {...x, body: next};
      }));
    }
    return n;
  };
  // 标题输入是逐键事件：不能每个按键都联动（中间态会污染全库双链），攒到停手 1.2s 后
  // 用「第一次变更前的旧名 → 最终新名」一次性替换；期间换了别的条目在改名则先冲掉前一个
  const renameSync = useRef(null); // {id, from, to, timer}
  function queueRenameRefs(id, from, to) {
    const fire = job => {
      const n = renameWikiRefs(job.from, job.to);
      if (n) setToast(`标题已改，${n} 处 [[双链]] 引用同步更新 · Links synced`);
    };
    if (renameSync.current && renameSync.current.id !== id) {
      clearTimeout(renameSync.current.timer);
      const prev = renameSync.current;
      renameSync.current = null;
      if (prev.from !== prev.to) fire(prev);
    }
    if (renameSync.current) renameSync.current.to = to;
    else renameSync.current = {id, from, to, timer: null};
    clearTimeout(renameSync.current.timer);
    renameSync.current.timer = setTimeout(() => {
      const job = renameSync.current;
      renameSync.current = null;
      if (job && job.from !== job.to) fire(job);
    }, 1200);
  }
  function updateNote(id, patch) {
    // 标题变化时联动更新他篇 [[双链]]（旧名引用不再断链）
    if (patch.title != null) {
      const old = notes.find(n => n.id === id);
      if (old && String(old.title).trim() !== String(patch.title).trim()) {
        queueRenameRefs(id, String(old.title).trim(), String(patch.title).trim());
      }
    }
    // 路径分配进 updater：用最新 notes 查重；文件名统一走 safeName（截断 60、分隔符换 ·），
    // 且 path 缺失 / 无 .md 时按目录重建文件名，标题与磁盘文件名不再脱节。
    setNotes(ns => ns.map(n => {
      if (n.id !== id) return n;
      const next = {...n, ...patch};
      if (patch.title != null) {
        const safe = safeName(patch.title);
        const base = /\/$/.test(String(n.path || '')) || !/\.md$/i.test(String(n.path || ''))
          ? `${(String(n.path || '').replace(/[^/]+$/, '') || '05-方法库 methods/笔记/')}${safe}.md`
          : String(n.path).replace(/[^/]+\.md$/, `${safe}.md`);
        next.path = uniqueNotePath(base, noteTaken(ns, id), id);
      }
      return next;
    }));
  }
  function addNote() {
    const t = '新建方法笔记';
    const id = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5); // 同毫秒点击也不撞 id
    setNotes(ns => {
      const taken = noteTaken(ns, id);
      let name = t, n = 1;
      while (taken.has(`05-方法库 methods/新建/${name}.md`)) name = `${t} ${++n}`; // 连点多次各占一个文件
      const path = uniqueNotePath(`05-方法库 methods/新建/${name}.md`, taken, id);
      return [{id, title: name, path, body: `# ${name}\n\n`}, ...ns];
    });
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
    // 路径分配进 updater：拖拽连点时闭包里的 notes 可能过期
    setNotes(ns => ns.map(x => x.id === id ? {...x, path: uniqueNotePath(notePathIn(x, folder), noteTaken(ns, id), id)} : x));
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
    setNotes(ns => {
      const taken = new Map(ns.filter(n => subOf(n) !== from && n.path).map(n => [n.path, n.id]));
      return ns.map(n => {
        if (subOf(n) !== from) return n;
        const path = uniqueNotePath(notePathIn(n, t), taken, n.id);
        taken.set(path, n.id); // 同批搬家也不能两条落同一个文件
        return {...n, path};
      });
    });
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
    setNotes(ns => {
      const taken = new Map(ns.filter(n => subOf(n) !== name && n.path).map(n => [n.path, n.id]));
      return ns.map(n => {
        if (subOf(n) !== name) return n;
        const path = uniqueNotePath(notePathIn(n, TRASH_FOLDER), taken, n.id);
        taken.set(path, n.id);
        return {...n, path};
      });
    });
    setFolders(fs => fs.filter(f => f !== name));
    setToast(`分类「${name}」已删除 · Folder deleted`);
  }
  // —— 笔记合并：两篇拼成一篇新笔记（正文拼接、双链随正文归并），原两篇经全局 diff 进回收站 ——
  function mergeNotes(aId, bId) {
    const a = notes.find(n => n.id === aId), b = notes.find(n => n.id === bId);
    if (!a || !b || a.id === b.id) return;
    if (!window.confirm(`把《${b.title || '未命名'}》合并进《${a.title || '未命名'}》？\n\n将生成一篇新笔记（正文拼接、[[双链]]随正文归并），原两篇移入知识库回收站（30 天内可找回）。`)) return;
    const nid = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
    const title = safeName(`${a.title || '未命名'} ＋ ${b.title || ''}`.replace(/\s＋\s*$/, '') || '合并笔记');
    const folder = subOf(a);
    const body = `${a.body || ''}${(a.body || '').trim() && (b.body || '').trim() ? '\n\n---\n\n' : ''}${b.body || ''}`;
    setNotes(ns => {
      const rest = ns.filter(n => n.id !== a.id && n.id !== b.id);
      const path = uniqueNotePath(`05-方法库 methods/${folder}/${title}.md`, new Map(rest.filter(x => x.path).map(x => [x.path, x.id])), nid);
      return [{id: nid, title, path, body}, ...rest];
    });
    // 外部指向 A、B 的 [[双链]] 一并改指向合并后的新笔记（确认框承诺的「双链归并」）
    renameWikiRefs(a.title, title);
    renameWikiRefs(b.title, title);
    setMethSel(nid); setPage('methods');
    setToast('已合并为一篇新笔记，原两篇进回收站 · Merged');
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
  // 选题 id：优先沿用全数字（示例数据 / 旧库），同时避开已有的字符串 id
  const nextIdeaId = list => {
    const used = new Set(list.map(x => String(x.id)));
    let n = Math.max(0, ...list.map(x => (/^\d+$/.test(String(x.id)) ? Number(x.id) : 0))) + 1;
    while (used.has(String(n))) n++;
    return n;
  };
  function moveContent(fromKind, rawId, toKind) {
    if (fromKind === toKind) return;
    const raw = String(rawId || '');
    const id = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const stamp = nowStamp();
    let moved = null;
    // 来源选中态在 updater 外面清理（渲染期副作用会重复执行）：搬走的条目已不存在，界面不能停在它身上
    let rest = null;
    if (fromKind === 'post') {
      const w = works.find(x => x.id === id); if (!w) return;
      moved = {title: w.title, body: w.body || '', tags: w.tags || []};
      rest = works.filter(x => x.id !== id);
      setWorks(rest);
      setLibSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
      setOpenArticle(a => a === id ? null : a);
    } else if (fromKind === 'note') {
      const n = notes.find(x => x.id === id); if (!n) return;
      moved = {title: n.title, body: n.body || ''};
      const src = subOf(n);
      rest = notes.filter(x => x.id !== id);
      setNotes(rest);
      setMethSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
      // 移走后原分类空了就自动移除，不留空分类
      if (!rest.some(x => subOf(x) === src) && folders.includes(src)) setFolders(fs => fs.filter(f => f !== src));
    } else if (fromKind === 'draft') {
      const d = drafts.find(x => x.id === id); if (!d) return;
      moved = {title: d.title, body: d.body || ''};
      rest = drafts.filter(x => x.id !== id);
      setDrafts(rest);
      setActive(a => a === id ? rest[0]?.id : a);
    } else if (fromKind === 'reading') {
      const r = readings.find(x => x.id === id); if (!r) return;
      moved = {title: r.title, body: r.body || ''};
      const src = readFolderOf(r);
      rest = readings.filter(x => x.id !== id);
      setReadings(rest);
      if (!rest.some(x => readFolderOf(x) === src) && readFolders.includes(src)) setReadFolders(fs => fs.filter(f => f !== src));
      setReadSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
      setReadOpen(o => o === id ? null : o);
    } else if (fromKind === 'archive') {
      const a = archives.find(x => x.id === id); if (!a) return;
      moved = {title: a.title, body: a.body || ''};
      rest = archives.filter(x => x.id !== id);
      setArchives(rest);
      setArcSel(sel => sel === id ? (rest[0]?.id ?? null) : sel);
      setArcOpen(o => o === id ? null : o);
    } else if (fromKind === 'idea') {
      const it = ideas.find(x => String(x.id) === String(id)); if (!it) return;
      moved = {title: it.title, body: it.note || ''};
      setIdeas(is => is.filter(x => String(x.id) !== String(id)));
    }
    if (!moved) return;
    if (toKind === 'works') setWorks(ws => [normalizeWork({...moved, date: stamp, tags: moved.tags || []}), ...ws]);
    else if (toKind === 'methods') {
      const nid = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
      // 文件名安全化：标题里的 / 与 \ 不能进路径（否则写盘时会被当成子目录）；路径查重进 updater
      const safe = safeName(moved.title);
      setNotes(ns => [{id: nid, title: moved.title, path: uniqueNotePath(`05-方法库 methods/新建/${safe}.md`, noteTaken(ns, nid), nid), body: moved.body}, ...ns]);
    }
    else if (toKind === 'drafts') setDrafts(ds => [{id: 'draft-' + Date.now(), title: moved.title, body: moved.body, source: null}, ...ds]);
    else if (toKind === 'ideas') setIdeas(is => [...is, {id: nextIdeaId(is), title: moved.title, platform: '', priority: '中', status: '待写', note: (moved.body || '').slice(0, 120)}]);
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
    if (patch.title != null) {
      const old = works.find(w => w.id === id);
      if (old && String(old.title).trim() !== String(patch.title).trim()) {
        const n = renameWikiRefs(old.title, patch.title);
        if (n) setToast(`标题已改，${n} 处 [[双链]] 引用同步更新 · Links synced`);
      }
    }
    setWorks(ws => ws.map(w => w.id === id ? {...w, ...patch, updatedAt: nowStamp()} : w));
  }
  function saveWork() {
    if (!editingWork?.title.trim()) return;
    const old = works.find(w => w.id === editingWork.id);
    if (old && String(old.title).trim() !== String(editingWork.title).trim()) {
      const n = renameWikiRefs(old.title, editingWork.title);
      if (n) setToast(`标题已改，${n} 处 [[双链]] 引用同步更新 · Links synced`);
    }
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
  // —— 文件恢复：从快照网找回被覆盖的内容（recovery.jsx 的两个回调）——
  // 就地恢复的字段口径：notes 不含 path（不回退外部对文件路径的改名）；选题不参与（位置 id）
  const RECOVER_PATCH = {
    works: ['title', 'date', 'direction', 'tags', 'body'],
    notes: ['title', 'body'],
    drafts: ['title', 'body', 'source'],
    readings: ['title', 'author', 'source', 'folder', 'date', 'body'],
    archives: ['title', 'date', 'body'],
  };
  const RECOVER_KIND_ZH = {works: '文章', notes: '方法笔记', drafts: '草稿', readings: '阅读', archives: '档案'};
  function patchItem(kind, id, patch) {
    if (kind === 'works') updateWork(id, patch);
    else if (kind === 'notes') updateNote(id, patch);
    else if (kind === 'drafts') setDrafts(ds => ds.map(d => d.id === id ? {...d, ...patch, updatedAt: nowStamp()} : d));
    else if (kind === 'readings') updateReading(id, patch);
    else if (kind === 'archives') updateArchive(id, patch);
  }
  function restoreSnapVersion(s) {
    const arr = {works, notes, drafts, readings, archives}[s.kind] || [];
    const cur = arr.find(x => String(x.id) === String(s.id));
    if (!cur) { setToast('该内容已不存在，试试「文件历史」里的恢复为副本 · Item no longer exists'); return; }
    const at = new Date(s.ts).toLocaleString();
    if (!window.confirm(`把${RECOVER_KIND_ZH[s.kind] || '内容'}「${cur.title || '未命名'}」恢复到 ${at} 的版本？当前内容会被覆盖。`)) return;
    const patch = {};
    for (const k of RECOVER_PATCH[s.kind] || []) patch[k] = s.item?.[k] ?? (k === 'tags' ? [] : null);
    patchItem(s.kind, s.id, patch);
    setModal(null);
    setToast(`已恢复「${cur.title || '未命名'}」的旧版本（${at}） · Version restored`);
  }
  async function restoreFileCopy(entry) {
    const body = await readFileSnapshot(entry.file);
    if (body == null) { setToast('快照读取失败 · Failed to read snapshot'); return; }
    const rel = String(entry.rel || '');
    const hit = [['02-作品库', 'works'], ['03-创作台', 'drafts'], ['06-阅读区', 'readings'], ['07-档案区', 'archives']].find(([d]) => rel.startsWith(d));
    const kind = hit ? hit[1] : 'notes';
    const title = (rel.split('/').pop().replace(/\.md$/i, '') || '未命名') + '（恢复）';
    // 快照是「覆盖前」的完整文件：剥掉 frontmatter 只取正文，恢复成全新条目（新 id 不与现有撞车；
    // 恢复走全局 diff 自动写盘，写盘前主进程又会把当前盘上版本拍进快照——恢复动作本身也可撤销）
    const text = body.replace(/^---\r?\n[\s\S]*?\n---\r?\n?/, '');
    if (kind === 'works') {
      const w = normalizeWork({title, date: nowStamp(), tags: [], body: text});
      setWorks(ws => [w, ...ws]); setLibSel(w.id); setPage('library');
    } else if (kind === 'drafts') {
      const d = {id: 'draft-' + Date.now(), title, body: text, source: null};
      setDrafts(ds => [d, ...ds]); setActive(d.id); setPage('drafts');
    } else if (kind === 'readings') {
      const r = {id: 'reading-' + Date.now(), title, author: '', source: '', date: nowStamp().slice(0, 10), body: text};
      setReadings(rs => [r, ...rs]); setReadSel(r.id); setPage('readings');
    } else if (kind === 'archives') {
      const a = {id: 'archive-' + Date.now(), title, date: nowStamp().slice(0, 10), body: text};
      setArchives(as => [a, ...as]); setArcSel(a.id); setPage('archives');
    } else {
      const id = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
      setNotes(ns => [{id, title, path: uniqueNotePath(`05-方法库 methods/恢复/${safeName(title)}.md`, noteTaken(ns, id), id), body: text}, ...ns]);
      setMethSel(id); setPage('methods');
    }
    setModal(null);
    setToast('已恢复为副本（新建条目，现有内容不动） · Restored as copy');
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
        const id = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
        const safe = safeName(t);
        setNotes(ns => [{id, title: t, path: uniqueNotePath(`05-方法库 methods/新建/${safe}.md`, noteTaken(ns, id), id), body: `# ${t}\n`}, ...ns]);
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
    // 联动双链走同一条防抖队列（与 updateNote 共用 from→to 串联，避免双入口交叉改名错向）
    const cur = notes.find(n => 'note:' + n.id === gid);
    if (cur && String(cur.title).trim() !== t) queueRenameRefs(cur.id, String(cur.title).trim(), t);
    setNotes(ns => ns.map(n => {
      if ('note:' + n.id !== gid) return n;
      const base = String(n.path || `05-方法库 methods/笔记/${t}.md`).replace(/[^/]+$/, t + '.md');
      return {...n, title: t, path: uniqueNotePath(base, new Map(ns.filter(x => x.id !== n.id && x.path).map(x => [x.path, x.id])), n.id)};
    }));
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
      const id = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5); const safe = safeName(t);
      setNotes(ns => [{id, title: t, path: uniqueNotePath(`05-方法库 methods/AI/${safe}.md`, noteTaken(ns, id), id), body: body || `# ${t}\n`}, ...ns]);
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
      const safeTitle = patch.title ? safeName(patch.title) : patch.title; // 文件名安全化（含 60 截断，与 updateNote 同规则）
      setNotes(ns => ns.map(x => {
        if (x.id !== id) return x;
        const next = {...x, ...patch};
        // path 缺失时只改内容不改路径（审计 v2-⑤）；改名查重用 updater 里的最新 notes
        if (safeTitle && x.path) next.path = uniqueNotePath(String(x.path).replace(/[^/]+$/, safeTitle + '.md'), noteTaken(ns, id), id);
        return next;
      }));
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
    // 正文节选取整段前 8000 字：长文写作时 AI 需要足够上下文（此前 1000 字经常不够用）
    if (page === 'drafts') { const d = drafts.find(x => x.id === active) || drafts[0]; return {page: '创作台 Drafts', title: d?.title, excerpt: (d?.body || '').slice(0, 8000)}; }
    if (page === 'library') { const w = works.find(x => x.id === (openArticle || libSel)); return {page: '作品库 Works', title: w?.title, excerpt: (w?.body || '').slice(0, 8000)}; }
    const sel = focus?.sel && graph.index.get(focus.sel);
    return {page: '工作台 Workspace', title: sel?.title, excerpt: (sel?.body || '').slice(0, 8000)};
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
    // 磁盘唯一事实源：连接知识库时内容快照缺位——盘上 .md 本身就是事实源，另有主进程写前
    // 快照与应用内 IndexedDB 快照网兜底，localStorage 全量快照（5MB 配额高危户）不再需要
    if (VAULT_MODE) return;
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
  // through（写透开关）：这次整体替换后的第一轮 diff 要不要写盘。导入（新副本要生成全部
  // 文件）与恢复快照（备份要写回知识库）= true；启动读盘 / 外部改动同步 = false——内容刚
  // 从盘上灌进内存，写透会把全库重写一遍。见 diff-writer 里的 adoptThrough。
  // preserveView（视图保留）：自动同步 = true——页面、打开的全文、选中态原地保留，
  // 只清掉已被外部删除的条目的选中态；导入 / 切示例 / 恢复快照 = false，整体重置回工作台。
  function adoptData(data, msg, keepFolders = false, through = true, preserveView = false) {
    // 概念词表合并而非覆盖：应用内改过的关键词与手动增删的概念（current）优先，
    // 词表里没有的（导入 / 同步带回的新词）补进来。直接覆盖会抹掉用户在概念内页的全部修改。
    // 代价（v1 接受）：应用内删除 / 改名的概念会在下次同步时被词表带回。
    const mergeConcepts = (incoming, current) => {
      const map = new Map((Array.isArray(current) ? current : []).map(([n, t]) => [n, t]));
      for (const [n, t] of (Array.isArray(incoming) ? incoming : [])) if (!map.has(n)) map.set(n, t);
      return [...map];
    };
    adoptThrough.current = through;
    saveSnapshot();
    setWorks(data.works); setNotes(data.notes ?? SEED_NOTES); setIdeas(data.ideas); setDrafts(data.drafts);
    setReadings(data.readings ?? seedReadings);
    setArchives(data.archives ?? seedArchives);
    setSnap(data.snapshot); setKbConcepts(mergeConcepts(data.concepts, kbConcepts));
    // keepFolders：自动同步 / 恢复快照不是「换库」，应用内手动建的空分类原样保留；
    // 全量导入 / 切回示例才是彻底替换，手动空分类随内容一起清掉
    if (!keepFolders) { setFolders([]); setReadFolders([]); }
    if (preserveView) {
      // 自动同步：界面原地不动（问题 6）——不跳页、不关弹窗；只把已被外部删除的条目的
      // 选中态清掉，避免界面停在已不存在的内容上
      const idSet = list => new Set((Array.isArray(list) ? list : []).map(x => String(x.id)));
      const wids = idSet(data.works), nids = idSet(data.notes ?? SEED_NOTES), dids = idSet(data.drafts);
      const rids = idSet(data.readings ?? seedReadings), aids = idSet(data.archives ?? seedArchives);
      setLibSel(s => s != null && !wids.has(String(s)) ? (data.works[0]?.id ?? null) : s);
      setOpenArticle(a => a != null && !wids.has(String(a)) ? null : a);
      setMethSel(s => s != null && !nids.has(String(s)) ? null : s);
      setActive(a => a != null && !dids.has(String(a)) ? data.drafts[0]?.id : a);
      setReadSel(s => s != null && !rids.has(String(s)) ? null : s);
      setReadOpen(o => o != null && !rids.has(String(o)) ? null : o);
      setArcSel(s => s != null && !aids.has(String(s)) ? null : s);
      setArcOpen(o => o != null && !aids.has(String(o)) ? null : o);
    } else {
      setLibSel(data.works[0]?.id ?? null); setActive(data.drafts[0]?.id);
      setReadSel(null); setReadOpen(null); setArcSel(null); setArcOpen(null);
      setFocus({mod: null, sel: null}); setOpenArticle(null); setPage('home');
      setModal(null);
    }
    setToast(msg);
  }
  function restoreSnapshot() {
    setPalette(false); setModal(null);
    let bak; // bak：备份内容；用 bak 而非 snap 命名，避免遮蔽外层的知识库信息 state
    try { bak = JSON.parse(localStorage.getItem(BACKUP_KEY)); } catch {}
    if (!bak || !Array.isArray(bak.works)) { setToast('没有可恢复的数据快照 · No snapshot'); return; }
    if (!window.confirm(`恢复 ${bak.at} 的数据快照？当前内容会先另存一份新快照（可再恢复回来），桌面版会写回知识库文件夹。`)) return;
    // 确认框承诺的「先另存一份新快照」：连库时 localStorage 全量快照缺位（saveSnapshot 直接
    // 返回），至少把内存里与备份有差异的条目存进应用内快照（IndexedDB），「文件恢复」可找回
    snapshotBeforeAdopt({works, notes, drafts, readings, archives},
      {works: bak.works ?? [], notes: bak.notes ?? SEED_NOTES, drafts: bak.drafts ?? [], readings: bak.readings ?? [], archives: bak.archives ?? []});
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
        // 新库的附属数据（闪念箱 / 概念定义 / 段落闪卡 / 手动空分类）与本机合并，再把本机版本写过去
        const meta = await loadMeta();
        if (meta) {
          hydrateConceptMeta(meta);
          if (Array.isArray(meta.inbox) && meta.inbox.length) setInbox(cur => mergeInbox(meta.inbox, cur));
          if (Array.isArray(meta.folders)) setFolders(cur => mergeFolders(meta.folders, cur));
          if (Array.isArray(meta.readFolders)) setReadFolders(cur => mergeFolders(meta.readFolders, cur));
        }
        metaReady.current = true;
        window.deepnotes?.vault?.watch?.(copy.dir); // 新库开始监听外部改动
      }
      else { await setRoot(null); window.deepnotes?.vault?.watch?.(null); setToast('无法创建知识库副本，本次导入只保存在浏览器 · Copy failed'); }
    }
    // 复用已有「 - Deep Notes」专属库时保留手动空分类（B8：它们刚刚从 meta 合并进来，
    // 不应被 adoptData keepFolders=false 误清后再空写盘上）；新建副本照常清空。
    adoptData(data, `已导入知识库：文章 ${data.counts.works} · 笔记 ${data.counts.notes} · 选题 ${data.counts.ideas} · 草稿 ${data.counts.drafts}${data.counts.readings ? ` · 阅读 ${data.counts.readings}` : ''}${data.counts.archives ? ` · 档案 ${data.counts.archives}` : ''}${copyDir ? ` · 已写入「${copyDir.replace(/\/+$/, '').split('/').pop()}」` : ''}`, reuse);
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
      // 导入的选题 id 可能是字符串（frontmatter deepnotes-id / 稳定散列），新增条目改用带时间戳的 id，避免与数字 id 撞车
      const stamp = 'idea-' + Date.now();
      setIdeas(mergeByTitle(ideas, fresh, (x, i) => ({...x, id: `${stamp}-${i}`}), ['title', 'platform', 'priority', 'status', 'note']));
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
    // 磁盘唯一事实源：断开库后下次启动回到 localStorage 模式——内容键里若还躺着连库期间的
    // 陈旧副本，重启会「复活」旧内容顶掉示例。断库即清，重启后干净地从种子数据开始。
    if (VAULT_MODE) {
      for (const k of [...VAULT_CONTENT_KEYS, WORKS_KEY]) { try { localStorage.removeItem(k); } catch {} }
    }
    adoptData({works: seedWorks(), notes: SEED_NOTES, ideas: seedIdeas, drafts: seedDrafts, readings: seedReadings, archives: seedArchives, snapshot, concepts: CONCEPTS}, '已切回示例数据 · Sample data restored');
  }

  // —— 多库快速切换：换根目录 → 重读附属数据 → 按启动首读口径灌入（等同重启后连上该库）——
  // metaReady 先关门：换库期间分类/闪念的变化不回写盘；附属数据按新库「替换」而非并集
  // （旧库的闪念/分类已在 setRoot 的 writeMetaNow 里落进旧库，不能跟着渗透到新库）。
  async function switchVault(dir) {
    if (!dir || dir === getRoot()) return;
    metaReady.current = false;
    await setRoot(dir); // 旧库队列先写尽、附属数据先落旧库
    window.deepnotes?.vault?.watch?.(dir);
    const meta = await loadMeta();
    if (meta) {
      hydrateConceptMeta(meta);
      if (Array.isArray(meta.inbox)) setInbox(meta.inbox);
      if (Array.isArray(meta.folders)) setFolders(meta.folders);
      if (Array.isArray(meta.readFolders)) setReadFolders(meta.readFolders);
    }
    metaReady.current = true;
    // force：用户亲自切库不算「文件数骤减」（内存里还是旧库条目，骤减守卫的基线对不上）
    const data = await syncRef.current({startup: true, force: true});
    if (!data?.counts?.all) showGlobalNotice('该知识库没有读到内容：确认文件夹还在原位，或先导入一次 · Vault appears empty');
  }

  // 批量替换的执行端：把命中正文整体替换（内部统一走正则；普通模式转义查找串 + 忽略大小写，
  // 且替换串里的 $ 按字面处理——普通模式用户预期没有 $& / $1 展开语义）
  function applyVaultReplace(scope, find, repl, useRe) {
    if (!find) return 0;
    let rx = null;
    if (useRe) { try { rx = new RegExp(find, 'g'); } catch { return 0; } }
    else rx = new RegExp(escapeRe(find), 'gi');
    const rep = useRe ? repl : String(repl).replace(/\$/g, '$$$$');
    let n = 0;
    const cur = {works, notes, drafts, readings, archives};
    const setters = {works: setWorks, notes: setNotes, drafts: setDrafts, readings: setReadings, archives: setArchives};
    for (const kind of Object.keys(cur)) {
      if (scope !== 'all' && scope !== kind) continue;
      const list = cur[kind] || [];
      const count = list.reduce((s, x) => s + ((String(x.body || '').match(rx) || []).length), 0); // 计数在 updater 外
      if (!count) continue;
      n += count;
      setters[kind](arr => (arr || []).map(x => {
        const s = String(x.body || '');
        if (!s) return x;
        const next = s.replace(rx, rep);
        return next === s ? x : {...x, body: next};
      }));
    }
    setToast(`已替换 ${n} 处 · ${n} replaced`);
    return n;
  }

  // —— 导出分享版：整个知识库打成一个自包含 HTML（内嵌全部正文，浏览器直接打开可读）——
  // 知识库引用图（![[x.png]]）在分享版里以文件名文本呈现；dataURL 粘贴图原样内嵌。
  async function exportVaultHtml() {
    setPalette(false); setModal(null);
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
    const MODULES_ZH = {works: '作品库', notes: '方法库', drafts: '创作台', readings: '阅读区', archives: '档案区'};
    const groups = [['works', works], ['notes', notes], ['drafts', drafts], ['readings', readings], ['archives', archives]]
      .map(([kind, items]) => ({kind, name: MODULES_ZH[kind], items: items.map(x => ({
        id: esc(kind + '-' + x.id), title: esc(x.title || '未命名'),
        meta: esc([kind === 'readings' ? x.author : '', kind === 'works' ? (x.date || '').slice(0, 10) : kind === 'notes' ? (x.path || '').split('/').slice(1).join(' / ') : (x.date || '').slice(0, 10)].filter(Boolean).join(' · ')),
        html: renderMarkdown(x.body || '')}))}))
      .filter(g => g.items.length);
    const total = groups.reduce((s, g) => s + g.items.length, 0);
    const chars = totalChars({works, notes, drafts, readings, archives});
    if (!total) { setToast('还没有可导出的内容 · Nothing to export'); return; }
    const now = new Date(), p = n => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(wsName)} · Deep Notes 分享版</title><style>
:root{color-scheme:dark}body{margin:0;background:#111413;color:#ddd8cc;font:14px/1.9 -apple-system,"PingFang SC","Segoe UI",sans-serif}
header.top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 22px;background:rgba(17,20,19,.92);backdrop-filter:blur(8px);border-bottom:1px solid #2c312e}
header.top h1{margin:0;font-size:16px;font-weight:600}header.top small{color:#98a29b}
main{display:grid;grid-template-columns:240px 1fr;min-height:calc(100vh - 53px)}
nav{border-right:1px solid #242927;padding:18px 10px 40px;overflow:auto;max-height:calc(100vh - 53px);position:sticky;top:53px}
nav h3{margin:14px 10px 6px;font-size:11px;color:#98a29b;letter-spacing:.08em}
nav a{display:block;padding:4px 10px;border-radius:7px;color:#c9c3b4;text-decoration:none;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav a:hover{background:#1d2220;color:#e8b45a}
article{padding:26px 34px 80px;max-width:860px}
article h2.dt{margin:8px 0 2px;font-size:22px}article p.dm{margin:0 0 26px;color:#98a29b;font-size:12px;border-bottom:1px solid #242927;padding-bottom:14px}
.md-preview{font-size:14.5px;line-height:1.95}.md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4{margin:1.4em 0 .5em;line-height:1.4}
.md-preview h1{font-size:20px}.md-preview h2{font-size:17px}.md-preview h3{font-size:15px}
.md-preview code{background:#1d2220;padding:1px 5px;border-radius:4px;font-size:12.5px}
.md-preview pre{background:#1d2220;padding:12px 14px;border-radius:9px;overflow:auto}.md-preview pre code{background:none;padding:0}
.md-preview blockquote{margin:.8em 0;padding:2px 14px;border-left:3px solid #4a4436;color:#b3ac9b}
.md-preview table{border-collapse:collapse}.md-preview th,.md-preview td{border:1px solid #333833;padding:5px 10px}
.md-preview img{max-width:100%}.md-preview a{color:#8fb7d8}
footer{grid-column:1/-1;padding:18px 22px;color:#6f7873;font-size:11.5px;border-top:1px solid #242927}
@media (max-width:760px){main{grid-template-columns:1fr}nav{position:static;max-height:none;border-right:0;border-bottom:1px solid #242927}}
</style></head><body>
<header class="top"><h1>${esc(wsName)} · Deep Notes 分享版</h1><small>${date} 生成 · ${total} 条 · ${chars.toLocaleString('zh-CN')} 字 · 本地导出，未联网</small></header>
<main><nav>${groups.map(g => `<h3>${esc(g.name)} · ${g.items.length}</h3>${g.items.map(x => `<a href="#${x.id}">${x.title}</a>`).join('')}`).join('')}</nav>
<article>${groups.map(g => g.items.map(x => `<section id="${x.id}"><h2 class="dt">${x.title}</h2><p class="dm">${g.name}${x.meta ? ' · ' + x.meta : ''}</p><div class="md-preview">${x.html}</div></section>`).join('<hr style="border:0;border-top:1px solid #242927;margin:34px 0">')).join('<hr style="border:0;border-top:1px solid #242927;margin:34px 0">')}</article>
</main><footer>由 Deep Notes 导出的只读快照 · Read-only snapshot exported by Deep Notes</footer></body></html>`;
    const blob = new Blob([html], {type: 'text/html;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Deep-Notes-分享版-${date}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setToast(`已导出 ${total} 条内容为单个 HTML（浏览器直接打开） · Exported`);
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
  // 单文件 HTML：自带排版样式，可直接发给别人用浏览器打开；不引用任何外部资源
  function exportCurrentHtml() {
    const cur = currentItem(); if (!cur?.item) return;
    setModal(null);
    const title = cur.item.title || '未命名';
    try {
      const doc = buildArticleHtml({title, meta: curMeta(cur), html: renderMarkdown(cur.item.body || ''), share: true});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([doc], {type: 'text/html;charset=utf-8'}));
      a.download = `${safeName(title)}.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      setToast(`已导出单文件 HTML《${title}》 · Shared`);
    } catch { setToast('导出失败 · Export failed'); }
  }

  // —— 文章 / 笔记 / 阅读 / 档案 → 思维导图：按标题层级建树（同源重复生成是更新），
  // 段落收为「¶ 摘句」叶节点；生成后跳导图页并选中，导图里可一键返回原文。
  function makeMapFor(kind, item) {
    if (!item) return;
    // source 用 openContent 认识的图谱 id 前缀（works→post 等），导图里「返回原文」才能直达
    const KIND_GID = {works: 'post', notes: 'note', drafts: 'draft', readings: 'reading', archives: 'archive'};
    const gid = (KIND_GID[kind] || kind) + ':' + item.id;
    const id = makeMapFromItem(gid, item.title, item.body || '');
    if (!id) return; // 用户取消了重新生成
    setMmSel(id);
    setMmOpen(true);
    setToast('思维导图已生成 / 更新 · Mind map ready');
  }

  // 桌面版打开软件自动同步：已连接知识库文件夹时重新读取文件夹内容（文件夹是唯一事实来源，
  // 应用内的编辑本来就会写回文件夹）。选题池同样落盘（04-选题池），随文件夹全量对齐。
  // 比对只看会写进文件的字段（忽略 updatedAt / capturedAt 等应用内字段），完全一致时静默返回。
  // 非破坏性增量保护：
  // 1) 有挂起写（上次写盘失败留底）时整体跳过——此刻同步会用旧文件夹内容覆盖浏览器里更新的数据；
  // 2) 文件数骤减（磁盘休眠 / 网盘未下载完 / 库被临时移走）时拒绝同步——「缺失」会被当成删除写回；
  // 3) iCloud 占位等「存在但读不到」的文件只排除出删除判定，对应内容原样保留，其余文件照常同步；
  // 4) 同步前先 flushAll 把防抖队列写尽再读文件——快照必须包含未落盘的编辑；
  // 5) 读文件期间又有新编辑（内存数组引用已变）则跳过本次采用并稍后重跑——否则 adopt 会用
  //    不含新编辑的文件版本回滚界面，diff 再把回滚内容写盘，编辑就真的丢了。
  const syncSeq = useRef(0);
  // 每次渲染对齐的最新内容引用：同步流程用它检测「读文件期间又有编辑」（闭包值仍是调用瞬间的）
  const contentRef = useRef(null);
  contentRef.current = {works, notes, drafts, readings, archives, ideas};
  // 返回值：读到并解析成功的 data（含 counts），任何失败 / 跳过返回 null。启动首读据此提示「没读到内容」。
  const syncFromVault = useCallback(async (opts) => {
    const startup = !!opts?.startup; // 启动首读：内存还是空占位，没有任何可被覆盖的编辑
    const force = !!opts?.force; // 用户显式换库（switchVault）：骤减守卫的基线还是旧库条目，必须跳过
    if (!capable() || !getRoot()) return null;
    await pendingReady; // IndexedDB 兜底的挂起写先灌回内存，再判定是否跳过同步（防覆盖）
    if (!startup && hasPendingWrites()) { setToast('上次有未写盘的修改，已跳过自动同步以防覆盖 · Sync skipped'); return null; }
    await flushAll(); // 先把防抖队列里的编辑写尽再读文件，快照才包含用户最新编辑
    if (!startup && hasPendingWrites()) return null; // 写尽后仍有留底（磁盘故障等）：跳过同步防覆盖，横幅已弹出
    const seq = ++syncSeq.current;
    const root = getRoot();
    let files, unreadable = [];
    try {
      const res = readVaultFiles(root, await window.deepnotes.vault.read(root));
      files = res.files; unreadable = res.unreadable;
    } catch { return null; }
    let data;
    try { data = await parseVault(files, getTarget()); } catch { return null; }
    if (seq !== syncSeq.current || !data.counts.all) return null;
    // 骤减守卫基线：会话内有内容时以内存条数为准——应用内删除已随 diff 写进 .trash，
    // 盘上不少于内存即属合法收缩（照常同步并在 same 分支收缩基线）；内存为空（启动首读）
    // 才用导入基线 FILES_KEY 兜底。此前取两者 max 且删除后从不收缩 FILES_KEY：删超 30%
    // 后自动同步被永久拦截，重启首读也被同一守卫拦成「空库」。
    const memCount = works.length + notes.length + drafts.length + readings.length + archives.length + ideas.length;
    const lastCount = memCount > 0 ? memCount : Math.max(Number(localStorage.getItem(FILES_KEY) || 0), 0);
    // 读不到的文件计入应读数：iCloud 占位不算「库被清空」；force（显式换库）不做骤减判定
    if (!force && data.counts.all + unreadable.length < lastCount * 0.7) {
      setToast(`知识库文件数量骤减（${lastCount} → ${data.counts.all}），已跳过自动同步以防误删；若确属有意删除，请重新导入一次该知识库 · Sync skipped`);
      return null;
    }
    // 与解析器同口径的归一化 + 按 id 顺序无关比对（vaultCompare）：自己写盘的回声、数组
    // 顺序差异、正文首尾空白、空指标 null↔0、media 缺省等往返差异都不再误判为「外部变更」。
    // 误判的代价是 adoptData 用盘上版本覆盖内存——重置页面 / 选中态、顶掉未落盘的移动。
    const same = sameVaultContent({works, notes, drafts, readings, archives, ideas}, data, kbConcepts);
    if (same) {
      if (unreadable.length) setToast(`知识库有 ${unreadable.length} 个文件暂时读不到（可能未从 iCloud 下载），相关内容保持原样 · Sync partial`);
      // 无变化也要收缩基线：应用内删除落盘后的回声同步走这里，FILES_KEY 不更新会越积越高
      try { localStorage.setItem(FILES_KEY, String(data.counts.all + unreadable.length)); } catch {}
      return data; // 文件夹没有变化就不打扰
    }
    // iCloud 占位：读不到的文件不参与删除判定，对应内容原样保留（与当前 state 同引用，
    // diff 写回时不会重写它们），其余内容照常对齐。选题不保留：数字 id 与读回内容必然撞车，
    // 保留副本还会对占位路径发起写盘；文件从 iCloud 下载完成后选题自然回来。
    let keepOld = null;
    if (unreadable.length) {
      const ghost = new Set(unreadable);
      // 真实磁盘路径优先：pathOf 是按标题反推的，标题 ≠ 文件名（外部导入的 .md 很常见）时匹配不上占位文件
      const relOfItem = (kind, x) => x.rel || pathOf(kind, x) || '';
      const cur = {works, notes, drafts, readings, archives};
      keepOld = {};
      for (const kind of Object.keys(cur)) {
        const fresh = new Set((data[kind] || []).map(x => relOfItem(kind, x)));
        keepOld[kind] = (cur[kind] || []).filter(x => { const r = relOfItem(kind, x); return r && ghost.has(r) && !fresh.has(r); });
      }
    }
    // 读文件期间用户又编辑过（内存数组引用已变）：本次快照不含这些新编辑，adopt 会把界面
    // 回滚成文件版本、diff 随后把回滚内容写盘。跳过本次采用并稍后重跑——新编辑会先被
    // flushAll 写盘，下轮快照自然包含它们，外部变更同样不会丢（重跑在用户停手 1.5s 后收敛）。
    const latest = contentRef.current;
    if (latest && (latest.works !== works || latest.notes !== notes || latest.drafts !== drafts ||
        latest.readings !== readings || latest.archives !== archives || latest.ideas !== ideas)) {
      setTimeout(() => syncRef.current(), 1500);
      return null;
    }
    // 外部文件版本即将覆盖内存：先把内存里有差异的条目存进应用内恢复快照（IndexedDB，每条 15 份），
    // 即使这次 adopt 是误覆盖，内容也能从「文件恢复」（About 或 ⌘K）里找回
    snapshotBeforeAdopt({works, notes, drafts, readings, archives}, data);
    const next = {
      works: keepOld ? [...(data.works || []), ...keepOld.works] : (data.works || []),
      notes: keepOld ? [...(data.notes ?? SEED_NOTES), ...keepOld.notes] : (data.notes ?? SEED_NOTES),
      ideas: data.ideas || [],
      drafts: keepOld ? [...(data.drafts || []), ...keepOld.drafts] : (data.drafts || []),
      readings: keepOld ? [...(data.readings ?? seedReadings), ...keepOld.readings] : (data.readings ?? seedReadings),
      archives: keepOld ? [...(data.archives ?? seedArchives), ...keepOld.archives] : (data.archives ?? seedArchives),
      snapshot: data.snapshot, concepts: data.concepts,
    };
    adoptData(next, `已同步知识库变更：文章 ${data.counts.works} · 笔记 ${data.counts.notes} · 选题 ${data.counts.ideas} · 草稿 ${data.counts.drafts}${data.counts.readings ? ` · 阅读 ${data.counts.readings}` : ''}${data.counts.archives ? ` · 档案 ${data.counts.archives}` : ''}${unreadable.length ? `（另有 ${unreadable.length} 个文件暂时读不到，已保持原样）` : ''}`, true, false, true); // 内容来自盘上：灌入不写透，避免全库重写；视图原地保留，不跳工作台
    try { localStorage.setItem(FILES_KEY, String(data.counts.all + unreadable.length)); } catch {} // 文件数基线含占位文件
    return data;
  }, [works, notes, ideas, drafts, readings, archives, kbConcepts, snap]);
  // —— 写作番茄钟：25 分钟专注 + 5 分钟休息。状态放 App（切页不中断）；倒计时秒级
  // 刷新只在创作台的徽标组件里做，App 树不必每秒重渲染。本轮写字数 = 草稿总字数相对起点增量。
  const [pomo, setPomo] = useState(null); // {phase: 'focus'|'break', endTs, baseChars}
  const draftsChars = () => drafts.reduce((s, d) => s + (d.body || '').length, 0);
  const startPomo = (focusMin = 25, breakMin = 5) => {
    const set = loadPomoSettings();
    if (set.noise && set.noise !== 'none') noiseStart(set.noise); // 专注期间白噪音，结束即停
    setPomo({phase: 'focus', endTs: Date.now() + focusMin * 60_000, baseChars: draftsChars(), breakMin});
  };
  useEffect(() => {
    if (!pomo) return;
    const t = setTimeout(() => {
      // 经 ref 读最新草稿字数：effect 闭包里的 draftsChars 是开始那一刻的快照，番茄钟走完早已过期
      const curChars = (contentRef.current.drafts || []).reduce((s, d) => s + (d.body || '').length, 0);
      noiseStop(); // 白噪音随专注结束停止（休息段保持安静）
      playRing(loadPomoSettings().sound); // 到时间响铃：默认滴滴（WebAudio 合成）或用户导入的音频
      if (pomo.phase === 'focus') {
        setToast(`🍅 专注完成（本轮 +${Math.max(0, curChars - pomo.baseChars).toLocaleString('zh-CN')} 字），休息 ${pomo.breakMin || 5} 分钟 · Focus done`);
        setPomo({phase: 'break', endTs: Date.now() + (pomo.breakMin || 5) * 60_000, baseChars: pomo.baseChars, breakMin: pomo.breakMin});
      } else { setToast('☕ 休息结束，继续写吧 · Break over, back to writing'); setPomo(null); }
    }, Math.max(0, pomo.endTs - Date.now()));
    return () => clearTimeout(t);
  }, [pomo]); // eslint-disable-line react-hooks/exhaustive-deps
  // 挂载跑一次启动首读，并开始监听外部改动：主进程 fs.watch 防抖 2s → 渲染层再防抖 3s → 同一比对
  // （应用自己写盘引发的回环只是多一次便宜的全量比对，无变化时静默，无害）。
  // 磁盘唯一事实源：启动先把上次没写成的挂起编辑补写进知识库（落盘才算数），再读盘灌入界面；
  // 首读完成才抬「读盘门」渲染主界面，门内内存还是空占位，不能让用户在假空库里编辑。
  const syncRef = useRef(syncFromVault);
  syncRef.current = syncFromVault;
  useEffect(() => {
    let alive = true, t = null;
    (async () => {
      try {
        if (VAULT_MODE) {
          await pendingReady; // IndexedDB 兜底的挂起写先灌回内存
          await retryPending().catch(() => {}); // 补写上次失败的编辑：写成的随首读自然带回界面
          // 附属数据（闪念箱 / 概念定义 / 段落闪卡 / 手动空分类）先与盘上 meta 合并，再允许回写；
          // 读不到就保持本机 localStorage 版本，且不写盘（防覆盖）。
          const meta = await loadMeta();
          if (meta) {
            hydrateConceptMeta(meta);
            if (Array.isArray(meta.inbox) && meta.inbox.length) setInbox(cur => mergeInbox(meta.inbox, cur));
            // B8：手动空分类随库合并——换机后另一台机器建的分类也能出现在本机
            if (Array.isArray(meta.folders)) setFolders(cur => mergeFolders(meta.folders, cur));
            if (Array.isArray(meta.readFolders)) setReadFolders(cur => mergeFolders(meta.readFolders, cur));
          }
          metaReady.current = true;
        }
        const data = await syncRef.current({startup: true});
        // 首读没拿到内容：知识库文件夹可能被移动 / 改名 / 整库未下载，明确告诉用户而不是默默展示空库
        if (alive && VAULT_MODE && (!data || !data.counts.all)) {
          showGlobalNotice('已连接知识库但没有读到内容：确认知识库文件夹还在原位且已从 iCloud 下载完整，或 ⌘K 重新导入一次 · Vault appears empty');
        }
      } catch {} // 同步内部已吞错；这里兜底保证门一定会抬
      finally { if (alive) setVaultReady(true); }
    })();
    const v = window.deepnotes?.vault;
    const root = getRoot();
    if (v?.watch && root) v.watch(root); // 换库 / 断开由 importVault 与切示例流程重设
    const offChanged = v?.onChanged?.(() => { clearTimeout(t); t = setTimeout(() => syncRef.current(), 3000); });
    // 剪贴板快速捕获（桌面版 ⌘/Ctrl+Alt+V）：文本进闪念箱，随时沉淀为草稿/笔记
    const offCapture = window.deepnotes?.clipboardCapture?.(text => {
      const txt = String(text || '').trim();
      if (!txt) return;
      setInbox(list => [{id: 'i-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: txt, ts: Date.now()}, ...list]);
      setToast('剪贴板内容已存入闪念箱 · Captured to inbox');
    });
    return () => { alive = false; clearTimeout(t); offChanged?.(); offCapture?.(); };
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
    if (kind === 'idea') { const it = ideas.find(x => String(x.id) === String(raw)); setPage('ideas'); if (it) editIdea(it); return; } // 审计 B9：与其余类型一致，先切到选题池再弹编辑
    openInGraph(id); // concept 与其余类型：回工作台图谱选中
  };

  // 命令面板动作清单：新建 / 跳转 / 数据导入导出（内容搜索由面板按 graph 自行匹配）
  const MODULE_ICON = {home: 'home', library: 'works', methods: 'methods', drafts: 'draft', ideas: 'idea', readings: 'book', archives: 'archive'};
  const paletteActions = [
    {group: '新建 New', icon: 'works', zh: '新建文章', en: 'New article', run: () => newWork()},
    {group: '新建 New', icon: 'methods', zh: '新建方法笔记', en: 'New note', run: addNote},
    {group: '新建 New', icon: 'draft', zh: '新建草稿', en: 'New draft', run: () => newDraft()},
    {group: '新建 New', icon: 'idea', zh: '添加选题', en: 'New idea', run: () => editIdea({id: nextIdeaId(ideas), title: '', platform: '小红书', priority: '中', status: '待写', note: ''})},
    {group: '新建 New', icon: 'book', zh: '新建阅读条目', en: 'New reading', run: newReading},
    {group: '新建 New', icon: 'archive', zh: '新建档案', en: 'New archive', run: newArchive},
    ...navs.map(([id, zh, en]) => ({group: '跳转 Go', icon: MODULE_ICON[id], zh: `打开${zh}`, en: `Go to ${en}`, run: () => setPage(id)})),
    {group: '跳转 Go', icon: 'concept', zh: '打开概念网络', en: 'Go to Concepts', run: () => setPage('concepts')},
    {group: '跳转 Go', icon: 'file', zh: '思维导图浮动窗口', en: 'Mind map window', run: () => setMmOpen(o => !o)},
    {group: '跳转 Go', icon: 'file', zh: '打开隐私笔记', en: 'Go to Private notes', run: () => setPage('private')},
    {group: '数据 Data', icon: 'file', zh: '导入知识库文件夹', en: 'Import vault folder', run: () => setModal('import')},
    {group: '数据 Data', icon: 'outlink', zh: '导入选定内容', en: 'Import selected files', run: () => setModal('import-files')},
    {group: '数据 Data', icon: 'search', zh: '批量替换', en: 'Find & replace', run: () => setModal('replace')},
    {group: '数据 Data', icon: 'pulse', zh: '写作统计', en: 'Writing stats', run: () => setModal('stats')},
    {group: '数据 Data', icon: 'outlink', zh: '导出分享版 HTML', en: 'Export shareable HTML', run: exportVaultHtml},
    {group: '数据 Data', icon: 'save', zh: '导出全部 Markdown', en: 'Export all Markdown', run: exportVault},
    {group: '数据 Data', icon: 'replay', zh: '恢复数据快照', en: 'Restore data snapshot', run: restoreSnapshot},
    {group: '数据 Data', icon: 'replay', zh: '文件恢复', en: 'File recovery', run: () => setModal('recovery')},
    {group: '数据 Data', icon: 'replay', zh: '校验知识库完整性', en: 'Verify vault integrity', run: async () => {
      await flushAll(); // 先把防抖队列里的编辑写尽，否则未落盘的修改会被误报为「内容不一致」
      const r = await verifyIntegrity({works, notes, drafts, ideas, readings, archives});
      if (!r?.ok) { setToast(`校验失败：${r?.error || '未知错误'} · Verification failed`); return; }
      const {changed = [], missing = [], extra = [], total = 0} = r;
      if (!changed.length && !missing.length && !extra.length) { setToast(`校验通过：${total} 个文件与记录一致 · All ${total} files verified`); return; }
      setToast(`发现差异：${changed.length} 处内容不一致、${missing.length} 个盘上新增、${extra.length} 个记录缺失，请去「文件恢复」核对 · Mismatch found`);
    }},
    {group: '数据 Data', icon: 'replay', zh: '切回示例数据', en: 'Reset to sample', run: resetToSample},
  ];
  const s = stats(graph);

  // 读盘门：磁盘唯一事实源模式下首读完成前不渲染主界面（内存还是空占位）。样式与整体深空底色一致。
  if (!vaultReady) return <div role="status" style={{minHeight: '100vh', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 10, background: '#101014', color: '#9aa3b2',
    fontFamily: '-apple-system, "PingFang SC", sans-serif', fontSize: 13, letterSpacing: '0.06em'}}>
    <span>正在读取知识库</span>
    <span style={{opacity: 0.55, fontSize: 12}}>Loading vault…</span>
  </div>;

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
        {capable() && knownVaults().length > 1 && <label className="vault-switch" title="切换知识库 · Switch vault">
          <Icon name="file" size={13}/>
          <select value={getRoot() || ''} onChange={e => { if (e.target.value) switchVault(e.target.value); }} aria-label="切换知识库 Switch vault">
            {knownVaults().map(v => <option key={v.path} value={v.path}>{v.path.replace(/\/+$/, '').split('/').pop()}</option>)}
          </select>
        </label>}
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
      {page === 'library' && <Library graph={graph} works={works} selected={libSel} setSelected={setLibSel} openArticle={openArticle} setOpenArticle={setOpenArticle} onNewWork={newWork} onUpdateWork={updateWork} onDeleteWork={deleteWork} onGo={openInGraph} onJumpContent={openContent} onAction={onAction} onBody={onBody} onNoteTitle={onNoteTitle} onConcept={onConcept} concepts={kbConcepts} onLinkify={linkifyMentions} onMakeMap={makeMapFor}/>}
      {page === 'methods' && <Methods graph={graph} notes={notes} setNotes={setNotes} selected={methSel} setSelected={setMethSel} onGo={openInGraph} onJumpContent={openContent} onNew={addNote} onDelete={deleteNote} onUpdate={updateNote} onMove={id => setModal({move: {kind: 'note', id}})} onMerge={mergeNotes} folders={folders} dragging={dragging} setDragging={setDragging} onMoveToFolder={moveNoteToFolder} onCreateFolder={createFolder} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder}/>}
      {page === 'drafts' && <Drafts graph={graph} drafts={drafts} setDrafts={setDrafts} active={active} setActive={setActive} onNew={() => newDraft()} onDelete={deleteDraft} onGo={openInGraph} onJumpContent={openContent} works={works} notes={notes} onMove={id => setModal({move: {kind: 'draft', id}})} inbox={inbox} setInbox={setInbox} onFlashToDraft={flashToDraft} onFlashToNote={flashToNote} onDaily={openDaily}/>}
      {page === 'ideas' && <Ideas graph={graph} ideas={ideas} onEdit={editIdea} onGraph={openInGraph} onNew={() => editIdea({id: nextIdeaId(ideas), title: '', platform: '小红书', priority: '中', status: '待写', note: ''})}/>}
      {page === 'readings' && <Readings graph={graph} readings={readings} selected={readSel} setSelected={setReadSel} openReading={readOpen} setOpenReading={setReadOpen} onGo={openInGraph} onJumpContent={openContent} onAction={onAction} onNew={newReading} onUpdate={updateReading} onDelete={deleteReading} readFolders={readFolders} dragging={dragging} setDragging={setDragging} onMoveToFolder={moveReadingToFolder} onCreateFolder={createReadingFolder} onRenameFolder={renameReadingFolder} onDeleteFolder={deleteReadingFolder} onLinkify={linkifyMentions} onImportFiles={importReadingItems} onMakeMap={makeMapFor}/>}
      {page === 'archives' && <Archives graph={graph} archives={archives} selected={arcSel} setSelected={setArcSel} openArchive={arcOpen} setOpenArchive={setArcOpen} onGo={openInGraph} onJumpContent={openContent} onAction={onAction} onNew={newArchive} onUpdate={updateArchive} onDelete={deleteArchive} onLinkify={linkifyMentions} onMakeMap={makeMapFor}/>}
      {page === 'concepts' && <Concepts graph={graph} onGo={openInGraph} onJumpContent={openContent}/>}
      {page === 'private' && <PrivateNotes/>}
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
    {/* 左下角常驻角标：每日随机回顾 + 番茄钟并排 */}
    <div className="corner-dock">
      <DailyRecall works={works} notes={notes} readings={readings} archives={archives} onOpen={openContent}/>
      <PomodoroFab pomo={pomo} written={pomo?.phase === 'focus' ? Math.max(0, draftsChars() - pomo.baseChars) : 0} onStart={startPomo} onStop={() => { noiseStop(); setPomo(null); }}/>
      <button className={`pomo-fab dock-extra${mmOpen ? ' active' : ''}`} onClick={() => setMmOpen(o => !o)} title="思维导图浮动窗口（打开期间底层界面锁定，关闭后恢复操作）· Mind map" aria-label="打开思维导图">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="6" cy="6" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.7"/><circle cx="6" cy="18" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.7"/><circle cx="18" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M8.2 7 15.4 11M8.2 17 15.4 13" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg>
      </button>
      <button className="pomo-fab dock-extra" onClick={() => setPage('private')} title="隐私区：本地加密笔记 · Private notes" aria-label="打开隐私笔记">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="5.5" y="10.5" width="13" height="9" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg>
      </button>
    </div>

    {/* 思维导图浮动窗口 */}
    <MindMapWindow open={mmOpen} onClose={() => setMmOpen(false)} onOpenContent={openContent} initialSel={mmSel}/>

    {/* ⌘K 全局命令面板：全文搜索 + 新建 / 跳转 / 导入导出 */}
    <CommandPalette open={palette} onClose={() => setPalette(false)} graph={graph} actions={paletteActions} onOpenContent={openContent}/>

    {modal === 'about' && <Modal title="关于这份数据" en="About the data" onClose={close}>
      <div className="about">
        <div className="form-actions">
          <button className="pill primary" onClick={() => setModal('import')}><Icon name="file" size={14}/>导入知识库文件夹 <em>Import vault</em></button>
          <button className="pill" onClick={() => setModal('import-files')}><Icon name="outlink" size={14}/>导入选定内容 <em>Import files</em></button>
          <button className="pill" disabled={!curItem?.item} title={curItem?.item ? `导出《${curItem.item.title}》` : '先打开一篇内容 · Open a piece first'} onClick={exportCurrentMd}><Icon name="save" size={14}/>导出当前 · Markdown <em>MD</em></button>
          <button className="pill" disabled={!curItem?.item} title={curItem?.item ? `打印 / 另存 PDF《${curItem.item.title}》` : '先打开一篇内容 · Open a piece first'} onClick={exportCurrentPdf}><Icon name="outlink" size={14}/>导出当前 · PDF <em>Print</em></button>
          <button className="pill" disabled={!curItem?.item} title={curItem?.item ? `导出《${curItem.item.title}》为单文件 HTML（自带排版，可直接分享）` : '先打开一篇内容 · Open a piece first'} onClick={exportCurrentHtml}><Icon name="outlink" size={14}/>分享 · 单文件 HTML <em>Share</em></button>
          <button className="pill" onClick={() => setModal('recovery')}><Icon name="replay" size={14}/>文件恢复 <em>Recovery</em></button>
          <button className="pill" onClick={() => setModal('stats')}><Icon name="pulse" size={14}/>写作统计 <em>Stats</em></button>
          <button className="pill ghost" onClick={resetToSample}>切回示例数据 <em>Reset</em></button>
        </div>
        <p>知识库 <em>Vault</em>：<strong>{snap.account}</strong> · 导入日期 <em>Imported</em>：{snap.capturedAt}</p>
        <p>数据来源 <em>Source</em>：{snap.source}{snap.publishedFrom ? `；内容时间跨度 ${snap.publishedFrom} — ${snap.publishedTo}` : ''}。</p>
        {capable() && getRoot() && <p>文件夹知识库 <em>Vault folder</em>：<code>{getRoot()}</code><br/>编辑会实时写回此文件夹里的 .md 文件，被删除的内容移入 <code>.trash</code>；网页版则只保存在浏览器里。</p>}
        <p className="about-mini">当前：{s.content} 条内容 · {s.links} 条连接 · {s.mutual} 组双向 · {s.ghosts} 个未创建双链。</p>
        <details className="about-fold">
          <summary>使用说明 <em>Instructions</em></summary>
          <div className="about-fold-body">
            <p className="quiet">随时按 <kbd>⌘K</kbd>（Windows 为 <kbd>Ctrl K</kbd>）呼出命令面板：全文搜索、新建、跳转、导出全部 Markdown、恢复数据快照都在那里。「导入选定内容」挑几个 .md 文件合并进某个模块（同标题更新、其余追加，不动其他内容），整体替换请用「导入知识库文件夹」；「导出当前」是正在看的那篇（文章全文 / 草稿 / 方法笔记 / 阅读 / 档案），PDF 经系统打印对话框「另存为 PDF」。任何整体替换之前都会自动存一份快照，可从 ⌘K 恢复；内容被意外覆盖时（外部同步、同名顶掉等），用「文件恢复」从两层快照网里找回旧版本。<em>Press ⌘K anywhere; imports are snapshotted first and reversible; overwritten versions live in File recovery.</em></p>
          </div>
        </details>
        <details className="about-fold">
          <summary>图谱怎么来的 <em>How the graph is built</em></summary>
          <div className="about-fold-body">
            <p>{snap.source === '导入自本地笔记' ? '全部由导入的本地笔记在浏览器中推导，不读取选择范围之外的文件：' : <>全部由 <code>src/data/sample.js</code> 里的资料在浏览器中推导，不读取外部 Obsidian 仓库：</>}</p>
            <ul>
              <li><b>[[双链]] Wikilinks</b>：文章、方法笔记与草稿正文中的双链；找不到对应笔记的记为「未创建」。</li>
              <li><b>话题 Topics</b>：文章正文里的 # 话题标签。</li>
              <li><b>正文提及 Mentions</b>：内容中出现概念词（导入时自动从重复出现的话题里提取），且至少两条内容提及才成为概念节点。</li>
              <li><b>双向共振 Resonance</b>：两条内容共同提及 ≥2 个概念，或选题与草稿互相记录。</li>
              <li><b>选题来源 Source</b>：草稿记录来源选题；选题状态为「已转草稿」时反向成立。</li>
            </ul>
            <p>作品库：{works.length} 篇文章<b>保存在此浏览器</b>{capable() && getRoot() ? '，并实时写回上面的知识库文件夹' : ''}，可自由新建、编辑、删除；导入知识库会整体替换，命令行导入（npm run import）仍然可用。</p>
            <p className="quiet">图谱分析是本地规则检索，未调用 AI。选题、草稿与目标保存在当前浏览器，不写入 Obsidian、不发布到平台。<em>Local rules only · no AI · nothing is published.</em></p>
          </div>
        </details>
      </div>
    </Modal>}
    {modal === 'recovery' && <RecoveryModal onClose={close} onRestoreSnap={restoreSnapVersion} onRestoreCopy={restoreFileCopy} currentBodyOf={(kind, id) => { const arr = {works, notes, drafts, readings, archives}[kind] || []; const it = arr.find(x => String(x.id) === String(id)); return it ? (it.body || '') : null; }}/>}
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
    {modal === 'replace' && <ReplaceModal works={works} notes={notes} drafts={drafts} readings={readings} archives={archives} onClose={close} onApply={applyVaultReplace}/>}
    {modal === 'stats' && (() => {
      const list = dailyDeltas(loadStats()).slice(-14);
      const maxDelta = Math.max(1, ...list.map(x => x.delta));
      const streak = streakDays(loadStats());
      const today = list[list.length - 1];
      const d = new Date(), pd = n => String(n).padStart(2, '0');
      const dayStr = `${d.getFullYear()}-${pd(d.getMonth() + 1)}-${pd(d.getDate())}`;
      const todayDelta = today && today.d === dayStr ? today.delta : 0; // 今天还没记录时不显示昨天的增量
      const mods = [['作品库', works], ['方法库', notes], ['创作台', drafts], ['阅读区', readings], ['档案区', archives]].map(([zh, arr]) => [zh, arr.reduce((s, x) => s + (x.body || '').length, 0)]);
      const modMax = Math.max(1, ...mods.map(([, c]) => c));
      return <Modal title="写作统计" en="Writing stats" onClose={close}>
        <div className="about">
          <div className="kpi-band glass" style={{marginBottom: 14}}>
            {[['今日新增', 'Today', todayDelta.toLocaleString('zh-CN') + ' 字'], ['连续写作', 'Streak', `${streak} 天`], ['全库总字数', 'Total', totalChars({works, notes, drafts, readings, archives}).toLocaleString('zh-CN')]].map(([zh, en, v]) =>
              <div key={zh}><span>{zh} <em>{en}</em></span><strong>{v}</strong></div>)}
          </div>
          <h3>最近 14 天 <em>Last 14 days</em></h3>
          <div className="stats-bars">{list.length ? list.map(x => <div key={x.d} className="stats-bar" title={`${x.d}：+${x.delta.toLocaleString('zh-CN')} 字`}>
            <i style={{'--h': x.delta / maxDelta}}/><small>{x.d.slice(5)}</small>
          </div>) : <p className="quiet">还没有记录，写下第一笔后就会出现（每天记一次全库字数快照）。<em>No data yet.</em></p>}</div>
          <h3>模块字数分布 <em>By module</em></h3>
          <div className="stats-mods">{mods.map(([zh, c]) => <div key={zh} className="stats-mod"><span>{zh}</span><i style={{'--w': c / modMax}}/><b>{c.toLocaleString('zh-CN')}</b></div>)}</div>
          <p className="quiet">统计只存在本机（每天一条全库字数快照，最多 400 天），不联网、不写入知识库。<em>Local-only daily snapshots.</em></p>
        </div>
      </Modal>;
    })()}
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
    {modal?.read && <ReadFull r={modal.read} graph={graph} onClose={close} onGo={openInGraph} onOpenContent={openContent}/>}
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
