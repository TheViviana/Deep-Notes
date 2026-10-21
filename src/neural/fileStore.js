// 桌面版文件夹知识库：编辑内容实时写回本地 .md 文件（与 Obsidian 相同的存放方式）。
// 仅在 Electron（window.deepnotes 存在）且已选择库根目录时启用；网页版保持 localStorage 不变。
// 每次导入都在原库旁新建「<原名> - Deep Notes」副本，原知识库文件夹内容不动。
import {CONFIG, VAULT_ROOT_KEY, readVaultRoot} from '../config';
import {clearAssetCache} from './images';

const TARGET_KEY = CONFIG.storagePrefix + '-vault-target-v1';
const api = () => window.deepnotes?.vault || null;
export const capable = () => !!api();

// 根目录路径存固定键（config.js 的 readVaultRoot 负责旧前缀键的迁移），换品牌不丢连接
export function getRoot() {
  return readVaultRoot();
}

// 导入时的归类方式（'auto' 或指定模块）：打开软件自动同步知识库时按同一方式重新解析。
export function getTarget() {
  try { return localStorage.getItem(TARGET_KEY) || 'auto'; } catch { return 'auto'; }
}
export function setTarget(t) {
  try { t && t !== 'auto' ? localStorage.setItem(TARGET_KEY, t) : localStorage.removeItem(TARGET_KEY); } catch {}
}

// 写盘失败回调（权限不足 / 磁盘满等），由渲染层注册用来提示用户。
let errorHandler = null;
export function setErrorHandler(fn) { errorHandler = fn; }

// 切库 / 停用写回：先把旧队列按各自捕获的旧根目录写完，再作废队列换根目录，
// 这样 800ms 防抖窗口内的编辑不会丢，也不会写进新库。
export async function setRoot(dir) {
  await flush();
  try {
    if (dir) localStorage.setItem(VAULT_ROOT_KEY, dir);
    else localStorage.removeItem(VAULT_ROOT_KEY);
  } catch {}
  clearAssetCache(); // 换库后旧图片缓存全部作废
  clearTimeout(timer);
  timer = null;
  queue.clear();
}

// 各模块内容落盘的默认目录；方法笔记直接使用自身 path（形如 05-方法库 methods/<子目录>/<文件名>.md）。
const DIRS = {works: '02-作品库', drafts: '03-创作台/正在写', readings: '06-阅读区', archives: '07-档案区', ideas: '04-选题池'};

// 文件名安全化：路径分隔符换成 ·，去首尾空白，限长 60。
const safe = t => String(t || '未命名').trim().replace(/[/\\]/g, '·').replace(/\s+/g, ' ').slice(0, 60) || '未命名';
export const safeName = safe; // 导出功能复用同一套文件名规则

