// 文章数据层：主信息与正文保存在浏览器 localStorage，可增删改查。
// 主信息字段：标题、发布日期、编辑日期（自动记录）、研究方向、标签；双链由正文 [[ ]] 推导（见 graph.js）。
// 首次运行用 src/data/sample.js 的示例数据做种子，之后全部以本地存储为准，删空也不会回滚。
import {useEffect, useState} from 'react';
import {posts as samplePosts, postContent} from '../data';
import {CONFIG} from '../config';

export const WORKS_KEY = CONFIG.storagePrefix + '-works-v1';
const METRIC_KEYS = ['views', 'likes', 'comments', 'saves', 'follows', 'shares', 'impressions', 'ctr', 'duration'];

const pad = n => String(n).padStart(2, '0');
export const nowStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// 标签输入兼容数组与字符串（逗号 / 顿号分隔，允许带 # 前缀）。
export function parseTags(v) {
  if (Array.isArray(v)) return v.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean);
  return String(v || '').split(/[,，、]+/).map(t => t.trim().replace(/^#/, '')).filter(Boolean);
}

// 归一化：补齐字段默认值，保证 graph 与页面上用到的一定存在。
// keep（导入时未消费的自定义 frontmatter 键）原样透传：写回知识库时展开，用户手写元数据不丢。
export function normalizeWork(w = {}) {
  return {
    id: w.id || 'work-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(w.title || '').trim() || '未命名文章',
    date: /^\d{4}-\d{2}-\d{2}/.test(w.date || '') ? w.date : nowStamp(),
    updatedAt: w.updatedAt || null, // 编辑日期：保存主信息或正文时自动刷新
    direction: String(w.direction || '').trim(), // 研究方向
    tags: parseTags(w.tags),
    body: String(w.body || ''),
    media: w.media || null,
    cover: w.cover || null,
    ...Object.fromEntries(METRIC_KEYS.map(k => [k, w[k] ?? (k === 'views' ? 0 : null)])),
    ...(w.keep && Object.keys(w.keep).length ? {keep: w.keep} : {})
  };
}

// 种子数据：示例 posts 与 postContent 按 title 合并成完整文章记录。
export function seedWorks() {
  return (samplePosts || []).map(p => {
    const c = (postContent || []).find(x => x.title === p.title) || {};
    return normalizeWork({...p, body: c.body || '', tags: c.tags || [], media: c.media || null, cover: c.cover || null});
  });
}

export function loadWorks() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKS_KEY));
    if (raw && Array.isArray(raw.items)) return raw.items.map(normalizeWork);
  } catch {}
  return seedWorks();
}

// 文章列表状态：localStorage 持久化（写入防抖 300ms：大库 + 粘贴图后全量序列化很重，逐键同步写会卡顿）。
// 防抖窗口内的待写数据登记进 pendingWorks，退出前同步补写；写失败 console 留痕不再静默。
let pendingWorks = null;
export function useWorks() {
  const [works, setWorks] = useState(loadWorks);
  useEffect(() => {
    pendingWorks = works;
    const t = setTimeout(() => {
      pendingWorks = null;
      try { localStorage.setItem(WORKS_KEY, JSON.stringify({seeded: true, items: works})); }
      catch (err) { console.warn('localStorage 写入失败 · Save failed:', err); }
    }, 300);
    return () => clearTimeout(t);
  }, [works]);
  return [works, setWorks];
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => {
  if (pendingWorks == null) return;
  try { localStorage.setItem(WORKS_KEY, JSON.stringify({seeded: true, items: pendingWorks})); } catch {}
});

// 「本月」以最新一篇文章所在月份为准。
export const monthWorks = ws => {
  const latest = ws.map(w => w.date).sort().pop();
  return latest ? ws.filter(w => w.date.slice(0, 7) === latest.slice(0, 7)) : [];
};

// datetime-local 输入值（2026-06-28T12:30）与存储格式（2026-06-28 12:30）互转。
export const toInputDateTime = s => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s || '') ? s.slice(0, 10) + 'T' + s.slice(11, 16) : '';
export const fromInputDateTime = s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s || '') ? s.slice(0, 10) + ' ' + s.slice(11, 16) : '';
