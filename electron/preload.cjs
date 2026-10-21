const { contextBridge, ipcRenderer } = require('electron');

// 只暴露渲染层真正用到的通道；没有对应 handler 的 IPC 一律不暴露（死代码会误导后续接入）。
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // AI 助手插件：主进程转发（仅当联网开关与插件同时打开时渲染层才会调用）
  aiFetch: payload => ipcRenderer.invoke('ai-fetch', payload),
  // API Key 本机加密（safeStorage）：明文只经 IPC 传一次，localStorage 里只存 base64 密文
  keyEncrypt: plain => ipcRenderer.invoke('key-encrypt', plain),
  keyDecrypt: b64 => ipcRenderer.invoke('key-decrypt', b64),
});

// 文件夹知识库（桌面版）：本地文件读写，全部走主进程并限制在所选根目录内。
contextBridge.exposeInMainWorld('deepnotes', {
  vault: {
    chooseDir: () => ipcRenderer.invoke('vault:choose-dir'),
    read: root => ipcRenderer.invoke('vault:read', root),
    write: (root, rel, body) => ipcRenderer.invoke('vault:write', { root, rel, body }),
    // 原子移动 / 重命名（rename）：改名不再拆成 trash + write 两步
    move: (root, from, to) => ipcRenderer.invoke('vault:move', { root, from, to }),
    trash: (root, rel) => ipcRenderer.invoke('vault:trash', { root, rel }),
    // 退出前的同步落盘（beforeunload 里异步 IPC 可能来不及执行）：阻塞到主进程写完才放行关闭
    flushSync: ops => ipcRenderer.sendSync('vault:flush-sync', ops),
    prepareCopy: srcRoot => ipcRenderer.invoke('vault:prepare-copy', srcRoot),
    exportMany: (root, files) => ipcRenderer.invoke('vault:export', { root, files }),
    asset: (root, ref) => ipcRenderer.invoke('vault:asset', { root, ref }),
  },
});
