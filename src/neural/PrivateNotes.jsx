// 隐私笔记页：锁定 / 未启用时是密码界面，解锁后是加密笔记的清单与编辑器。
// 加解密在 privateNotes.js（WebCrypto），密钥仅在解锁后驻内存，本页不触碰密码以外任何凭据。
import React, {useEffect, useRef, useState} from 'react';
import {Icon} from './icons';
import {hasVault, isUnlocked, setupVault, unlock, relock, listNotes, upsertNote, deleteNote, exportVault, importVault} from './privateNotes';

function PasswordGate({mode, onDone, onBack}) {
  // mode: 'setup'（首次设置，输两遍） | 'unlock'
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr('');
    if (p1.length < 4) { setErr('密码至少 4 位'); return; }
    if (mode === 'setup' && p1 !== p2) { setErr('两次输入不一致'); return; }
    setBusy(true);
    try {
      if (mode === 'setup') await setupVault(p1);
      else await unlock(p1);
      onDone();
    } catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  return <section className="pn-gate glass" aria-label="隐私区密码">
    <header><b>{mode === 'setup' ? '启用隐私区' : '解锁隐私区'}</b><em>{mode === 'setup' ? 'Set up' : 'Unlock'}</em></header>
    <p className="quiet">{mode === 'setup'
      ? '为隐私笔记设置一个密码。笔记以 AES-GCM 加密存放在本机与知识库附属数据里，密码不落盘——忘记密码将无法找回内容，请务必记牢。'
      : '输入密码解锁。密钥只在内存中，关闭软件或点「上锁」后需要重新解锁。'}<em>End-to-end local encryption.</em></p>
    <label>密码 <em>Password</em><input type="password" autoFocus value={p1} autoComplete="new-password"
      onChange={e => setP1(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.isComposing) submit(); }}/></label>
    {mode === 'setup' && <label>再输一遍 <em>Repeat</em><input type="password" value={p2} autoComplete="new-password"
      onChange={e => setP2(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.isComposing) submit(); }}/></label>}
    {err && <p className="quiet" role="alert">{err}</p>}
    <div className="form-actions">
      {onBack && mode === 'setup' && <button className="pill ghost" onClick={onBack}>返回 <em>Back</em></button>}
      <button className="pill primary" disabled={busy} onClick={submit}>{mode === 'setup' ? '启用' : '解锁'} <em>Go</em></button>
    </div>
  </section>;
}

