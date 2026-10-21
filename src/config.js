// 个性化配置：换成你自己的品牌名、账号和头像，其余代码不用改。
// Personal settings: swap in your own brand, account and avatar; nothing else needs to change.
export const CONFIG = {
  brand: {name: 'DEEP', sub: 'NOTES', tagline: '深度笔记', taglineEn: 'Deep notes'},
  // 图谱中心节点的名字
  workspace: '我的创作空间',
  // 头像放在 public/ 下，填相对路径
  avatar: 'avatar.svg',
  footer: {zh: '每一篇笔记，都是网络里的一个节点。', en: 'Every note is a node in the network.'},
  // 选题、草稿、目标保存在浏览器 localStorage 里的键名前缀
  storagePrefix: 'neural-dashboard'
};

// public/ 下的素材路径（兼容部署在子路径，如 GitHub Pages）
export const asset = path => import.meta.env.BASE_URL + path;

// —— 桌面版知识库根目录的存储（fileStore 与 images 共用） ——
// 键名是固定常量、不随品牌前缀（storagePrefix）变：本配置文件鼓励改名换前缀，
// 已连接的知识库路径不能因此悄悄断开。首次读取时把旧前缀键里的路径迁移到固定键
// （复制、保留旧键，万一回退旧版本也不丢）。
export const VAULT_ROOT_KEY = 'deepnotes-vault-root-v1';
export function readVaultRoot() {
  try {
    const cur = localStorage.getItem(VAULT_ROOT_KEY);
    if (cur) return cur;
    const legacy = localStorage.getItem(CONFIG.storagePrefix + '-vault-root-v1');
    if (legacy) { try { localStorage.setItem(VAULT_ROOT_KEY, legacy); } catch {} }
    return legacy;
  } catch { return null; }
}
