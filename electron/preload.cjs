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
