const { app, BrowserWindow, shell, ipcMain, net, dialog } = require('electron');
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

async function readMd(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        try {
          out.push({ relPath: path.relative(root, full).split(path.sep).join('/'), body: await fsp.readFile(full, 'utf8') });
        } catch {}
      }
    }
  }
  await walk(root);
  return out;
}

ipcMain.handle('vault:choose-dir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
});

ipcMain.handle('vault:read', async (_e, root) => {
  try { return { ok: true, files: await readMd(root) }; }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('vault:write', async (_e, { root, rel, body }) => {
  try {
    const full = path.join(root, rel);
    if (!inside(root, full)) return { ok: false, error: '路径越界' };
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, body, 'utf8');
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
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, f.body, 'utf8');
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

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
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// 在原知识库旁新建「<原名> - Deep Notes」副本目录，原库内容不动；重名自动加序号。
// 文件夹本身已带「 - Deep Notes」后缀（Deep Notes 专属库）：直接作为工作库使用，不再复制副本。
ipcMain.handle('vault:prepare-copy', async (_e, srcRoot) => {
  try {
    const resolved = path.resolve(srcRoot);
    if (/ - Deep Notes$/i.test(path.basename(resolved))) return { ok: true, dir: resolved, reused: true };
    const parent = path.dirname(resolved);
    const base = path.basename(resolved) + ' - Deep Notes';
    let dir = path.join(parent, base);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(parent, `${base} ${i}`);
    await fsp.mkdir(dir, { recursive: true });
    return { ok: true, dir };
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
