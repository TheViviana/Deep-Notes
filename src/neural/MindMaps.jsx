// 思维导图页：左侧导图清单（独立分类），右侧交互画布（平移/缩放/增删改/折叠）。
// 数据走 conceptStore 的 mindmaps store（localStorage + 知识库 meta.json 同步）。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {CONFIG} from '../config';
import {mindmaps as mindmapStore} from './conceptStore';
import {outlineToTree, treeToOutline, headingsToTree, layoutTree, nodeCount} from './mindmap';

const newId = () => 'mm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// —— 画布：横向树，拖拽平移、按钮缩放，选中节点的编辑与增删 ——
function MapCanvas({map, onChange, onOpenSource}) {
  // 渲染树与操作树是同一份（useMemo 产物深拷贝后改），节点 id 是「路径序号」：
  // 同结构多次解析 id 稳定，选中态跨保存不失效；此前 mutate 独立重 parse，
  // 随机 id 对不上导致非根节点的增删改全部静默无效
  const tree = useMemo(() => outlineToTree(map.outline), [map.outline]);
  const folded = map.folded || {};
  const [selId, setSelId] = useState(null);
  const [editing, setEditing] = useState(null); // 正在改文字的节点 id（'title' = 导图标题）
  const [editVal, setEditVal] = useState('');
  const [zoom, setZoom] = useState(1);
  const view = useRef({x: 40, y: 40});
  const drag = useRef(null);
  const box = useRef(null);
  const [tick, setTick] = useState(0); // 平移后手动重绘（视图状态不进 React，避免拖拽抖动）

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
  // 操作统一在「当前渲染树的拷贝」上改，改完序列化回写；新节点 id 由路径序号在下次解析时自然生成
  const mutate = fn => {
    const root = clone(tree);
    fn(root);
    onChange({...map, outline: treeToOutline(root)});
  };
  const addChild = () => {
    if (!selId) return;
    mutate(root => {
      const n = findNode(root, selId);
      if (n) (n.children ||= []).unshift({id: n.id + '-n', text: '新节点', children: []});
    });
  };
  const addSibling = () => {
    if (!selId) return;
    mutate(root => {
      const p = findParent(root, selId);
      if (!p) return; // 根没有同级
      const idx = p.children.findIndex(c => c.id === selId);
      p.children.splice(idx + 1, 0, {id: p.id + '-n', text: '新节点', children: []});
    });
  };
  const removeNode = () => {
    if (!selId) return;
    mutate(root => {
      const p = findParent(root, selId);
      if (!p) return;
      p.children = p.children.filter(c => c.id !== selId);
    });
    setSelId(null);
  };
  // 折叠态存进导图记录（folded: {路径id: true}），随大纲一起持久化
  const toggleCollapse = () => {
    if (!selId) return;
    const next = {...folded};
    if (next[selId]) delete next[selId]; else next[selId] = true;
    onChange({...map, folded: next});
  };
  const commitText = () => {
    if (!editing) return;
    const t = editVal.trim() || '未命名';
    if (editing === 'title') onChange({...map, title: t}); // 标题改的是导图记录，不进大纲
    else mutate(root => { const n = findNode(root, editing); if (n) n.text = t; });
    setEditing(null);
  };

  const {entries, height} = useMemo(() => layoutTree(tree, folded), [tree, folded]);
  const posOf = useMemo(() => Object.fromEntries(entries.map(e => [e.node.id, e])), [entries]);
  const ROW = 44 * zoom, COL = (150 + 64) * zoom;
  const totalH = height * ROW + 80;
  const maxDepth = entries.reduce((m, e) => Math.max(m, e.depth), 0) + 1;
  const totalW = maxDepth * COL + 120;

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

  return <section className="mm-canvas glass" aria-label={`思维导图画布 ${map.title}`}>
    <header className="mm-bar">
      <div className="mm-bar-title">
        {editing === 'title'
          ? <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={commitText}
              onKeyDown={e => { if (e.key === 'Enter' && !e.isComposing) commitText(); if (e.key === 'Escape') setEditing(null); }} aria-label="导图标题"/>
          : <b onDoubleClick={() => { setEditing('title'); setEditVal(map.title || ''); }} title="双击改标题">{map.title || '未命名导图'}</b>}
        <small>{nodeCount(tree)} 节点 · {entries.length} 可见</small>
      </div>
      <div className="mm-tools" role="group" aria-label="导图工具">
        {map.source && <button className="pill ghost" onClick={() => onOpenSource(map.source)} title="打开生成这篇导图的原文"><Icon name="file" size={13}/>返回原文 <em>Source</em></button>}
        <button className="pill ghost" disabled={!selId} onClick={addChild} title="给选中节点加子级（树-growing）"><Icon name="plus" size={13}/>子节点</button>
        <button className="pill ghost" disabled={!selId || selId === tree.id} onClick={addSibling} title="加同级节点">同级 <em>Sibling</em></button>
        <button className="pill ghost" disabled={!selId} onClick={toggleCollapse} title="收起 / 展开选中节点的后代">收起/展开 <em>折叠</em></button>
        <button className="pill ghost danger" disabled={!selId || selId === tree.id} onClick={removeNode}><Icon name="trash" size={13}/>删除节点</button>
        <span className="mm-zoom">
          <button className="icon-btn" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="缩小">−</button>
          <b>{Math.round(zoom * 100)}%</b>
          <button className="icon-btn" onClick={() => setZoom(z => Math.min(1.6, +(z + 0.1).toFixed(2)))} aria-label="放大">＋</button>
          <button className="icon-btn" onClick={() => { view.current = {x: 40, y: 40}; setTick(t => t + 1); }} aria-label="复位视图" title="复位平移与缩放">⌂</button>
        </span>
      </div>
    </header>
    <div className="mm-viewport" onMouseDown={onDown}>
      <div className="mm-inner" ref={box}>
        <svg className="mm-lines" width={totalW} height={totalH} aria-hidden="true">
          {entries.filter(e => e.depth > 0 && posOf[e.pid]).map(e => {
            const p = posOf[e.pid];
            const x1 = p.depth * COL + 150 * zoom, y1 = p.y * ROW + 18 * zoom;
            const x2 = e.depth * COL, y2 = e.y * ROW + 18 * zoom;
            const mx = (x1 + x2) / 2;
            return <path key={e.node.id} className={selId === e.node.id || selId === e.pid ? 'on' : ''}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}/>;
          })}
        </svg>
        {entries.map(e => {
          const x = e.depth * COL, y = e.y * ROW;
          const kids = (e.node.children || []).length;
          const hidden = kids && folded[e.node.id];
          return <div key={e.node.id}
            className={`mm-node${selId === e.node.id ? ' sel' : ''}${e.depth === 0 ? ' root' : ''}${hidden ? ' folded' : ''}`}
            style={{left: x, top: y, width: 150 * zoom}}
            onClick={ev => { ev.stopPropagation(); setSelId(e.node.id); if (editing && editing !== e.node.id) commitText(); }}
            onDoubleClick={() => { setEditing(e.node.id); setEditVal(e.node.text); }} title="双击改文字">
            {editing === e.node.id
              ? <input autoFocus value={editVal} onChange={ev => setEditVal(ev.target.value)} onBlur={commitText}
                  onKeyDown={ev => { if (ev.key === 'Enter' && !ev.isComposing) commitText(); if (ev.key === 'Escape') setEditing(null); }}
                  onClick={ev => ev.stopPropagation()} aria-label="节点文字"/>
              : <span className="mm-text">{e.node.text || '　'}</span>}
            {hidden && <em className="mm-badge">+{kids}</em>}
          </div>;
        })}
      </div>
      <p className="mm-hint">拖拽空白平移 · 双击节点改文字 · 选中后用上方工具增删折叠</p>
    </div>
  </section>;
}