export function PrivateNotes() {
  const [unlocked, setUnlocked] = useState(isUnlocked());
  const [vault, setVault] = useState(hasVault());
  const [notes, setNotes] = useState([]);
  const [sel, setSel] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [q, setQ] = useState('');
  const [hint, setHint] = useState('');
  const [syncedId, setSyncedId] = useState(null); // 编辑器里已回填好的笔记 id：只有它等于选中 id 才允许自动保存
  const saveTimer = useRef(null);
  const pending = useRef(null); // 待落盘的编辑快照：切笔记 / 上锁 / 卸载前必须 flush，防抖窗口内的输入不能丢
  const cur = sel ? notes.find(n => n.id === sel) : null;
  const parseTags = s => String(s || '').split(/[,，、\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean);
  const kw = q.trim().toLowerCase();
  const shown = kw ? notes.filter(n => [n.title, n.body, ...(n.tags || [])].join(' ').toLowerCase().includes(kw)) : notes;

  const reload = () => { if (isUnlocked()) return listNotes().then(setNotes).catch(() => setNotes([])); return Promise.resolve(); };
  useEffect(() => { if (unlocked) reload(); }, [unlocked]); // eslint-disable-line react-hooks/exhaustive-deps
  // 依赖 cur?.id（而非 sel）：新建后 notes 异步解密回来 cur 才有值，此时再回填标题正文
  useEffect(() => { setTitle(cur?.title || ''); setBody(cur?.body || ''); setTagsInput((cur?.tags || []).join(', ')); setSyncedId(cur?.id || null); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 编辑防抖自动加密保存（800ms 静默）；cleanup 把挂起的编辑立即落盘
  const flushSave = async snapshot => {
    if (!snapshot || !isUnlocked()) return;
    try {
      await upsertNote(snapshot);
      setHint(`已加密保存 · ${new Date().toLocaleTimeString()}`);
      reload();
    } catch (e) { setHint(`保存失败：${e?.message || e}`); }
  };
  useEffect(() => {
    // syncedId 保护：切笔记的瞬间标题/正文还是上一条的旧值，此时不能启动防抖，
    // 否则 cleanup 会把旧内容写进刚选中的新笔记（覆盖新笔记正文）。
    if (!unlocked || !sel || !cur || syncedId !== sel) return;
    clearTimeout(saveTimer.current);
    const snapshot = {id: sel, title, body, tags: parseTags(tagsInput)};
    pending.current = snapshot;
    saveTimer.current = setTimeout(() => { pending.current = null; flushSave(snapshot); }, 800);
    return () => {
      clearTimeout(saveTimer.current);
      if (pending.current) { const p = pending.current; pending.current = null; flushSave(p); }
    };
  }, [sel, title, body, tagsInput, unlocked, syncedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const createNote = async () => {
    const id = await upsertNote({title: '新建隐私笔记', body: ''});
    setSel(null); // 先清选中，避免旧选中笔记的防抖把内容追写过来
    await reload(); // 等解密列表落地再选中新笔记（固定 50ms 在大库上会抢跑，落在空态里）
    setSel(id);
  };

  if (!vault || !unlocked) {
    return <div className="page page-private">
      <header className="page-head"><div><p className="eyebrow">PRIVATE <span>隐私区</span></p><h1>只属于你的加密笔记。</h1><p className="page-sub">AES-GCM 本地加密，不上锁谁也看不见。</p></div></header>
      <PasswordGate mode={vault ? 'unlock' : 'setup'} onDone={() => { setUnlocked(true); setVault(true); }} onBack={vault ? () => setUnlocked(false) : null}/>
    </div>;
  }

  return <div className="page page-private">
    <header className="page-head">
      <div><p className="eyebrow">PRIVATE <span>隐私区</span></p><h1>已解锁。</h1><p className="page-sub">离开前记得上锁；密文随知识库同步，换机后用同一密码解锁。</p></div>
      <div className="page-head-actions">
        <button className="pill primary" onClick={createNote}><Icon name="plus" size={15}/>新建隐私笔记 <em>New</em></button>
        <button className="pill ghost" onClick={async () => { if (pending.current) { const p = pending.current; pending.current = null; await flushSave(p); } relock(); setUnlocked(false); setSel(null); }}><Icon name="close" size={14}/>上锁 <em>Lock</em></button>
        <button className="pill ghost" title="导出加密备份文件（不含密码，导入后用同一密码解锁）· Export encrypted backup" onClick={() => {
          try {
            const text = exportVault();
            const blob = new Blob([text], {type: 'application/json'});
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `Deep-Notes-隐私备份-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          } catch (e) { window.showGlobalNotice?.(`备份导出失败：${e?.message || e}`); }
        }}><Icon name="save" size={14}/>备份 <em>Backup</em></button>
        <button className="pill ghost" title="导入加密备份文件（密文追加，同密码解锁）· Import encrypted backup" onClick={() => {
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.accept = '.json';
          inp.onchange = async () => {
            const f = inp.files?.[0];
            if (!f) return;
            try {
              await importVault(await f.text());
              reload();
              window.showGlobalNotice?.('备份已导入 · Backup imported');
            } catch (e) { window.showGlobalNotice?.(`导入失败：${e?.message || e}`); }
          };
          inp.click();
        }}><Icon name="file" size={14}/>导入 <em>Import</em></button>
      </div>
    </header>
    <div className="pn-layout">
      <aside className="pn-list glass" aria-label="隐私笔记清单">
        <h3>隐私笔记 <em>Notes</em><b>{shown.length}</b></h3>
        <input className="pn-search" type="search" value={q} onChange={e => setQ(e.target.value)}
          placeholder="搜索标题 / 正文 / 标签" aria-label="搜索隐私笔记"/>
        {shown.map(n => <div key={n.id} className={`pn-item${sel === n.id ? ' active' : ''}`} onClick={() => setSel(n.id)} role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(n.id); } }}>
          <span><b>{n.title || '未命名'}</b><small>{new Date(n.ts || Date.now()).toLocaleString()}</small>
            {(n.tags || []).length > 0 && <small className="pn-tags">{n.tags.map(t => <i key={t}>#{t}</i>)}</small>}</span>
          <button className="icon-btn" aria-label={`删除 ${n.title || ''}`} title="删除（不可恢复）"
            onClick={async e => { e.stopPropagation(); if (!window.confirm(`彻底删除隐私笔记「${n.title || '未命名'}」？加密内容无法找回。`)) return;
              await deleteNote(n.id).catch(() => {}); reload(); if (sel === n.id) setSel(null); }}><Icon name="trash" size={13}/></button>
        </div>)}
        {!shown.length && <p className="empty-line">{notes.length ? '没有匹配的笔记' : '还没有隐私笔记'} <em>Nothing yet</em></p>}
      </aside>
      {cur
        ? <section className="pn-editor glass" aria-label="隐私笔记编辑器">
            <input className="editor-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="标题" aria-label="隐私笔记标题"/>
            <input className="pn-tags-input" value={tagsInput} onChange={e => setTagsInput(e.target.value)}
              placeholder="标签，用逗号分隔（例如：灵感, 日记）" aria-label="隐私笔记标签"/>
            <div className="editor-area"><textarea className="editor-input" value={body} onChange={e => setBody(e.target.value)}
              placeholder="写下只属于你的内容…（自动加密保存）" aria-label="隐私笔记正文"/></div>
            <footer className="editor-foot"><span>{hint} · 内容与标签加密后存本机与知识库附属数据</span></footer>
          </section>
        : <section className="pn-editor glass empty"><p className="empty-line">选一条笔记，或新建一条。<em>Pick or create.</em></p></section>}
    </div>
  </div>;
}
