// 思维导图浮动窗口：左下角图标入口，打开后覆盖在文章/笔记之上。
// 大小与位置可随意调整并记忆（localStorage）；打开期间底层界面只可滚动文字，不可点击——
// 关掉浮动窗口才能恢复完整交互。数据走 conceptStore 的 mindmaps store。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {CONFIG} from '../config';
import {mindmaps as mindmapStore} from './conceptStore';
import {outlineToTree, treeToOutline, headingsToTree, layoutTree, nodeCount} from './mindmap';

const newId = () => 'mm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const WIN_KEY = CONFIG.storagePrefix + '-mm-window-v1';

function loadWinPos() {
  try {
    const v = JSON.parse(localStorage.getItem(WIN_KEY));
    const num = (x, d, min, max) => Number.isFinite(Number(x)) ? Math.max(min, Math.min(max, Number(x))) : d;
    return {w: num(v?.w, 720, 400, window.innerWidth - 40), h: num(v?.h, 500, 300, window.innerHeight - 40),
            x: num(v?.x, 80, 0, Math.max(0, window.innerWidth - 400)), y: num(v?.y, 60, 0, Math.max(0, window.innerHeight - 300))};
  } catch { return {w: 720, h: 500, x: 80, y: 60}; }
}

// —— 画布：横向树，拖拽平移、⌘+滚轮缩放、选中节点的编辑与增删 ——
function MapCanvas({map, onChange, onOpenSource}) {
  const tree = useMemo(() => outlineToTree(map.outline), [map.outline]);
  const folded = map.folded || {};
  const [selId, setSelId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [zoom, setZoom] = useState(1);
  const view = useRef({x: 40, y: 40});
  const drag = useRef(null);
  const box = useRef(null);
  const viewport = useRef(null);
  const [tick, setTick] = useState(0);

  const findNode = (root, id) => {
    if (root.id === id) return root;
    for (const c of root.children || []) { const hit = findNode(c, id); if (hit) return hit; }
    return null;
  };
  const findParent = (root, id) => {
    for (const c of root.children || []) {
      if (c.id === id) return root;
      const hit = findParent(c, id);
      if (hit) return hit;
    }
    return null;
  };
  const clone = n => ({...n, children: (n.children || []).map(clone)});
  const mutate = fn => {
    const root = clone(tree);
    fn(root);
    onChange({...map, outline: treeToOutline(root)});
  };
  const addChild = () => {
    if (!selId) return;
    mutate(root => { const n = findNode(root, selId); if (n) (n.children ||= []).unshift({id: n.id + '-n', text: '新节点', children: []}); });
  };
  const addSibling = () => {
    if (!selId) return;
    mutate(root => {
      const p = findParent(root, selId);
      if (!p) return;
      p.children.splice(p.children.findIndex(c => c.id === selId) + 1, 0, {id: p.id + '-n', text: '新节点', children: []});
    });
  };
  const removeNode = () => {
    if (!selId) return;
    mutate(root => { const p = findParent(root, selId); if (p) p.children = p.children.filter(c => c.id !== selId); });
    setSelId(null);
  };
  const toggleCollapse = () => {
    if (!selId) return;
    const next = {...folded};
    if (next[selId]) delete next[selId]; else next[selId] = true;
    onChange({...map, folded: next});
  };
  const commitText = () => {
    if (!editing) return;
    const t = editVal.trim() || '未命名';
    if (editing === 'title') onChange({...map, title: t});
    else mutate(root => { const n = findNode(root, editing); if (n) n.text = t; });
    setEditing(null);
  };

  const {entries} = useMemo(() => layoutTree(tree, folded), [tree, folded]);
  const posOf = useMemo(() => Object.fromEntries(entries.map(e => [e.node.id, e])), [entries]);
  const ROW = 46 * zoom, COL = (150 + 64) * zoom;
  const CANVAS = 20000;
  const ORIGIN = CANVAS / 2;

  const onWheel = useCallback(e => {
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    setZoom(z => Math.max(0.35, Math.min(2, +(z + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
  }, []);
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    vp.addEventListener('wheel', onWheel, {passive: false});
    return () => vp.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const onDown = e => {
    if (e.button !== 0 || e.target.closest('.mm-node')) return;
    drag.current = {sx: e.clientX, sy: e.clientY, ox: view.current.x, oy: view.current.y};
    const move = ev => {
      if (!drag.current) return;
      view.current = {x: drag.current.ox + (ev.clientX - drag.current.sx), y: drag.current.oy + (ev.clientY - drag.current.sy)};
      if (box.current) box.current.style.transform = `translate(${view.current.x}px, ${view.current.y}px)`;
    };
    const up = () => { drag.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  useEffect(() => {
    if (box.current) box.current.style.transform = `translate(${view.current.x}px, ${view.current.y}px)`;
  }, [tick, zoom]);

  const exportPng = () => {
    const vp = viewport.current;
    if (!vp) return;
    // 计算可见节点的包围盒，裁剪出有效区域
    const nodes = [...vp.querySelectorAll('.mm-node')];
    if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      const r = n.getBoundingClientRect();
      const vr = vp.getBoundingClientRect();
      minX = Math.min(minX, r.left - vr.left + vp.scrollLeft);
      minY = Math.min(minY, r.top - vr.top + vp.scrollTop);
      maxX = Math.max(maxX, r.right - vr.left + vp.scrollLeft);
      maxY = Math.max(maxY, r.bottom - vr.top + vp.scrollTop);
    });
    const pad = 30;
    const W = Math.ceil(maxX - minX + pad * 2), H = Math.ceil(maxY - minY + pad * 2);
    // 离屏 canvas：先把 SVG 连线画上去，再把 HTML 节点逐个画上去（文字 + 边框）
    const c = document.createElement('canvas');
    c.width = W * 2; c.height = H * 2; // 2x 清晰度
    const ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.fillStyle = '#141515';
    ctx.fillRect(0, 0, W, H);
    // 连线
    const paths = [...vp.querySelectorAll('.mm-lines path')];
    ctx.strokeStyle = 'rgba(205,208,204,.5)';
    ctx.lineWidth = 1.4;
    paths.forEach(p => {
      const d = p.getAttribute('d');
      if (!d) return;
      // 简化：只画 M 和 C 的端点连线（不精确贝塞尔，视觉近似）
      const nums = d.match(/[-\d.]+/g);
      if (!nums || nums.length < 6) return;
      // SVG path 的 d 是 mm-inner 本地坐标，而节点 rect 含 transform 平移——补上 view 偏移对齐
      const x1 = +nums[0] + view.current.x - minX + pad, y1 = +nums[1] + view.current.y - minY + pad;
      const x2 = +nums[nums.length - 2] + view.current.x - minX + pad, y2 = +nums[nums.length - 1] + view.current.y - minY + pad;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
      ctx.stroke();
    });
    // 节点
    ctx.font = '12.5px -apple-system, "PingFang SC", sans-serif';
    nodes.forEach(n => {
      const r = n.getBoundingClientRect();
      const vr = vp.getBoundingClientRect();
      const x = r.left - vr.left + vp.scrollLeft - minX + pad;
      const y = r.top - vr.top + vp.scrollTop - minY + pad;
      const w = r.width, h = r.height;
      const isRoot = n.classList.contains('root');
      const isSel = n.classList.contains('sel');
      // 圆角矩形背景
      ctx.fillStyle = isRoot ? 'rgba(232,180,90,.15)' : 'rgba(20,22,22,.92)';
      ctx.strokeStyle = isSel ? '#e8b45a' : isRoot ? 'rgba(232,180,90,.5)' : 'rgba(228,228,222,.15)';
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 9);
      ctx.fill();
      ctx.stroke();
      // 文字
      const text = n.querySelector('.mm-text')?.textContent || '';
      ctx.fillStyle = isRoot ? '#e8b45a' : '#ecece9';
      ctx.textBaseline = 'middle';
      const maxChars = Math.floor(w / 7.2);
      ctx.fillText(text.length > maxChars ? text.slice(0, maxChars) + '…' : text, x + 9, y + h / 2, w - 14);
    });
    // 导出
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `${map.title || '思维导图'}.png`;
    a.click();
  };

  return <section className="mm-canvas" aria-label={`思维导图画布 ${map.title}`}>
    <header className="mm-bar">
      <div className="mm-bar-title">
        {editing === 'title'
          ? <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={commitText}
              onKeyDown={e => { if (e.key === 'Enter' && !e.isComposing) commitText(); if (e.key === 'Escape') setEditing(null); }} aria-label="导图标题"/>
          : <b onDoubleClick={() => { setEditing('title'); setEditVal(map.title || ''); }} title="双击改标题">{map.title || '未命名导图'}</b>}
        <small>{nodeCount(tree)} 节点</small>
      </div>
      <div className="mm-tools" role="group" aria-label="导图工具">
        {map.source && <button className="pill ghost" onClick={() => onOpenSource(map.source)} title="打开原文"><Icon name="file" size={13}/>原文 <em>Src</em></button>}
        <button className="pill ghost" disabled={!selId} onClick={addChild} title="给选中节点加子级"><Icon name="plus" size={13}/>子</button>
        <button className="pill ghost" disabled={!selId || selId === tree.id} onClick={addSibling} title="加同级节点">同级</button>
        <button className="pill ghost" disabled={!selId} onClick={toggleCollapse} title="收起/展开">折叠</button>
        <button className="pill ghost danger" disabled={!selId || selId === tree.id} onClick={removeNode} title="删除选中节点"><Icon name="trash" size={13}/></button>
        <button className="pill ghost" onClick={() => exportPng()} title="导出为 PNG 图片 · Export PNG"><Icon name="outlink" size={13}/>PNG</button>
        <span className="mm-zoom">
          <button className="icon-btn" onClick={() => setZoom(z => Math.max(0.35, +(z - 0.1).toFixed(2)))} aria-label="缩小">−</button>
          <b>{Math.round(zoom * 100)}%</b>
          <button className="icon-btn" onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(2)))} aria-label="放大">＋</button>
          <button className="icon-btn" onClick={() => { view.current = {x: 40, y: 40}; setTick(t => t + 1); }} title="复位">⌂</button>
        </span>
      </div>
    </header>
    <div className="mm-viewport" ref={viewport} onMouseDown={onDown}>
      <div className="mm-inner" ref={box} style={{width: CANVAS, height: CANVAS}}>
        <svg className="mm-lines" width={CANVAS} height={CANVAS} aria-hidden="true">
          {entries.filter(e => e.depth > 0 && posOf[e.pid]).map(e => {
            const p = posOf[e.pid];
            const x1 = ORIGIN + p.depth * COL + 150 * zoom, y1 = ORIGIN + p.y * ROW + 18 * zoom;
            const x2 = ORIGIN + e.depth * COL, y2 = ORIGIN + e.y * ROW + 18 * zoom;
            const mx = (x1 + x2) / 2;
            return <path key={e.node.id} className={selId === e.node.id || selId === e.pid ? 'on' : ''}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}/>;
          })}
        </svg>
        {entries.map(e => {
          const x = ORIGIN + e.depth * COL, y = ORIGIN + e.y * ROW;
          const kids = (e.node.children || []).length;
          const hidden = kids && folded[e.node.id];
          return <div key={e.node.id}
            className={`mm-node${selId === e.node.id ? ' sel' : ''}${e.depth === 0 ? ' root' : ''}${hidden ? ' folded' : ''}`}
            style={{left: x, top: y, width: 150 * zoom}}
            onClick={ev => { ev.stopPropagation(); setSelId(e.node.id); if (editing && editing !== e.node.id) commitText(); }}
            onDoubleClick={() => { setEditing(e.node.id); setEditVal(e.node.text); }} title={e.node.text ? `${e.node.text.split('::')[0]}${e.node.text.includes('::') ? `\n备注：${e.node.text.split('::')[1] || ''}` : ''}\n双击改文字（::后写备注）` : '双击改文字'}>
            {editing === e.node.id
              ? <input autoFocus value={editVal} onChange={ev => setEditVal(ev.target.value)} onBlur={commitText}
                  onKeyDown={ev => { if (ev.key === 'Enter' && !ev.isComposing) commitText(); if (ev.key === 'Escape') setEditing(null); }}
                  onClick={ev => ev.stopPropagation()} aria-label="节点文字"/>
              : <span className="mm-text">{String(e.node.text || '').split('::')[0] || '　'}</span>}
            {hidden && <em className="mm-badge">+{kids}</em>}
          </div>;
        })}
      </div>
      <p className="mm-hint">⌘/Ctrl+滚轮缩放 · 拖拽平移 · 双击改文字</p>
    </div>
  </section>;
}

