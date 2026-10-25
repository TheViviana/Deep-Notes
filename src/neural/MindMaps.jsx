// 思维导图浮动窗口：左下角图标入口，浮在文章/笔记之上。
// 大小与位置可随意调整并记忆（localStorage）；打开期间底层界面照常可交互（无遮罩），
// 工具栏悬停在标题栏上才展开、移开即收起（节省空间）。数据走 conceptStore 的 mindmaps store。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {CONFIG} from '../config';
import {mindmaps as mindmapStore} from './conceptStore';
import {resolveVaultImg} from './images';
import {outlineToTree, treeToOutline, headingsToTree, layoutTree, nodeCount, parseNodeText, formatNodeText, estimateNodeHeight, NODE_COLORS, NODE_W, NODE_GAP_Y, NODE_GAP_X} from './mindmap';

const newId = () => 'mm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const WIN_KEY = CONFIG.storagePrefix + '-mm-window-v1';
const FREE_KEY = CONFIG.storagePrefix + '-mm-freeplace-v1'; // 「自由摆放」模式开关（会话记忆）
const LINK_KEY = CONFIG.storagePrefix + '-mm-linkmode-v1';  // 「连线」模式开关（会话记忆）
const NODE_W_MIN = 96, NODE_W_MAX = 460; // 手调节点宽度的上下限（逻辑 px）
const IMG_TYPE = 'application/x-deepnotes-image'; // 媒体库拖图进导图的 dataTransfer 类型
// 从 drop 事件取媒体库图片载荷（非本类型拖拽返回 null，不影响重排拖拽）
const imgPayloadOf = e => {
  try {
    const v = JSON.parse(e.dataTransfer.getData(IMG_TYPE));
    return v && (v.ref || v.src) ? v : null;
  } catch { return null; }
};
const imgTokenOf = p => p.ref ? `![[${p.ref}]]` : `![图片](${p.src})`;

function loadWinPos() {
  try {
    const v = JSON.parse(localStorage.getItem(WIN_KEY));
    const num = (x, d, min, max) => Number.isFinite(Number(x)) ? Math.max(min, Math.min(max, Number(x))) : d;
    return {w: num(v?.w, 720, 400, window.innerWidth - 40), h: num(v?.h, 500, 300, window.innerHeight - 40),
            x: num(v?.x, 80, 0, Math.max(0, window.innerWidth - 400)), y: num(v?.y, 60, 0, Math.max(0, window.innerHeight - 300))};
  } catch { return {w: 720, h: 500, x: 80, y: 60}; }
}

// 节点文字里的 [[双链]] 与图片（![[图.png]] / ![alt](src)）就地渲染：双链是可点击跳转的小按钮
// （与正文双链同一套名称解析：标题 / 路径文件名，忽略大小写）；图片是缩略图（库内引用由
// resolveVaultImg 回填，dataURL / 网络图直接显示）；未创建的目标按纯文本 + 虚线显示，不产生死按钮
const MM_LABEL_TOKEN = /(!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\s]+\)|\[\[[^\]\n]+\]\])/g;
function NodeLabel({label, nameMap, onJump, linkMode, freePlace}) {
  const dragMode = !!(linkMode || freePlace); // 连线/摆放模式：mousedown 必须放行给节点拖动逻辑
  const parts = String(label || '').split(MM_LABEL_TOKEN);
  return parts.map((seg, i) => {
    let m = seg.match(/^!\[\[([^\]\n]+)\]\]$/);
    if (m) {
      const name = m[1].split('|')[0].trim();
      return <img key={i} className="mm-node-img" data-asset={name} alt={name} draggable={false}/>;
    }
    m = seg.match(/^!\[([^\]\n]*)\]\(([^)\s]+)\)$/);
    if (m) {
      const src = m[2];
      const local = !/^(data:|https?:|blob:)/i.test(src);
      return <img key={i} className="mm-node-img" src={src} alt={m[1] || '图片'} draggable={false}
        {...(local ? {'data-local': '1'} : {})}/>;
    }
    m = seg.match(/^\[\[([^\]\n]+)\]\]$/);
    if (m) {
      const raw = m[1].split('|')[0].trim();
      const gid = nameMap && raw ? nameMap.get(raw.split('#')[0].toLowerCase()) : null;
      if (!gid || !onJump) return <span key={i} className="mm-wikilink unresolved">{raw}</span>;
      return <button key={i} type="button" className="mm-wikilink" title={`打开「${raw}」`}
        onMouseDown={e => { if (!dragMode) e.stopPropagation(); }}
        onClick={e => { e.stopPropagation(); if (!dragMode) onJump(gid); }}>{raw}</button>;
    }
    return <React.Fragment key={i}>{seg}</React.Fragment>;
  });
}

