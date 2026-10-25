// 媒体库（图片画廊）：汇总全库正文里的图片（作品 / 笔记 / 草稿 / 阅读 / 档案），
// 一页浏览、点图放大（灯箱）、一键跳回原文。纯本地：库内引用图（![[名字]] / 相对路径）
// 经 vault:asset 回填，dataURL 粘贴图与网络图直接显示。
import React, {useDeferredValue, useEffect, useMemo, useRef, useState} from 'react';
import {Icon} from './icons';
import {openImageLightbox, resolveVaultImg} from './images';
import {PageHead} from './pages';

const EMBED_RE = /!\[\[([^\]\n]+)\]\]/g;       // ![[图片.png|300]]（Obsidian 嵌入）
const MD_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g; // ![alt](src)
const VIDEO_RE = /\.(mp4|m4v|webm|mov|ogv|ogg)$/i;
const GALLERY_MAX = 400; // 单页最多展示的张数（超出提示，防一次渲染上千节点）

const KINDS_ZH = {works: '文章', notes: '笔记', drafts: '草稿', readings: '阅读', archives: '档案'};
const KIND_GID = {works: 'post', notes: 'note', drafts: 'draft', readings: 'reading', archives: 'archive'};

export function Gallery({works, notes, drafts, readings, archives, onOpenContent}) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  // 大库正文逐篇扫描：延迟值 + 一次性 useMemo，进入页面才算（打字时本页未挂载）
  const dWorks = useDeferredValue(works);
  const dNotes = useDeferredValue(notes);
  const dDrafts = useDeferredValue(drafts);
  const dReadings = useDeferredValue(readings);
  const dArchives = useDeferredValue(archives);
  const items = useMemo(() => {
    const seen = new Set();
    const out = [];
    const push = (ref, src, k, id, title) => {
      // 去重键：库内引用按名字；外部图按「长度 + 头尾片段」——dataURL 的 base64 头部对同格式图片
      // 几乎相同（PNG IHDR 固定），只取前缀会把不同图误判成同一张，必须掺入长度与尾部
      const key = ref ? 'a:' + ref.toLowerCase()
        : 's:' + String(src || '').length + ':' + String(src || '').slice(0, 48) + String(src || '').slice(-64);
      if (!ref && !src) return;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({key, ref, src, kind: k, id, title});
    };
    const scan = (k, list) => {
      for (const x of list || []) {
        const body = String(x?.body || '');
        if (!body.includes('![')) continue; // 快速预筛：没有图片语法的正文直接跳过
        const title = x.title || '未命名';
        for (const m of body.matchAll(EMBED_RE)) {
          const name = m[1].split('|')[0].trim();
          if (!name || VIDEO_RE.test(name)) continue; // 视频不进画廊（有播放器体系）
          push(name, null, k, x.id, title);
        }
        for (const m of body.matchAll(MD_RE)) {
          const src = (m[2] || '').trim();
          if (!src || VIDEO_RE.test(src.split(/[?#]/)[0]) || /^deepnotes-asset:/i.test(src)) continue;
          push(/^(data:|https?:|blob:)/i.test(src) ? null : src, src, k, x.id, title);
        }
      }
    };
    scan('works', dWorks);
    scan('notes', dNotes);
    scan('drafts', dDrafts);
    scan('readings', dReadings);
    scan('archives', dArchives);
    return out;
  }, [dWorks, dNotes, dDrafts, dReadings, dArchives]);
  const kw = q.trim().toLowerCase();
  const shown = items.filter(it => (kind === 'all' || it.kind === kind)
    && (!kw || it.title.toLowerCase().includes(kw) || String(it.ref || it.src || '').toLowerCase().includes(kw)));
  const list = shown.slice(0, GALLERY_MAX);

  // 渲染后回填库内引用图 / 相对路径图（与正文同一套 vault:asset 解析与缓存）
  const boxRef = useRef(null);
  useEffect(() => {
    if (!boxRef.current) return;
    boxRef.current.querySelectorAll('img[data-asset], img[data-local]').forEach(el => resolveVaultImg(el));
  }, [list]);

  return <div className="page page-gallery">
    <PageHead zh="媒体库" en="Gallery" sub="全库正文里的图片，一页看全。" subEn="Every image in your vault, on one page.">
      <label className="search"><Icon name="search" size={15}/><input value={q} onChange={e => setQ(e.target.value)}
        placeholder="按标题或文件名搜索… Search" aria-label="搜索图片"/></label>
    </PageHead>
    <div className="toolbar-row" role="group" aria-label="按模块筛选 Filter by module">
      <div className="seg">
        {[['all', `全部 ${items.length}`], ...Object.keys(KINDS_ZH).map(k => [k, KINDS_ZH[k]])].map(([k, zh]) =>
          <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{zh}</button>)}
      </div>
    </div>
    {!items.length
      ? <div className="empty"><Icon name="works" size={30}/><p>正文里还没有图片 <em>No images yet</em></p>
          <p className="source-line">在编辑器里粘贴截图、点「插图」，或用 ![[图片.png]] / ![图片](地址) 引用后，这里就会汇总出来。</p></div>
      : <div className="gallery-grid" ref={boxRef}>
          {list.map(it => {
            const gid = KIND_GID[it.kind] + ':' + it.id;
            return <figure key={it.key + ':' + it.kind + ':' + it.id} className="gallery-card glass">
              <button className="gallery-img" aria-label={`放大查看 ${it.ref || it.title}`}
                onClick={e => {
                  // 优先取回填后的实际 src（库内引用图已解析成 dataURL）；未回填（网页版无库）则不打灯箱
                  const src = e.currentTarget.querySelector('img')?.getAttribute('src');
                  if (src) openImageLightbox(src, it.ref || it.title);
                }}>
                {it.ref
                  ? <img data-asset={it.ref} alt={it.ref} loading="lazy"/>
                  : /^(data:|https?:|blob:)/i.test(it.src)
                    ? <img src={it.src} alt={it.title} loading="lazy"/>
                    : <img data-local="1" src={it.src} alt={it.title} loading="lazy"/>}
              </button>
              <figcaption>
                <button className="gallery-src" title={`打开${KINDS_ZH[it.kind]}《${it.title}》`} onClick={() => onOpenContent(gid)}>
                  <Icon name="file" size={12}/>{it.title}
                </button>
                <span className="gallery-kind">{KINDS_ZH[it.kind]}{it.ref ? '' : ' · 直链'}</span>
              </figcaption>
            </figure>;
          })}
        </div>}
    {shown.length > list.length && <p className="source-line">共 {shown.length} 张，仅显示前 {GALLERY_MAX} 张——用搜索或按模块筛选缩小范围。</p>}
    {!!items.length && <p className="source-line"><Icon name="info" size={13}/>同一张图（同名引用）只显示一次；点击图片放大，点击标题跳回原文。</p>}
  </div>;
}
