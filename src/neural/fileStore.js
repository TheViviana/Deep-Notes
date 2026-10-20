// 桌面版文件夹知识库：编辑内容实时写回本地 .md 文件（与 Obsidian 相同的存放方式）。
// 仅在 Electron（window.deepnotes 存在）且已选择库根目录时启用；网页版保持 localStorage 不变。
// 每次导入都在原库旁新建「<原名> - Deep Notes」副本，原知识库文件夹内容不动。
import {CONFIG} from '../config';

const ROOT_KEY = CONFIG.storagePrefix + '-vault-root-v1';
const api = () => window.deepnotes?.vault || null;
export const capable = () => !!api();

export function getRoot() {
  try { return localStorage.getItem(ROOT_KEY) || null; } catch { return null; }
}

// 写盘失败回调（权限不足 / 磁盘满等），由渲染层注册用来提示用户。
let errorHandler = null;
export function setErrorHandler(fn) { errorHandler = fn; }

// 切库 / 停用写回：先把旧队列按各自捕获的旧根目录写完，再作废队列换根目录，
// 这样 800ms 防抖窗口内的编辑不会丢，也不会写进新库。
export async function setRoot(dir) {
  await flush();
  try {
    if (dir) localStorage.setItem(ROOT_KEY, dir);
    else localStorage.removeItem(ROOT_KEY);
  } catch {}
  clearTimeout(timer);
  timer = null;
  queue.clear();
}

// 各模块内容落盘的默认目录；方法笔记直接使用自身 path（形如 05-方法库 methods/<子目录>/<文件名>.md）。
const DIRS = {works: '02-作品库', drafts: '03-创作台/正在写', readings: '06-阅读区', archives: '07-档案区'};

// 文件名安全化：路径分隔符换成 ·，去首尾空白，限长 60。
const safe = t => String(t || '未命名').trim().replace(/[/\\]/g, '·').replace(/\s+/g, ' ').slice(0, 60) || '未命名';

// 计算一条内容对应的库内相对路径（posix 分隔）。kind ∈ works | notes | drafts | readings | archives
export function pathOf(kind, item) {
  if (!item) return null;
  if (kind === 'notes') return item.path || null;
  const dir = DIRS[kind];
  if (!dir) return null;
  return `${dir}/${safe(item.title)}.md`;
}

// 同名标题会映射到同一个 .md 文件、互相覆盖：对撞车的那组文件名追加 id 短码消歧
// （每组第一条保持原名）。notes 用自身 path 由调用方保证唯一，不参与。
const shortId = id => String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'x';
export function resolveRels(kind, items) {
  if (kind === 'notes') return new Map(items.filter(x => x?.id).map(x => [x.id, pathOf(kind, x)]));
  const counts = new Map();
  for (const x of items) {
    if (!x?.id) continue;
    const rel = pathOf(kind, x);
    if (rel) counts.set(rel, (counts.get(rel) || 0) + 1);
  }
  const seen = new Set();
  const map = new Map();
  for (const x of items) {
    if (!x?.id) continue;
    let rel = pathOf(kind, x);
    if (rel && counts.get(rel) > 1) {
      let dedup = rel.replace(/\.md$/, `--${shortId(x.id)}.md`);
      while (seen.has(dedup)) dedup = dedup.replace(/\.md$/, `-${shortId(x.id)}.md`);
      rel = dedup;
    }
    if (rel) seen.add(rel);
    map.set(x.id, rel);
  }
  return map;
}

