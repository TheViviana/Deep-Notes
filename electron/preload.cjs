const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('get-version'),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  // AI 助手插件：主进程转发（仅当联网开关与插件同时打开时渲染层才会调用）
  aiFetch: payload => ipcRenderer.invoke('ai-fetch', payload),
});

// 文件夹知识库（桌面版）：本地文件读写，全部走主进程并限制在所选根目录内。
contextBridge.exposeInMainWorld('deepnotes', {
  vault: {
    chooseDir: () => ipcRenderer.invoke('vault:choose-dir'),
    read: root => ipcRenderer.invoke('vault:read', root),
    write: (root, rel, body) => ipcRenderer.invoke('vault:write', { root, rel, body }),
    trash: (root, rel) => ipcRenderer.invoke('vault:trash', { root, rel }),
    prepareCopy: srcRoot => ipcRenderer.invoke('vault:prepare-copy', srcRoot),
  },
});
