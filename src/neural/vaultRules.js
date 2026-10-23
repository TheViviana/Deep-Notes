// 零依赖纯模块：知识库导入的共享规则。供 src/neural/importer.js（浏览器）与
// scripts/import-notes.mjs（Node CLI）双方 import——不得引入 React、DOM、localStorage
// 等 Node 环境没有的东西（CLI 直接 import 本模块，没有打包器）。
// ⚠️ 修改这里的解析 / 路径 / id 规则等于一次数据迁移事件：已写盘的知识库会在下次
// 导入 / 同步时整体对齐一轮（一轮 move + 重写，内容不丢但文件 mtime 全变）。
// 两侧（应用内 / CLI）必须同时改，tests/importer.test.mjs 与契约测试会锁死一致性。

// —— frontmatter：key: value（半角或全角冒号）、key: [a, b]、以及「- 项」列表 ——
// 全角冒号同样识别：中文笔记手写「主题：xxx」很常见，此前静默丢失（已丢的从备份恢复）。
export const unquote = s => {
  const t = String(s).trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'") && t[t.length - 1] === q) {
      try { return q === '"' ? JSON.parse(t) : t.slice(1, -1).replace(/''/g, "'"); } catch { /* 引号不配对，按原样返回 */ }
    }
  }
  return t;
};
// 块标量需要在 serialize 时按 `|` 形式回写，用一个标记包装以便 render 识别
export const isBlock = v => v && typeof v === 'object' && v.__block === true;
export function parse(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    const lines = m[1].split(/\r?\n/);
    let key = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // —— 块标量续行：上一行以 `key: |` 或 `key: >` 结尾，吞掉后续所有缩进更深的行 ——
      if (key && fm[key] && isBlock(fm[key])) {
        const blk = fm[key];
        if (raw.length === 0) { blk.text += '\n'; continue; }
        const indent = raw.match(/^\s*/)[0].length;
        if (indent > blk.indent) {
          // 首行内容锁死基准缩进，后续行按基准剥（更深保留相对缩进，更浅按实际缩进剥，不吃字符）
          if (blk.contentIndent == null) blk.contentIndent = indent;
          blk.text += raw.slice(Math.min(blk.contentIndent, indent)) + '\n'; continue;
        }
        else { // 续行结束
          blk.text = blk.text.replace(/\n+$/, '');
          key = null;
        }
      }
      const item = raw.match(/^\s*-\s+(.*)$/);
      if (item && key) { if (!Array.isArray(fm[key])) fm[key] = []; fm[key].push(unquote(item[1])); continue; }
      const block = raw.match(/^(\s*)([^:#：\s][^:：]*?)[:：]\s*([|>])([+-]?)\s*$/);
      if (block) {
        key = block[2].trim();
        const indent = block[1].length;
        fm[key] = {__block: true, style: block[3], chomp: block[4] || '', text: '', indent};
        continue;
      }
      const kv = raw.match(/^([^:#：][^:：]*)[:：]\s*(.*)$/);
      if (!kv) continue;
      key = kv[1].trim();
      const v = kv[2].trim();
      fm[key] = v.startsWith('[') && v.endsWith(']')
        ? v.slice(1, -1).split(',').map(unquote).filter(Boolean)
        : v === '' ? '' : unquote(v);
    }
    // 末尾收尾：最后一行若是块标量，去掉尾部多余换行
    if (key && isBlock(fm[key])) fm[key].text = fm[key].text.replace(/\n+$/, '');
  }
  return {fm, body: m ? text.slice(m[0].length) : text};
}
export const pick = (fm, keys) => {
  for (const k of keys) for (const f of Object.keys(fm)) {
    if (f.toLowerCase() !== k.toLowerCase()) continue;
    const v = fm[f];
    if (v === '' || v == null) continue;
    if (isBlock(v)) return v.text;
    return v;
  }
  return undefined;
};

// —— keep：frontmatter 里软件未消费的自定义键原样保留，写回时展开（如「主题: 类时纠缠」不再丢） ——
// 各模块解析时实际消费的键（含中英别名，大小写不敏感）；没列进来的键进 keep 随内容走。
// 将来新增正式消费的字段时同步加进对应清单：老文件里已进 keep 的副本会多写一轮（无害）。
export const CONSUMED = {
  // 指标键（follows / shares / impressions / ctr / duration 及其中文别名）必须列全：
  // serialize 写回时统一用中文键（涨粉 / 分享 / 曝光 / 封面点击率 / 平均观看时长），
  // 漏列会让已消费的指标同时进 keep，写回后 frontmatter 出现重复行
  works: ['title', '标题', 'name', 'date', '发布时间', '发布日期', 'published', 'publishedAt', 'created', '创建时间', 'direction', '研究方向', '方向', 'tags', 'tag', '标签', '话题', 'media', '类型', 'type', '形式', 'views', '观看', '浏览', '阅读', '播放', 'likes', '点赞', 'comments', '评论', 'saves', '收藏', 'follows', '涨粉', 'shares', '分享', '转发', 'impressions', '曝光', 'ctr', '点击率', '封面点击率', 'duration', '平均观看', '平均观看时长', '时长'],
  notes: ['title', '标题', 'name', 'tags', 'tag', '标签', '话题'],
  ideas: ['title', '标题', 'name', 'status', '状态', 'platform', '平台', 'priority', '优先级', 'note', '备注', 'description', '简介'],
  drafts: ['title', '标题', 'name', 'source', '来源选题', '选题'],
  readings: ['title', '标题', 'name', 'author', '作者', 'by', 'source', '来源', '出处', 'url', '链接', 'folder', '分类', '目录', 'group', 'date', '收藏日期', '发布日期', 'published'],
  archives: ['title', '标题', 'name', 'date', '收档日期', '创建日期', 'published'],
};
// 所有模块序列化都会写回的通用键：不算自定义
export const COMMON_FM = ['deepnotes-id', 'updated'];
export function keepOf(fm, kind) {
  const used = new Set([...(CONSUMED[kind] || []), ...COMMON_FM].map(k => k.toLowerCase()));
  const keep = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === '' || v == null) continue;
    if (used.has(k.toLowerCase())) continue;
    keep[k] = v;
  }
  return Object.keys(keep).length ? keep : undefined;
}

export function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[,，\s%秒s]/gi, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)(万|w|k|千)?$/i);
  if (!m) return null;
  const mul = {万: 1e4, w: 1e4, W: 1e4, k: 1e3, K: 1e3, 千: 1e3}[m[2]] || 1;
  // 归整到 6 位小数：只为清掉 1.2万 → 12000.000000002 这类浮点尾巴；
  // 原先 ×10 的一位小数取整会把 ctr（点击率常是 0.062 这类小数）抹成 0.1
  return Math.round(Number(m[1]) * mul * 1e6) / 1e6;
}
export function tagsOf(fm, body) {
  const raw = pick(fm, ['tags', 'tag', '标签', '话题']);
  const list = Array.isArray(raw) ? raw : raw ? String(raw).split(/[,，\s]+/) : [];
  for (const m of body.matchAll(/(?:^|\s)#([^\s#，。,.!?！？、；;:：()（）[\]]+)/g)) list.push(m[1]);
  return [...new Set(list.map(t => t.replace(/^#/, '').trim()).filter(t => t && !/^\d+$/.test(t)))];
}

// —— 标题识别：同时支持 ATX（# 标题）与 Setext（标题文字\n=== / ---），大纲 / 镜像层 / 导入三处统一调用 ——
// 返回 {level, text}；不是标题行返回 null。Setext 需看 i+1 行。
export function headingAt(lines, i) {
  const ln = String(lines?.[i] ?? '');
  const atx = ln.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
  if (atx) return {level: atx[1].length, text: atx[2].trim()};
  const next = String(lines?.[i + 1] ?? '');
  // Setext 要求本行非空：空行 + --- 是分隔线（hr），不是标题
  if (ln.trim() && /^=+\s*$/.test(next)) return {level: 1, text: ln.trim()};
  if (ln.trim() && /^-+\s*$/.test(next)) return {level: 2, text: ln.trim()};
  return null;
}

// —— 分类：作品 / 草稿 / 选题 / 方法笔记 / 阅读 / 档案，按文件夹名识别；未识别的全部作为方法笔记 ——
export const RULES = [
  ['works', /(作品|works?$|published|已发布)/i],
  ['readings', /(阅读|readings?$|书架|书摘|稍后读)/i],
  ['archives', /(档案|archives?$|个人简介|profile)/i],
  ['drafts', /(草稿|创作台|drafts?$|正在写|写作中)/i],
  ['ideas', /(选题|ideas?$|灵感)/i],
  ['methods', /(方法|methods?$|模板|templates?$|流程|workflow|知识|卡片|notes?$)/i]
];
export const METHODS_RE = RULES.find(([k]) => k === 'methods')[1];

// 方法笔记落盘路径：分类根不重复拼接，子目录全链保留（三层以上不再压平，不同子目录里的
// 同名文件不再互相覆盖）；文件直接在分类根下时归入「笔记」兜底；分类兜底命中的真实子目录名
// （不匹配方法库规则的，如「读书笔记」）仍原样保留。
// rootName：分类根目录名；restDirs：分类根之后的子目录链（无分类根时跳过第一层传入）。
export function notePath(rootName, restDirs, filename) {
  const sub = restDirs.length ? restDirs.join('/')
    : (rootName && !METHODS_RE.test(rootName) ? rootName : '笔记');
  return `05-方法库 methods/${sub}/${filename}`;
}

// —— 稳定 id：优先用 frontmatter 的 deepnotes-id（上次写盘留下的），重导入 / 自动同步不再按
// 下标重新编号——否则两次解析的「n4」会指向不同文件，diff 按 id 配对就把对方路径的文件
// 误移进 .trash（丢笔记的根因）。没有 deepnotes-id 的（Obsidian 里新加的文件）用
// 「前缀 + 文件相对路径散列」兜底：同一文件无论导入次序、中途插入了新文件，id 都不变。 ——
export const ID_OK = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const hash32 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0; return h.toString(36); };
export function settleIds(items, prefix) {
  const used = new Set();
  for (const it of items) {
    const stable = String(pick(it.fm || {}, ['deepnotes-id']) || '');
    if (ID_OK.test(stable) && !used.has(stable)) { it.id = stable; used.add(stable); }
  }
  for (const it of items) {
    if (it.id) continue;
    const key = String(it.rel || it.path || it.title || '');
    let cand = prefix + hash32(key);
    for (let j = 1; used.has(cand); j++) cand = prefix + hash32(key + '-' + j); // 散列撞号：确定性加尾再散
    it.id = cand;
    used.add(cand);
  }
  for (const it of items) delete it.fm;
  return items;
}
