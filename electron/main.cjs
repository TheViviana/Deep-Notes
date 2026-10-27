const { app, BrowserWindow, shell, ipcMain, net, dialog, safeStorage, protocol, globalShortcut, clipboard } = require('electron');
const { Readable } = require('node:stream');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const dns = require('dns');
const crypto = require('crypto');

// 视频等大体积资源走自定义流式协议 deepnotes-asset://：图片用 vault:asset 返回 base64 足够，
// 但一部课程视频动辄数百 MB，base64 会把内存撑爆、也无法拖动进度条。协议直接把库内文件
// 以流的方式交给 <video>（支持 Range，seek 正常）。scheme 必须在 app ready 之前声明为
// 特权协议（standard + stream），否则渲染层拿不到可用的 URL 与响应体。
protocol.registerSchemesAsPrivileged([{
  scheme: 'deepnotes-asset',
  privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true},
}]);

// —— 文件夹知识库（桌面版）：渲染层经 preload 暴露的 window.deepnotes.vault 调用 ——
// 所有写操作都限制在所选根目录（root）内，路径越界一律拒绝。
function realPath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
// 越界校验必须解析真实路径：库里的符号链接若指向库外，纯字符串前缀比较会放行，
// writeFile 跟随链接就把内容写到库外了。目标（或中间目录）还不存在时，向上找第一个
// 真实存在的祖先解析出真实位置再拼回未创建的后缀——藏在中间的符号链接照样被识破。
function inside(root, target) {
  const r = realPath(path.resolve(root));
  let t = path.resolve(String(target || ''));
  let suffix = '';
  for (let cur = t; ; ) {
    let real = null;
    try { real = fs.realpathSync(cur); } catch { /* 不存在，继续向上 */ }
    if (real) { t = real + suffix; break; }
    suffix = path.sep + path.basename(cur) + suffix;
    const parent = path.dirname(cur);
    if (parent === cur) { t = path.resolve(String(target || '')); break; }
    cur = parent;
  }
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep); // 根即文件系统根（/）时不再拼出 //
}
// 目标本身是符号链接时直接拒绝（rename / writeFile 会穿过或搬运链接，语义都不对）。
function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// —— 授权根目录白名单（审计 M1）：只有经系统对话框由用户亲自选过的目录才能作为知识库 root。
// 渲染层万一被注入，也无法指派磁盘上任意目录让主进程读写，爆炸半径收敛到用户授权过的库。
// 白名单持久化在 userData，重启后已连接的库无需重新授权；升级老用户的存量根目录在首次
// 访问时弹一次系统确认框，允许后永久登记（每目录每会话最多弹一次）。拒绝的选择同样持久化
// （审计 v2-③），否则老用户每次启动都会被重复追问；prepare-copy 产生的副本目录不再自动
// 登记（审计 v2-②），首次访问同样要经一次确认——「只授权用户亲自确认过的目录」没有例外。
const AUTH_FILE = () => path.join(app.getPath('userData'), 'authorized-roots.json');
let authorizedRoots = null; // 惰性加载：{allowed, denied} 各为 Set，同时登记「解析路径 + 真实路径」两种写法
function loadAuth() {
  if (authorizedRoots) return authorizedRoots;
  let allowed = [], denied = [];
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf8'));
    if (Array.isArray(raw)) allowed = raw; // 旧格式：纯数组即允许清单
    else if (raw && typeof raw === 'object') { allowed = raw.allowed || []; denied = raw.denied || []; }
  } catch {}
  authorizedRoots = { allowed: new Set(allowed), denied: new Set(denied) };
  try { fs.chmodSync(AUTH_FILE(), 0o600); } catch {} // 审计 v2-⑩：历史文件权限收紧到仅本用户可读写
  return authorizedRoots;
}
function saveAuth() {
  const { allowed, denied } = authorizedRoots;
  // 0600：清单本身泄露已授权目录的路径，只留给当前用户
  try { fs.writeFileSync(AUTH_FILE(), JSON.stringify({ allowed: [...allowed], denied: [...denied] }, null, 2), { mode: 0o600 }); } catch {}
}
function authSet() { return loadAuth().allowed; }
function authorizeRoot(dir) {
  const r = path.resolve(String(dir || ''));
  if (!r) return;
  const auth = loadAuth();
  auth.allowed.add(r);
  auth.denied.delete(r); // 用户后来又亲自授权了同一目录：撤销此前的拒绝记录
  try { auth.allowed.add(fs.realpathSync(r)); } catch {} // 符号链接路径按真实路径补记，两种写法都能命中
  saveAuth();
}
function denyRoot(dir) {
  const r = path.resolve(String(dir || ''));
  if (!r) return;
  const auth = loadAuth();
  auth.denied.add(r);
  try { auth.denied.add(fs.realpathSync(r)); } catch {}
  saveAuth();
}
function rootAuthorized(root) {
  const raw = String(root || '').trim();
  if (!raw) return false; // 审计 v2-④：空 root 会 resolve 成 cwd，绝不能把当前目录卷进白名单
  const r = path.resolve(raw);
  if (!authSet().has(r)) return false;
  // 目录暂时读不到（磁盘休眠等）：按登记路径放行。显式复查登记集合而非无条件 true（审计 v2-⑨）
  try { return authSet().has(fs.realpathSync(r)); } catch { return authSet().has(r); }
}
const askedRoots = new Set(); // 确认框每目录每会话最多弹一次
async function ensureAuthorized(root) {
  const raw = String(root || '').trim();
  if (!raw) return false; // 审计 v2-④：空 root 不弹框，杜绝把 cwd 误授权
  if (rootAuthorized(raw)) return true;
  const r = path.resolve(raw);
  const denied = loadAuth().denied;
  if (denied.has(r)) return false; // 用户明确拒绝过且已持久化：静默保持未授权，不再追问
  // denyRoot 同时登记解析路径与 realpath：这里也两种写法都查，否则改经符号链接写法访问同一库会重复弹框
  try { if (denied.has(fs.realpathSync(r))) return false; } catch {}
  if (askedRoots.has(r)) return false;
  askedRoots.add(r);
  try {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: `允许 Deep Notes 访问该文件夹？\n${r}`,
      detail: '只有你亲自选择过的文件夹才会被授权为知识库根目录，允许后将永久记住这个选择。'
        + '\nOnly folders you personally picked can be used as the vault root.',
      buttons: ['允许 Allow', '拒绝 Deny'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) { authorizeRoot(r); return true; }
    // 只有点「拒绝」按钮（response===1）才持久化拒绝；按 ESC / 点关闭按钮同样返回 cancelId，
    // 但那只是「现在不想决定」——记成永久拒绝后该库 403 且无界面解除通道，误按一次就废了
    if (response === 1) denyRoot(r); // 拒绝也记下来：否则每次启动都对同一目录重复追问
  } catch {}
  return false;
}

const SKIP = new Set(['.obsidian', '.trash', '.git', '.DS_Store', 'node_modules']);

// —— 写序号守卫：同一路径的写盘按发起序号排队，过期的迟到写（慢盘上的在途 IPC）不得覆盖
// 已用更新版本落盘的文件（渲染层退出同步通道已在主进程内写完新版，迟到的异步旧写被拦下）。
const writeEpochs = new Map(); // 键 = 解析后的绝对路径
function writeGuard(full, epoch) {
  if (!epoch) return null; // 旧客户端不带序号：维持原行为
  // 序号必须是有限数：NaN 与一切比较恒为 false（守卫静默失效），超大值会让该路径此后
  // 所有合法写入被误判过期且渲染层按成功处理——畸形序号一律按「无守卫」放行本写
  const num = Number(epoch);
  if (!Number.isFinite(num) || num <= 0) return null;
  const key = path.resolve(String(full));
  const latest = writeEpochs.get(key) || 0;
  // 记录的序号比当前墙钟还大：上次落盘后时钟被回拨（NTP 校正 / 手动改时间），序号基准
  // 已失效——不收敛的话，渲染层重载后（lastEpoch 归零、以回拨后的墙钟为基准）所有新写
  // 都会被误判成「迟到的旧写」静默跳过，且渲染层按成功处理、不留底。以本次写为新基准继续。
  if (latest > Date.now()) { writeEpochs.set(key, num); return null; }
  if (num < latest) return '已有更新的版本落盘，本次过期写入已跳过';
  writeEpochs.set(key, num);
  return null;
}