export function MindMaps({onOpenContent, initialSel}) {
  const store = mindmapStore.use();
  const list = Array.isArray(store.list) ? store.list : [];
  const [sel, setSel] = useState(initialSel || null);
  useEffect(() => { if (initialSel) setSel(initialSel); }, [initialSel]); // 从文章生成后跳进来直接选中
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const saveList = next => mindmapStore.write({list: next});

  const cur = sel ? list.find(m => m.id === sel) : null;
  const changeMap = next => {
    saveList(list.map(m => m.id === next.id ? {...next, updatedAt: Date.now()} : m));
  };
  const createMap = () => {
    const t = name.trim() || '未命名导图';
    const m = {id: newId(), title: t, outline: `- 第一个分支\n- 第二个分支`, source: null, updatedAt: Date.now()};
    saveList([m, ...list]);
    setSel(m.id); setCreating(false); setName('');
  };
  const deleteMap = id => {
    const m = list.find(x => x.id === id);
    if (!window.confirm(`删除导图「${m?.title || '未命名'}」？${m?.source ? '\n原文不受影响，可随时重新生成。' : ''}`)) return;
    saveList(list.filter(x => x.id !== id));
    if (sel === id) setSel(null);
  };

  return <div className="page page-mindmaps">
    <header className="page-head">
      <div><p className="eyebrow">MIND MAPS <span>思维导图</span></p><h1>把结构画出来。</h1><p className="page-sub">独立的导图分类：可直接新建，也可从文章 / 笔记生成并随时回到原文。</p></div>
      <div className="page-head-actions">
        <button className="pill primary" onClick={() => { setCreating(true); setName(''); }}><Icon name="plus" size={15}/>新建导图 <em>New map</em></button>
      </div>
    </header>
    <div className="mm-layout">
      <aside className="mm-list glass" aria-label="导图清单">
        <h3>导图 <em>Maps</em><b>{list.length}</b></h3>
        {creating && <div className="mm-new">
          <input autoFocus value={name} placeholder="导图名称，回车创建" aria-label="新导图名称"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.isComposing) return; if (e.key === 'Enter') createMap(); if (e.key === 'Escape') setCreating(false); }}/>
        </div>}
        {list.map(m => <div key={m.id} className={`mm-item${sel === m.id ? ' active' : ''}`} onClick={() => setSel(m.id)} role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(m.id); } }}>
          <span className="mm-item-body">
            <b>{m.title || '未命名导图'}</b>
            <small>{m.source ? '来自原文 · ' : ''}{nodeCount(outlineToTree(m.outline))} 节点 · {new Date(m.updatedAt || Date.now()).toLocaleDateString()}</small>
          </span>
          <button className="icon-btn" aria-label={`删除导图 ${m.title || ''}`} title="删除导图"
            onClick={e => { e.stopPropagation(); deleteMap(m.id); }}><Icon name="trash" size={13}/></button>
        </div>)}
        {!list.length && !creating && <p className="empty-line">还没有导图。点右上角新建，或在文章 / 笔记里点「导图」从标题生成。<em>No maps yet.</em></p>}
      </aside>
      {cur
        ? <MapCanvas map={cur} onChange={changeMap} onOpenSource={gid => onOpenContent(gid)}/>
        : <section className="mm-canvas glass empty"><p className="empty-line">从左侧选一张导图，或新建一张开始画。<em>Pick or create a map.</em></p></section>}
    </div>
  </div>;
}

// 供 main.jsx 调：从文章/笔记生成（或更新）一张导图。返回创建/更新的 map id（取消返回 null）。
// 重新生成会整体替换 outline（用户在导图上的手工增删将丢失）：已有导图时弹确认；
// folded 折叠态保留不动——结构换血但折叠意愿还在。
export function makeMapFromItem(gid, title, body) {
  const root = headingsToTree(title, body);
  const outline = treeToOutline(root);
  const cur = mindmapStore.get();
  const list = Array.isArray(cur.list) ? cur.list : [];
  const exist = list.find(m => m.source === gid);
  if (exist) {
    if (!window.confirm(`《${title}》已有一张导图。重新生成会替换导图内容（在导图上的手工修改将丢失），确定？`)) return null;
    mindmapStore.write({list: list.map(m => m.id === exist.id ? {...m, title, outline, folded: m.folded, updatedAt: Date.now()} : m)});
    return exist.id;
  }
  const m = {id: newId(), title, outline, source: gid, updatedAt: Date.now()};
  mindmapStore.write({list: [m, ...list]});
  return m.id;
}