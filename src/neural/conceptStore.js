// 概念扩展数据与复习调度：独立 localStorage 键（-concept-extras-v1 / -concept-review-v1），
// 订阅式单例：概念内页、分析栏、图谱共用同一份状态。
// 磁盘唯一事实源：连库时同一份数据另存进库根 .deepnotes/meta.json（fileStore 的 patchMeta），
// 换机 / 重装后随知识库带走；localStorage 只作本机兜底。
import {useEffect, useState} from 'react';
import {CONFIG} from '../config';

let sink = null;      // 连库时由 main.jsx 注入：把改动合并进知识库 meta
let hydrating = false; // 灌入盘上数据期间不回写，避免「读盘 → 写盘」空转
export function setConceptSink(fn) { sink = fn; }

// —— 三向合并的影子副本（审计 B7）——
// shadow 记录「本机已确认与盘上一致的最后一版」（hydrate 完成、或 meta 写盘成功后更新）。
// 双机来回编辑时据此判断每个键是哪边改的：本地没动用盘上、盘上没动用本地、两边都动取盘上
// （多台机器收敛到同一份）。没有 shadow（老用户首次升级）时退化为本地优先，与旧行为一致。
const SHADOW_KEY = () => CONFIG.storagePrefix + '-concept-meta-shadow-v1';
const readShadow = () => { try { return JSON.parse(localStorage.getItem(SHADOW_KEY())) || null; } catch { return {}; } };
const writeShadow = obj => { try { localStorage.setItem(SHADOW_KEY(), JSON.stringify(obj)); } catch {} };
// meta 写盘成功（含换库后另一边的成功写入）时同步 shadow；patchMeta 写失败不会派发，shadow 不撒谎
if (typeof window !== 'undefined') {
  window.addEventListener('deepnotes-meta-written', e => {
    const snap = e.detail;
    if (snap && typeof snap === 'object') {
      const sh = readShadow();
      for (const k of ['conceptExtras', 'conceptReview', 'paraCards', 'paraReview']) {
        if (snap[k] && typeof snap[k] === 'object') sh[k] = snap[k];
      }
      writeShadow(sh);
    }
  });
}

// export 供 tests/metaMerge.test.mjs 做三向合并回归
export function merge3(local, disk, shadow) {
  const out = {};
  for (const k of new Set([...Object.keys(local || {}), ...Object.keys(disk || {})])) {
    const l = local?.[k], d = disk?.[k], s = shadow?.[k];
    const lj = JSON.stringify(l), dj = JSON.stringify(d), sj = JSON.stringify(s);
    if (lj === dj) { if (d !== undefined) out[k] = d; continue; }
    if (lj === sj) { if (d !== undefined) out[k] = d; continue; } // 本地没动 → 用盘上（含本地已删）
    if (dj === sj) { if (l !== undefined) out[k] = l; continue; } // 盘上没动 → 用本地（含盘上已删）
    if (d !== undefined) out[k] = d; else out[k] = l;              // 两边都动 → 取盘上，双机收敛
  }
  return out;
}

function makeStore(key, metaKey) {
  const full = CONFIG.storagePrefix + key;
  const load = () => { try { return JSON.parse(localStorage.getItem(full)) || {}; } catch { return {}; } };
  let state = load();
  const subs = new Set();
  const write = next => {
    state = next;
    // 写失败（配额满 / 隐私模式）不能静默：内存已更新、界面看似保存成功，
    // 下次启动数据却没了。留 warn 痕迹，与 AI 配置等处的存储写失败提示同一风格。
    try { localStorage.setItem(full, JSON.stringify(next)); }
    catch (err) { console.warn('localStorage 写入失败 · Save failed:', full, err); }
    if (!hydrating && sink) sink(metaKey, next);
    for (const f of subs) f(next);
  };
  return {
    get: () => state,
    use: () => {
      const [v, set] = useState(state);
      useEffect(() => { const f = x => set(x); subs.add(f); return () => { subs.delete(f); }; }, []);
      return v;
    },
    write,
  };
}