// —— 原子写入：先写同目录隐藏临时文件，再 rename 到位 ——
// 写一半崩溃 / 断电时要么是完整旧文件、要么是完整新文件，不会留下截断的半截 .md。
// 临时文件以 . 开头：readMd 与 vault:asset 都会跳过，永远不会被当成笔记读出来。
async function atomicWrite(full, body, guard) {
  const tmp = path.join(path.dirname(full), '.' + path.basename(full) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  // 覆盖已有文件时沿用原权限：临时文件默认 0644，rename 换 inode 后用户手动收紧的
  // 权限（如 chmod 600）会被静默放宽
  let mode = 0o666;
  try { mode = (await fsp.stat(full)).mode & 0o777; } catch {}
  // open + sync + close：数据落盘后才 rename（断电也不会出现「rename 完成但内容还在页缓存」的空文件）；
  // close 放 finally——写失败也不能漏关句柄，fd 泄漏积多了进程再也打不开文件
  try {
    const fh = await fsp.open(tmp, 'w', mode);
    try {
      await fh.writeFile(typeof body === 'string' ? String(body ?? '') : (body ?? Buffer.alloc(0)), typeof body === 'string' ? 'utf8' : undefined);
      await fh.sync();
    } finally {
      await fh.close().catch(() => {});
    }
    // rename 前最后一刻再过一次序号守卫：写盘期间退出同步通道可能已用更新版本落盘，
    // 迟到的旧版本绝不能盖上去（guard 为同步函数，与 sendSync 处理器的执行不会交错）
    if (guard && guard()) { await fsp.unlink(tmp).catch(() => {}); return 'stale'; }
    await fsp.rename(tmp, full);
    return null;
  } catch (err) {
    // 任何一步失败都要清掉临时文件：写失败 / fsync 失败 / rename 失败都不在库里留残渣
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

// —— 拒绝不完整覆盖：空内容不允许覆盖已有文件 ——
// 正常序列化结果必带 deepnotes-id frontmatter：带这个标识的「空」是用户主动清空正文，放行写入；
// 连标识都没有的纯空串只可能来自上游 bug 或数据损坏，此时宁可拒写保住盘上原文。
function rejectIncomplete(full, body) {
  const s = String(body);
  if (s.trim()) return null;
  if (/^---\r?\n[\s\S]*\bdeepnotes-id:/.test(s)) return null;
  try { if (fs.existsSync(full) && fs.statSync(full).size > 0) return '拒绝用空内容覆盖已有文件'; } catch {}
  return '拒绝写入空文件';
}

// —— 写前快照（「文件恢复」网，对标 Obsidian 的 File Recovery）——
// 本应用每次覆盖库内已有文件前，若旧内容与本次写入不同，先把旧内容存进 userData 的快照库
// （在知识库文件夹之外，不进 .trash，也不会被知识库同步读走）。时序防线再严密也可能有漏网
// （双编辑器并发、未来的新代码路径），快照网保证任何被本应用覆盖掉的版本都能从恢复界面捞回来。
// 按内容去重（与该文件最新一份快照相同就跳过）+ 每文件最多 30 份 + 超过 7 天自动清理；
// 快照失败绝不阻塞写入本身。vault:snapshots / vault:snapshot-read 供恢复界面列出与读取。
const SNAP_TTL = 7 * 24 * 60 * 60 * 1000;
const SNAP_KEEP = 30; // 每文件最多保留份数（超出删最旧）
const SNAP_LIST_MAX = 400; // 恢复界面单次列出的条数上限（新到旧）
function snapDirFor(root) {
  // 按库根目录哈希分目录：多库互不混放，路径里的特殊字符也不进文件系统
  const key = crypto.createHash('sha1').update(path.resolve(String(root))).digest('hex').slice(0, 12);
  return path.join(app.getPath('userData'), 'file-snapshots', key);
}
// 每进程最多一天触发一次全局清理（不再用 snapPruned 布尔值 → 长期运行会失效）。
let snapLastPrune = 0;
const SNAP_PRUNE_INTERVAL = 24 * 60 * 60 * 1000;
async function pruneSnapshots(dir, now, isRoot = true) { // 超期清理 + 空目录清理（审计 B3）
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await pruneSnapshots(p, now, false); continue; }
    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > SNAP_TTL) await fsp.rm(p, { force: true });
    } catch {}
  }
  if (!isRoot) {
    try { const remain = await fsp.readdir(dir); if (remain.length === 0) await fsp.rmdir(dir); } catch {}
  }
}
// 快照文件名后缀是毫秒时间戳（同毫秒再追加 -1/-2）：按解析出的数值排序，
// 不能按字符串排——「-」排在「.」前面会把 stem_123-1.md 当成比 stem_123.md 更旧/更新。
const snapNum = n => { const m = n.match(/_(\d{13,})(?:-(\d+))?\.md$/); return m ? [+m[1], +(m[2] || 0)] : [0, 0]; };
const sortSnapNames = names => names.sort((a, b) => { const [ta, ia] = snapNum(a), [tb, ib] = snapNum(b); return ta - tb || ia - ib; });
async function capSnapshots(dir) { // 单个文件的快照超额删最旧：按原文件（stem）分组，每组最多 SNAP_KEEP 份
  // 不能按目录合并计数：快照目录镜像库目录，同目录里所有笔记的快照混在一起，
  // 按目录限额会让同目录第 31 篇笔记的首次快照挤掉最早那篇的唯一快照
  let names = [];
  try { names = sortSnapNames((await fsp.readdir(dir)).filter(n => n.endsWith('.md'))); } catch { return; }
  const stemOf = n => n.replace(/_\d{13,}(?:-\d+)?\.md$/, '');
  const perStem = new Map();
  for (const n of names) {
    const s = stemOf(n);
    if (!perStem.has(s)) perStem.set(s, []);
    perStem.get(s).push(n); // names 已按时间升序，组内天然有序
  }
  for (const arr of perStem.values()) {
    if (arr.length <= SNAP_KEEP) continue;
    for (const n of arr.slice(0, arr.length - SNAP_KEEP)) await fsp.rm(path.join(dir, n), { force: true }).catch(() => {});
  }
}
function uniqueSnapPath(dir, stem, ts) { // 审计 B5：同毫秒多次写同一文件时追加递增后缀，避免互相覆盖
  let idx = 0;
  let dest = path.join(dir, stem + '_' + ts + '.md');
  while (true) {
    try { fs.statSync(dest); dest = path.join(dir, stem + '_' + ts + '-' + (++idx) + '.md'); } catch { break; }
  }
  return dest;
}
async function snapshotBeforeWrite(root, full, body) {
  try {
    let old = null;
    try { old = await fsp.readFile(full, 'utf8'); } catch { return; } // 新文件（首次创建）无需快照
    if (String(old) === String(body)) return; // 内容没变不拍
    const dir = snapDirFor(root);
    const now = Date.now();
    // 审计 B5：追加后缀防毫秒级同名覆盖
    const dest = uniqueSnapPath(dir, path.relative(path.resolve(String(root)), path.resolve(full)).replace(/\.(md|markdown)$/i, ''), now);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // 内容去重：与本文件最新一份快照相同就跳过（连续保存只留真正变化过的版本）
    const stem = path.basename(dest).replace(/_\d{13,}(?:-\d+)?\.md$/, '');
    let names = [];
    try { names = sortSnapNames((await fsp.readdir(path.dirname(dest))).filter(n => n.startsWith(stem + '_') && n.endsWith('.md'))); } catch {}
    if (names.length) {
      try { if ((await fsp.readFile(path.join(path.dirname(dest), names[names.length - 1]), 'utf8')) === String(old)) return; } catch {}
    }
    await fsp.writeFile(dest, String(old), 'utf8');
    capSnapshots(path.dirname(dest)).catch(() => {});
    if (now - snapLastPrune > SNAP_PRUNE_INTERVAL) {
      snapLastPrune = now;
      // 审计 B1：改成周期性清理，不再只跑一次；B3：整棵快照树都扫（旧库残留一并清）
      pruneSnapshots(path.join(app.getPath('userData'), 'file-snapshots'), now, true).catch(() => {});
    }
  } catch {} // 快照是保底网，自身故障不能影响正常写盘
}
function snapshotBeforeWriteSync(root, full, body) { // 退出同步通道用：同步 fs，不能 await（审计 B2）
  try {
    let old = null;
    try { old = fs.readFileSync(full, 'utf8'); } catch { return; }
    if (String(old) === String(body)) return;
    const dir = snapDirFor(root);
    const dest = uniqueSnapPath(dir, path.relative(path.resolve(String(root)), path.resolve(full)).replace(/\.(md|markdown)$/i, ''), Date.now());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 内容去重：同步版直接读最新快照文件对比（取目录里排序最末一份）
    const stem = path.basename(dest).replace(/_\d{13,}(?:-\d+)?\.md$/, '');
    try {
      const names = sortSnapNames(fs.readdirSync(path.dirname(dest)).filter(n => n.startsWith(stem + '_') && n.endsWith('.md')));
      if (names.length && fs.readFileSync(path.join(path.dirname(dest), names[names.length - 1]), 'utf8') === String(old)) return;
    } catch {}
    fs.writeFileSync(dest, String(old), 'utf8');
    // 退出通道不能 await，但仍然可以异步抛一份 capSnapshots（同步写入已落盘，后续清理不影响）
    capSnapshots(path.dirname(dest)).catch(() => {});
  } catch {}
}

