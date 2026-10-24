// 从 main.jsx 拆出的两个独立弹窗组件：每日随机回顾 与 全库批量替换。
// main.jsx 由此回到以应用壳 / 数据流为主的职责，弹窗组件独立可测。
import React, {useDeferredValue, useEffect, useMemo, useState} from 'react';
import {Icon} from './icons';
import {CONFIG} from '../config';
import {Modal} from './Modal.jsx';

const KIND_ZH = {works: '作品库', methods: '方法库', readings: '阅读区', archives: '档案区'};

// —— 每日随机回顾：每天首次启动按日期种子确定性挑 3 条旧内容，浮动入口 + 弹窗速览 ——
// 同一天多次启动抽到同三篇；点条目直接跳转打开。防止导入的旧笔记/书籍章节石沉大海。
const RECALL_KEY = CONFIG.storagePrefix + '-daily-recall-v1';
function todayRecall(pool) {
  if (!pool.length) return [];
  const d = new Date();
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(RECALL_KEY)); } catch {}
  if (cached?.day === day && Array.isArray(cached.ids)) {
    const byId = new Map(pool.map(x => [x.id, x]));
    const items = cached.ids.map(id => byId.get(id)).filter(Boolean);
    if (items.length) return items;
  }
  // 日期做种子的确定性洗牌：清了缓存 / 重装后同一天抽到的仍是同三篇
  let s = 0; for (const c of day) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  const picked = arr.slice(0, Math.min(3, arr.length));
  try { localStorage.setItem(RECALL_KEY, JSON.stringify({day, ids: picked.map(x => x.id)})); } catch {}
  return picked;
}
export function DailyRecall({works, notes, readings, archives, onOpen}) {
  // 池子用延迟值构建：编辑打字不必每个按键全库重建摘录（大库 O(全库字符数)）
  const dWorks = useDeferredValue(works);
  const dNotes = useDeferredValue(notes);
  const dReadings = useDeferredValue(readings);
  const dArchives = useDeferredValue(archives);
  const pool = useMemo(() => [
    ...dWorks.map(w => ({id: 'post:' + w.id, kind: 'works', title: w.title, excerpt: (w.body || '').replace(/\s+/g, ' ')})),
    ...dNotes.map(n => ({id: 'note:' + n.id, kind: 'methods', title: n.title, excerpt: (n.body || '').replace(/\s+/g, ' ')})),
    ...dReadings.map(r => ({id: 'reading:' + r.id, kind: 'readings', title: r.title, excerpt: (r.body || '').replace(/\s+/g, ' ')})),
    ...dArchives.map(a => ({id: 'archive:' + a.id, kind: 'archives', title: a.title, excerpt: (a.body || '').replace(/\s+/g, ' ')})),
  ].filter(x => x.excerpt.trim().length >= 20), [dWorks, dNotes, dReadings, dArchives]);
  // 池子随编辑变化，但当天抽中的三篇由缓存钉死（校验 day：否则缓存永不轮换，「每日」变「永远同三篇」）
  const cachedIds = useMemo(() => {
    try {
      const c = JSON.parse(localStorage.getItem(RECALL_KEY));
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      return c?.day === day && Array.isArray(c.ids) ? c.ids : null;
    } catch { return null; }
  }, [pool]);
  const picks = useMemo(() => {
    const byId = new Map(pool.map(x => [x.id, x]));
    if (cachedIds) { const hit = cachedIds.map(id => byId.get(id)).filter(Boolean); if (hit.length) return hit; }
    return todayRecall(pool);
  }, [pool, cachedIds]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false); // 仅本会话隐藏，明天照常出现
  if (dismissed || !picks.length) return null;
  return <>
    <button className="recall-fab" onClick={() => setOpen(o => !o)} aria-expanded={open}
      title="每天随机回顾三条旧内容 · Daily random recall">
      <Icon name="replay" size={14}/>今日回顾 <em>{picks.length}</em>
    </button>
    {open && <div className="veil" onClick={() => setOpen(false)}>
      <section className="modal glass" role="dialog" aria-modal="true" aria-label="今日回顾 Daily recall" onClick={e => e.stopPropagation()}>
        <header><h2>今日回顾 <em>Daily recall</em></h2><button className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭弹窗"><Icon name="close" size={16}/></button></header>
        <div className="about">
          <p className="quiet">每天随机捞三条旧内容回来见一面，同一天内固定不变；点条目直接打开原文。<em>Three random pieces a day — same all day. Click to open.</em></p>
          {picks.map(p => <div className="recall-item" key={p.id}>
            <span className="recall-kind">{KIND_ZH[p.kind]}</span>
            <button className="recall-open" onClick={() => { setOpen(false); onOpen(p.id); }}>
              <b>{p.title || '未命名'}</b>
              <small>{p.excerpt.slice(0, 110)}{p.excerpt.length > 110 ? '…' : ''}</small>
            </button>
          </div>)}
          <div className="form-actions"><button className="pill ghost" onClick={() => setDismissed(true)}>本次启动不再显示 <em>Hide for now</em></button></div>
        </div>
      </section>
    </div>}
  </>;
}