// 序列化成带 frontmatter 的 Markdown；deepnotes-id 保证再次导入时不产生重复节点。
function frontmatter(pairs) {
  return '---\n' + pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n---\n';
}
export function serialize(kind, item) {
  let fm = frontmatter([['deepnotes-id', item.id], ['title', item.title], ['updated', item.updatedAt || null]]);
  if (kind === 'works') {
    fm = frontmatter([
      ['deepnotes-id', item.id], ['title', item.title], ['date', item.date], ['updated', item.updatedAt || null],
      ['direction', item.direction || null], ['tags', (item.tags || []).map(t => '#' + t).join(' ')],
      ['media', item.media === 'video' ? '视频' : item.media === 'images' ? '图文' : null],
      ['观看', item.views ?? null], ['点赞', item.likes ?? null], ['评论', item.comments ?? null],
      ['收藏', item.saves ?? null], ['涨粉', item.follows ?? null], ['分享', item.shares ?? null],
      ['曝光', item.impressions ?? null], ['封面点击率', item.ctr ?? null], ['平均观看时长', item.duration ?? null],
    ]);
  } else if (kind === 'readings') {
    fm = frontmatter([['deepnotes-id', item.id], ['title', item.title], ['author', item.author || null], ['source', item.source || null], ['date', item.date || null], ['updated', item.updatedAt || null]]);
  } else if (kind === 'archives') {
    fm = frontmatter([['deepnotes-id', item.id], ['title', item.title], ['date', item.date || null], ['updated', item.updatedAt || null]]);
  } else if (kind === 'drafts') {
    fm = frontmatter([['deepnotes-id', item.id], ['title', item.title], ['updated', item.updatedAt || null]]);
  }
  return fm + '\n' + (item.body || '');
}

// —— 防抖写盘队列：多次编辑合并，800ms 静默后统一 flush ——
const queue = new Map(); // rel -> {root, rel, body} | {root, rel, trash: true}
let timer = null;

function enqueue(op) {
  queue.set(op.rel, op);
  clearTimeout(timer);
  timer = setTimeout(flush, 800);
}

export async function flush() {
  clearTimeout(timer);
  timer = null;
  const v = api();
  if (!v || !queue.size) return;
  const ops = [...queue.values()];
  queue.clear();
  const failed = [];
  for (const op of ops) {
    try {
      // 用 op 捕获时的根目录：即使中途切库，旧编辑也只写进旧库
      const root = op.root || getRoot();
      if (!root) continue;
      if (op.trash) await v.trash(root, op.rel);
      else await v.write(root, op.rel, op.body);
    } catch (err) { failed.push(op.rel); }
  }
  if (failed.length && errorHandler) errorHandler(failed);
}

// 同步一条内容到磁盘。item 为 null 表示删除；old 为变更前的旧记录（路径变了会先移走旧文件）。
// old 与 item 同引用（其他 kind 变化引发的全量 diff）时无需重写。
// relMap 来自 resolveRels：同名标题的内容在此取得消歧后的真实路径，删除/重命名场景必须用它算旧路径。
export function queueSync(kind, item, old, relMap) {
  const root = getRoot();
  if (!root || !api() || kind === 'ideas') return;
  const relOf = x => (relMap && x && relMap.get(x.id)) || pathOf(kind, x);
  const newRel = item ? relOf(item) : null;
  const oldRel = old ? relOf(old) : null;
  if (old === item && oldRel === newRel) return;
  if (!item) {
    if (oldRel) enqueue({root, rel: oldRel, trash: true});
    return;
  }
  if (old && oldRel && oldRel !== newRel) enqueue({root, rel: oldRel, trash: true});
  if (newRel) enqueue({root, rel: newRel, body: serialize(kind, item)});
}

// —— 导入：桌面版选目录 → 主进程读文件 → 转成 parseVault 兼容的 File 桩 ——
export async function chooseDir() {
  const v = api();
  return v ? v.chooseDir() : null;
}

// 把主进程读到的 {relPath, body} 列表转成 importer.parseVault 可用的 File 桩。
export function readVaultFiles(dir, res) {
  if (!res?.ok) throw new Error(res?.error || '读取失败');
  const base = (dir || '').split('/').pop() || 'vault';
  return res.files.map(f => ({
    name: f.relPath.split('/').pop(),
    webkitRelativePath: base + '/' + f.relPath,
    lastModified: 0,
    text: async () => f.body,
  }));
}

export async function prepareCopy(srcRoot) {
  const v = api();
  if (!v) return null;
  return v.prepareCopy(srcRoot);
}
