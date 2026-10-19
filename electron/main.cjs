const { app, BrowserWindow, shell, ipcMain, net } = require('electron');
const path = require('path');

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
