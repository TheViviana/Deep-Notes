// 软件内知识库导入：把一个 Markdown 文件夹（如 Obsidian 仓库）解析成看板数据。
// 解析规则与 scripts/import-notes.mjs 一致；区别是纯浏览器完成（目录选择器 + File API），
// 未识别的文件夹一律作为方法笔记导入（知识库不丢文件），且不要求必须有「作品」文件夹。
// 不联网，不读取选择范围之外的任何文件。
import {normalizeWork} from './worksStore';

const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// 不设容量上限：知识库有多少内容就导入多少，图谱与列表天然支持滚动与折叠。
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const isMd = name => /\.(md|markdown)$/i.test(name);
const clean = body => String(body).replace(/\r/g, '').trim();
const unquote = s => String(s).trim().replace(/^['"]|['"]$/g, '');

// —— frontmatter：key: value、key: [a, b]、以及「- 项」列表（与导入脚本同一套简化规则） ——
function parse(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    let key = null;
    for (const raw of m[1].split(/\r?\n/)) {
      const item = raw.match(/^\s*-\s+(.*)$/);
      if (item && key) { if (!Array.isArray(fm[key])) fm[key] = []; fm[key].push(unquote(item[1])); continue; }
      const kv = raw.match(/^([^:#][^:]*):\s*(.*)$/);
      if (!kv) continue;
      key = kv[1].trim();
      const v = kv[2].trim();
      fm[key] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : v === '' ? '' : unquote(v);
    }
  }
  return {fm, body: m ? text.slice(m[0].length) : text};
}
const pick = (fm, keys) => { for (const k of keys) for (const f of Object.keys(fm)) if (f.toLowerCase() === k.toLowerCase() && fm[f] !== '') return fm[f]; return undefined; };

// —— keep：frontmatter 里软件未消费的自定义键原样保留，写回时展开（如「主题: 类时纠缠」不再丢） ——
// 各模块解析时实际消费的键（含中英别名，大小写不敏感）；没列进来的键进 keep 随内容走
const CONSUMED = {
  works: ['title', '标题', 'name', 'date', '发布时间', '发布日期', 'published', 'publishedAt', 'created', '创建时间', 'direction', '研究方向', '方向', 'tags', 'tag', '标签', '话题', 'media', '类型', 'type', '形式', 'views', '观看', '浏览', '阅读', '播放', 'likes', '点赞', 'comments', '评论', 'saves', '收藏'],
  notes: ['title', '标题', 'name', 'tags', 'tag', '标签', '话题'],
  ideas: ['title', '标题', 'name', 'status', '状态', 'platform', '平台', 'priority', '优先级', 'note', '备注', 'description', '简介'],
  drafts: ['title', '标题', 'name', 'source', '来源选题', '选题'],
  readings: ['title', '标题', 'name', 'author', '作者', 'by', 'source', '来源', '出处', 'url', '链接', 'folder', '分类', '目录', 'group', 'date', '收藏日期', '发布日期', 'published'],
  archives: ['title', '标题', 'name', 'date', '收档日期', '创建日期', 'published'],
};
// 所有模块序列化都会写回的通用键：不算自定义
const COMMON_FM = ['deepnotes-id', 'updated'];
function keepOf(fm, kind) {
  const used = new Set([...(CONSUMED[kind] || []), ...COMMON_FM].map(k => k.toLowerCase()));
  const keep = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === '' || v == null) continue;
    if (used.has(k.toLowerCase())) continue;
    keep[k] = v;
  }
  return Object.keys(keep).length ? keep : undefined;
}
function num(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[,，\s%秒s]/gi, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)(万|w|k|千)?$/i);
  if (!m) return null;
  const mul = {万: 1e4, w: 1e4, W: 1e4, k: 1e3, K: 1e3, 千: 1e3}[m[2]] || 1;
  return Math.round(Number(m[1]) * mul * 10) / 10;
}
const dateOf = (v, ms) => {
  const s = v ? String(v).trim().replace(/\//g, '-').replace(/^(\d{4}-\d{1,2}-\d{1,2})$/, '$1 00:00') : '';
  const d = s ? new Date(s) : null;
  const t = d && !isNaN(d) ? d : new Date(ms || Date.now());
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
};

// —— 稳定 id：优先用 frontmatter 的 deepnotes-id（上次写盘留下的），重导入 / 自动同步不再按
// 下标重新编号——否则两次解析的「n4」会指向不同文件，diff 按 id 配对就把对方路径的文件
// 误移进 .trash（丢笔记的根因）。没有 deepnotes-id 的（Obsidian 里新加的文件）用
// 「前缀 + 文件相对路径散列」兜底：同一文件无论导入次序、中途插入了新文件，id 都不变——
// 按遍历次序补号会在首次写盘前漂移（readdir 顺序一变 id 全变），触发整库无谓的移动重写。 ——
const ID_OK = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const hash32 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0; return h.toString(36); };
function settleIds(items, prefix) {
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
function tagsOf(fm, body) {
  const raw = pick(fm, ['tags', 'tag', '标签', '话题']);
  const list = Array.isArray(raw) ? raw : raw ? String(raw).split(/[,，\s]+/) : [];
  for (const m of body.matchAll(/(?:^|\s)#([^\s#，。,.!?！？、；;:：()（）[\]]+)/g)) list.push(m[1]);
  return [...new Set(list.map(t => t.replace(/^#/, '').trim()).filter(t => t && !/^\d+$/.test(t)))];
}

// —— 分类：作品 / 草稿 / 选题 / 方法笔记 / 阅读 / 档案，按文件夹名识别；未识别的全部作为方法笔记 ——
const RULES = [
  ['works', /(作品|works?$|published|已发布)/i],
  ['readings', /(阅读|readings?$|书架|书摘|稍后读)/i],
  ['archives', /(档案|archives?$|个人简介|profile)/i],
  ['drafts', /(草稿|创作台|drafts?$|正在写|写作中)/i],
  ['ideas', /(选题|ideas?$|灵感)/i],
  ['methods', /(方法|methods?$|模板|templates?$|流程|workflow|知识|卡片|notes?$)/i]
];
const classify = dirs => {
  for (const dir of dirs) for (const [kind, re] of RULES) if (re.test(dir)) return kind;
  return 'methods';
};

// —— 目录选择：webkitdirectory 让用户挑一个文件夹，返回其中的 File 列表；取消返回 null ——
export function pickVaultFolder() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    let done = false;
    input.onchange = () => { done = true; resolve(input.files && input.files.length ? [...input.files] : null); };
    // 用户点「取消」时不会触发 change：窗口重新获得焦点后仍无结果就按取消处理
    window.addEventListener('focus', () => setTimeout(() => { if (!done) resolve(null); }, 400), {once: true});
    input.click();
  });
}

// —— 选定文件导入：不选整个文件夹，只挑一个或多个 .md 文件（解析规则与整库导入一致） ——
export function pickMdFiles() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.md,.markdown,text/markdown';
    let done = false;
    input.onchange = () => { done = true; resolve(input.files && input.files.length ? [...input.files] : null); };
    window.addEventListener('focus', () => setTimeout(() => { if (!done) resolve(null); }, 400), {once: true});
    input.click();
  });
}

// —— 主入口：File 列表 → 看板数据（works / ideas / drafts / snapshot / concepts） ——
// target：'auto' 按文件夹名自动分类；也可指定 'works' | 'methods' | 'ideas' | 'drafts' | 'readings' | 'archives'，把全部文件归入所选模块
export async function parseVault(fileList, target = 'auto') {
  const all = fileList.filter(f => f && isMd(f.name) && !f.name.startsWith('.'));
  const files = all.map(f => {
    // webkitRelativePath 形如「仓库名/子目录/文件.md」；第一段是所选文件夹名，分类时跳过
    const parts = (f.webkitRelativePath || f.name).split('/');
    const rel = parts.length > 1 ? parts.slice(1).join('/') : f.name;
    const dirs = rel.split('/').slice(0, -1).filter(seg => seg && !seg.startsWith('.') && !SKIP_DIRS.has(seg));
    return {file: f, rel, dirs, kind: target !== 'auto' ? target : classify(dirs)};
  });
  const read = await Promise.all(files.map(async x => {
    const {fm, body} = parse(await x.file.text());
    return {...x, fm, body};
  }));

  const bucket = {works: [], methods: [], ideas: [], drafts: [], readings: [], archives: []};
  for (const x of read) {
    const title = String(pick(x.fm, ['title', '标题', 'name']) || x.file.name.replace(/\.(md|markdown)$/i, '')).trim();
    bucket[x.kind].push({...x, title});
  }
  const byDate = (a, b) => b.date.localeCompare(a.date);

  // 带 fm 构建 → 排序 → settleIds 定 id → 归一化；顺序保证 id 只依赖 deepnotes-id，不依赖文件顺序
  // rel 一并带上：settleIds 用它做稳定散列，normalizeWork / 随后的 delete 会把临时字段清掉
  const worksRaw = bucket.works.map(x => {
    const media = /视频|video/i.test(String(pick(x.fm, ['media', '类型', 'type', '形式']) || '')) ? 'video' : 'images';
    const date = dateOf(pick(x.fm, ['date', '发布时间', '发布日期', 'published', 'publishedAt', 'created', '创建时间']), x.file.lastModified);
    return {
      fm: x.fm,
      rel: x.rel,
      title: x.title, date,
      direction: String(pick(x.fm, ['direction', '研究方向', '方向']) || '').trim(),
      views: num(pick(x.fm, ['views', '观看', '浏览', '阅读', '播放'])) ?? 0,
      likes: num(pick(x.fm, ['likes', '点赞'])) ?? 0,
      comments: num(pick(x.fm, ['comments', '评论'])) ?? 0,
      saves: num(pick(x.fm, ['saves', '收藏'])) ?? 0,
      body: clean(x.body), tags: tagsOf(x.fm, x.body), media, keep: keepOf(x.fm, 'works')
    };
  }).sort(byDate);
  settleIds(worksRaw, 'w');
  const works = worksRaw.map(w => normalizeWork(w));

  const noteTags = [];
  // 文件直接在方法库根目录时（dirs.length === 1）：dirs[0] 就是分类根名本身（如「05-方法库 methods」），
  // 不能再拼一遍得到「05-方法库 methods/05-方法库 methods/…」——归入「笔记」兜底；
  // 分类兜底命中的真实子目录名（如「读书笔记」，不匹配方法库规则）仍原样保留。
  const METHODS_RE = RULES.find(([k]) => k === 'methods')[1];
  const notes = bucket.methods.map(x => {
    // 子目录全链保留（05-方法库/A/B/xx.md）：三层以上不再压平，不同子目录里的同名文件也不再互相覆盖
    const sub = x.dirs.length > 1 ? x.dirs.slice(1).join('/')
      : (x.dirs[0] && !METHODS_RE.test(x.dirs[0]) ? x.dirs[0] : '笔记');
    noteTags.push(...tagsOf(x.fm, x.body));
    return {fm: x.fm, rel: x.rel, title: x.title, path: `05-方法库 methods/${sub}/${x.file.name}`, body: clean(x.body), keep: keepOf(x.fm, 'notes')};
  });
  settleIds(notes, 'n');
  for (const n of notes) delete n.rel;

  const ideas = bucket.ideas.map((x, i) => {
    const status = String(pick(x.fm, ['status', '状态']) || '待写');
    return {id: i + 1, title: x.title, platform: String(pick(x.fm, ['platform', '平台']) || '本地'), priority: ['高', '中', '低'].includes(String(pick(x.fm, ['priority', '优先级']))) ? String(pick(x.fm, ['priority', '优先级'])) : '中',
      status: ['待写', '待扩展', '已转草稿'].includes(status) ? status : '待写', note: String(pick(x.fm, ['note', '备注', 'description', '简介']) || clean(x.body).replace(/^#.*\n/, '').trim().slice(0, 120)), keep: keepOf(x.fm, 'ideas')};
  });

  const drafts = bucket.drafts.map(x => {
    const src = String(pick(x.fm, ['source', '来源选题', '选题']) || '');
    const idea = ideas.find(d => d.title === src);
    return {fm: x.fm, rel: x.rel, title: x.title, body: clean(x.body), source: idea ? idea.id : null, keep: keepOf(x.fm, 'drafts')};
  });
  settleIds(drafts, 'draft-');
  for (const d of drafts) delete d.rel;

  // 阅读区：别人写好的内容（作者 / 来源 / 分类可选，写在 frontmatter 里）。
  // folder 是应用内的左侧分类：落盘在每篇 .md 的 frontmatter 里，导入 / 自动同步都不会丢。
  const readings = bucket.readings.map(x => ({
    fm: x.fm, rel: x.rel, title: x.title,
    author: String(pick(x.fm, ['author', '作者', 'by']) || ''),
    source: String(pick(x.fm, ['source', '来源', '出处', 'url', '链接']) || ''),
    folder: String(pick(x.fm, ['folder', '分类', '目录', 'group']) || '').trim(),
    date: dateOf(pick(x.fm, ['date', '收藏日期', '发布日期', 'published']), x.file.lastModified).slice(0, 10),
    body: clean(x.body), keep: keepOf(x.fm, 'readings')
  }));
  settleIds(readings, 'reading-');
  for (const r of readings) delete r.rel;
  readings.sort((a, b) => b.date.localeCompare(a.date));

  // 档案区：创作者自己的个人档案（简介、回顾、清单等），同样参与双链与图谱。
  const archives = bucket.archives.map(x => ({
    fm: x.fm, rel: x.rel, title: x.title,
    date: dateOf(pick(x.fm, ['date', '收档日期', '创建日期', 'published']), x.file.lastModified).slice(0, 10),
    body: clean(x.body), keep: keepOf(x.fm, 'archives')
  }));
  settleIds(archives, 'archive-');
  for (const a of archives) delete a.rel;
  archives.sort((a, b) => b.date.localeCompare(a.date));

  // 概念词：内容里出现的全部话题标签（不设数量上限），出现越多在概念网络里越靠前。
  const count = new Map();
  for (const t of [...works.flatMap(w => w.tags), ...noteTags]) count.set(t, (count.get(t) || 0) + 1);
  const concepts = [...count].sort((a, b) => b[1] - a[1]).map(([t]) => [t, [t.toLowerCase()]]);

  const dates = works.map(w => w.date.slice(0, 10)).sort();
  const snapshot = {
    account: '我的知识库', followers: null, capturedAt: today(),
    publishedFrom: dates[0] || '', publishedTo: dates[dates.length - 1] || '', source: '导入自本地笔记'
  };

  return {
    vault: (fileList[0]?.webkitRelativePath || '').split('/')[0] || '所选文件夹',
    works, notes, ideas, drafts, readings, archives, snapshot, concepts,
    counts: {all: read.length, works: works.length, notes: notes.length, ideas: ideas.length, drafts: drafts.length, readings: readings.length, archives: archives.length}
  };
}