// —— 浮动窗口：拖拽标题栏移动、右下角拉伸调整大小，位置尺寸记忆 ——
export function MindMapWindow({open, onClose, onOpenContent, initialSel}) {
  const store = mindmapStore.use();
  const list = Array.isArray(store.list) ? store.list : [];
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [win, setWin] = useState(loadWinPos);
  const [sideOpen, setSideOpen] = useState(true);
  const headRef = useRef(null);
  const resizeRef = useRef(null);
  const winRef = useRef(win);
  winRef.current = win;

  useEffect(() => { if (initialSel) setSel(initialSel); }, [initialSel]);

  const saveWin = w => { setWin(w); try { localStorage.setItem(WIN_KEY, JSON.stringify(w)); } catch {} };

  // 拖拽移动（标题栏）
  useEffect(() => {
    if (!open) return;
    const el = headRef.current;
    if (!el) return;
    let st = null;
    const down = e => {
      if (e.target.closest('button, input')) return;
      st = {sx: e.clientX, sy: e.clientY, ox: winRef.current.x, oy: winRef.current.y};
      e.preventDefault();
    };
    const move = e => {
      if (!st) return;
      saveWin({...winRef.current, x: Math.max(0, Math.min(window.innerWidth - 200, st.ox + e.clientX - st.sx)), y: Math.max(0, Math.min(window.innerHeight - 60, st.oy + e.clientY - st.sy))});
    };
    const up = () => { st = null; };
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { el.removeEventListener('mousedown', down); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 右下角拉伸调整大小
  useEffect(() => {
    if (!open) return;
    const el = resizeRef.current;
    if (!el) return;
    let st = null;
    const down = e => { st = {sx: e.clientX, sy: e.clientY, ow: winRef.current.w, oh: winRef.current.h}; e.preventDefault(); e.stopPropagation(); };
    const move = e => {
      if (!st) return;
      saveWin({...winRef.current, w: Math.max(400, Math.min(window.innerWidth - winRef.current.x, st.ow + e.clientX - st.sx)), h: Math.max(300, Math.min(window.innerHeight - winRef.current.y, st.oh + e.clientY - st.sy))});
    };
    const up = () => { st = null; };
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { el.removeEventListener('mousedown', down); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = sel ? list.find(m => m.id === sel) : null;
  const changeMap = next => mindmapStore.write({list: list.map(m => m.id === next.id ? {...next, updatedAt: Date.now()} : m)});
  const createMap = () => {
    const t = name.trim() || '未命名导图';
    const m = {id: newId(), title: t, outline: '- 第一个分支\n- 第二个分支', source: null, updatedAt: Date.now()};
    mindmapStore.write({list: [m, ...list]});
    setSel(m.id); setCreating(false); setName('');
  };
  const deleteMap = id => {
    const m = list.find(x => x.id === id);
    if (!window.confirm(`删除导图「${m?.title || '未命名'}」？${m?.source ? '\n原文不受影响。' : ''}`)) return;
    mindmapStore.write({list: list.filter(x => x.id !== id)});
    if (sel === id) setSel(null);
  };

  if (!open) return null;

  return <>
    {/* 底层遮罩：浮动窗口打开期间，底层界面锁定不可点击；关闭窗口后恢复操作 */}
    <div className="mm-overlay" onClick={e => e.stopPropagation()} />

    <div className="mm-window glass" style={{left: win.x, top: win.y, width: win.w, height: win.h}} role="dialog" aria-label="思维导图浮动窗口">
      <header className="mm-window-head" ref={headRef}>
        <b><Icon name="concept" size={13}/> 思维导图 <em>Mind Map</em></b>
        <div className="mm-window-tools">
          <button className="icon-btn" onClick={() => setSideOpen(o => !o)} title={sideOpen ? '收起清单' : '展开清单'} aria-label="切换清单">{sideOpen ? '◀' : '▶'}</button>
          <button className="icon-btn" onClick={() => { setCreating(true); setName(''); }} title="新建导图" aria-label="新建导图"><Icon name="plus" size={13}/></button>
          <button className="icon-btn" onClick={onClose} title="关闭浮动窗口（关闭后恢复底层界面操作）" aria-label="关闭思维导图"><Icon name="close" size={14}/></button>
        </div>
      </header>
      <div className="mm-window-body">
        {sideOpen && <aside className="mm-list" aria-label="导图清单">
          {creating && <div className="mm-new">
            <input autoFocus value={name} placeholder="名称，回车创建" aria-label="新导图名称"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') createMap(); if (e.key === 'Escape') setCreating(false); }}/>
          </div>}
          {list.map(m => <div key={m.id} className={`mm-item${sel === m.id ? ' active' : ''}`} onClick={() => setSel(m.id)} role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(m.id); } }}>
            <span className="mm-item-body">
              <b>{m.title || '未命名导图'}</b>
              <small>{m.source ? '📄 ' : ''}{nodeCount(outlineToTree(m.outline))} 节点</small>
            </span>
            <button className="icon-btn" aria-label={`删除 ${m.title || ''}`} title="删除导图"
              onClick={e => { e.stopPropagation(); deleteMap(m.id); }}><Icon name="trash" size={13}/></button>
          </div>)}
          {!list.length && !creating && <p className="empty-line">还没有导图<em>No maps</em></p>}
        </aside>}
        {cur
          ? <MapCanvas map={cur} onChange={changeMap} onOpenSource={gid => { onClose(); onOpenContent(gid); }}/>
          : <section className="mm-canvas empty"><p className="empty-line">选一张导图或点 ＋ 新建<em>Pick or create</em></p></section>}
      </div>
      <div className="mm-resize" ref={resizeRef} title="拖动调整窗口大小" aria-hidden="true"/>
    </div>
  </>;
}

// 供 main.jsx 调：从文章/笔记生成（或更新）一张导图。返回创建/更新的 map id（取消返回 null）。
export function makeMapFromItem(gid, title, body) {
  const root = headingsToTree(title, body);
  const outline = treeToOutline(root);
  const cur = mindmapStore.get();
  const list = Array.isArray(cur.list) ? cur.list : [];
  const exist = list.find(m => m.source === gid);
  if (exist) {
    if (!window.confirm(`《${title}》已有一张导图。重新生成会替换导图内容（手工修改将丢失），确定？`)) return null;
    mindmapStore.write({list: list.map(m => m.id === exist.id ? {...m, title, outline, folded: m.folded, updatedAt: Date.now()} : m)});
    return exist.id;
  }
  const m = {id: newId(), title, outline, source: gid, updatedAt: Date.now()};
  mindmapStore.write({list: [m, ...list]});
  return m.id;
}
