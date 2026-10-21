const { app, BrowserWindow, shell, ipcMain, net, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const dns = require('dns');

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
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
});

ipcMain.handle('vault:read', async (_e, root) => {
  try { return { ok: true, ...await readMd(root) }; }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('vault:write', async (_e, { root, rel, body }) => {
  try {
    const full = path.join(root, rel);
    if (!inside(root, full)) return { ok: false, error: '路径越界' };
    if (isSymlink(full)) return { ok: false, error: '目标是符号链接，拒绝写入' };
    const blocked = rejectIncomplete(full, body);
    if (blocked) return { ok: false, error: blocked };
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
    if (!Array.isArray(files)) return { ok: false, error: '参数错误' };
    for (const f of files) {
      const full = path.join(root, f.rel);
      if (!inside(root, full)) return { ok: false, error: '路径越界' };
      if (isSymlink(full)) return { ok: false, error: `${f.rel}: 目标是符号链接，拒绝写入` };
      const blocked = rejectIncomplete(full, f.body);
      if (blocked) return { ok: false, error: `${f.rel}: ${blocked}` };
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
    const resolved = path.resolve(srcRoot);
    if (/ - Deep Notes$/i.test(path.basename(resolved))) return { ok: true, dir: resolved, reused: true };
    const parent = path.dirname(resolved);
    const base = path.basename(resolved) + ' - Deep Notes';
    let dir = path.join(parent, base);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(parent, `${base} ${i}`);
    await fsp.mkdir(dir, { recursive: true });
    await copyAssets(resolved, dir);
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

try {
  if (require('electron-squirrel-startup')) app.quit();
} catch (e) {}

// AI 助手插件：主进程转发 OpenAI 兼容请求。
// 部分服务商不允许浏览器直连（CORS），桌面版经主进程 net 转发；调用仍受渲染层「联网开关 + 插件开关」双闸控制。
// 转发不是代理跳板：只放行 https 公网与 http 本机回环（本地 Ollama 场景），
// 内网段 / 云 metadata 端点一律拒绝，防止渲染层被注入后借主进程探测内网（SSRF）。
const MAX_AI_BODY = 10 * 1024 * 1024; // 响应体上限 10MB，防超大响应打爆内存
function aiUrlAllowed(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return 'URL 无效'; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.protocol === 'http:') {
    const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
    if (!loopback) return '明文 http 仅允许本机地址（localhost / 127.0.0.1 / ::1）';
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