// 自底向上清理空目录：只沿受影响的目录链（被删/被写文件所在目录 → 根目录）走，
// 链上某一层还占有内容就停。根目录永不删；. 开头的目录（.trash / .obsidian 等）算占用不删。
async function pruneUp(root, dir) {
  let cur = path.resolve(dir);
  const r = path.resolve(root) + path.sep;
  while (cur.startsWith(r)) {
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { break; }
    // 隐藏文件（如 .DS_Store）不算占用：目录里只剩它们也视为空（rmdir 会自然失败兜底）
    const occupied = entries.some(e => e.isDirectory() || !e.name.startsWith('.'));
    if (occupied) break;
    try { await fsp.rmdir(cur); } catch { break; }
    cur = path.dirname(cur);
  }
}

async function readMd(root) {
  const out = [];
  const unreadable = []; // 存在但读不出内容（iCloud / 网盘未下载、权限不足等）
  // 上层必须把 unreadable 与「文件不存在」区分开：把读不到当删除写回，会把云盘文件真删掉
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // iCloud 未下载的文件在盘上是「.原名.icloud」占位（带前导点）：不能当成不存在——
      // 上层靠 unreadable 区分「读不到」与「已删除」，漏报会把云盘文件当成删除写回、真删掉
      const cloud = e.name.match(/^\.+(.+)\.icloud$/i);
      if (cloud && /\.(md|markdown)$/i.test(cloud[1])) {
        unreadable.push(path.relative(root, path.join(dir, cloud[1])).split(path.sep).join('/'));
        continue;
      }
      // iCloud 也可把整层文件夹卸成「.目录名.icloud」占位文件：里面所有笔记都读不到。
      // 占位与文件同名同构（无法区分「目录占位」与「无扩展名文件占位」），按启发式处理：
      // 带扩展名的是资源占位（图片/PDF 等，与笔记同步无关）静默跳过；不带扩展名的按目录占位
      // 计入 unreadable（尾部带 '/' 前缀标记），上层 keepOld 按前缀保护整层内容不被误删。
      if (cloud) {
        if (!/\.[a-z0-9]{1,10}$/i.test(cloud[1])) {
          unreadable.push(path.relative(root, path.join(dir, cloud[1])).split(path.sep).join('/') + '/');
        }
        continue;
      }
      if (e.name.startsWith('.') || SKIP.has(e.name)) {
        // 隐藏目录但非 iCloud 占位：静默跳过（.obsidian / .trash 等）
        if (!e.isDirectory() && e.isFile() && /^\..+\.tmp-/.test(e.name)) {
          // 顺手清掉上次崩溃残留的写入临时文件：正在写的临时文件很新，超过 1 小时的一定是残留
          const p = path.join(dir, e.name);
          try { const st = await fsp.stat(p); if (Date.now() - st.mtimeMs > 60 * 60 * 1000) await fsp.rm(p, { force: true }); } catch {}
        }
        continue;
      }
      const full = path.join(dir, e.name);
      // 库内符号链接（用户的组织方式）不跟随、不读取，也绝不能被同步按「已删除」移进 .trash：
      // 计作 unreadable 让上层 keepOld 原样保留
      if (e.isSymbolicLink()) {
        if (/\.(md|markdown)$/i.test(e.name)) unreadable.push(path.relative(root, full).split(path.sep).join('/'));
        continue;
      }
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) { // 与软件内导入 isMd 同口径
        const relPath = path.relative(root, full).split(path.sep).join('/');
        try {
          // mtime 一并带回：无 date frontmatter 的内容导入时按文件修改时间定日期，
          // 否则桌面端导入/同步会把日期全算成「导入那一刻」，且跨天重算导致无谓 adopt
          const [body, st] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
          out.push({ relPath, body, mtimeMs: st.mtimeMs || 0 });
        } catch { unreadable.push(relPath); }
      }
    }
  }
  await walk(root);
  return { files: out, unreadable };
}

ipcMain.handle('vault:choose-dir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  const picked = res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  if (picked) authorizeRoot(picked); // 用户亲自选过的目录登记进授权白名单（M1）
  return picked;
});

