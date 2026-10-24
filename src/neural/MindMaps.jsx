// 思维导图浮动窗口：左下角图标入口，打开后覆盖在文章/笔记之上。
// 大小与位置可随意调整并记忆（localStorage）；打开期间底层界面只可滚动文字，不可点击——
// 关掉浮动窗口才能恢复完整交互。数据走 conceptStore 的 mindmaps store。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {CONFIG} from '../config';
import {mindmaps as mindmapStore} from './conceptStore';
import {outlineToTree, treeToOutline, headingsToTree, layoutTree, nodeCount, parseNodeText, formatNodeText, NODE_COLORS} from './mindmap';

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
function MapCanvas({map, onChange, onOpenSource, outlineOpen, onToggleOutline, onToDraft}) {
  const tree = useMemo(() => outlineToTree(map.outline), [map.outline]);
  const folded = map.folded || {};
  const [selId, setSelId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [noteEdit, setNoteEdit] = useState(null); // {id, val}：正在编辑的节点备注
  const [zoom, setZoom] = useState(1);
  const view = useRef({x: 40, y: 40});
  const drag = useRef(null);
  const dragId = useRef(null); // 拖动重排中的节点 id
  const box = useRef(null);
  const viewport = useRef(null);

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
  // 结构变化统一走这里：改树 + 可选的附加字段（如展开被折叠的父节点）一次提交
  const applyTree = (fn, patch) => {
    const root = clone(tree);
    fn(root);
    onChange({...map, ...(patch || {}), outline: treeToOutline(root)});
  };
  // 新节点 id 按「路径序号」推定（与 outlineToTree 的规则一致），建完立即进入编辑态，
  // 双击/新建后马上就有可输入的文字框，不用再双击一次。
  const startEdit = id => { setSelId(id); setEditing(id); setEditVal('新节点'); };
  const addChildTo = base => {
    const parent = base ? findNode(tree, base) : null;
    if (!parent) return;
    const nextFolded = {...folded};
    delete nextFolded[base];
    const idx = (parent.children || []).length; // 追加在末尾：已有子节点的路径 id 不变，折叠态不会错位
    applyTree(root => { const n = findNode(root, base); if (n) (n.children ||= []).push({text: '新节点', children: []}); }, {folded: nextFolded});
    startEdit(base + '-' + idx);
  };
  const addSiblingTo = id => {
    if (!id) return;
    const p = findParent(tree, id);
    if (!p) { addChildTo(tree.id); return; }
    const idx = p.children.findIndex(c => c.id === id);
    applyTree(root => { const pr = findNode(root, p.id); if (pr) pr.children.splice(idx + 1, 0, {text: '新节点', children: []}); });
    startEdit(p.id + '-' + (idx + 1));
  };
  const addChild = () => { if (selId) addChildTo(selId); };
  const removeNode = () => {
    if (!selId) return;
    applyTree(root => { const p = findParent(root, selId); if (p) p.children = p.children.filter(c => c.id !== selId); });
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
    if (editing === 'title' || editing === tree.id) onChange({...map, title: t}); // 中心主题不进大纲文本，改名即改导图标题
    else applyTree(root => {
      const n = findNode(root, editing);
      if (n) { const p = parseNodeText(n.text); n.text = formatNodeText(t, p.note, p.color); }
    });
    setEditing(null);
  };
  // 节点装饰：颜色与备注都编码进大纲文本，增删兄弟后仍跟着节点
  const selNode = selId ? findNode(tree, selId) : null;
  const selMeta = selNode ? parseNodeText(selNode.text) : {label: '', note: '', color: ''};
  const setNodeColor = color => {
    if (!selId) return;
    applyTree(root => {
      const n = findNode(root, selId);
      if (n) { const p = parseNodeText(n.text); n.text = formatNodeText(p.label, p.note, p.color === color ? '' : color); }
    });
  };
  const openNote = () => {
    if (!selId) return;
    const n = findNode(tree, selId);
    if (n) setNoteEdit({id: selId, val: parseNodeText(n.text).note});
  };
  const commitNote = () => {
    if (!noteEdit) return;
    const {id, val} = noteEdit;
    applyTree(root => {
      const n = findNode(root, id);
      if (n) { const p = parseNodeText(n.text); n.text = formatNodeText(p.label, val, p.color); }
    });
    setNoteEdit(null);
  };
  // 拖动重排：把节点拖到另一个节点上 → 成为它的下一个同级（拖到中心主题 → 成为其首个子级）
  const isAncestorId = (ancestor, id) => id === ancestor || id.startsWith(ancestor + '-');
  const moveNodeTo = (srcId, dstId) => {
    if (!srcId || !dstId || srcId === dstId || srcId === tree.id) return;
    if (isAncestorId(srcId, dstId)) return; // 不能把父节点拖进自己的子树
    let moved = false;
    applyTree(root => {
      const srcParent = findParent(root, srcId);
      if (!srcParent) return;
      const srcIdx = srcParent.children.findIndex(c => c.id === srcId);
      if (srcIdx < 0) return;
      const [node] = srcParent.children.splice(srcIdx, 1);
      const dstParent = findParent(root, dstId);
      if (dstParent) {
        const dstIdx = dstParent.children.findIndex(c => c.id === dstId);
        dstParent.children.splice(Math.max(0, dstIdx) + 1, 0, node);
      } else {
        root.children.unshift(node); // 拖到中心主题：升为一级节点
      }
      moved = true;
    });
    if (moved) setSelId(null);
  };

  const {entries} = useMemo(() => layoutTree(tree, folded), [tree, folded]);
  const posOf = useMemo(() => Object.fromEntries(entries.map(e => [e.node.id, e])), [entries]);
  const ROW = 46 * zoom, COL = (150 + 64) * zoom;
  const CANVAS = 20000;
  const ORIGIN = CANVAS / 2;

  // 视图定位：把内容包围盒放到视口正中。节点画在 20000 画布的中心（ORIGIN），
  // 打开导图 / 切换导图时若不定位，节点全在视口外——看起来就是「一张空导图」「两个找不到的节点」。
  const fitView = useCallback(() => {
    const vp = viewport.current;
    if (!vp || !entries.length) return;
    const xs = entries.map(e => e.depth * COL);
    const ys = entries.map(e => e.y * ROW);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + 150 * zoom;
    const minY = Math.min(...ys), maxY = Math.max(...ys) + 34 * zoom;
    const vw = vp.clientWidth || 640, vh = vp.clientHeight || 420;
    view.current = {
      x: (vw - (maxX - minX)) / 2 - ORIGIN - minX,
      y: (vh - (maxY - minY)) / 2 - ORIGIN - minY,
    };
    if (box.current) box.current.style.transform = `translate(${view.current.x}px, ${view.current.y}px)`;
  }, [entries, COL, ROW, zoom, ORIGIN]);
  // 只在切换导图时自动定位；编辑过程中不抢视角
  const fitRef = useRef(fitView);
  fitRef.current = fitView;
  useEffect(() => {
    // 换导图：清掉上一张的选中 / 编辑态（路径 id 在不同导图里可能撞名，残留会误删新导图的节点）
    setSelId(null); setEditing(null); setNoteEdit(null);
    const raf = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(raf);
  }, [map.id]);

  // 结构变化后选中 id 可能失效（如删除了父节点）：清空，避免工具按钮空转
  useEffect(() => {
    if (selId && !findNode(tree, selId)) setSelId(null);
  }, [tree, selId]);

  // 键盘：Enter 加同级、Tab 加子级、F2 改名、Delete 删除（输入框内不拦截）
  useEffect(() => {
    const onKey = e => {
      if (!selId) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Enter') { e.preventDefault(); addSiblingTo(selId); }
      else if (e.key === 'Tab') { e.preventDefault(); addChildTo(selId); }
      else if (e.key === 'F2') { const n = findNode(tree, selId); if (n) { setEditing(selId); setEditVal(n.text); } }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeNode(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 双击空白画布：给选中节点（或中心主题）加子级，并直接进入文字编辑
  const onCanvasDblClick = e => {
    if (e.target.closest('.mm-node, .mm-bar, .mm-hint, button, input')) return;
    addChildTo(selId && posOf[selId] ? selId : tree.id);
  };

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
  }, [zoom]);

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
    a.download = `${String(map.title || '思维导图').replace(/[/\\:*?"<>|]/g, '·').slice(0, 60)}.png`;
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
        <button className="pill ghost" disabled={!selId} onClick={addChild} title="给选中节点加子级（Tab）"><Icon name="plus" size={13}/>子</button>
        <button className="pill ghost" disabled={!selId || selId === tree.id} onClick={() => addSiblingTo(selId)} title="加同级节点（Enter）">同级</button>
        <button className="pill ghost" disabled={!selId} onClick={toggleCollapse} title="收起/展开">折叠</button>
        <button className="pill ghost danger" disabled={!selId || selId === tree.id} onClick={removeNode} title="删除选中节点"><Icon name="trash" size={13}/></button>
        <span className="mm-colors" role="group" aria-label="节点颜色">
          {NODE_COLORS.map(c => <button key={c} type="button" disabled={!selId} onClick={() => setNodeColor(c)}
            className={`mm-dot c-${c}${selMeta.color === c ? ' on' : ''}`} title={`标记颜色 ${c}（再点一次取消）`} aria-label={`节点颜色 ${c}`}/>)}
        </span>
        <button className="pill ghost" disabled={!selId} onClick={openNote} title="编辑节点备注">备注</button>
        <button className={`pill ghost${outlineOpen ? ' on' : ''}`} aria-pressed={!!outlineOpen} onClick={onToggleOutline}
          title="文本大纲：与画布双向同步，可拖动分割线调宽 · Outline panel">大纲 <em>Outline</em></button>
        {onToDraft && <button className="pill ghost" onClick={() => onToDraft(map)}
          title="按导图结构生成一篇新草稿（一级分支转小节） · Convert to draft"><Icon name="draft" size={13}/>转草稿</button>}
        <button className="pill ghost" onClick={() => exportPng()} title="导出为 PNG 图片 · Export PNG"><Icon name="outlink" size={13}/>PNG</button>
        <span className="mm-zoom">
          <button className="icon-btn" onClick={() => setZoom(z => Math.max(0.35, +(z - 0.1).toFixed(2)))} aria-label="缩小">−</button>
          <b>{Math.round(zoom * 100)}%</b>
          <button className="icon-btn" onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(2)))} aria-label="放大">＋</button>
          <button className="icon-btn" onClick={() => fitView()} title="回到内容位置（适应窗口）" aria-label="回到内容位置">⌂</button>
        </span>
      </div>
    </header>
    <div className="mm-viewport" ref={viewport} onMouseDown={onDown} onDoubleClick={onCanvasDblClick}>
      {noteEdit && <div className="mm-note-bar" onMouseDown={e => e.stopPropagation()}>
        <span>备注 <em>Note</em></span>
        <input autoFocus value={noteEdit.val} placeholder="给这个节点写一条备注（随导图保存）" aria-label="节点备注"
          onChange={e => setNoteEdit({...noteEdit, val: e.target.value})}
          onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') commitNote(); if (e.key === 'Escape') setNoteEdit(null); }}/>
        <button className="pill primary" onClick={commitNote}>保存</button>
        <button className="icon-btn" onClick={() => setNoteEdit(null)} aria-label="取消备注"><Icon name="close" size={12}/></button>
      </div>}
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
          const hidden = kids > 0 && !!folded[e.node.id]; // kids 为 0 时不能返回 0：React 会把 0 当文本渲染（旧版叶子节点后面多出一个「0」）
          const meta = parseNodeText(e.node.text);
          const label = e.depth === 0 ? (map.title || '未命名导图') : meta.label; // 中心主题显示导图标题（根文本不进大纲）
          return <div key={e.node.id}
            className={`mm-node${selId === e.node.id ? ' sel' : ''}${e.depth === 0 ? ' root' : ''}${hidden ? ' folded' : ''}${meta.color ? ' c-' + meta.color : ''}`}
            style={{left: x, top: y, width: 150 * zoom, minHeight: 34 * zoom, padding: `${5 * zoom}px ${9 * zoom}px`, borderRadius: 9 * zoom, fontSize: 12.5 * zoom}}
            draggable={editing !== e.node.id}
            onDragStart={ev => { dragId.current = e.node.id; ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', e.node.id); } catch {} }}
            onDragOver={ev => { const src = dragId.current; if (src && src !== e.node.id && !isAncestorId(src, e.node.id)) ev.preventDefault(); }}
            onDrop={ev => { ev.preventDefault(); const src = dragId.current || ev.dataTransfer.getData('text/plain'); dragId.current = null; moveNodeTo(src, e.node.id); }}
            onDragEnd={() => { dragId.current = null; }}
            onClick={ev => { ev.stopPropagation(); setSelId(e.node.id); if (editing && editing !== e.node.id) commitText(); }}
            onDoubleClick={() => { setEditing(e.node.id); setEditVal(label); }}
            title={`${label}${meta.note ? `\n备注：${meta.note}` : ''}\n双击改文字 · 拖动可重排`}>
            {editing === e.node.id
              ? <input autoFocus value={editVal} onChange={ev => setEditVal(ev.target.value)} onBlur={commitText}
                  onKeyDown={ev => { if (ev.key === 'Enter' && !ev.isComposing) commitText(); if (ev.key === 'Escape') setEditing(null); }}
                  onClick={ev => ev.stopPropagation()} aria-label="节点文字"/>
              : <span className="mm-text">{label || '　'}</span>}
            {meta.note && <i className="mm-note-dot" title={`备注：${meta.note}`} aria-hidden="true">•</i>}
            {hidden && <em className="mm-badge">+{kids}</em>}
          </div>;
        })}
      </div>
      <p className="mm-hint">双击空白处新建子节点 · 双击节点改文字 · Enter 同级 · Tab 子级 · ⌘/Ctrl+滚轮缩放</p>
    </div>
  </section>;
}

