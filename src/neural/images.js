// 图片支持：正文里的图一律存 dataURL（离线、自包含，网页版也能用）；
// 知识库里的引用图（![[名字]] 或相对路径）渲染时经 vault:asset IPC 读原文件（仅桌面版，读取限制在库根目录内）。
import {useEffect} from 'react';
import {readVaultRoot} from '../config';

// 文件 → dataURL：小图原样保留；大图 canvas 压缩（最长边 1280，png 保透明，其余 jpeg 0.85）。
export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  }).then(dataUrl => new Promise((res, rej) => {
    if (file.size <= 200 * 1024) return res(dataUrl);
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      let w = img.width, h = img.height;
      if (Math.max(w, h) > MAX) { const k = MAX / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      res(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85));
    };
    img.onerror = rej;
    img.src = dataUrl;
  }));
}

// 把 dataURL 落盘到知识库 attachments/ 下按内容 sha1 去重，返回 Obsidian 嵌入引用 `![[attachments/xx/sha1.ext]]`。
// 同一内容反复粘贴只存一份，避免长文 .md 被 base64 撑爆。未连库或 IPC 失败时返回 null，
// 调用方据此回退为原 dataURL 写法（网页版 / 未连库保持原有自包含行为）。
const MIME_EXT = {'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/gif':'gif','image/webp':'webp','image/bmp':'bmp','image/svg+xml':'svg'};
export async function saveAssetDataUrl(dataUrl) {
  const v = window.deepnotes?.vault;
  const root = readRoot();
  if (!v || !root || !v.saveAsset) return null;
  const m = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  const ext = MIME_EXT[m[1]] || 'bin';
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-1', bin);
  const sha1 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const name = `${sha1}.${ext}`;
  const r = await v.saveAsset(root, name, m[1], m[2]);
  if (!r?.ok) return null;
  return `![[${r.rel || 'attachments/' + sha1.slice(0, 2) + '/' + name}]]`;
}

// 库根目录经 config.js 的 readVaultRoot 读取（固定键 + 旧键迁移），与 fileStore 保持同一份
const readRoot = readVaultRoot;

// dataURL 缓存（LRU，上限约 128MB + 500 条）：同一张库内图（根目录+引用名）只读一次盘。
// 图片来自用户知识库、无大小保证，无上限的缓存会把内存吃满；Map 按插入序淘汰最旧条目，
// 命中时重新插入刷新新鲜度。null 是「找不到」的负缓存，同样受条目数上限约束。
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
const CACHE_MAX_ITEMS = 500;
let cache = new Map();
let cacheBytes = 0;
function touchCache(key, url) {
  if (cache.has(key)) { cacheBytes -= cache.get(key)?.length || 0; cache.delete(key); }
  cache.set(key, url);
  cacheBytes += url?.length || 0; // base64 dataURL 是 ASCII 串，字符数近似字节数
  while ((cacheBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_ITEMS) && cache.size > 1) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest)?.length || 0;
    cache.delete(oldest);
  }
}
export const clearAssetCache = () => { cache = new Map(); cacheBytes = 0; };