// 概念定义与手动关键词：{ 概念名: {text, terms} }。terms 会合并进概念词表参与图谱匹配。
export const conceptExtras = makeStore('-concept-extras-v1', 'conceptExtras');
export function setConceptExtra(name, patch) {
  const cur = conceptExtras.get();
  if (patch.delete) {
    const rest = {...cur};
    delete rest[name];
    conceptExtras.write(rest);
    return;
  }
  conceptExtras.write({...cur, [name]: {...(cur[name] || {}), ...patch}});
}

// 闪卡复习调度（简化 SM-2）：{ 概念名: {due, ivl, ef, reps} }。
// grade：0 忘了（明天再来，间隔重置）· 1 模糊（按原间隔）· 2 记得（间隔 × ef）
export const conceptReview = makeStore('-concept-review-v1', 'conceptReview');
const DAY = 86400000;
function gradeIn(store, key, grade) {
  const st = store.get();
  const cur = st[key] || {due: 0, ivl: 0, ef: 2.0, reps: 0};
  const now = Date.now();
  let next;
  if (grade === 0) next = {due: now + DAY, ivl: 1, ef: Math.max(1.3, cur.ef - 0.2), reps: cur.reps + 1};
  else if (grade === 1) {
    // 「模糊」：间隔温和增长（×1.2 向上取整，上限 120 天）——原实现间隔永不增长，会一直卡在同一天
    const ivl = Math.min(120, Math.ceil(Math.max(1, cur.ivl || 1) * 1.2));
    next = {due: now + ivl * DAY, ivl, ef: cur.ef, reps: cur.reps + 1};
  }
  else {
    const ivl = Math.min(120, Math.max(1, cur.ivl || 1) * cur.ef);
    next = {due: now + ivl * DAY, ivl, ef: Math.min(3, cur.ef + 0.05), reps: cur.reps + 1};
  }
  store.write({...st, [key]: next});
}
export function gradeConcept(name, grade) { gradeIn(conceptReview, name, grade); }

// 段落闪卡：编辑器里选中正文一键存卡（{卡片id: {id, text, source, ts}}），
// 复习调度与概念卡同一条 Leitner 曲线，进度按卡片 id 存 -para-review-v1。
export const paraCards = makeStore('-para-cards-v1', 'paraCards');
export const paraReview = makeStore('-para-review-v1', 'paraReview');
export function saveParaCard(text, source) {
  const id = 'pc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  paraCards.write({...paraCards.get(), [id]: {id, text, source, ts: Date.now()}});
  return id;
}
export function deleteParaCard(id) {
  const rest = {...paraCards.get()};
  delete rest[id];
  paraCards.write(rest);
  const rr = {...paraReview.get()};
  delete rr[id];
  paraReview.write(rr);
}
export function gradePara(id, grade) { gradeIn(paraReview, id, grade); }

// 启动时把知识库 meta 里的附属数据灌回来：有 shadow 时按 merge3 三向合并（双机编辑不互相抹，
// 审计 B7）；没有 shadow（老用户首次升级 / 从未写盘成功过）退化为本地优先，与旧行为一致。
export function hydrateConceptMeta(meta) {
  if (!meta || typeof meta !== 'object') return;
  const pairs = [[conceptExtras, 'conceptExtras'], [conceptReview, 'conceptReview'], [paraCards, 'paraCards'], [paraReview, 'paraReview']];
  const shadow = readShadow();
  const hasShadow = shadow && typeof shadow === 'object';
  hydrating = true;
  try {
    const newShadow = {...(hasShadow ? shadow : {})};
    for (const [store, key] of pairs) {
      const incoming = meta[key];
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
      const local = store.get();
      const merged = hasShadow && shadow[key] ? merge3(local, incoming, shadow[key]) : {...incoming, ...local};
      store.write(merged);
      newShadow[key] = merged;
    }
    writeShadow(newShadow);
  } finally { hydrating = false; }
}
