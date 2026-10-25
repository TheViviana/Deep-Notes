const { contextBridge, ipcRenderer } = require('electron');

// 只暴露渲染层真正用到的通道；没有对应 handler 的 IPC 一律不暴露（死代码会误导后续接入）。
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // AI 助手插件：主进程转发（仅当联网开关与插件同时打开时渲染层才会调用）
  aiFetch: payload => ipcRenderer.invoke('ai-fetch', payload),
  // AI 流式：onChunk 收到主进程逐段推回的 SSE 原始文本；返回 invoke 的最终结果（ok/status）
  aiFetchStream: (payload, onChunk) => {
    const h = (_e, text) => { try { onChunk(text); } catch {} };
    ipcRenderer.on('ai-stream-chunk', h);
    return ipcRenderer.invoke('ai-fetch-stream', payload).finally(() => ipcRenderer.off('ai-stream-chunk', h));
  },
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
    // 图片按内容 sha1 落盘到 attachments/，同图复用同一路径
    saveAsset: (root, name, mime, data) => ipcRenderer.invoke('vault:saveAsset', { root, name, mime, data }),
    verifyIntegrity: (root, expected) => ipcRenderer.invoke('vault:verifyIntegrity', { root, expected }),
    // 应用级附属数据（闪念箱 / 概念定义 / 段落闪卡）：库根下 .deepnotes/meta.json，随库走
    metaRead: root => ipcRenderer.invoke('vault:meta-read', root),
    metaWrite: (root, data) => ipcRenderer.invoke('vault:meta-write', {root, data}),
    // 退出前的同步 meta 落盘（beforeunload 里异步通道来不及）
    metaWriteSync: (root, data) => ipcRenderer.sendSync('vault:meta-write-sync', {root, data}),
    // 文件恢复：列出写前快照 / 读取某份快照内容（恢复界面数据源）
    snapshots: root => ipcRenderer.invoke('vault:snapshots', { root }),
    snapshotRead: (root, file) => ipcRenderer.invoke('vault:snapshot-read', { root, file }),
    // 文件监听：外部改动（Obsidian 等）经主进程防抖后回调 onChanged；watch 换库时重设监听目录
    watch: dir => ipcRenderer.send('vault:watch', dir),
    onChanged: cb => { const h = () => cb(); ipcRenderer.on('vault:changed', h); return () => ipcRenderer.off('vault:changed', h); },
  },
  // 剪贴板快速捕获：主进程全局快捷键（⌘/Ctrl+Alt+V）读剪贴板后把文本回调给渲染层
  clipboardCapture: cb => { const h = (_e, text) => cb(text); ipcRenderer.on('clipboard-capture', h); return () => ipcRenderer.off('clipboard-capture', h); },
});