// —— 画布：横向树，拖拽平移、⌘+滚轮缩放、选中节点的编辑与增删 ——
// 节点文字自动换行、框随内容增高；右缘把手可拖宽（sizes 记忆）；「摆放」模式下节点可自由拖位（pos 记忆）；
// 「连线」模式下可在任意两节点间拉一条自由曲线（map.links，独立于父子层级）；节点文字里的 [[双链]] 可点击跳转。
function MapCanvas({map, onChange, onOpenSource, outlineOpen, onToggleOutline, onToDraft, onUndo, onRedo, canUndo, canRedo, nameMap, onJump}) {
  const tree = useMemo(() => outlineToTree(map.outline), [map.outline]);
  const folded = map.folded || {};
  const sizes = map.sizes || {};   // {路径id: 逻辑宽 px}——右缘把手拖宽的记忆
  const posMap = map.pos || {};    // {路径id: {x, y}}——「摆放」模式下的自由位置（逻辑坐标）
  const userLinks = Array.isArray(map.links) ? map.links : []; // [{id, a, b}]——自由连线
  const [selId, setSelId] = useState(null);
  const [selLink, setSelLink] = useState(null); // 选中的自由连线 id
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [noteEdit, setNoteEdit] = useState(null); // {id, val}：正在编辑的节点备注
  const [zoom, setZoom] = useState(1);
  const [freePlace, setFreePlace] = useState(() => { try { return JSON.parse(localStorage.getItem(FREE_KEY)) === true; } catch { return false; } });
  const [linkMode, setLinkMode] = useState(() => { try { return JSON.parse(localStorage.getItem(LINK_KEY)) === true; } catch { return false; } });
  const [linkDrag, setLinkDrag] = useState(null); // 连线拖拽中：{a, mx, my}（鼠标画布逻辑坐标，实时预览）
  const [live, setLive] = useState(null); // 拖动中的实时覆盖：{id, x, y}（自由拖位）或 {id, w}（调宽）
  useEffect(() => { try { localStorage.setItem(FREE_KEY, JSON.stringify(freePlace)); } catch {} }, [freePlace]);
  useEffect(() => { try { localStorage.setItem(LINK_KEY, JSON.stringify(linkMode)); } catch {} }, [linkMode]);
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
  // 收集一棵子树的全部节点 id：删除节点时同步清掉 sizes/pos 残留——
  // 否则同路径新建的节点（路径序号 id 会复用）会莫名继承被删节点的宽度/位置。
  // 命中后只收集该子树：不能按「已收集非空」判断——深度优先回溯后会把兄弟子树也误收进来
  const subtreeIds = (root, id) => {
    const out = [];
    const collect = n => { out.push(n.id); for (const c of n.children || []) collect(c); };
    const walk = n => {
      if (n.id === id) { collect(n); return true; }
      for (const c of n.children || []) if (walk(c)) return true;
      return false;
    };
    walk(root);
    return out;
  };
  const removeNode = () => {
    if (selLink) { removeLink(selLink); return; } // 选中的是自由连线：删除该线
    if (!selId) return;
    const gone = new Set(subtreeIds(tree, selId));
    const root = clone(tree);
    const p = findParent(root, selId);
    if (p) p.children = p.children.filter(c => c.id !== selId);
    const sizes = {...(map.sizes || {})}, pos = {...(map.pos || {})};
    for (const id of gone) { delete sizes[id]; delete pos[id]; }
    // 连到被删节点（含其子树）的自由连线一并移除，不留悬空线
    const links = userLinks.filter(l => !gone.has(l.a) && !gone.has(l.b));
    // 一次提交：新大纲 + 清理后的 sizes/pos/links——分两次写会让第二次用旧 outline 把删除回滚掉
    onChange({...map, outline: treeToOutline(root), sizes, pos, links});
    setSelId(null);
  };
  const toggleCollapse = () => {
    if (!selId) return;
    const next = {...folded};
    if (next[selId]) delete next[selId]; else next[selId] = true;
    onChange({...map, folded: next});
  };
  // 一键展开 / 收起全部：收起折叠到一级（root 不折，否则整图只剩中心主题）
  const expandAll = () => { if (Object.keys(folded).length) onChange({...map, folded: {}}); };
  const collapseAll = () => {
    const next = {};
    const walk = (n, depth) => {
      if (depth >= 1 && (n.children || []).length) next[n.id] = true;
      for (const c of n.children || []) walk(c, depth + 1);
    };
    walk(tree, 0);
    onChange({...map, folded: next});
  };
  // —— 自由连线：任意两节点之间拉一条曲线（独立于父子层级，随节点位置自动跟随） ——
  const addLink = (a, b) => {
    if (!a || !b || a === b) return;
    const dup = userLinks.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    if (dup) return;
    onChange({...map, links: [...userLinks, {id: 'lk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), a, b}]});
  };
  const removeLink = id => {
    onChange({...map, links: userLinks.filter(l => l.id !== id)});
    setSelLink(null);
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

  // —— 几何计算（三步）：每节点宽 → 估算高度 → 紧凑布局 → 渲染坐标（含自由摆放/调宽覆盖） ——
  const labelOf = (id, text) => (id === tree.id ? (map.title || '未命名导图') : parseNodeText(text).label);
  const widthOf = id => Math.max(NODE_W_MIN, Math.min(NODE_W_MAX, sizes[id] || NODE_W));
  const heights = useMemo(() => {
    const m = new Map();
    const walk = n => {
      m.set(n.id, estimateNodeHeight(labelOf(n.id, n.text), widthOf(n.id)));
      for (const c of n.children || []) walk(c);
    };
    walk(tree);
    return m;
  }, [tree, map.title, map.sizes]); // eslint-disable-line react-hooks/exhaustive-deps
  const {entries} = useMemo(() => layoutTree(tree, folded, heights, NODE_GAP_Y), [tree, folded, heights]);
  // 渲染几何：逻辑坐标（画布原点相对），渲染时统一乘 zoom。自由拖位/调宽的实时值在此覆盖。
  const geometry = useMemo(() => {
    const g = new Map();
    for (const e of entries) {
      const id = e.node.id;
      const w = live?.kind === 'w' && live.id === id ? live.w : widthOf(id);
      const pos = live?.kind === 'p' && live.id === id ? {x: live.x, y: live.y} : posMap[id];
      g.set(id, {
        x: pos ? pos.x : e.depth * (NODE_W + NODE_GAP_X),
        y: pos ? pos.y : e.y,
        w, h: heights.get(id) || 34,
      });
    }
    return g;
  }, [entries, heights, map.pos, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const CANVAS = 20000;
  const ORIGIN = CANVAS / 2;

  // 视图定位：把内容包围盒放到视口正中。节点画在 20000 画布的中心（ORIGIN），
  // 打开导图 / 切换导图时若不定位，节点全在视口外——看起来就是「一张空导图」「两个找不到的节点」。
  const fitView = useCallback(() => {
    const vp = viewport.current;
    if (!vp || !geometry.size) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of geometry.values()) {
      minX = Math.min(minX, g.x); maxX = Math.max(maxX, g.x + g.w);
      minY = Math.min(minY, g.y); maxY = Math.max(maxY, g.y + g.h);
    }
    const vw = vp.clientWidth || 640, vh = vp.clientHeight || 420;
    const w = (maxX - minX) * zoom, h = (maxY - minY) * zoom;
    view.current = {
      x: (vw - w) / 2 - ORIGIN - minX * zoom,
      y: (vh - h) / 2 - ORIGIN - minY * zoom,
    };
    if (box.current) box.current.style.transform = `translate(${view.current.x}px, ${view.current.y}px)`;
  }, [geometry, zoom, ORIGIN]);
  // 只在切换导图时自动定位；编辑过程中不抢视角
  const fitRef = useRef(fitView);
  fitRef.current = fitView;
  useEffect(() => {
    // 换导图：清掉上一张的选中 / 编辑态（路径 id 在不同导图里可能撞名，残留会误删新导图的节点或连线）
    setSelId(null); setEditing(null); setNoteEdit(null); setSelLink(null);
    const raf = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(raf);
  }, [map.id]);

  // 结构变化后选中 id 可能失效（如删除了父节点）：清空，避免工具按钮空转
  useEffect(() => {
    if (selId && !findNode(tree, selId)) setSelId(null);
  }, [tree, selId]);

  // 键盘：Enter 加同级、Tab 加子级、F2 改名、Delete 删除（选中的是自由连线时 Delete 删线；输入框内不拦截）
  useEffect(() => {
    const onKey = e => {
      if (!selId && !selLink) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Enter' && selId) { e.preventDefault(); addSiblingTo(selId); }
      else if (e.key === 'Tab' && selId) { e.preventDefault(); addChildTo(selId); }
      else if (e.key === 'F2' && selId) { const n = findNode(tree, selId); if (n) { setEditing(selId); setEditVal(n.text); } }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeNode(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 双击空白画布：给选中节点（或中心主题）加子级，并直接进入文字编辑
  const onCanvasDblClick = e => {
    if (e.target.closest('.mm-node, .mm-bar, .mm-hint, button, input')) return;
    addChildTo(selId && geometry.get(selId) ? selId : tree.id);
  };

  const onWheel = useCallback(e => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setZoom(z => Math.max(0.35, Math.min(2, +(z + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2))));
      return;
    }
    // 普通滚轮转发给底层页面：导图窗口开着也能滚轮阅读身后的文章（平移画布用拖拽）
    e.preventDefault();
    window.scrollBy(0, e.deltaY);
  }, []);
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    vp.addEventListener('wheel', onWheel, {passive: false});
    return () => vp.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  // —— 自由摆放：拖节点任意移位（pos 记忆，子树仍自动排；线在落盘后由 geometry 重算） ——
  const rafLive = useRef(0);
  const setLiveRaf = next => { // rAF 合帧：拖动每帧至多一次重渲染，几百节点的大图也流畅
    if (rafLive.current) cancelAnimationFrame(rafLive.current);
    rafLive.current = requestAnimationFrame(() => { rafLive.current = 0; setLive(next); });
  };
  useEffect(() => () => { if (rafLive.current) cancelAnimationFrame(rafLive.current); }, []);
  // 鼠标 → 画布逻辑坐标（inner 含 view 平移与 zoom 缩放）
  const canvasPt = e => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return {x: 0, y: 0};
    return {x: (e.clientX - r.left) / zoom - ORIGIN, y: (e.clientY - r.top) / zoom - ORIGIN};
  };
  const onNodeDown = (e, id) => {
    if (e.button !== 0 || e.target.closest('.mm-nw, input')) return;
    const g = geometry.get(id);
    if (!g) return;
    if (linkMode) {
      // 连线模式：mousedown 起点节点，拖到目标节点松手建一条自由曲线
      e.preventDefault();
      e.stopPropagation();
      setSelId(id); setSelLink(null);
      const move = ev => setLinkDrag({a: id, mx: canvasPt(ev).x, my: canvasPt(ev).y});
      const up = ev => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const t = ev.target.closest?.('.mm-node');
        const bid = t?.dataset?.id;
        if (bid && bid !== id) addLink(id, bid);
        setLinkDrag(null);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    if (freePlace) {
      // 摆放模式：mousedown 即开始自由拖位（阻止 HTML5 reparent 拖拽与文本选择）
      e.preventDefault();
      e.stopPropagation();
      setSelId(id);
      const sx = e.clientX, sy = e.clientY, ox = g.x, oy = g.y;
      const move = ev => setLiveRaf({kind: 'p', id, x: Math.round(ox + (ev.clientX - sx) / zoom), y: Math.round(oy + (ev.clientY - sy) / zoom)});
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        setLive(cur => { // 落盘：与拖动中同一份实时值写成 pos；无位移则不产生写入
          if (cur && cur.kind === 'p' && cur.id === id) {
            const old = posMap[id];
            if (!old || old.x !== cur.x || old.y !== cur.y) onChange({...map, pos: {...posMap, [id]: {x: cur.x, y: cur.y}}});
          }
          return null;
        });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
    // 默认模式：点击选中（拖拽重排走 HTML5 draggable）
    e.stopPropagation();
    setSelId(id);
    if (editing && editing !== id) commitText();
  };
  // 右缘把手拖宽（任何模式可用；双击恢复默认宽）
  const onWidthDown = (e, id) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const g = geometry.get(id);
    if (!g) return;
    const sx = e.clientX, ow = g.w;
    const move = ev => setLiveRaf({kind: 'w', id, w: Math.round(Math.max(NODE_W_MIN, Math.min(NODE_W_MAX, ow + (ev.clientX - sx) / zoom)))});
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setLive(cur => {
        if (cur && cur.kind === 'w' && cur.id === id) {
          const nextSizes = {...sizes};
          if (cur.w === NODE_W) delete nextSizes[id]; else nextSizes[id] = cur.w;
          const changed = JSON.stringify(nextSizes) !== JSON.stringify(sizes);
          if (changed) onChange({...map, sizes: nextSizes});
        }
        return null;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const resetPlacement = () => {
    if (!Object.keys(posMap).length && !userLinks.length) return;
    onChange({...map, pos: {}, links: []}); // 复位：清自由位置与自由连线，回到纯自动布局
    setSelLink(null);
  };

  // —— 媒体库拖图进导图：落到节点上把图片追加进该节点文字；落到空白处新建一个图片节点 ——
  // 节点宽度顺手放宽到至少 190（图片缩略图太窄看不清），随 sizes 记忆
  const dropImageOnNode = (id, payload) => {
    const root = clone(tree);
    const n = findNode(root, id);
    if (!n) return;
    const p = parseNodeText(n.text);
    const label = (p.label + ' ' + imgTokenOf(payload)).trim();
    n.text = formatNodeText(label, p.note, p.color);
    const sizes = {...map.sizes};
    if (!sizes[id] || sizes[id] < 190) sizes[id] = Math.max(sizes[id] || NODE_W, 190);
    onChange({...map, outline: treeToOutline(root), sizes});
    setSelId(id);
  };
  const dropImageOnCanvas = payload => {
    const base = selId && geometry.get(selId) ? selId : tree.id; // 空白落图：挂到选中节点（或中心主题）末尾
    const parent = findNode(tree, base);
    if (!parent) return;
    const idx = (parent.children || []).length;
    applyTree(root => { const n = findNode(root, base); if (n) (n.children ||= []).push({text: imgTokenOf(payload), children: []}); });
    setSelId(base + '-' + idx);
  };
  // 库内引用图回填：节点 DOM 随每次渲染重建（vaultDone 标记重置），resolveVaultImg 自带缓存，重复调用廉价
  useEffect(() => {
    const el = box.current;
    if (el) el.querySelectorAll('img[data-asset], img[data-local]').forEach(img => resolveVaultImg(img));
  });

  const onDown = e => {
    if (e.button !== 0 || e.target.closest('.mm-node')) return;
    setSelLink(null); // 点空白：取消连线选中
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
    // 自由连线（青色，与父子线区分）
    const upaths = [...vp.querySelectorAll('.mm-userlines .mm-uline')];
    ctx.strokeStyle = 'rgba(140,200,250,.75)';
    ctx.lineWidth = 1.6;
    upaths.forEach(p => {
      const d = p.getAttribute('d');
      if (!d) return;
      const nums = d.match(/[-\d.]+/g);
      if (!nums || nums.length < 6) return;
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
      // 节点内的图片缩略图（已加载成功的画进导出图，随图排布在文字下方）
      const thumb = n.querySelector('.mm-node-img');
      let textY = y + h / 2;
      if (thumb && thumb.complete && thumb.naturalWidth > 0) {
        const iw = w - 18, ih = Math.min(92, Math.round(iw * thumb.naturalHeight / thumb.naturalWidth));
        ctx.drawImage(thumb, x + 9, y + 22, iw, ih);
        textY = y + 14;
      }
      // 文字
      const text = n.querySelector('.mm-text')?.textContent || '';
      ctx.fillStyle = isRoot ? '#e8b45a' : '#ecece9';
      ctx.textBaseline = 'middle';
      const maxChars = Math.floor(w / 7.2);
      ctx.fillText(text.length > maxChars ? text.slice(0, maxChars) + '…' : text, x + 9, textY, w - 14);
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
      <span className="mm-tools-hint" aria-hidden="true">⚙ 工具</span>
      <div className="mm-tools" role="group" aria-label="导图工具">
        <button className="pill ghost" disabled={!canUndo} onClick={onUndo} title="撤销（⌘/Ctrl+Z）"><Icon name="replay" size={13}/>撤销</button>
        <button className="pill ghost" disabled={!canRedo} onClick={onRedo} title="重做（⌘/Ctrl+Shift+Z）"><Icon name="replay" size={13}/>重做</button>
        {map.source && <button className="pill ghost" onClick={() => onOpenSource(map.source)} title="打开原文"><Icon name="file" size={13}/>原文 <em>Src</em></button>}
        <button className="pill ghost" disabled={!selId} onClick={addChild} title="给选中节点加子级（Tab）"><Icon name="plus" size={13}/>子</button>
        <button className="pill ghost" disabled={!selId || selId === tree.id} onClick={() => addSiblingTo(selId)} title="加同级节点（Enter）">同级</button>
        <button className="pill ghost" disabled={!selId} onClick={toggleCollapse} title="收起/展开">折叠</button>
        <button className="pill ghost" onClick={expandAll} disabled={!Object.keys(folded).length} title="展开全部节点">展开</button>
        <button className="pill ghost" onClick={collapseAll} title="收起全部（折叠到一级分支）">收全</button>
        <button className={`pill ghost${freePlace ? ' on' : ''}`} aria-pressed={freePlace} onClick={() => setFreePlace(v => !v)}
          title={freePlace ? '自由摆放中：拖动节点放到任意位置（点此恢复自动布局）' : '开启自由摆放：拖动节点放到任意位置（宽度把手不受影响）'}>摆放</button>
        <button className={`pill ghost${linkMode ? ' on' : ''}`} aria-pressed={linkMode} onClick={() => setLinkMode(v => !v)}
          title={linkMode ? '连线中：从节点 A 拖到节点 B 建一条自由曲线（点此退出）' : '连线模式：在任意两个节点之间拉一条自由曲线（Delete 删除选中的线）'}>连线</button>
        <button className="pill ghost" disabled={!Object.keys(posMap).length && !userLinks.length} onClick={resetPlacement}
          title="清除全部自由摆放的位置与自由连线，回到自动布局">复位</button>
        <button className="pill ghost danger" disabled={!selLink && (!selId || selId === tree.id)} onClick={removeNode} title="删除选中节点 / 连线"><Icon name="trash" size={13}/></button>
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
    <div className="mm-viewport" ref={viewport} onMouseDown={onDown} onDoubleClick={onCanvasDblClick}
      onDragOver={ev => { if (ev.dataTransfer.types.includes(IMG_TYPE)) ev.preventDefault(); }}
      onDrop={ev => {
        const img = imgPayloadOf(ev);
        if (!img) return;
        ev.preventDefault();
        dropImageOnCanvas(img);
      }}>
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
          {entries.filter(e => e.depth > 0 && geometry.get(e.pid)).map(e => {
            const P = geometry.get(e.pid), C = geometry.get(e.node.id);
            // 线锚在节点框的真实边缘：父右缘中点 → 子左缘中点（节点高度随文字自适应后不再用固定 18px 偏移）
            const x1 = ORIGIN + (P.x + P.w) * zoom, y1 = ORIGIN + (P.y + P.h / 2) * zoom;
            const x2 = ORIGIN + C.x * zoom, y2 = ORIGIN + (C.y + C.h / 2) * zoom;
            const mx = (x1 + x2) / 2;
            return <path key={e.node.id} className={selId === e.node.id || selId === e.pid ? 'on' : ''}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}/>;
          })}
        </svg>
        {/* 自由连线：独立于父子层级，可点击选中、Delete 删除；宽热区 path 负责命中 */}
        <svg className="mm-userlines" width={CANVAS} height={CANVAS}>
          {userLinks.map(l => {
            const A = geometry.get(l.a), B = geometry.get(l.b);
            if (!A || !B) return null;
            const a2b = A.x + A.w <= B.x, b2a = B.x + B.w <= A.x;
            const [x1, y1, x2, y2] = a2b ? [ORIGIN + (A.x + A.w) * zoom, ORIGIN + (A.y + A.h / 2) * zoom, ORIGIN + B.x * zoom, ORIGIN + (B.y + B.h / 2) * zoom]
              : b2a ? [ORIGIN + (B.x + B.w) * zoom, ORIGIN + (B.y + B.h / 2) * zoom, ORIGIN + A.x * zoom, ORIGIN + (A.y + A.h / 2) * zoom]
              : [ORIGIN + (A.x + A.w / 2) * zoom, ORIGIN + (A.y + (A.y <= B.y ? A.h : 0)) * zoom, ORIGIN + (B.x + B.w / 2) * zoom, ORIGIN + (B.y + (A.y <= B.y ? 0 : B.h)) * zoom];
            const mx = (x1 + x2) / 2;
            const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
            return <g key={l.id} className={selLink === l.id ? 'sel' : ''}>
              <path className="mm-uline-hit" d={d} fill="none" onClick={e => { e.stopPropagation(); setSelLink(l.id); setSelId(null); }}/>
              <path className="mm-uline" d={d} fill="none" pointerEvents="none"/>
            </g>;
          })}
          {linkDrag && (() => {
            const A = geometry.get(linkDrag.a);
            if (!A) return null;
            const fromRight = linkDrag.mx >= A.x;
            const x1 = ORIGIN + (fromRight ? A.x + A.w : A.x) * zoom, y1 = ORIGIN + (A.y + A.h / 2) * zoom;
            const x2 = ORIGIN + linkDrag.mx * zoom, y2 = ORIGIN + linkDrag.my * zoom;
            const mx = (x1 + x2) / 2;
            return <path className="mm-uline preview" d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" pointerEvents="none"/>;
          })()}
        </svg>
        {entries.map(e => {
          const g = geometry.get(e.node.id) || {x: e.x, y: e.y, w: NODE_W, h: 34};
          const kids = (e.node.children || []).length;
          const hidden = kids > 0 && !!folded[e.node.id]; // kids 为 0 时不能返回 0：React 会把 0 当文本渲染（旧版叶子节点后面多出一个「0」）
          const meta = parseNodeText(e.node.text);
          const label = e.depth === 0 ? (map.title || '未命名导图') : meta.label; // 中心主题显示导图标题（根文本不进大纲）
          return <div key={e.node.id} data-id={e.node.id}
            className={`mm-node${selId === e.node.id ? ' sel' : ''}${e.depth === 0 ? ' root' : ''}${hidden ? ' folded' : ''}${meta.color ? ' c-' + meta.color : ''}${freePlace ? ' free' : ''}${linkMode ? ' linking' : ''}`}
            style={{left: ORIGIN + g.x * zoom, top: ORIGIN + g.y * zoom, width: g.w * zoom, minHeight: g.h * zoom, padding: `${5 * zoom}px ${9 * zoom}px`, borderRadius: 9 * zoom, fontSize: 12.5 * zoom}}
            draggable={!freePlace && !linkMode && editing !== e.node.id}
            onDragStart={ev => { dragId.current = e.node.id; ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', e.node.id); } catch {} }}
            onDragOver={ev => {
              if (ev.dataTransfer.types.includes(IMG_TYPE)) { ev.preventDefault(); return; } // 媒体库拖图：允许落到本节点
              const src = dragId.current; if (src && src !== e.node.id && !isAncestorId(src, e.node.id)) ev.preventDefault();
            }}
            onDrop={ev => {
              const img = imgPayloadOf(ev);
              if (img) { ev.preventDefault(); ev.stopPropagation(); dropImageOnNode(e.node.id, img); return; } // 图片不冒泡到画布
              ev.preventDefault(); ev.stopPropagation();
              const src = dragId.current || ev.dataTransfer.getData('text/plain'); dragId.current = null; moveNodeTo(src, e.node.id);
            }}
            onDragEnd={() => { dragId.current = null; }}
            onMouseDown={ev => onNodeDown(ev, e.node.id)}
            onDoubleClick={() => { setEditing(e.node.id); setEditVal(label); }}
            title={`${label}${meta.note ? `\n备注：${meta.note}` : ''}\n双击改文字 · 拖右缘调宽${linkMode ? ' · 拖到目标节点建立连线' : freePlace ? ' · 拖动自由摆放' : ' · 拖到别的节点上重排'}`}>
            {editing === e.node.id
              ? <input autoFocus value={editVal} onChange={ev => setEditVal(ev.target.value)} onBlur={commitText}
                  onKeyDown={ev => { if (ev.key === 'Enter' && !ev.isComposing) commitText(); if (ev.key === 'Escape') setEditing(null); }}
                  onClick={ev => ev.stopPropagation()} aria-label="节点文字"/>
              : <span className="mm-text"><NodeLabel label={label} nameMap={nameMap} onJump={onJump} linkMode={linkMode} freePlace={freePlace}/>{label ? '' : '　'}</span>}
            {meta.note && <i className="mm-note-dot" title={`备注：${meta.note}`} aria-hidden="true">•</i>}
            {hidden && <em className="mm-badge">+{kids}</em>}
            <i className="mm-nw" aria-hidden="true" title="拖动调宽（双击恢复默认）"
              onMouseDown={ev => onWidthDown(ev, e.node.id)}
              onDoubleClick={ev => { ev.stopPropagation(); if (sizes[e.node.id]) onChange({...map, sizes: {...sizes, [e.node.id]: NODE_W}}); }}
              onClick={ev => ev.stopPropagation()}/>
          </div>;
        })}
      </div>
      <p className="mm-hint">双击空白新建 · 双击节点改文字 · Enter 同级 / Tab 子级 · 拖右缘调宽 · 「摆放」拖节点自由移位 · 「连线」从 A 拖到 B 建自由曲线（点线选中，Delete 删）· 节点里 [[双链]] 可点击 · ⌘/Ctrl+滚轮缩放 · 滚轮滚动身后文章</p>
    </div>
  </section>;
}

// —— 浮动窗口：拖拽标题栏移动、右下角拉伸调整大小，位置尺寸记忆 ——
// graph 供节点 [[双链]] 解析名称 → 内容 id；撤销/重做在窗口层统一管理（changeMap 每次写入前先压栈）
export function MindMapWindow({open, onClose, onOpenContent, initialSel, onToDraft, graph}) {
  const store = mindmapStore.use();
  const list = Array.isArray(store.list) ? store.list : [];
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [win, setWin] = useState(loadWinPos);
  const [sideOpen, setSideOpen] = useState(true);
  // 撤销 / 重做：按导图记录快照（切换导图即清空）。栈只存引用，大导图也只是多几个对象指针
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const [hist, setHist] = useState({undo: 0, redo: 0});
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
  // changeMap 包装：写入前把当前版本压进撤销栈（上限 50 步），重做栈清空
  const changeMap = next => {
    const curSnap = list.find(m => m.id === next.id);
    if (curSnap) {
      undoStack.current = [...undoStack.current.slice(-49), curSnap];
      redoStack.current = [];
      setHist({undo: undoStack.current.length, redo: 0});
    }
    mindmapStore.write({list: list.map(m => m.id === next.id ? {...next, updatedAt: Date.now()} : m)});
  };
  const undo = () => {
    const curSnap = sel ? list.find(m => m.id === sel) : null;
    const prev = undoStack.current.pop();
    if (!curSnap || !prev) return;
    redoStack.current.push(curSnap);
    mindmapStore.write({list: list.map(m => m.id === curSnap.id ? {...prev, updatedAt: Date.now()} : m)});
    setHist({undo: undoStack.current.length, redo: redoStack.current.length});
  };
  const redo = () => {
    const curSnap = sel ? list.find(m => m.id === sel) : null;
    const next = redoStack.current.pop();
    if (!curSnap || !next) return;
    undoStack.current.push(curSnap);
    mindmapStore.write({list: list.map(m => m.id === curSnap.id ? {...next, updatedAt: Date.now()} : m)});
    setHist({undo: undoStack.current.length, redo: redoStack.current.length});
  };
  // 切换导图 / 关窗：清空历史（跨导图的撤销没有意义且会串图）
  useEffect(() => { undoStack.current = []; redoStack.current = []; setHist({undo: 0, redo: 0}); }, [sel]);
  // ⌘/Ctrl+Z 撤销、⌘/Ctrl+Shift+Z（或 ⌘Y）重做：输入框内不拦截
  const histRef = useRef(null); histRef.current = {undo, redo};
  useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? histRef.current.redo() : histRef.current.undo(); }
      else if (k === 'y') { e.preventDefault(); histRef.current.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // 节点 [[双链]] 名称解析：与图谱 nameIndex 同规则（graph 未传时不渲染跳转按钮）
  const nameMap = useMemo(() => {
    if (!graph?.nodes) return null;
    const m = new Map();
    for (const n of graph.nodes) {
      if (n.kind !== 'post' && n.kind !== 'note' && n.kind !== 'idea' && n.kind !== 'draft' && n.kind !== 'reading' && n.kind !== 'archive') continue;
      m.set(String(n.title).toLowerCase(), n.id);
      if (n.path) m.set(n.path.split('/').pop().replace(/\.md$/, '').toLowerCase(), n.id);
    }
    return m;
  }, [graph]);
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
    {/* 无全屏遮罩：导图窗口打开期间底层界面照常可点击、可滚动、可编辑——窗口只是浮在内容上方（悬停工具栏 + 窗口本体自身交互） */}
    <div className="mm-window glass" style={{left: win.x, top: win.y, width: win.w, height: win.h}} role="dialog" aria-label="思维导图浮动窗口">
      <header className="mm-window-head" ref={headRef}>
        <b><Icon name="concept" size={13}/> 思维导图 <em>Mind Map</em></b>
        <div className="mm-window-tools">
          <button className="icon-btn" onClick={() => setSideOpen(o => !o)} title={sideOpen ? '收起清单' : '展开清单'} aria-label="切换清单">{sideOpen ? '◀' : '▶'}</button>
          <button className="icon-btn" onClick={() => { setCreating(true); setName(''); }} title="新建导图" aria-label="新建导图"><Icon name="plus" size={13}/></button>
          <button className="icon-btn" onClick={onClose} title="关闭思维导图" aria-label="关闭思维导图"><Icon name="close" size={14}/></button>
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
              outlineOpen={outlineOpen} onToggleOutline={() => setOutlineOpen(o => !o)} onToDraft={onToDraft}
              onUndo={undo} onRedo={redo} canUndo={hist.undo > 0} canRedo={hist.redo > 0}
              nameMap={nameMap} onJump={gid => { onClose(); onOpenContent(gid); }}/>
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
    mindmapStore.write({list: list.map(m => m.id === exist.id ? {...m, title, outline, folded: m.folded, sizes: m.sizes, pos: m.pos, links: m.links, updatedAt: Date.now()} : m)});
    return exist.id;
  }
  const m = {id: newId(), title, outline, source: gid, updatedAt: Date.now()};
  mindmapStore.write({list: [m, ...list]});
  return m.id;
}