// —— 浮动窗口：拖拽标题栏移动、右下角拉伸调整大小，位置尺寸记忆 ——
export function MindMapWindow({open, onClose, onOpenContent, initialSel, onToDraft}) {
  const store = mindmapStore.use();
  const list = Array.isArray(store.list) ? store.list : [];
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [win, setWin] = useState(loadWinPos);
  const [sideOpen, setSideOpen] = useState(true);
  // 大纲面板：可收起，宽度可拖拽（记忆在 localStorage）
  const OUTLINE_KEY = CONFIG.storagePrefix + '-mm-outline-v1';
  const OUTLINE_W_KEY = CONFIG.storagePrefix + '-mm-outline-w-v1';
  const [outlineOpen, setOutlineOpen] = useState(() => { try { return JSON.parse(localStorage.getItem(OUTLINE_KEY)) === true; } catch { return false; } });
  const [outlineW, setOutlineW] = useState(() => { try { const v = JSON.parse(localStorage.getItem(OUTLINE_W_KEY)); return Number.isFinite(v) ? Math.max(160, Math.min(480, v)) : 240; } catch { return 240; } });
  useEffect(() => { try { localStorage.setItem(OUTLINE_KEY, JSON.stringify(outlineOpen)); } catch {} }, [OUTLINE_KEY, outlineOpen]);
  useEffect(() => { try { localStorage.setItem(OUTLINE_W_KEY, JSON.stringify(outlineW)); } catch {} }, [OUTLINE_W_KEY, outlineW]);
  const outlineWRef = useRef(outlineW);
  outlineWRef.current = outlineW;
  // 分割线拖拽：向右拖变窄、向左拖变宽（面板在右侧），钳制 160–480
  const onSplitDown = e => {
    e.preventDefault();
    const sx = e.clientX, ow = outlineWRef.current;
    const move = ev => setOutlineW(Math.max(160, Math.min(480, ow - (ev.clientX - sx))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
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
          ? <MapCanvas map={cur} onChange={changeMap} onOpenSource={gid => { onClose(); onOpenContent(gid); }}
              outlineOpen={outlineOpen} onToggleOutline={() => setOutlineOpen(o => !o)} onToDraft={onToDraft}/>
          : <section className="mm-canvas empty"><p className="empty-line">选一张导图或点 ＋ 新建<em>Pick or create</em></p></section>}
        {cur && outlineOpen && <>
          <div className="mm-split" role="separator" aria-orientation="vertical" aria-label="调整大纲宽度"
            title="拖动调整大纲宽度 Drag to resize" onPointerDown={onSplitDown}/>
          <aside className="mm-outline" style={{width: outlineW}} aria-label="文本大纲">
            <header className="mm-outline-head"><span>大纲 <em>Outline</em></span><span>与画布双向同步</span></header>
            <textarea value={cur.outline} aria-label="大纲文本（缩进表示层级）"
              placeholder={'每行一个节点，行首两个空格表示缩进一级\n- 也可以直接粘贴列表'}
              onChange={e => changeMap({...cur, outline: e.target.value})}
              onKeyDown={e => e.stopPropagation()}/>
          </aside>
        </>}
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
