// 概念扩展数据与复习调度：独立 localStorage 键（-concept-extras-v1 / -concept-review-v1），
// 不随知识库导入或自动同步被覆盖。订阅式单例：概念内页、分析栏、图谱共用同一份状态。
import {useEffect, useState} from 'react';
import {CONFIG} from '../config';

function makeStore(key) {
  const full = CONFIG.storagePrefix + key;
  const load = () => { try { return JSON.parse(localStorage.getItem(full)) || {}; } catch { return {}; } };
  let state = load();
  const subs = new Set();
  const write = next => {
    state = next;
    try { localStorage.setItem(full, JSON.stringify(next)); } catch {}
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
export const conceptExtras = makeStore('-concept-extras-v1');
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
export const conceptReview = makeStore('-concept-review-v1');
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
export const paraCards = makeStore('-para-cards-v1');
export const paraReview = makeStore('-para-review-v1');
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
