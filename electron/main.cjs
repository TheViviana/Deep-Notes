const { app, BrowserWindow, shell, ipcMain, net, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// —— 文件夹知识库（桌面版）：渲染层经 preload 暴露的 window.deepnotes.vault 调用 ——
// 所有写操作都限制在所选根目录（root）内，路径越界一律拒绝。
function inside(root, target) {
  const r = path.resolve(root) + path.sep;
  const t = path.resolve(target);
  return t === path.resolve(root) || t.startsWith(r);
}

const SKIP = new Set(['.obsidian', '.trash', '.git', '.DS_Store', 'node_modules']);

// —— 原子写入：先写同目录隐藏临时文件，再 rename 到位 ——
// 写一半崩溃 / 断电时要么是完整旧文件、要么是完整新文件，不会留下截断的半截 .md。
// 临时文件以 . 开头：readMd 与 vault:asset 都会跳过，永远不会被当成笔记读出来。
async function atomicWrite(full, body) {
  const tmp = path.join(path.dirname(full), '.' + path.basename(full) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  await fsp.writeFile(tmp, body, 'utf8');
  try { await fsp.rename(tmp, full); }
  catch (err) { await fsp.unlink(tmp).catch(() => {}); throw err; }
}

// —— 拒绝不完整覆盖：空内容不允许覆盖已有文件 ——
// 序列化结果永远带 frontmatter，正常流程不可能写出空文件；空 body 只能来自上游 bug 或损坏，
// 此时宁可拒写保住盘上原文，也不能用一个空文件把内容毁掉。
function rejectIncomplete(full, body) {
  if (String(body).trim()) return null;
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
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
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
    const blocked = rejectIncomplete(full, body);
    if (blocked) return { ok: false, error: blocked };
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await atomicWrite(full, body);
    await pruneUp(root, path.dirname(full)).catch(() => {}); // 顺手清掉因改名/移动而空掉的目录
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
      if (now - (st.mtimeMs || st.ctimeMs) > TRASH_TTL) await fsp.rm(p, { recursive: true, force: true });
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
// 与 vault:write / vault:trash 同一套越界与拒绝空写规则；队列结构见渲染层 fileStore.js。
ipcMain.on('vault:flush-sync', (e, ops) => {
  const failed = [];
  for (const op of (Array.isArray(ops) ? ops : [])) {
    const rel = String(op?.rel || '');
    try {
      const full = path.join(op?.root || '', rel);
      if (!op?.root || !rel || !inside(op.root, full)) { failed.push(rel); continue; }
      if (op.trash) {
        const trashDir = path.join(op.root, '.trash');
        fs.mkdirSync(trashDir, { recursive: true });
        const dest = path.join(trashDir, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + path.basename(full));
        try { fs.renameSync(full, dest); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
        pruneUp(op.root, path.dirname(full)).catch(() => {});
      } else {
        const blocked = rejectIncomplete(full, op.body);
        if (blocked) { failed.push(rel); continue; }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const tmp = path.join(path.dirname(full), '.' + path.basename(full) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
        fs.writeFileSync(tmp, String(op.body ?? ''), 'utf8');
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
ipcMain.handle('ai-fetch', async (_event, { url, headers, body }) => {
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  }
});

let mainWindow;
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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