// —— 全库批量替换：范围（全部 / 单模块）+ 普通文本或正则，先预览逐条命中数，确认后应用 ——
const REPLACE_SCOPES = [['all', '全部 All'], ['works', '作品库'], ['notes', '方法库'], ['drafts', '创作台'], ['readings', '阅读区'], ['archives', '档案区']];
export function ReplaceModal({works, notes, drafts, readings, archives, onClose, onApply}) {
  const [scope, setScope] = useState('all');
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [useRe, setUseRe] = useState(false);
  const [armed, setArmed] = useState(false);
  let re = null, reErr = '';
  if (useRe && find) { try { re = new RegExp(find, 'g'); } catch (e) { reErr = String(e?.message || e); } }
  const plain = find.toLowerCase();
  const data = [['works', works], ['notes', notes], ['drafts', drafts], ['readings', readings], ['archives', archives]];
  const hits = useMemo(() => {
    if (!find || (useRe && !re)) return [];
    const out = [];
    for (const [kind, items] of data) {
      if (scope !== 'all' && scope !== kind) continue;
      for (const x of items) {
        const body = String(x.body || '');
        const c = useRe ? (body.match(re) || []).length : (body.toLowerCase().split(plain).length - 1);
        if (!c) continue;
        const at = useRe ? body.search(re) : body.toLowerCase().indexOf(plain);
        out.push({kind, title: x.title || '未命名', count: c,
          snippet: body.slice(Math.max(0, at - 20), Math.min(body.length, Math.max(0, at - 20) + 90)).replace(/\s+/g, ' ')});
      }
    }
    return out;
  }, [find, scope, useRe, works, notes, drafts, readings, archives]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = hits.reduce((s, x) => s + x.count, 0);
  const SCOPE_ZH = Object.fromEntries(REPLACE_SCOPES);
  return <Modal title="批量替换" en="Find & replace" onClose={onClose}>
    <div className="form">
      <p className="quiet">在所选范围的正文里查找并替换（标题不动）。先预览命中，确认后写入；改动会照常写回知识库，且可用 ⌘K「恢复数据快照」回退。<em>Preview first, then apply.</em></p>
      <label>范围 <em>Scope</em>
        <select value={scope} onChange={e => setScope(e.target.value)} aria-label="替换范围">
          {REPLACE_SCOPES.map(([k, zh]) => <option key={k} value={k}>{zh}</option>)}
        </select></label>
      <div className="form-row">
        <label>查找 <em>Find</em><input autoFocus value={find} onChange={e => { setFind(e.target.value); setArmed(false); }} placeholder="要替换的文本"/></label>
        <label>替换为 <em>Replace</em><input value={repl} onChange={e => { setRepl(e.target.value); setArmed(false); }} placeholder="新文本（可留空删除）"/></label>
      </div>
      <label className="rep-regex"><input type="checkbox" checked={useRe} onChange={e => { setUseRe(e.target.checked); setArmed(false); }}/>按正则表达式查找（替换串支持 $1 等分组引用）</label>
      {reErr && <p className="quiet" role="alert">正则无效：{reErr}</p>}
      {find && !reErr && <div className="rep-preview">
        <p className="quiet">{hits.length ? `${hits.length} 条内容、共 ${total} 处命中：` : '没有命中。'}</p>
        <div className="rep-hits">{hits.slice(0, 30).map((h, i) => <div key={i} className="rep-hit">
          <span className="rep-hit-head">[{SCOPE_ZH[h.kind]}] {h.title} <b>×{h.count}</b></span>
          <small>…{h.snippet}…</small>
        </div>)}
        {hits.length > 30 && <p className="quiet">…还有 {hits.length - 30} 条未列出</p>}</div>
      </div>}
      <div className="form-actions">
        <button className="pill ghost" onClick={onClose}>取消 <em>Cancel</em></button>
        {armed
          ? <button className="pill danger" disabled={!total} onClick={() => { onApply(scope, find, repl, useRe); onClose(); }}><Icon name="check" size={14}/>确认替换 {total} 处 <em>Apply</em></button>
          : <button className="pill primary" disabled={!total} onClick={() => setArmed(true)}>预览并准备替换 <em>Arm</em></button>}
      </div>
    </div>
  </Modal>;
}