const isLocalRef = s => !!s && !/^(data:|https?:|blob:|\/|#)/i.test(s);

// 解析一张渲染出来的 <img>：data-asset（![[名字]]）或相对路径 src。
// 命中缓存立即回填；未命中走 IPC，成功后写缓存。返回 Promise（供导出 PDF 前等待）。
export function resolveVaultImg(img) {
  const v = window.deepnotes?.vault;
  const ref = img.dataset.asset || (isLocalRef(img.getAttribute('src')) ? img.getAttribute('src') : '');
  if (!v || !ref || img.dataset.vaultDone) return Promise.resolve();
  img.dataset.vaultDone = '1';
  const root = readRoot();
  const key = (root || '') + '|' + ref;
  if (cache.has(key)) { const url = cache.get(key); touchCache(key, url); if (url) img.src = url; return Promise.resolve(); }
  return v.asset(root, ref).then(r => {
    if (r?.ok && r.data) {
      const url = `data:${r.mime};base64,${r.data}`;
      touchCache(key, url);
      img.src = url;
    } else touchCache(key, null);
  }).catch(() => {});
}

// 解析任意文档里全部待解析图片（导出 PDF 的隐藏 iframe 在打印前等待一次）
export function resolveAllInDoc(doc) {
  return Promise.all([...doc.querySelectorAll('img[data-asset], img[src]')].map(resolveVaultImg));
}

// —— 视频：知识库里的视频不复制进副本（课程视频动辄数百 MB），由 deepnotes-asset://
// 只读流式协议按 Range 读取（见 electron/main.cjs 的 streamAsset），<video> 可直接 seek ——
const VIDEO_RE = /\.(mp4|m4v|webm|mov|ogv|ogg)$/i;
export const isVideoRef = r => VIDEO_RE.test(String(r || '').trim().split(/[?#]/)[0]);

export function vaultAssetUrl(ref) {
  const v = window.deepnotes?.vault;
  const root = readRoot();
  if (!v || !root || !ref) return '';
  return `deepnotes-asset://asset/?root=${encodeURIComponent(root)}&ref=${encodeURIComponent(ref)}`;
}

// 回填一个 <video data-asset>；网页版没有本地访问权限，保持虚线占位。
// 加载失败（404 找不到 / 403 未授权 / 源库被移走或未从 iCloud 下载）不再静默黑框（审计 B6），
// 就地换成一行原因提示。
export function resolveVaultVideo(el) {
  if (!el || el.dataset.vaultDone) return;
  const url = vaultAssetUrl(el.dataset.asset);
  if (!url) return;
  el.dataset.vaultDone = '1';
  el.addEventListener('error', () => {
    const tip = document.createElement('div');
    tip.className = 'md-embed-video-fail';
    tip.textContent = `本地视频不可用：${el.dataset.asset} · 请确认文件在知识库（或旁边的原始库）中，且本机已下载（iCloud 占位需先取回）`;
    el.replaceWith(tip);
  }, {once: true});
  el.src = url;
}

// 视频灯箱：正文 / 表格里的 [文件名](x.mp4) 点击后在浮层播放，不离开当前视图。
// 用纯 DOM 而非 React：.md-preview 是 innerHTML 渲染的，文章页 / 各内页 / 对照分屏各自独立，
// 全局挂一次点击委托即可覆盖所有入口（与 useVaultImages 同一个 hook）。
export function openVideoLightbox(ref, label = '') {
  document.getElementById('video-lightbox')?.remove();
  const url = vaultAssetUrl(ref);
  const box = document.createElement('div');
  box.id = 'video-lightbox';
  box.className = 'video-lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  if (!url) {
    box.innerHTML = '<div class="vl-body vl-empty"><p>本地视频只在桌面版可播放<br><small>Local video plays in the desktop app only</small></p>'
      + '<button class="vl-close" aria-label="关闭 Close">×</button></div>';
  } else {
    box.innerHTML = '<div class="vl-body"><header class="vl-head"><span class="vl-name"></span>'
      + '<button class="vl-close" aria-label="关闭 Close">×</button></header>'
      + '<video controls autoplay playsinline></video></div>';
    box.querySelector('.vl-name').textContent = label || String(ref).split('/').pop();
    box.querySelector('video').src = url;
  }
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => {
    try { box.querySelector('video')?.pause(); } catch {}
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  box.addEventListener('click', e => { if (e.target === box || e.target.closest('.vl-close')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
  return true;
}

// 图片灯箱：正文 / 预览里的图片点击后放大查看（与视频灯箱同一套交互：Esc / 点遮罩 / 点 × 关闭）。
// dataURL 粘贴图与知识库引用图（已回填 src）都适用；长图滚动查看。
export function openImageLightbox(src, label = '') {
  if (!src) return false;
  document.getElementById('image-lightbox')?.remove();
  const box = document.createElement('div');
  box.id = 'image-lightbox';
  box.className = 'video-lightbox image-lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = '<div class="vl-body"><header class="vl-head"><span class="vl-name"></span>'
    + '<button class="vl-close" aria-label="关闭 Close">×</button></header>'
    + '<div class="vl-img-wrap"><img alt=""/></div></div>';
  box.querySelector('.vl-name').textContent = label || '图片 · Image';
  const img = box.querySelector('img');
  img.src = src;
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  box.addEventListener('click', e => { if (e.target === box || e.target.closest('.vl-close')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(box);
  return true;
}

// 全局挂一次：所有 .md-preview 里新出现的图片 / 视频自动解析（双链弹窗、阅读模式、对照分屏共用），
// 视频链接与图片的点击委托（网页版也会挂；图片点击进灯箱，视频链接点开提示仅桌面版可播放）
export function useVaultImages() {
  useEffect(() => {
    const onClick = e => {
      const a = e.target.closest?.('.md-video-link');
      if (a) {
        e.preventDefault();
        openVideoLightbox(a.dataset.asset || '', a.textContent?.trim() || '');
        return;
      }
      // 预览视图里的图片点击放大：编辑镜像层（.lm-img）不拦——那里点按要定位光标
      const img = e.target.closest?.('.md-preview img');
      if (img && !img.closest('a') && img.getAttribute('src')) {
        e.preventDefault();
        openImageLightbox(img.getAttribute('src'), img.getAttribute('alt') || '');
      }
    };
    document.addEventListener('click', onClick);
    if (!window.deepnotes?.vault) return () => document.removeEventListener('click', onClick);
    const scan = () => {
      document.querySelectorAll('.md-preview img').forEach(resolveVaultImg);
      document.querySelectorAll('.md-preview video[data-asset]').forEach(resolveVaultVideo);
    };
    scan();
    const mo = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.('.md-preview') || n.querySelector?.('.md-preview')) scan();
        else if (n.matches?.('img')) resolveVaultImg(n);
        else if (n.matches?.('video')) resolveVaultVideo(n);
      }
    });
    mo.observe(document.body, {childList: true, subtree: true});
    return () => { mo.disconnect(); document.removeEventListener('click', onClick); };
  }, []);
}