ipcMain.handle('vault:read', async (_e, root) => {
  try {
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    return { ok: true, ...await readMd(root) };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('vault:write', async (_e, { root, rel, body, epoch }) => {
  try {
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    if (!rel) return { ok: false, error: '路径为空' }; // 与 flush-sync 同口径：空 rel 会让 full===root 借 t===r 混过 inside
    const full = path.join(root, rel);
    if (!inside(root, full)) return { ok: false, error: '路径越界' };
    if (isSymlink(full)) return { ok: false, error: '目标是符号链接，拒绝写入' };
    const stale = writeGuard(full, epoch);
    if (stale) return { ok: true, stale: true }; // 过期写按成功返回：内容已有更新版本，渲染层无需重试留底
    const blocked = rejectIncomplete(full, body);
    if (blocked) return { ok: false, error: blocked };
    await snapshotBeforeWrite(root, full, body); // 覆盖前把盘上旧内容存进恢复快照库（失败不阻塞写盘）
    await fsp.mkdir(path.dirname(full), { recursive: true });
    // rename 前再验一次：写盘期间退出同步通道可能已用更新版本落盘（序号更大），本次迟到写必须让位
    const guard = epoch ? () => (writeEpochs.get(path.resolve(full)) || 0) > epoch : null;
    const wr = await atomicWrite(full, body, guard);
    if (wr === 'stale') return { ok: true, stale: true };
    await pruneUp(root, path.dirname(full)).catch(() => {}); // 顺手清掉因改名/移动而空掉的目录
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// 图片落盘：按内容 sha1 存到 <root>/attachments/<前 2 位>/<sha1>.<ext>，同一张图只存一份。
// 粘贴 / 插图时计算内容哈希，命中已存在文件则直接返回同一路径，避免长文 .md 被 base64 反复撑大。
ipcMain.handle('vault:saveAsset', async (_e, { root, name, mime, data }) => {
  try {
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    // 扩展段禁「点」防 .. 上跳，也必须禁「/」「\」：'xx.png/a/b' 会借 path.join 在
    // attachments 下建出任意深度的嵌套目录，'.md' 尾巴还会产出一个会被 readMd 当笔记读的假文件
    if (/[/\\]/.test(String(name || ''))) return { ok: false, error: '非法资源名' };
    const sha = String(name || '').replace(/\.[^.]+$/, '');
    if (!/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, error: '非法资源名' };
    if (!/^[[\]a-z0-9]{1,12}$/i.test((String(name).match(/\.([^.]+)$/)?.[1]) || '')) return { ok: false, error: '非法资源名' };
    const sub = sha.slice(0, 2);
    const rel = path.posix.join('attachments', sub, name);
    const full = path.join(root, rel);
    if (!inside(root, full)) return { ok: false, error: '路径越界' };
    if (isSymlink(full)) return { ok: false, error: '目标是符号链接，拒绝写入' };
    try { if (await fsp.stat(full)) return { ok: true, rel }; } catch {} // 已存在：直接复用
    const bin = Buffer.from(String(data || ''), 'base64');
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await atomicWrite(full, bin); // 与正文写盘同口径：原子写入，崩溃不留半截图片
    return { ok: true, rel };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// 原子移动 / 重命名：rename 在同一卷内是原子操作。重命名不再拆成「先 trash 旧路径、
// 再 write 新路径」两步——中间任何一步失败（磁盘满、权限、进程被杀）旧文件已在回收站、
// 新文件又没写成，内容就真没了；改走 move 后要么成功、要么旧文件原封不动留在原处，
// 且改名不再往 .trash 塞副本（回收站里只剩用户主动删除的内容）。
ipcMain.handle('vault:move', async (_e, { root, from, to }) => {
  try {
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const a = path.join(root || '', String(from || ''));
    const b = path.join(root || '', String(to || ''));
    if (!root || !from || !to || !inside(root, a) || !inside(root, b)) return { ok: false, error: '路径越界' };
    if (isSymlink(a) || isSymlink(b)) return { ok: false, error: '目标是符号链接，拒绝移动' };
    // rename 会静默覆盖已存在的目标：源还在时，先把「改到已有文件名上」拦下来，否则另一篇内容会被顶掉；
    // 源已不在（ENOENT）按「已移走」放行——重试时目标自然已在，同样视为成功，不误报失败
    let srcExists = true;
    try { srcExists = !!(await fsp.stat(a)); } catch { srcExists = false; }
    if (srcExists) {
      let targetExists = false;
      try { targetExists = !!(await fsp.stat(b)); } catch {}
      if (targetExists) {
        // 大小写不敏感文件系统（macOS APFS / Windows NTFS）上「仅改大小写」的改名会 stat 到源文件本身，
        // 按「目标已存在」误拒会让这类改名永远失败——同一 inode（或同一路径）时放行 rename。
        // (ino || dev) 防 Windows 等平台两值恒 0 时任意两个文件都被判成同一文件
        let sameFile = a === b;
        if (!sameFile) {
          try { const sa = await fsp.stat(a), sb = await fsp.stat(b); sameFile = sa.ino === sb.ino && sa.dev === sb.dev && !!(sa.ino || sa.dev); } catch {}
        }
        if (!sameFile) return { ok: false, error: '目标已存在，拒绝覆盖' };
      }
    }
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b).catch(err => { if (err?.code === 'ENOENT') return; throw err; }); // 源本就不存在视为已移走
    await pruneUp(root, path.dirname(a)).catch(() => {}); // 源目录空了就删掉，不留空文件夹
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// 导出：把渲染层给出的 [{rel, body}] 批量写入所选目录（同样限制在该目录内）。
ipcMain.handle('vault:export', async (_e, { root, files }) => {
  try {
    if (!(await ensureAuthorized(root))) return { ok: false, error: '目标文件夹未授权 · Folder not authorized' };
    if (!Array.isArray(files)) return { ok: false, error: '参数错误' };
    for (const f of files) {
      const full = path.join(root, f.rel);
      if (!inside(root, full)) return { ok: false, error: '路径越界' };
      if (isSymlink(full)) return { ok: false, error: `${f.rel}: 目标是符号链接，拒绝写入` };
      const blocked = rejectIncomplete(full, f.body);
      if (blocked) return { ok: false, error: `${f.rel}: ${blocked}` };
      await snapshotBeforeWrite(root, full, f.body); // 导出覆盖同路径文件前也留快照
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await atomicWrite(full, f.body);
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// .trash 超期清理：回收站里超过 30 天的文件自动删除，防止只增不减。失败静默（下次触发再清）。
const TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
async function pruneTrash(root) {
  const trashDir = path.join(root, '.trash');
  let entries;
  try { entries = await fsp.readdir(trashDir, { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const e of entries) {
    const p = path.join(trashDir, e.name);
    try {
      const st = await fsp.stat(p);
      // rename 进回收站不刷新 mtime：老文件刚被删时 mtime 仍是数周前，按 mtime 判定会被当场物理清除。
      // 取 mtime 与 ctime 的较新者——ctime 会被 rename 刷新，回收期从「进回收站那一刻」起算。
      if (now - Math.max(st.mtimeMs || 0, st.ctimeMs || 0) > TRASH_TTL) {
        await fsp.rm(p, { recursive: true, force: true });
        // 清理留痕：误删找回的最后一点线索（文件名与被清时间）
        await fsp.appendFile(path.join(trashDir, '.cleanup.log'),
          `${new Date().toISOString()} 清理超期回收站文件 · pruned ${e.name}\n`).catch(() => {});
      }
    } catch {}
  }
}

ipcMain.handle('vault:trash', async (_e, { root, rel }) => {
  try {
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const full = path.join(root, rel);
    if (!inside(root, full)) return { ok: false, error: '路径越界' };
    // 库内符号链接是用户的组织方式，readMd 已按 unreadable 保留其内容——trash 绝不能把
    // 符号链接本体移进 .trash（用户的库结构会被同步静默拆掉）
    if (isSymlink(full)) return { ok: false, error: '目标是符号链接，拒绝移入回收站' };
    const trashDir = path.join(root, '.trash');
    await fsp.mkdir(trashDir, { recursive: true });
    // 随机后缀避免同毫秒同名互相覆盖（先删的内容也要能找回）
    const dest = path.join(trashDir, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + path.basename(full));
    await fsp.rename(full, dest).catch(err => {
      if (err?.code === 'ENOENT') return; // 文件本就不存在，视为已删除
      throw err;
    });
    // 进站即刷新 mtime：回收期按「进回收站那一刻」起算。原本依赖 rename 刷新 ctime，
    // 但 exFAT / SMB / 旧内核 ext4 上 rename 不刷新 ctime，重挂载后还可能归零——
    // 老文件刚删就会被 pruneTrash 当场物理清除。主动 utimes 让 TTL 锚点不依赖文件系统行为
    const t = new Date();
    await fsp.utimes(dest, t, t).catch(() => {});
    await pruneUp(root, path.dirname(full)).catch(() => {}); // 文件移走后目录空了就删掉，不在库里留空文件夹
    pruneTrash(root).catch(() => {}); // 顺手清掉超期的回收站文件
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// 退出前同步落盘：beforeunload 里异步 invoke 不可靠（页面可能先卸载、回调永远不来），
// 渲染层用 sendSync 调这里，主进程用同步 fs 一次写完才放行关闭。
// 与 vault:write / vault:move / vault:trash 同一套越界与拒绝空写规则；队列结构见渲染层 fileStore.js。
ipcMain.on('vault:flush-sync', (e, ops) => {
  const failed = [];
  for (const op of (Array.isArray(ops) ? ops : [])) {
    const rel = String(op?.rel || op?.from || '');
    // 同步通道不能弹确认框：只做白名单校验（退出前此刻的 root 一定来自授权过的库）
    if (!rootAuthorized(op?.root)) { failed.push(rel); continue; }
    try {
      if (op?.move) {
        // 与 vault:move 相同的原子移动：退出前一刻的重命名也不走「先 trash 再写」
        const a = path.join(op?.root || '', String(op.from || ''));
        const b = path.join(op?.root || '', String(op.to || ''));
        if (!op?.root || !op.from || !op.to || !inside(op.root, a) || !inside(op.root, b) || isSymlink(a) || isSymlink(b)) { failed.push(rel); continue; }
        // 与 vault:move 相同的目标存在检查（源还在时才拦）：退出前的 rename 也不能静默顶掉已有文件；
        // 源已不在按「已移走」放行，重试不误报
        let srcExists = true;
        try { srcExists = fs.existsSync(a); } catch { srcExists = false; }
        if (srcExists) {
          let exists = false;
          try { exists = fs.existsSync(b); } catch {}
          if (exists) {
            // 与 vault:move 同一口径：大小写不敏感 FS 上的纯大小写改名（同一 inode）放行
            let sameFile = a === b;
            if (!sameFile) {
              try { const sa = fs.statSync(a), sb = fs.statSync(b); sameFile = sa.ino === sb.ino && sa.dev === sb.dev && !!(sa.ino || sa.dev); } catch {}
            }
            if (!sameFile) { failed.push(rel); continue; }
          }
        }
        fs.mkdirSync(path.dirname(b), { recursive: true });
        try { fs.renameSync(a, b); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
        pruneUp(op.root, path.dirname(a)).catch(() => {});
        continue;
      }
      const full = path.join(op?.root || '', rel);
      if (!op?.root || !rel || !inside(op.root, full)) { failed.push(rel); continue; }
      if (op.trash) {
        if (isSymlink(full)) { failed.push(rel); continue; } // 与 vault:trash 同口径：符号链接不进回收站
        const trashDir = path.join(op.root, '.trash');
        fs.mkdirSync(trashDir, { recursive: true });
        const dest = path.join(trashDir, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + path.basename(full));
        try { fs.renameSync(full, dest); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
        // 与异步通道同口径：进站刷新 mtime，回收期不依赖文件系统的 ctime 行为
        try { const t = new Date(); fs.utimesSync(dest, t, t); } catch {}
        pruneUp(op.root, path.dirname(full)).catch(() => {});
      } else {
        if (isSymlink(full)) { failed.push(rel); continue; }
        const stale = writeGuard(full, op?.epoch); // 同步通道也是一次写：过期序号不能回滚新内容
        if (stale) continue; // 过期写按成功处理：不列入 failed，渲染层不会留底重试
        const blocked = rejectIncomplete(full, op.body);
        if (blocked) { failed.push(rel); continue; }
        snapshotBeforeWriteSync(op.root, full, op.body); // 退出写盘前的最后一道快照
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const tmp = path.join(path.dirname(full), '.' + path.basename(full) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
        // 与 atomicWrite 同一套落盘纪律：沿用原文件权限、fsync 后 rename，句柄 finally 关闭；失败清临时文件
        let mode = 0o666;
        try { mode = fs.statSync(full).mode & 0o777; } catch {}
        try {
          const fd = fs.openSync(tmp, 'w', mode);
          try { fs.writeSync(fd, String(op.body ?? ''), null, 'utf8'); fs.fsyncSync(fd); }
          finally { try { fs.closeSync(fd); } catch {} }
          fs.renameSync(tmp, full);
        } catch (err) { try { fs.unlinkSync(tmp); } catch {} throw err; }
      }
    } catch { failed.push(rel); }
  }
  e.returnValue = { ok: failed.length === 0, failed };
});

// —— 文件恢复：列出某库的写前快照（恢复界面数据源）——
// 快照目录结构与库内目录一一对应，文件名 = 原文件名去 .md + _毫秒时间戳。
// file 供 vault:snapshot-read 使用（快照目录内相对路径），rel 还原出原库相对路径。
ipcMain.handle('vault:snapshots', async (_e, { root }) => {
  try {
    if (!root) return { ok: false, error: '参数错误' };
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const base = snapDirFor(root);
    const list = [];
    async function walk(dir) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(p); continue; }
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        // 同毫秒的多份快照带 -1/-2 后缀：一并列出，rel 去掉整个后缀（否则会显示成 xxx-1.md）
        const m = e.name.match(/_(\d{13,})(?:-(\d+))?\.md$/);
        if (!m) continue;
        const file = path.relative(base, p).split(path.sep).join('/');
        list.push({ file, ts: Number(m[1]), seq: Number(m[2] || 0), rel: file.replace(/_\d{13,}(?:-\d+)?\.md$/, '.md') });
      }
    }
    await walk(base);
    list.sort((a, b) => b.ts - a.ts || b.seq - a.seq); // 新的在前
    return { ok: true, list: list.slice(0, SNAP_LIST_MAX) };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// —— 文件恢复：读取一份快照内容（同样只许读快照目录内、且不许借符号链接越界）——
ipcMain.handle('vault:snapshot-read', async (_e, { root, file }) => {
  try {
    if (!root || !file) return { ok: false, error: '参数错误' };
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const base = snapDirFor(root);
    const full = path.join(base, String(file));
    if (!inside(base, full)) return { ok: false, error: '路径越界' };
    if (isSymlink(full)) return { ok: false, error: '路径越界' };
    return { ok: true, body: await fsp.readFile(full, 'utf8') };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// API Key 本机加密存储（safeStorage：macOS Keychain / Windows DPAPI / Linux libsecret）。
// 明文只在 IPC 里走一趟，localStorage 落盘的是 base64 密文；加密不可用时返回 ok:false，渲染层自行回退。
ipcMain.handle('key-encrypt', (_e, plain) => {
  try {
    if (!plain || !safeStorage?.isEncryptionAvailable()) return { ok: false };
    return { ok: true, data: safeStorage.encryptString(String(plain)).toString('base64') };
  } catch { return { ok: false }; }
});
ipcMain.handle('key-decrypt', (_e, b64) => {
  try {
    if (!b64 || !safeStorage?.isEncryptionAvailable()) return { ok: false };
    return { ok: true, data: safeStorage.decryptString(Buffer.from(String(b64), 'base64')) };
  } catch { return { ok: false }; }
});

// 在原知识库旁新建「<原名> - Deep Notes」副本目录，原库内容不动；重名自动加序号。
// 文件夹本身已带「 - Deep Notes」后缀（Deep Notes 专属库）：直接作为工作库使用，不再复制副本。
// 副本只带走图片 / PDF 等小体积资源（.md 正文里的 ![[图片]] 引用才能正常显示）；
// 视频不复制——课程视频动辄数百 MB，复制进 iCloud 副本等于整库体积翻倍，
// 播放时由 findAsset 回退到原始库只读读取（见下方 sourceRootOf）。
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf)$/i;
// 单文件 512MB 上限：源库里数 GB 的扫描版 PDF 会让 prepare-copy 长时间无反馈、副本体积翻倍。
// 超限跳过并计数回报；正文引用该文件时由 findAsset 回退源库只读读取，内容不丢
const ASSET_CAP = 512 * 1024 * 1024;
async function copyAssets(src, dest, state = {skipped: 0}) {
  let entries;
  try { entries = await fsp.readdir(src, { withFileTypes: true }); } catch { return state; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { await fsp.mkdir(d, { recursive: true }); await copyAssets(s, d, state); }
    else if (e.isFile() && ASSET_RE.test(e.name)) {
      const st = await fsp.stat(s).catch(() => null);
      if (!st || st.size > ASSET_CAP) { state.skipped++; continue; }
      await fsp.copyFile(s, d).catch(() => {});
    }
  }
  return state;
}

ipcMain.handle('vault:prepare-copy', async (_e, srcRoot) => {
  try {
    // 来源目录必须是授权过的（M1）：副本会从 srcRoot 复制资源文件，未授权目录不能当来源
    if (!(await ensureAuthorized(srcRoot))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const resolved = path.resolve(srcRoot);
    if (/ - Deep Notes$/i.test(path.basename(resolved))) {
      // 审计 v2-②：不再自动登记白名单——「只授权用户亲自确认过的目录」没有例外，
      // 首次访问该目录时同样会弹一次系统确认框
      return { ok: true, dir: resolved, reused: true };
    }
    const parent = path.dirname(resolved);
    const base = path.basename(resolved) + ' - Deep Notes';
    let dir = path.join(parent, base);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(parent, `${base} ${i}`);
    await fsp.mkdir(dir, { recursive: true });
    const {skipped} = await copyAssets(resolved, dir);
    // 审计 v2-②：新副本不再自动登记授权白名单——导入后的首次读取会触发一次系统确认框，
    // 允许后永久记住；自动授权点会让「只授权用户亲自选过的目录」形同虚设
    return { ok: true, dir, skippedAssets: skipped || undefined };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// 读知识库内的图片等资源 → base64（阅读视图渲染 ![[名字]] 与相对路径引用图）。
// ref 可以是相对路径，也可以只是文件名（Obsidian 的 ![[文件名]] 不带路径）：找不到就按文件名全库搜。
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ogv': 'video/ogg', '.ogg': 'video/ogg'};

// 「<原名> - Deep Notes」工作库对应的原始库：导入时用户亲自选过的那个目录。
// 视频不随副本复制，播放时回退到这里只读读取；名字必须精确对应，符号链接目录一律不认。
function sourceRootOf(root) {
  const abs = path.resolve(String(root || ''));
  const m = path.basename(abs).match(/^(.*) - Deep Notes$/i); // 与 prepare-copy 的复用判断同口径（大小写不敏感）
  if (!m || !m[1]) return null;
  const sib = path.join(path.dirname(abs), m[1]);
  try {
    const st = fs.lstatSync(sib); // lstat：符号链接不跟随
    if (st.isDirectory()) return sib;
  } catch {}
  return null;
}

// 按文件名全库搜（跳过隐藏文件与应用目录）。目录读不到（iCloud 未下载等）静默跳过。
// 比较前统一 NFC：macOS 盘上文件名可能是 NFD，正文引用通常是 NFC，码点相等但字节不等会误判找不到
async function walkByName(dir, base) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = await walkByName(f, base);
      if (r) return r;
    } else if (e.isFile() && e.name.normalize('NFC').toLowerCase() === base) return f;
  }
  return null;
}

// 解析一个资源引用：先按相对路径直找工作库（每次现算，工作库后放的同名文件优先于旧缓存），
// 再按文件名全库搜；工作库找不到时回退原始库。命中结果缓存在 ASSET_CACHE（键 = 工作库 + 引用，
// LRU 上限封顶），命中后仍校验文件存在与符号链接，失效自动重找。
const ASSET_CACHE = new Map();
const ASSET_CACHE_MAX = 256;
function assetCacheSet(key, val) {
  ASSET_CACHE.delete(key); // 重新插入刷新新鲜度（LRU：最旧的先淘汰）
  ASSET_CACHE.set(key, val);
  while (ASSET_CACHE.size > ASSET_CACHE_MAX) ASSET_CACHE.delete(ASSET_CACHE.keys().next().value);
}
// 命中校验：是文件、不是符号链接、且真实路径仍在某个搜索根内（审计 A1：库内 symlink 指向库外
// 时 inside 已按真实路径拦截，这里再显式拒绝 symlink 本体，与写类 IPC / 快照读取的口径一致）
function assetOk(p, roots) {
  try {
    if (isSymlink(p) || !fs.statSync(p).isFile()) return false;
    return roots.some(r => inside(r, p));
  } catch { return false; }
}
async function findAsset(root, ref) {
  const clean = String(ref || '').replace(/^\.?\//, '');
  if (!root || !clean) return null;
  const roots = [path.resolve(root)];
  // 回退原始库同样要过授权白名单：「目录名对得上」不等于「用户确认过」（审计 A2，
  // 与 v2-②「只授权用户亲自确认过的目录」同一口径；正常导入的源库经系统对话框选过，必然已登记）
  const src = sourceRootOf(root);
  if (src && src !== roots[0] && rootAuthorized(src)) roots.push(src);
  const key = roots[0] + '|' + clean;
  const base = path.basename(clean).normalize('NFC').toLowerCase();
  // 审计 B4：工作库直找永远先于缓存——缓存里可能躺着「源库同名文件」的旧命中，
  // 工作库后来放的真身必须优先被找到（直找只是一次 statSync，代价可忽略）
  const direct0 = path.resolve(roots[0], clean);
  if (assetOk(direct0, roots)) { assetCacheSet(key, direct0); return direct0; }
  const cached = ASSET_CACHE.get(key);
  if (cached) {
    if (assetOk(cached, roots)) return cached;
    ASSET_CACHE.delete(key);
  }
  for (const r of roots) {
    const direct = path.resolve(r, clean);
    if (assetOk(direct, roots)) { assetCacheSet(key, direct); return direct; }
    const found = await walkByName(r, base);
    if (found && assetOk(found, roots)) { assetCacheSet(key, found); return found; }
  }
  return null;
}

// Range 解析：视频 seek 靠它。bytes=a-b / bytes=a- / bytes=-n；非法返回 'invalid'。
function parseByteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return {start, end};
}

// deepnotes-asset://asset/?root=<库根>&ref=<引用>：只读、只认已授权根目录，
// 工作库与原始库都经 inside 校验；返回流式响应（不把整个文件读进内存）。
async function streamAsset(req) {
  try {
    const u = new URL(req.url);
    const root = u.searchParams.get('root') || '';
    const ref = u.searchParams.get('ref') || '';
    // 协议请求没有 UI 上下文，不能弹授权框：只认已授权目录（导入时已登记）
    if (!rootAuthorized(root)) return new Response('', {status: 403});
    const full = await findAsset(root, ref);
    if (!full) return new Response('', {status: 404});
    // 只放行白名单里的资源类型：协议是渲染层可直达的入口，不能顺手把 .js / .json 之类
    // 库内任意文件也当资源吐出去（虽然本应用自己不会请求，但注入面越小越好）
    const mime = MIME[path.extname(full).toLowerCase()];
    if (!mime) return new Response('', {status: 415});
    const st = await fsp.stat(full);
    const headers = {'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache'};
    const range = parseByteRange(req.headers.get('range'), st.size);
    if (range === 'invalid') return new Response('', {status: 416, headers: {'Content-Range': `bytes */${st.size}`}});
    if (range) {
      return new Response(Readable.toWeb(fs.createReadStream(full, {start: range.start, end: range.end})), {
        status: 206,
        headers: {...headers, 'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`},
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(full)), {
      status: 200, headers: {...headers, 'Content-Length': String(st.size)},
    });
  } catch { return new Response('', {status: 500}); }
}

ipcMain.handle('vault:asset', async (_e, { root, ref }) => {
  try {
    if (!root || !ref) return { ok: false, error: '参数错误' };
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const full = await findAsset(root, ref);
    if (!full) return { ok: false, error: '找不到资源' };
    const mime = MIME[path.extname(full).toLowerCase()];
    if (!mime) return { ok: false, error: '不支持的格式' };
    // 视频走 deepnotes-asset:// 流式通道：base64 一部视频就几百 MB，绝不能走 IPC
    if (mime.startsWith('video/')) return { ok: false, error: '视频请走流式通道' };
    // 体积上限：图片 / PDF 经 base64 走 IPC 会放大 4/3 倍并整读进内存——超大文件（数百 MB
    // 扫描版 PDF）直接拒读，渲染层显示占位而不是把两个进程的内存一起打满
    const ASSET_MAX = 64 * 1024 * 1024; // 64MB
    try { if ((await fsp.stat(full)).size > ASSET_MAX) return { ok: false, error: '文件过大（超 64MB），请直接到知识库文件夹查看' }; } catch {}
    const buf = await fsp.readFile(full);
    return { ok: true, mime, data: buf.toString('base64') };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// —— 应用级附属数据（闪念箱 / 概念定义 / 段落闪卡）：单个隐藏 JSON 文件随库走 ——
// 这些是用户手写的内容，但结构不适合写成普通 .md 笔记（会被导入成方法笔记），
// 所以放进库根下的 .deepnotes/meta.json：隐藏目录，readMd 与 Obsidian 都不会当成笔记读，
// 换机 / 重装后随知识库文件夹一起带走（localStorage 仍保留一份作为本地兜底）。
const META_REL = path.join('.deepnotes', 'meta.json');
ipcMain.handle('vault:meta-read', async (_e, root) => {
  try {
    if (!root) return {ok: false, error: '参数错误'};
    if (!(await ensureAuthorized(root))) return {ok: false, error: '知识库文件夹未授权 · Vault root not authorized'};
    const full = path.join(path.resolve(root), META_REL);
    if (!inside(root, full)) return {ok: false, error: '越界'};
    try { return {ok: true, data: JSON.parse(await fsp.readFile(full, 'utf8'))}; }
    catch (err) {
      if (err?.code === 'ENOENT') return {ok: true, data: null}; // 还没有 meta 文件：视为空
      // JSON 损坏必须如实报错：渲染层据此设 metaBlocked 绝不覆盖盘上文件；
      // 若静默当空返回，损坏的文件会被后续 patchMeta 用内存版本直接盖掉，盘上内容彻底丢失
      return {ok: false, error: 'meta.json 解析失败（文件可能已损坏）'};
    }
  } catch (err) { return {ok: false, error: String(err?.message || err)}; }
});
ipcMain.handle('vault:meta-write', async (_e, {root, data}) => {
  try {
    if (!root || !data) return {ok: false, error: '参数错误'};
    if (!(await ensureAuthorized(root))) return {ok: false, error: '知识库文件夹未授权 · Vault root not authorized'};
    const full = path.join(path.resolve(root), META_REL);
    if (!inside(root, full)) return {ok: false, error: '越界'};
    await fsp.mkdir(path.dirname(full), {recursive: true});
    await atomicWrite(full, JSON.stringify(data)); // 原子写：不会留下半截 JSON
    return {ok: true};
  } catch (err) { return {ok: false, error: String(err?.message || err)}; }
});
// 退出前的同步 meta 落盘：beforeunload 里异步 vault:meta-write 可能来不及执行，
// 走 sendSync 阻塞通道（与 vault:flush-sync 同口径：只校验白名单，不弹框）。
// 带 dirty（本会话改过的顶层键）时先同步重读盘上 meta 再只盖这些键——长驻会话直接整对象
// 覆盖会把另一台机器（iCloud 同步）本次会话的改动整块回滚；返回实际落盘的合并结果供渲染层对齐基线。
// 与渲染层 fileStore.mergeMetaList 同口径：本地为本会话权威，盘上多出来的条目（另一台机器
// 在本会话期间新增的闪念 / 分类）补进来；本会话删掉的（在 base 里）不复活。
const META_LIST_KEYS = new Set(['inbox', 'folders', 'readFolders']);
function mergeMetaList(local, disk, base) {
  const arr = Array.isArray(local) ? local.slice() : [];
  if (!Array.isArray(disk)) return arr;
  const keyOf = x => (x && typeof x === 'object' ? String(x.id ?? JSON.stringify(x)) : String(x));
  const localKeys = new Set(arr.map(keyOf));
  const baseKeys = new Set((Array.isArray(base) ? base : []).map(keyOf));
  for (const x of disk) {
    const k = keyOf(x);
    if (localKeys.has(k) || baseKeys.has(k)) continue;
    arr.push(x);
  }
  return arr;
}
ipcMain.on('vault:meta-write-sync', (e, {root, data, dirty, base} = {}) => {
  try {
    if (!root || !data || !rootAuthorized(root)) { e.returnValue = {ok: false, error: '未授权'}; return; }
    const full = path.join(path.resolve(root), META_REL);
    if (!inside(root, full)) { e.returnValue = {ok: false, error: '越界'}; return; }
    let payload = data;
    if (Array.isArray(dirty) && dirty.length) {
      let disk = {};
      try { const d = JSON.parse(fs.readFileSync(full, 'utf8')); if (d && typeof d === 'object' && !Array.isArray(d)) disk = d; } catch {}
      payload = {...disk};
      const b = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
      for (const k of dirty) if (Object.prototype.hasOwnProperty.call(data, k)) {
        payload[k] = META_LIST_KEYS.has(k) ? mergeMetaList(data[k], disk[k], b[k]) : data[k];
      }
    }
    fs.mkdirSync(path.dirname(full), {recursive: true});
    const tmp = full + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8); // 随机段：崩溃残留不与下次写互顶
    fs.writeFileSync(tmp, JSON.stringify(payload));
    try { const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); } catch {} // fsync 再 rename：断电不留空/截断的 meta.json
    fs.renameSync(tmp, full); // 原子替换，与 atomicWrite 同思路
    e.returnValue = {ok: true, data: payload};
  } catch (err) { e.returnValue = {ok: false, error: String(err?.message || err)}; }
});

// —— 知识库完整性校验：列出全部 .md，计算 sha256 与字节数，与渲染层传入的期望值比对 ——
// 返回 changed（盘上与记录不一致，疑似损坏或外部改写）、missing（盘上有但无记录）、
// extra（记录有但盘上无）。只报告、绝不自动覆盖盘上文件；修复需用户在恢复界面手动操作。
const MD_LIKE = /\.(md|markdown)$/i;
ipcMain.handle('vault:verifyIntegrity', async (_e, {root, expected}) => {
  try {
    if (!root) return {ok: false, error: '参数错误'};
    if (!(await ensureAuthorized(root))) return {ok: false, error: '知识库文件夹未授权 · Vault root not authorized'};
    const expect = new Map(Object.entries(expected || {}));
    const actual = new Map();
    async function walk(dir) {
      let entries;
      try { entries = await fsp.readdir(dir, {withFileTypes: true}); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(p); continue; }
        if (!e.isFile() || !MD_LIKE.test(e.name)) continue;
        const rel = path.relative(root, p).split(path.sep).join('/');
        const buf = await fsp.readFile(p);
        actual.set(rel, {sha: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length});
      }
    }
    await walk(root);
    const changed = [], missing = [], extra = [];
    for (const [rel, a] of actual) {
      const exp = expect.get(rel);
      if (!exp) missing.push(rel);
      else if (exp.sha !== a.sha) changed.push(rel);
    }
    for (const rel of expect.keys()) if (!actual.has(rel)) extra.push(rel);
    return {ok: true, changed, missing, extra, total: actual.size};
  } catch (err) { return {ok: false, error: String(err?.message || err)}; }
});


// —— 知识库文件监听：外部改动（Obsidian / 网盘回捞等）2s 防抖后通知渲染层跑一次同步比对
// （渲染层比对无变化时静默，应用自己写盘引发的回环只是多一次便宜的全量比对，无害）。
let vaultWatcher = null, vaultWatchTimer = null;
function closeVaultWatcher() {
  if (vaultWatcher) { try { vaultWatcher.close(); } catch {} vaultWatcher = null; }
  clearTimeout(vaultWatchTimer);
  vaultWatchTimer = null;
}
ipcMain.on('vault:watch', (_e, root) => {
  closeVaultWatcher();
  // linux 的 fs.watch 不支持 recursive（监不到子目录），与其给出「看起来能用实则漏报」的监听，
  // 不如明确不监听：linux 上仍可用顶栏手动导入 / 重启时自动同步兜底。
  // 未授权的目录不监听（M1）：白名单校验走同步检查，不弹确认框（弹窗留给首个读请求）
  if (!root || !rootAuthorized(root) || process.platform === 'linux') return;
  try {
    vaultWatcher = fs.watch(root, {recursive: true}, (_event, filename) => {
      // 应用自身写盘也会触发 watch（回环）：.deepnotes/meta.json（附属数据）与 .trash（删除移入）
      // 这类点开头路径的变更不代表用户内容变化，过滤掉——否则每次写 meta / 删文件都会白跑
      // 一次全库读取比对。内容文件的自写回声由渲染层的同口径比对兜底（无变化静默返回）。
      const rel = String(filename || '').replace(/\\/g, '/');
      if (!rel || rel.split('/').some(seg => seg.startsWith('.'))) return;
      clearTimeout(vaultWatchTimer);
      vaultWatchTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vault:changed');
      }, 2000);
    });
    vaultWatcher.on('error', closeVaultWatcher); // 目录被移走 / 权限变化：静默停用，不反复报错
  } catch { closeVaultWatcher(); }
});
app.on('will-quit', closeVaultWatcher);

// —— 单实例锁：同时开两个窗口会对同一知识库做全量覆盖写、互相覆盖（数据丢失）——
// 第二实例拿不到锁直接退出；已运行的实例把主窗口拉到前台。
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// AI 助手插件：主进程转发 OpenAI 兼容请求。
// 部分服务商不允许浏览器直连（CORS），桌面版经主进程 net 转发；调用仍受渲染层「联网开关 + 插件开关」双闸控制。
// 转发不是代理跳板：只放行 https 公网与 http 本机回环（本地 Ollama 场景），
// 内网段 / 云 metadata 端点一律拒绝，防止渲染层被注入后借主进程探测内网（SSRF）。
const MAX_AI_BODY = 10 * 1024 * 1024; // 响应体上限 10MB，防超大响应打爆内存
// 本机回环端口白名单：回环地址只放行常见本地模型 / 推理服务端口，防止被注入的渲染层
// 借主进程 POST 打任意本机端口（探测或利用本机其他服务）。与 src/neural/ai.jsx 的 LOCAL_PORTS 保持一致。
const LOCAL_PORTS = new Set([11434, 11435, 1234, 1337, 3000, 5000, 5001, 7860, 8000, 8080, 8081, 8888]);
function aiUrlAllowed(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return 'URL 无效'; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (u.protocol === 'http:') {
    if (!loopback) return '明文 http 仅允许本机地址（localhost / 127.0.0.1 / ::1）';
    // 回环地址也限制端口：省略端口（默认 80）同样拒绝——本地推理服务都带显式端口
    if (!LOCAL_PORTS.has(Number(u.port) || 0)) {
      return `本机 http 仅允许常见本地服务端口（${[...LOCAL_PORTS].sort((a, b) => a - b).join(' / ')}）`;
    }
  } else if (u.protocol !== 'https:') {
    return '仅允许 http(s) 地址';
  } else if (loopback) {
    // https 回环此前不限端口，架空了整个白名单设计（本机任意端口的 TLS 服务都可被打）。
    // 公网 https 不受限；本机回环无论协议都只放行常见本地服务端口
    if (!LOCAL_PORTS.has(Number(u.port) || 0)) {
      return `本机地址仅允许常见本地服务端口（${[...LOCAL_PORTS].sort((a, b) => a - b).join(' / ')}）`;
    }
  }
  if (!loopback && (
    /^(10\.|192\.168\.|169\.254\.|0\.)/.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^(::|f[cd][0-9a-f]{2}:|fe80:)/i.test(host)
    || host.endsWith('.local')
  )) return '禁止访问内网 / 保留段地址';
  return null;
}

// 内网 / 保留段 IP 判断（含 IPv4 映射的 IPv6 地址）。
function privateIp(ip) {
  const s = String(ip || '');
  if (/^::ffff:/i.test(s)) return privateIp(s.slice(7));
  if (/^(10\.|192\.168\.|169\.254\.|0\.|127\.)/.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  // CGNAT 100.64.0.0/10 与基准测试段 198.18.0.0/15：同属不可路由段，DNS rebinding 同样要打进来
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s) || /^198\.1[89]\./.test(s)) return true;
  return /^(::1$|::|f[cd][0-9a-f]{2}:|fe80:)/i.test(s);
}

// 域名先解析成 IP 再查内网段：公网域名也可能被解析到内网地址（DNS rebinding 常规手法）。
// 尽力而为而非根治——解析与真正发请求之间仍有 TOCTOU 窗口；IP 字面量与 loopback 不必再查。
async function aiHostAllowed(raw) {
  let host;
  try { host = new URL(String(raw || '')).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return null; }
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return null; // 已是 IP 字面量，aiUrlAllowed 查过段位
  const addrs = await dns.promises.lookup(host, { all: true }).catch(() => null);
  if (!addrs) return null; // 解析失败留给 fetch 自己报错
  for (const { address } of addrs) if (privateIp(address)) return `域名 ${host} 解析到内网地址，已拦截`;
  return null;
}
ipcMain.handle('ai-fetch', async (_event, { url, headers, body }) => {
  try {
    const blocked = aiUrlAllowed(url);
    if (blocked) return { ok: false, status: 0, error: `请求被拒绝：${blocked}` };
    const hostBlocked = await aiHostAllowed(url);
    if (hostBlocked) return { ok: false, status: 0, error: `请求被拒绝：${hostBlocked}` };
    const res = await net.fetch(String(url), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // 90 秒超时：服务商挂死 / 断流时请求自动中止，不再永远占着一次对话
      signal: AbortSignal.timeout(90_000),
      // 不跟随重定向：白名单只校验了初始 URL，跟随 302 可能把请求引到内网（SSRF 绕过）；
      // 正规 AI 接口不会重定向 POST 请求，遇到重定向直接报错即可
      redirect: 'error',
    });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_AI_BODY) return { ok: false, status: res.status, error: '响应体超过 10MB，已拒绝' };
    // 流式读取并累计计数：chunked/gzip 响应没有 content-length，整体 arrayBuffer 会先把超大响应读进内存
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, status: res.status, error: '响应体不可读' };
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AI_BODY) { await reader.cancel().catch(() => {}); return { ok: false, status: res.status, error: '响应体超过 10MB，已拒绝' }; }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
    let data = null;
    try { data = JSON.parse(new TextDecoder().decode(buf)); } catch { /* 非 JSON 响应（如纯文本报错）按 null 处理 */ }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  }
});

// —— AI 流式转发（ai-fetch-stream）：SSE 原始字节逐段推回渲染层，由渲染层解析聚合 ——
// 与 ai-fetch 同一套 SSRF / 内网段 / 端口白名单；渲染层同一时刻只有一个 AI 请求（busy 单例），
// chunk 直接发给发起方即可，无需多路复用。空闲 90s（无新 chunk）自动中止：总时长不限——
// 长文生成几分钟是常态，卡死的判据是「不再有数据」而不是「总时间」。
ipcMain.handle('ai-fetch-stream', async (event, { url, headers, body }) => {
  let idle = null; // 提出 try：异常路径也要清，否则定时器残留 90 秒后对已中止的 controller 空触发
  try {
    const blocked = aiUrlAllowed(url);
    if (blocked) return { ok: false, status: 0, error: `请求被拒绝：${blocked}` };
    const hostBlocked = await aiHostAllowed(url);
    if (hostBlocked) return { ok: false, status: 0, error: `请求被拒绝：${hostBlocked}` };
    const ctrl = new AbortController();
    idle = setTimeout(() => ctrl.abort(new Error('响应空闲超过 90 秒，已中止')), 90_000);
    const res = await net.fetch(String(url), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (!res.ok || !res.body) {
      clearTimeout(idle);
      // 错误响应体很小：整读后按原结构返回，渲染层照常给出报错信息
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(text); } catch { /* 非 JSON 报错按 null 处理 */ }
      return { ok: res.ok, status: res.status, data };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new Error('响应空闲超过 90 秒，已中止')), 90_000);
      total += value.byteLength;
      if (total > MAX_AI_BODY) {
        clearTimeout(idle);
        await reader.cancel().catch(() => {});
        return { ok: false, status: res.status, error: '响应体超过 10MB，已拒绝' };
      }
      if (!event.sender.isDestroyed()) event.sender.send('ai-stream-chunk', dec.decode(value, { stream: true }));
    }
    clearTimeout(idle);
    return { ok: true, status: res.status };
  } catch (err) {
    if (idle) clearTimeout(idle);
    return { ok: false, status: 0, error: String(err?.message || err) };
  }
});

let mainWindow;
let ownDir = null; // 生产模式本应用 dist 目录（loadFile 的实际路径推导），will-navigate 据此放行自有导航
const isDev = !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    show: false,
    backgroundColor: '#1a1a1a',
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外链白名单：只放行网页与邮件链接交给系统打开，其余自定义协议（file:、smb: 等）一律不交给系统
  const EXTERNAL_OK = /^(https?:|mailto:)/i;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_OK.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // 应用是单页应用，页面内容切换全走 React state，不该发生任何页面级导航；
    // 开发模式只放行 Vite 地址，生产模式只放行本应用 dist 目录内的 file:// URL（重载 / 锚点跳转），
    // 其余一律拦下，外链转交系统浏览器——避免整窗被导航到任意外部页面或任意本地文件（应用被替换 / 钓鱼）
    let own = false;
    try {
      const u = new URL(url);
      if (isDev) own = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === '5173';
      else if (u.protocol === 'file:' && ownDir) {
        let p = decodeURIComponent(u.pathname);
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
        own = p === ownDir || p.startsWith(ownDir + path.sep);
      }
    } catch { /* URL 解析失败按外处理 */ }
    if (own) return;
    e.preventDefault();
    if (EXTERNAL_OK.test(url)) shell.openExternal(url);
  });

  if (isDev) {
    const devUrl = 'http://localhost:5173';
    const checkServer = () => {
      mainWindow.loadURL(devUrl).catch(() => setTimeout(checkServer, 1000));
    };
    checkServer();
    mainWindow.webContents.openDevTools();
  } else {
    // In production, use app.getAppPath() for correct asar paths
    const appPath = app.getAppPath();
    const indexPath = path.join(appPath, 'dist', 'index.html');
    ownDir = path.dirname(indexPath); // will-navigate 白名单：只放行本应用 dist 目录内的 file:// 导航
    mainWindow.loadFile(indexPath);
  }
}

app.whenReady().then(() => {
  // 视频流式协议：只读、限授权根目录（见 streamAsset）
  protocol.handle('deepnotes-asset', streamAsset);
  createWindow();
  // 全局快捷键：⌘/Ctrl+Shift+D 唤出主窗口（即使在别的应用里也能一键回到笔记）。
  // 只注册一次：createWindow 在 macOS「点击 Dock 图标重新激活」时会再次执行，重复注册同一加速键会失败
  try {
    globalShortcut.register('CommandOrControl+Shift+D', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    // 剪贴板快速捕获：⌘/Ctrl+Alt+V 把剪贴板文本一键存进闪念箱（Alt 组合避开常用快捷键）。
    // 只在本机读剪贴板经 IPC 转发一次，不联网；窗口在后台/最小化时同样可用
    globalShortcut.register('CommandOrControl+Alt+V', () => {
      try {
        let text = clipboard.readText().trim();
        if (!text) return;
        if (text.length > 100000) text = text.slice(0, 100000) + '…（超长截断）';
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('clipboard-capture', text);
      } catch {}
    });
  } catch (_) { /* 快捷键被其他应用占用时静默失败，不影响启动 */ }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
