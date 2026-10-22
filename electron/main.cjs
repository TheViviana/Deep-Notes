const { app, BrowserWindow, shell, ipcMain, net, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const dns = require('dns');
const crypto = require('crypto');

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
  return t === r || t.startsWith(r + path.sep);
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
  if (loadAuth().denied.has(r)) return false; // 用户明确拒绝过且已持久化：静默保持未授权，不再追问
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
    denyRoot(r); // 拒绝也记下来：否则每次启动都对同一目录重复追问
  } catch {}
  return false;
}

const SKIP = new Set(['.obsidian', '.trash', '.git', '.DS_Store', 'node_modules']);

// —— 原子写入：先写同目录隐藏临时文件，再 rename 到位 ——
// 写一半崩溃 / 断电时要么是完整旧文件、要么是完整新文件，不会留下截断的半截 .md。
// 临时文件以 . 开头：readMd 与 vault:asset 都会跳过，永远不会被当成笔记读出来。
async function atomicWrite(full, body) {
  const tmp = path.join(path.dirname(full), '.' + path.basename(full) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  // open + sync + close：数据落盘后才 rename（断电也不会出现「rename 完成但内容还在页缓存」的空文件）；
  // close 放 finally——写失败也不能漏关句柄，fd 泄漏积多了进程再也打不开文件
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(String(body ?? ''), 'utf8');
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
  try { await fsp.rename(tmp, full); }
  catch (err) { await fsp.unlink(tmp).catch(() => {}); throw err; }
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
function snapPathFor(root, full, ts) {
  const rel = path.relative(path.resolve(String(root)), path.resolve(full));
  return path.join(snapDirFor(root), rel.replace(/\.md$/i, '') + '_' + ts + '.md');
}
let snapPruned = false;
async function pruneSnapshots(dir, now) { // 超期清理：整库快照树一遍，失败静默（下次触发再清）
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await pruneSnapshots(p, now); continue; }
    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > SNAP_TTL) await fsp.rm(p, { force: true });
    } catch {}
  }
}
async function capSnapshots(dir) { // 单个文件的快照超额删最旧（文件名带毫秒时间戳前缀，天然可排序）
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(n => n.endsWith('.md')).sort(); } catch { return; }
  if (names.length <= SNAP_KEEP) return;
  for (const n of names.slice(0, names.length - SNAP_KEEP)) await fsp.rm(path.join(dir, n), { force: true }).catch(() => {});
}
async function snapshotBeforeWrite(root, full, body) {
  try {
    let old = null;
    try { old = await fsp.readFile(full, 'utf8'); } catch { return; } // 新文件（首次创建）无需快照
    if (String(old) === String(body)) return; // 内容没变不拍
    const dest = snapPathFor(root, full, Date.now());
    const dir = path.dirname(dest);
    // 内容去重：与本文件最新一份快照相同就跳过（连续保存只留真正变化过的版本）
    const stem = path.basename(dest).replace(/_\d{13,}\.md$/, '');
    let names = [];
    try { names = (await fsp.readdir(dir)).filter(n => n.startsWith(stem + '_') && n.endsWith('.md')).sort(); } catch {}
    if (names.length) {
      try { if ((await fsp.readFile(path.join(dir, names[names.length - 1]), 'utf8')) === String(old)) return; } catch {}
    }
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(dest, String(old), 'utf8');
    capSnapshots(dir).catch(() => {});
    if (!snapPruned) { snapPruned = true; pruneSnapshots(snapDirFor(root), Date.now()).catch(() => {}); }
  } catch {} // 快照是保底网，自身故障不能影响正常写盘
}
function snapshotBeforeWriteSync(root, full, body) { // 退出同步通道用：同步 fs，不能 await
  try {
    let old = null;
    try { old = fs.readFileSync(full, 'utf8'); } catch { return; }
    if (String(old) === String(body)) return;
    const dest = snapPathFor(root, full, Date.now());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, String(old), 'utf8');
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
      if (cloud && /\.md$/i.test(cloud[1])) {
        unreadable.push(path.relative(root, path.join(dir, cloud[1])).split(path.sep).join('/'));
        continue;
      }
      if (e.name.startsWith('.') || SKIP.has(e.name)) {
        // 顺手清掉上次崩溃残留的写入临时文件：正在写的临时文件很新，超过 1 小时的一定是残留
        if (e.isFile() && /^\..+\.tmp-/.test(e.name)) {
          const p = path.join(dir, e.name);
          try { const st = await fsp.stat(p); if (Date.now() - st.mtimeMs > 60 * 60 * 1000) await fsp.rm(p, { force: true }); } catch {}
        }
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        const relPath = path.relative(root, full).split(path.sep).join('/');
        try {
          out.push({ relPath, body: await fsp.readFile(full, 'utf8') });
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

ipcMain.handle('vault:write', async (_e, { root, rel, body }) => {
  try {
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const full = path.join(root, rel);
    if (!inside(root, full)) return { ok: false, error: '路径越界' };
    if (isSymlink(full)) return { ok: false, error: '目标是符号链接，拒绝写入' };
    const blocked = rejectIncomplete(full, body);
    if (blocked) return { ok: false, error: blocked };
    await snapshotBeforeWrite(root, full, body); // 覆盖前把盘上旧内容存进恢复快照库（失败不阻塞写盘）
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await atomicWrite(full, body);
    await pruneUp(root, path.dirname(full)).catch(() => {}); // 顺手清掉因改名/移动而空掉的目录
    return { ok: true };
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
      if (targetExists) return { ok: false, error: '目标已存在，拒绝覆盖' };
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
      if (now - (st.mtimeMs || st.ctimeMs) > TRASH_TTL) {
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
    const trashDir = path.join(root, '.trash');
    await fsp.mkdir(trashDir, { recursive: true });
    // 随机后缀避免同毫秒同名互相覆盖（先删的内容也要能找回）
    const dest = path.join(trashDir, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + path.basename(full));
    await fsp.rename(full, dest).catch(err => {
      if (err?.code === 'ENOENT') return; // 文件本就不存在，视为已删除
      throw err;
    });
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
          if (exists) { failed.push(rel); continue; }
        }
        fs.mkdirSync(path.dirname(b), { recursive: true });
        try { fs.renameSync(a, b); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
        pruneUp(op.root, path.dirname(a)).catch(() => {});
        continue;
      }
      const full = path.join(op?.root || '', rel);
      if (!op?.root || !rel || !inside(op.root, full)) { failed.push(rel); continue; }
      if (op.trash) {
        const trashDir = path.join(op.root, '.trash');
        fs.mkdirSync(trashDir, { recursive: true });
        const dest = path.join(trashDir, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + path.basename(full));
        try { fs.renameSync(full, dest); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
        pruneUp(op.root, path.dirname(full)).catch(() => {});
      } else {
        if (isSymlink(full)) { failed.push(rel); continue; }
        const blocked = rejectIncomplete(full, op.body);
        if (blocked) { failed.push(rel); continue; }
        snapshotBeforeWriteSync(op.root, full, op.body); // 退出写盘前的最后一道快照
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const tmp = path.join(path.dirname(full), '.' + path.basename(full) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
        // 与 atomicWrite 同一套落盘纪律：fsync 后 rename，句柄 finally 关闭
        const fd = fs.openSync(tmp, 'w');
        try { fs.writeSync(fd, String(op.body ?? ''), null, 'utf8'); fs.fsyncSync(fd); }
        finally { try { fs.closeSync(fd); } catch {} }
        fs.renameSync(tmp, full);
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
        const m = e.name.match(/_(\d{13})\.md$/);
        if (!m) continue;
        const file = path.relative(base, p).split(path.sep).join('/');
        list.push({ file, ts: Number(m[1]), rel: file.replace(/_(\d{13})\.md$/, '.md') });
      }
    }
    await walk(base);
    list.sort((a, b) => b.ts - a.ts); // 新的在前
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
// 副本同时带走图片等资源文件（.md 正文里的 ![[图片]] 引用才能正常显示）。
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf)$/i;
async function copyAssets(src, dest) {
  let entries;
  try { entries = await fsp.readdir(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { await fsp.mkdir(d, { recursive: true }); await copyAssets(s, d); }
    else if (e.isFile() && ASSET_RE.test(e.name)) await fsp.copyFile(s, d).catch(() => {});
  }
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
    await copyAssets(resolved, dir);
    // 审计 v2-②：新副本不再自动登记授权白名单——导入后的首次读取会触发一次系统确认框，
    // 允许后永久记住；自动授权点会让「只授权用户亲自选过的目录」形同虚设
    return { ok: true, dir };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// 读知识库内的图片等资源 → base64（阅读视图渲染 ![[名字]] 与相对路径引用图）。
// ref 可以是相对路径，也可以只是文件名（Obsidian 的 ![[文件名]] 不带路径）：找不到就按文件名全库搜。
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif'};
ipcMain.handle('vault:asset', async (_e, { root, ref }) => {
  try {
    if (!root || !ref) return { ok: false, error: '参数错误' };
    if (!(await ensureAuthorized(root))) return { ok: false, error: '知识库文件夹未授权 · Vault root not authorized' };
    const clean = String(ref).replace(/^\.?\//, '');
    let full = path.resolve(root, clean);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      const base = path.basename(clean).toLowerCase();
      let found = null;
      async function walk(dir) {
        if (found) return;
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (found) return;
          if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
          const f = path.join(dir, e.name);
          if (e.isDirectory()) await walk(f);
          else if (e.isFile() && e.name.toLowerCase() === base) { found = f; return; }
        }
      }
      await walk(root);
      if (!found) return { ok: false, error: '找不到资源' };
      full = found;
    }
    if (!inside(root, full)) return { ok: false, error: '路径越界' };
    const mime = MIME[path.extname(full).toLowerCase()];
    if (!mime) return { ok: false, error: '不支持的格式' };
    const buf = await fsp.readFile(full);
    return { ok: true, mime, data: buf.toString('base64') };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
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
    vaultWatcher = fs.watch(root, {recursive: true}, () => {
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
  if (u.protocol === 'http:') {
    const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
    if (!loopback) return '明文 http 仅允许本机地址（localhost / 127.0.0.1 / ::1）';
    // 回环地址也限制端口：省略端口（默认 80）同样拒绝——本地推理服务都带显式端口
    if (!LOCAL_PORTS.has(Number(u.port) || 0)) {
      return `本机 http 仅允许常见本地服务端口（${[...LOCAL_PORTS].sort((a, b) => a - b).join(' / ')}）`;
    }
  } else if (u.protocol !== 'https:') {
    return '仅允许 http(s) 地址';
  }
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
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
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_AI_BODY) return { ok: false, status: res.status, error: '响应体超过 10MB，已拒绝' };
    let data = null;
    try { data = JSON.parse(new TextDecoder().decode(buf)); } catch { /* 非 JSON 响应（如纯文本报错）按 null 处理 */ }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
