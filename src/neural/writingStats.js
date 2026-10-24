// —— 写作统计：每天记一次「全库总字数」快照（localStorage，最多 400 天）——
// 日增量 = 与前一天快照的差值；当日重复记录取较大值（外部删除导致总量回落不产生负增量）。
// 只在本机记录，不联网、不落知识库。
import {CONFIG, readVaultRoot} from '../config';

// 统计按知识库隔离：不同库的体量互不污染「今日增量 / 连续天数」；未连库时共用 'local'
const statsKey = () => CONFIG.storagePrefix + '-writing-stats-v1:' + (readVaultRoot() || 'local');
const KNOWN_KEY = CONFIG.storagePrefix + '-known-vaults-v1';

export function totalChars({works = [], notes = [], drafts = [], readings = [], archives = []}) {
  const sum = list => (Array.isArray(list) ? list : []).reduce((s, x) => s + (x.body || '').length, 0);
  return sum(works) + sum(notes) + sum(drafts) + sum(readings) + sum(archives);
}

export function recordDaily(total) {
  try {
    const list = loadStats();
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const last = list[list.length - 1];
    if (last && last.d === day) last.c = Math.max(last.c, total);
    else if (total > 0) list.push({d: day, c: total});
    localStorage.setItem(statsKey(), JSON.stringify(list.slice(-400)));
  } catch {} // 统计是附加功能，存储失败不影响使用
}

export function loadStats() { try { const v = JSON.parse(localStorage.getItem(statsKey())); return Array.isArray(v) ? v : []; } catch { return []; } }

// 相邻两日差值：首日增量为 0（没有更早的基线）
export function dailyDeltas(list = []) {
  return list.map((x, i) => ({d: x.d, c: x.c, delta: i === 0 ? 0 : Math.max(0, x.c - list[i - 1].c)}));
}

// 连续写作天数：从今天（或昨天）往前数「有正增量」的连续天数
export function streakDays(list = []) {
  const deltas = dailyDeltas(list);
  const wrote = new Set(deltas.filter(x => x.delta > 0).map(x => x.d));
  if (!wrote.size) return 0;
  const day = new Date(), p = n => String(n).padStart(2, '0');
  const key = dt => `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  const today = key(day);
  if (!wrote.has(today)) { day.setDate(day.getDate() - 1); if (!wrote.has(key(day))) return 0; } // 昨天写过的连续段也算
  let n = 0;
  while (wrote.has(key(day))) { n += 1; day.setDate(day.getDate() - 1); }
  return n;
}

// —— 多库快速切换的「已知知识库」清单：setRoot 成功时登记，最近使用的排在前面 ——
export function rememberVault(dir) {
  if (!dir) return;
  try {
    const l = JSON.parse(localStorage.getItem(KNOWN_KEY)) || [];
    const next = [{path: dir, at: Date.now()}, ...l.filter(x => x.path !== dir)].slice(0, 12);
    localStorage.setItem(KNOWN_KEY, JSON.stringify(next));
  } catch {}
}
export function knownVaults() { try { const v = JSON.parse(localStorage.getItem(KNOWN_KEY)); return Array.isArray(v) ? v : []; } catch { return []; } }
