// 图片支持：正文里的图一律存 dataURL（离线、自包含，网页版也能用）；
// 知识库里的引用图（![[名字]] 或相对路径）渲染时经 vault:asset IPC 读原文件（仅桌面版，读取限制在库根目录内）。
import {useEffect} from 'react';
import {CONFIG} from '../config';

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

const ROOT_KEY = CONFIG.storagePrefix + '-vault-root-v1';
const readRoot = () => { try { return localStorage.getItem(ROOT_KEY) || null; } catch { return null; } };

// dataURL 缓存：同一张库内图（根目录+引用名）只读一次盘
let cache = new Map();
export const clearAssetCache = () => { cache = new Map(); };

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
  if (cache.has(key)) { const url = cache.get(key); if (url) img.src = url; return Promise.resolve(); }
  return v.asset(root, ref).then(r => {
    if (r?.ok && r.data) {
      const url = `data:${r.mime};base64,${r.data}`;
      cache.set(key, url);
      img.src = url;
    } else cache.set(key, null);
  }).catch(() => {});
}

// 解析任意文档里全部待解析图片（导出 PDF 的隐藏 iframe 在打印前等待一次）
export function resolveAllInDoc(doc) {
  return Promise.all([...doc.querySelectorAll('img[data-asset], img[src]')].map(resolveVaultImg));
}

// 全局挂一次：所有 .md-preview 里新出现的图片自动解析（双链弹窗、阅读模式、对照分屏、文章预览共用）
export function useVaultImages() {
  useEffect(() => {
    if (!window.deepnotes?.vault) return undefined;
    const scan = () => document.querySelectorAll('.md-preview img').forEach(resolveVaultImg);
    scan();
    const mo = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.('.md-preview') || n.querySelector?.('.md-preview')) scan();
        else if (n.matches?.('img')) resolveVaultImg(n);
      }
    });
    mo.observe(document.body, {childList: true, subtree: true});
    return () => mo.disconnect();
  }, []);
}