// —— 导出 Markdown：桌面版选目录逐文件写盘（vault:export 限制在所选目录内）；
// 网页版合并成单个 .md 经浏览器下载。files: [{rel, body}]，返回落盘目录 / 'download'（用户取消返回 null）。 ——
export async function exportFiles(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const v = api();
  if (v) {
    const dir = await v.chooseDir();
    if (!dir) return null;
    const res = await v.exportMany(dir, files);
    if (!res?.ok) throw new Error(res?.error || '导出失败');
    return dir;
  }
  const merged = files.map(f => f.body).join('\n\n---\n\n');
  const blob = new Blob([merged], {type: 'text/markdown'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = files.length === 1 ? files[0].rel.split('/').pop() : 'Deep-Notes-导出.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return 'download';
}

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
export {shortId};
export function resolveRels(kind, items) {
  if (kind === 'notes') return new Map(items.filter(x => x?.id).map(x => [x.id, pathOf(kind, x)]));
  const seen = new Set();
  const map = new Map();
  for (const x of items) {
    if (!x?.id) continue;
    let rel = pathOf(kind, x);
    // 先到先得：撞车时后来的那条追加 id 短码，第一条保持原名
    if (rel && seen.has(rel)) {
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
// 数组值（keep 里的列表）展开成「- 项」多行而不是压成逗号串——否则往返一次后列表会变形；
// 空数组直接丢弃。多行展开仍在同一 frontmatter 块内，后续键不受影响。
function frontmatter(pairs) {
  const render = ([k, v]) => Array.isArray(v)
    ? (v.length ? `${k}:\n` + v.map(x => `  - ${String(x).replace(/\n/g, ' ')}`).join('\n') : null)
    : `${k}: ${String(v).replace(/\n/g, ' ')}`;
  return '---\n' + pairs.filter(([, v]) => v != null && v !== '').map(render).filter(Boolean).join('\n') + '\n---\n';
}
export function serialize(kind, item) {
  // keep：导入时未消费的自定义 frontmatter 键（如「主题」）原样展开在最前——写回不丢用户手写元数据
  const keep = Object.entries(item.keep || {});
  let fm = frontmatter([...keep, ['deepnotes-id', item.id], ['title', item.title], ['updated', item.updatedAt || null]]);
  if (kind === 'works') {
    fm = frontmatter([...keep,
      ['deepnotes-id', item.id], ['title', item.title], ['date', item.date], ['updated', item.updatedAt || null],
      ['direction', item.direction || null], ['tags', (item.tags || []).map(t => '#' + t).join(' ')],
      ['media', item.media === 'video' ? '视频' : item.media === 'images' ? '图文' : null],
      ['观看', item.views ?? null], ['点赞', item.likes ?? null], ['评论', item.comments ?? null],
      ['收藏', item.saves ?? null], ['涨粉', item.follows ?? null], ['分享', item.shares ?? null],
      ['曝光', item.impressions ?? null], ['封面点击率', item.ctr ?? null], ['平均观看时长', item.duration ?? null],
    ]);
  } else if (kind === 'readings') {
    // folder 一并落盘：阅读区分类随 .md 文件走，重新导入 / 自动同步都不会再丢分类
    fm = frontmatter([...keep, ['deepnotes-id', item.id], ['title', item.title], ['author', item.author || null], ['source', item.source || null], ['folder', item.folder || null], ['date', item.date || null], ['updated', item.updatedAt || null]]);
  } else if (kind === 'archives') {
    fm = frontmatter([...keep, ['deepnotes-id', item.id], ['title', item.title], ['date', item.date || null], ['updated', item.updatedAt || null]]);
  } else if (kind === 'drafts') {
    fm = frontmatter([...keep, ['deepnotes-id', item.id], ['title', item.title], ['updated', item.updatedAt || null]]);
  } else if (kind === 'ideas') {
    // 选题没有正文：平台 / 优先级 / 状态 / 备注全部入 frontmatter（导入端优先读 fm.note，往返无损）
    fm = frontmatter([...keep, ['deepnotes-id', item.id], ['title', item.title],
      ['platform', item.platform || null], ['priority', item.priority || null],
      ['status', item.status || null], ['note', item.note || null]]);
  }
  return fm + '\n' + (item.body || '');
}

// —— 防抖写盘队列：多次编辑合并，800ms 静默后统一 flush ——
// 以「类型 + 路径」为键：move（重命名，原子）、trash（删除）、write（写入）三类，
// 同一文件先 move/trash 后 write（如甲删除、乙顶上原名）多个操作都要执行——
// 若只按路径去重，write 会盖掉 trash，被删内容的旧文件不会进 .trash 就被覆盖（破坏可找回性）。
// 重命名走 move（rename 原子）而不是「trash 旧 + write 新」：中途失败旧文件仍在原处，
// 内容既不丢、也不往 .trash 塞改名副本。
const queue = new Map(); // 'm:from' -> {root, from, to, move} | 't:rel' -> {root, rel, trash} | 'w:rel' -> {root, rel, body}
let timer = null;
const opKey = op => op.move ? 'm:' + op.from : op.trash ? 't:' + op.rel : 'w:' + op.rel;

function enqueue(op) {
  queue.set(opKey(op), op);
  clearTimeout(timer);
  timer = setTimeout(flush, 800);
}

// —— 挂起写记录：写盘重试仍失败的操作持久留底 ——
// 连续两次失败（磁盘满 / 权限 / 文件被占用等）意味着这次修改没有落盘；只弹 toast 的话，
// 下次启动的自动同步会「以文件夹为准」把浏览器状态覆盖掉，用户无感知地丢编辑。
// 所以最终失败的操作要记进 localStorage：启动时检测到挂起记录就跳过自动同步并提示，
// 重试成功后清除。记录只在本机，含原文 body（与业务数据同级）。
// 审计 H3：localStorage 自身写满（与 H2 叠加：磁盘满 + 存储满双失败）时记录转存 IndexedDB
// （配额大得多、与 localStorage 独立），留底不再丢；启动时异步读回合并，确认完再谈自动同步。
const PENDING_KEY = CONFIG.storagePrefix + '-pending-writes-v1';
let pendingRecorded = false; // 内存标记：避免每次成功 flush 都空写一次 localStorage
let pendingList = (() => { // 内存为唯一事实源：模块加载时从 localStorage 读一次
  try { const v = JSON.parse(localStorage.getItem(PENDING_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
})();
function loadPending() { return pendingList; }
const IDB_NAME = 'deepnotes-pending', IDB_STORE = 'kv';
function idbRun(mode, fn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = v => { if (!settled) { settled = true; resolve(v); } };
    const fail = e => { if (!settled) { settled = true; reject(e || new Error('IndexedDB 不可用')); } };
    try {
      const open = indexedDB.open(IDB_NAME, 1);
      open.onupgradeneeded = () => { try { open.result.createObjectStore(IDB_STORE); } catch {} };
      open.onerror = () => fail(open.error);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction(IDB_STORE, mode);
          const req = fn(tx.objectStore(IDB_STORE));
          tx.oncomplete = () => { db.close(); ok(req && 'result' in req ? req.result : undefined); };
          tx.onerror = () => { db.close(); fail(tx.error); };
          tx.onabort = () => { db.close(); fail(tx.error); };
        } catch (e) { try { db.close(); } catch {} fail(e); }
      };
    } catch (e) { fail(e); }
  });
}
const idbGet = () => idbRun('readonly', st => st.get('pending')).then(r => Array.isArray(r) ? r : []).catch(() => []);
const idbPut = list => idbRun('readwrite', st => st.put(list, 'pending'));
const idbClear = () => idbRun('readwrite', st => st.delete('pending'));
// 启动补灌：localStorage 没有留底而 IndexedDB 有（上次会话的兜底），读回内存并让横幅出现。
// syncFromVault 会 await pendingReady 之后再判定「是否跳过自动同步」，补灌不与同步抢跑。
let pendingReadyResolve;
export const pendingReady = new Promise(r => { pendingReadyResolve = r; });
idbGet().then(list => {
  if (!pendingList.length && list.length) {
    pendingList = list;
    pendingRecorded = true;
    try { window.dispatchEvent(new Event('deepnotes-pending-changed')); } catch {}
  }
  pendingReadyResolve();
}).catch(() => pendingReadyResolve());
function savePending(list) {
  pendingList = Array.isArray(list) ? list.slice() : [];
  pendingRecorded = !!pendingList.length;
  let saved = true;
  try {
    if (pendingList.length) localStorage.setItem(PENDING_KEY, JSON.stringify(pendingList));
    else localStorage.removeItem(PENDING_KEY);
  } catch { saved = false; }
  if (!saved && pendingList.length) {
    // localStorage 写满：IndexedDB 兜底。兜底也写不进（审计 v2-⑧）就必须明确告警——
    // 此时留底只存在于本次会话的内存里，关窗即失，用户必须知道并尽快处理
    idbPut(pendingList).catch(err => {
      console.warn('IndexedDB 留底兜底失败 · IndexedDB backup failed:', err);
      try { window.dispatchEvent(new Event('deepnotes-pending-persist-failed')); } catch {}
    });
  } else if (saved) idbClear().catch(() => {}); // localStorage 写成功后清掉 IndexedDB 旧兜底，避免复活
  try { window.dispatchEvent(new Event('deepnotes-pending-changed')); } catch {} // 横幅状态跟随（出现 / 自动隐藏）
}
export function hasPendingWrites() {
  return pendingRecorded || pendingList.length > 0;
}
export function clearPendingWrites() { savePending([]); }
let retryingPending = false; // 防递归：flush 末尾会补写历史留底再次进入 retryPending，补写期间由这里拦住
// 把挂起操作重新排队并 flush：写盘成功的记录才清除，仍失败的由 flush 失败路径重新留底
//（时间戳最新）。await 本轮写完才返回——调用方（横幅「重试写盘」）据此判断最终结果。
// 审计 v2-①：留底不能在写盘结果未知前清掉——旧实现先 savePending([]) 再写盘，进程在
// await flush() 期间被杀（崩溃 / 断电 / 强退）时留底已清而磁盘未必写成，编辑就真丢了。
// 现在先写后清：中途被杀最坏也就是「留底还在、盘上未知」，下次启动照旧横幅提示。
export async function retryPending() {
  if (retryingPending) return 0;
  const list = loadPending();
  const v = api();
  if (!v || !list.length) return 0; // 没有桌面 API 时更不能清留底（清了就真丢），原样保留
  retryingPending = true;
  try {
    for (const op of list) queue.set(opKey(op), {...op, _retry: true});
    const failed = (await flush()) || [];
    const failedKeys = new Set(failed.map(opKey));
    for (const op of list) if (!op.root) failedKeys.add(opKey(op)); // root 丢失写不了：视为仍失败，保留留底
    // 留底收敛为「仍失败的」：写盘成功的已从记录清除
    savePending(loadPending().filter(op => failedKeys.has(opKey(op))));
    return list.length;
  } finally { retryingPending = false; }
}
function recordPending(ops) {
  const at = new Date().toISOString();
  // 以「类型 + 路径」去重合并：同一条反复失败只留最新一份（body 取本次的，更新鲜）
  const map = new Map(loadPending().map(op => [opKey(op), op]));
  for (const op of ops) map.set(opKey(op), {...op, at});
  savePending([...map.values()]);
}

export async function flush() {
  clearTimeout(timer);
  timer = null;
  const v = api();
  if (!v || !queue.size) return;
  const ops = [...queue.values()];
  queue.clear();
  const failedOps = [];
  let requeued = false;
  for (const op of ops) {
    try {
      // 用 op 捕获时的根目录：即使中途切库，旧编辑也只写进旧库
      const root = op.root || getRoot();
      if (!root) continue;
      const res = op.move ? await v.move(root, op.from, op.to)
        : op.trash ? await v.trash(root, op.rel)
        : await v.write(root, op.rel, op.body);
      // 主进程把业务失败包成 {ok:false} 返回而非抛错：这里必须显式检查，
      // 否则越界 / 拒写 / 权限不足全被静默吞掉，重试与用户提示都不会触发
      if (res && res.ok === false) throw new Error(res.error || '写盘失败');
    } catch (err) {
      // 非破坏性增量：瞬时故障（磁盘休眠 / 占用等）不丢操作，稍后自动重试一次；
      // 重试仍失败则持久留底为「挂起写」（启动时跳过同步防覆盖 + 提示重试），
      // 内容始终还留在浏览器里
      if (!op._retry) { queue.set(opKey(op), {...op, _retry: true}); requeued = true; }
      else failedOps.push(op);
    }
  }
  if (requeued) { clearTimeout(timer); timer = setTimeout(flush, 2500); }
  if (failedOps.length) {
    recordPending(failedOps);
    if (errorHandler) errorHandler(failedOps.map(op => op.rel || op.from));
  } else if (pendingRecorded && !retryingPending) {
    // 有历史留底：先补写留底的操作再谈「清除」。直接清掉会让留底内容静默丢失
    //（下次启动按文件夹覆盖），补写失败会重新留底并再次提示。
    retryPending();
  }
  return failedOps; // 调用方（retryPending）据此知道哪些操作最终仍失败
}

// 退出前的同步落盘：beforeunload 里异步 IPC（flush）可能页面先卸载、操作根本发不出去，
// 改走 sendSync 阻塞通道，主进程用同步 fs 写完才放行关闭。只应在 beforeunload 里调用。
export function flushSyncNow() {
  const v = api();
  if (!v?.flushSync) return;
  clearTimeout(timer);
  timer = null;
  // 挂起写也搭上退出前的同步通道（最后一次机会）：写成功记录随之清除，仍失败原样留底。
  // 若只写新操作就清记录，留底内容会被静默丢掉（下次启动按文件夹覆盖）。
  const pend = loadPending();
  if (pend.length) {
    savePending([]);
    for (const op of pend) queue.set(opKey(op), {...op, _retry: true});
  }
  if (!queue.size) return;
  const ops = [...queue.values()].map(op => ({...op, root: op.root || getRoot()}));
  queue.clear();
  try {
    const res = v.flushSync(ops);
    const bad = Array.isArray(res?.failed) ? res.failed : null;
    if (bad && bad.length) {
      // 退出前也没写成：记为挂起写，下次启动跳过同步并提示
      recordPending(ops.filter(op => bad.includes(op.rel || op.from || '')));
    } else if (pendingRecorded) {
      clearPendingWrites(); // 退出前全部写成功：挂起记录清掉
    }
  } catch (err) {
    recordPending(ops); // 同步通道整体异常：宁可全部留底（下次重试成功即可清除）
    console.warn('退出落盘失败 · Flush on quit failed:', err);
  }
}

// 同步一条内容到磁盘。item 为 null 表示删除；old 为变更前的旧记录（路径变了走 move 原子移动）。
// old 与 item 同引用（其他 kind 变化引发的全量 diff）时无需重写。
// relMap 按「新数组」算出的消歧路径；oldRelMap 按「旧数组」算——旧路径必须用旧的消歧结果：
// 若按新数组算，同名消歧短码会挪给别的条目，删除/重命名时错删同名文件、留下真孤儿。
export function queueSync(kind, item, old, relMap, oldRelMap) {
  const root = getRoot();
  if (!root || !api()) return;
  const relOf = (x, map) => (map && x && map.get(x.id)) || pathOf(kind, x);
  const newRel = item ? relOf(item, relMap) : null;
  const oldRel = old ? relOf(old, oldRelMap || relMap) : null;
  if (old === item && oldRel === newRel) return;
  if (!item) {
    if (oldRel) enqueue({root, rel: oldRel, trash: true});
    return;
  }
  if (old && oldRel && oldRel !== newRel) enqueue({root, from: oldRel, to: newRel, move: true});
  if (newRel) enqueue({root, rel: newRel, body: serialize(kind, item)});
}

// —— 导入：桌面版选目录 → 主进程读文件 → 转成 parseVault 兼容的 File 桩 ——
export async function chooseDir() {
  const v = api();
  return v ? v.chooseDir() : null;
}

// 把主进程读到的 {relPath, body} 列表转成 importer.parseVault 可用的 File 桩。
// 返回 {files, unreadable}：unreadable 是「存在但读不出内容」的文件（iCloud 未下载等），
// 调用方必须据此中止导入 / 同步——把读不到当删除写回会把云盘文件真删掉。
export function readVaultFiles(dir, res) {
  if (!res?.ok) throw new Error(res?.error || '读取失败');
  const base = (dir || '').split('/').pop() || 'vault';
  const files = res.files.map(f => ({
    name: f.relPath.split('/').pop(),
    webkitRelativePath: base + '/' + f.relPath,
    lastModified: 0,
    text: async () => f.body,
  }));
  return {files, unreadable: res.unreadable || []};
}

export async function prepareCopy(srcRoot) {
  const v = api();
  if (!v) return null;
  return v.prepareCopy(srcRoot);
}
