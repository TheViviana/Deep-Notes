import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {listSnapshots, listFileSnapshots, readFileSnapshot} from './fileStore';

// 「文件恢复」弹窗：两层快照网的统一查询界面。自包含弹窗结构（与 main.jsx 的 Modal 同形），
// 避免互相 import 成环。
// 应用内快照（IndexedDB，外部同步覆盖界面内容前自动留存）→「恢复此版本」就地覆盖当前内容；
// 文件历史（桌面版主进程写前快照）→「恢复为副本」新建一条，不动现有内容。
const KIND_LABEL = {works: '作品', notes: '方法笔记', drafts: '草稿', readings: '阅读', archives: '档案'};
const fmtTs = ts => {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const baseName = rel => String(rel || '').split('/').pop().replace(/\.md$/i, '');

export function RecoveryModal({onClose, onRestoreSnap, onRestoreCopy}) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus({preventScroll: true});
    const key = e => { if (e.key === 'Escape' && !e.isComposing) closeRef.current(); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (before?.isConnected) before.focus({preventScroll: true}); };
  }, []);

  const snaps = useMemo(() => listSnapshots(), []); // 打开瞬间定格：恢复操作不再让列表跳动
  const [openKey, setOpenKey] = useState(null);
  const [selSnap, setSelSnap] = useState(null);
  const [fileList, setFileList] = useState(null); // null = 快照库还在读取
  const [openRel, setOpenRel] = useState(null);
  const [fileVer, setFileVer] = useState(null);
  const [fileBody, setFileBody] = useState(null);
  useEffect(() => {
    let alive = true;
    listFileSnapshots().then(l => { if (alive) setFileList(l); }).catch(() => { if (alive) setFileList([]); });
    return () => { alive = false; };
  }, []);

  const groups = useMemo(() => { // 应用内快照按条目分组（列表已按时间新→旧，每组头部即最新）
    const map = new Map();
    for (const s of snaps) { if (!map.has(s.key)) map.set(s.key, []); map.get(s.key).push(s); }
    return [...map.values()];
  }, [snaps]);
  const fileGroups = useMemo(() => {
    if (!Array.isArray(fileList)) return [];
    const map = new Map();
    for (const e of fileList) { if (!map.has(e.rel)) map.set(e.rel, []); map.get(e.rel).push(e); }
    return [...map.values()];
  }, [fileList]);

  const pickFileVer = e => {
    setFileVer(e);
    setFileBody(null); // null = 读取中
    readFileSnapshot(e.file)
      .then(body => setFileBody(body ?? '（读取失败 · Failed to read）'))
      .catch(() => setFileBody('（读取失败 · Failed to read）'));
  };

  return <div className="veil" onClick={onClose}>
    <section ref={ref} tabIndex={-1} className="modal glass wide" role="dialog" aria-modal="true" aria-label="文件恢复" onClick={e => e.stopPropagation()}>
      <header><h2>文件恢复 <em>File recovery</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" size={16}/></button></header>
      <div className="about">
        <p className="quiet">两层恢复网自动生效：覆盖盘上旧内容前，旧版本先进本机快照库（保留 7 天、每文件最多 30 份，内容没变不重复留）；外部同步用文件版本覆盖界面内容前，内存版本先存应用内快照（每条最多 15 份）。「恢复此版本」就地覆盖当前内容；「恢复为副本」新建一条，不动现有内容。<em>Overwritten versions are kept automatically and can be restored in place or as a copy.</em></p>

        <h3>应用内快照 <em>In-app snapshots</em></h3>
        {groups.length
          ? <div className="snap-list">{groups.map(list => {
              const head = list[0];
              const open = openKey === head.key;
              return <div key={head.key} className="snap-group">
                <button className="snap-row" onClick={() => { setOpenKey(open ? null : head.key); setSelSnap(null); }}>
                  <span className="snap-title">[{KIND_LABEL[head.kind] || head.kind}] {head.title || '未命名'}</span>
                  <span className="snap-meta">{list.length} 份 · 最新 {fmtTs(head.ts)}</span>
                  <Icon name={open ? 'close' : 'chevron'} size={13}/>
                </button>
                {open && list.map(s =>
                  <button key={head.key + '@' + s.ts} className={`snap-row sub${selSnap === s ? ' on' : ''}`} onClick={() => setSelSnap(s)}>
                    <span className="snap-title">{fmtTs(s.ts)}</span>
                    <span className="snap-meta">正文 {String(s.item?.body || '').length} 字</span>
                  </button>)}
              </div>;
            })}</div>
          : <p className="quiet">还没有应用内快照。外部同步覆盖界面内容时会自动留存，之后可在这里找回。<em>Nothing captured yet.</em></p>}
        {selSnap && <div className="snap-preview">
          <div className="snap-preview-head">
            <span>{KIND_LABEL[selSnap.kind]} · {selSnap.title || '未命名'} · {fmtTs(selSnap.ts)}</span>
            <button className="pill primary" onClick={() => onRestoreSnap(selSnap)}><Icon name="replay" size={13}/>恢复此版本 <em>Restore</em></button>
          </div>
          <pre>{selSnap.item?.body || '（无正文 · Empty）'}</pre>
        </div>}

        <h3>文件历史 <em>File history</em></h3>
        {!Array.isArray(fileList)
          ? <p className="quiet">正在读取本机快照库…</p>
          : !fileGroups.length
            ? <p className="quiet">还没有文件历史。连接知识库后，每次覆盖写入之前盘上的旧内容都会自动留档，在这里可以按文件查看。<em>Nothing captured yet.</em></p>
            : <div className="snap-list">{fileGroups.map(list => {
                const rel = list[0].rel;
                const open = openRel === rel;
                return <div key={rel} className="snap-group">
                  <button className="snap-row" onClick={() => { setOpenRel(open ? null : rel); setFileVer(null); setFileBody(null); }}>
                    <span className="snap-title">{rel}</span>
                    <span className="snap-meta">{list.length} 份</span>
                    <Icon name={open ? 'close' : 'chevron'} size={13}/>
                  </button>
                  {open && list.map(e =>
                    <button key={e.file} className={`snap-row sub${fileVer?.file === e.file ? ' on' : ''}`} onClick={() => pickFileVer(e)}>
                      <span className="snap-title">{fmtTs(e.ts)}</span>
                    </button>)}
                </div>;
              })}</div>}
        {fileVer && <div className="snap-preview">
          <div className="snap-preview-head">
            <span>{baseName(fileVer.rel)} · {fmtTs(fileVer.ts)}</span>
            <button className="pill primary" onClick={() => onRestoreCopy(fileVer)}><Icon name="replay" size={13}/>恢复为副本 <em>Restore as copy</em></button>
          </div>
          <pre>{fileBody ?? '正在读取…'}</pre>
        </div>}
      </div>
    </section>
  </div>;
}
