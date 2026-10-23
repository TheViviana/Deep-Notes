// 自动同步的「内容是否真有变化」判定：与解析器（importer.parseVault + vaultRules）同口径
// 归一化后，按 id 建指纹表做顺序无关比对。自己写盘的回声（fs.watch 回环）、数组顺序差异、
// 正文首尾空白、空指标 null↔0、media null↔'images' 等往返差异都不再被误判为「外部变更」——
// 误判会让 adoptData 用盘上版本覆盖内存：重置页面 / 选中态，并顶掉尚未落盘的移动操作。
import {tagsOf} from './vaultRules';

const T = v => String(v ?? '').trim();                    // 标量：解析器对 frontmatter 值与标题的 trim
const B = v => String(v ?? '').replace(/\r/g, '').trim(); // 正文：importer 的 clean()
const N0 = v => (v == null || v === '' || Number.isNaN(Number(v))) ? 0 : Number(v);   // 解析端 `num(...) ?? 0`
const NN = v => (v == null || v === '' || Number.isNaN(Number(v))) ? null : Number(v); // 解析端裸 `num(...)`
const M = v => v === 'video' ? 'video' : 'images';        // 解析端 media 缺省 'images'

// 日期归一化与 importer.dateOf 同口径（文件时间戳兜底在这里换成「今天」——
// 解析端对缺省日期同样回落到当天，两侧一致即可）。
const pad = n => String(n).padStart(2, '0');
const dateFull = v => {
  const s = v ? String(v).trim().replace(/\//g, '-').replace(/^(\d{4}-\d{1,2}-\d{1,2})$/, '$1 00:00') : '';
  const d = s ? new Date(s) : null;
  const t = d && !isNaN(d) ? d : new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
};
const dateDay = v => dateFull(v).slice(0, 10);

// 作品标签：序列化把 tags 写成「#a #b」进 frontmatter，解析端 tagsOf 再叠加正文里的 #话题——
// 指纹必须复刻这条链路，否则正文带 #话题 的作品每次同步都被误判为外部变更。
const tagsFp = item => tagsOf({tags: (Array.isArray(item.tags) ? item.tags : []).map(t => '#' + t).join(' ')}, item.body || '');

const J = JSON.stringify;
// 各模块指纹字段与 importer.parseVault 的产物逐一对齐
const FP = {
  works: w => J([T(w.title), dateFull(w.date), T(w.direction), tagsFp(w), B(w.body), M(w.media),
    N0(w.views), N0(w.likes), N0(w.comments), N0(w.saves), NN(w.follows), N0(w.shares),
    NN(w.impressions), NN(w.ctr), NN(w.duration)]),
  notes: n => J([T(n.title), String(n.path || ''), B(n.body)]),
  drafts: d => J([T(d.title), B(d.body), String(d.source ?? '')]),
  readings: r => J([T(r.title), T(r.author), T(r.source), T(r.folder), dateDay(r.date), B(r.body)]),
  archives: a => J([T(a.title), dateDay(a.date), B(a.body)]),
  ideas: i => J([T(i.title), T(i.platform) || '小红书', T(i.priority) || '中', T(i.status) || '待写', T(i.note)]),
};

// 按 id 建指纹表：id 唯一（settleIds / 应用内生成），顺序无关
const fpMapOf = (kind, list) => {
  const build = FP[kind];
  const m = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || x.id == null) continue;
    m.set(String(x.id), build(x));
  }
  return m;
};
const sameKind = (kind, cur, fresh) => {
  const a = fpMapOf(kind, cur), b = fpMapOf(kind, fresh);
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};

// cur：内存六类数组；data：parseVault 刚解析出的盘上内容；kbConcepts：当前概念词表。
// 概念沿用原有语义：盘上词表是内存词表的子集即算无变化（概念由内容推导且应用内可编辑，不落盘）。
export function sameVaultContent(cur, data, kbConcepts) {
  if (!data) return false;
  for (const kind of ['works', 'notes', 'drafts', 'readings', 'archives', 'ideas']) {
    if (!sameKind(kind, cur?.[kind], data?.[kind])) return false;
  }
  return (data.concepts || []).every(([n]) => (kbConcepts || []).some(([k]) => k === n));
}
