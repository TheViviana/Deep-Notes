// 软件内知识库导入：把一个 Markdown 文件夹（如 Obsidian 仓库）解析成看板数据。
// 解析规则与 scripts/import-notes.mjs 一致；区别是纯浏览器完成（目录选择器 + File API），
// 未识别的文件夹一律作为方法笔记导入（知识库不丢文件），且不要求必须有「作品」文件夹。
// 不联网，不读取选择范围之外的任何文件。
// frontmatter 解析 / keep / 分类规则 / 稳定 id 等共享逻辑在 ./vaultRules（零依赖，
// 与 scripts/import-notes.mjs 共用一份，两侧规则永不分叉）。
import {normalizeWork} from './worksStore';
import {parse, pick, keepOf, num, tagsOf, RULES, notePath, settleIds} from './vaultRules';

const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// 不设容量上限：知识库有多少内容就导入多少，图谱与列表天然支持滚动与折叠。
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const isMd = name => /\.(md|markdown)$/i.test(name);
const clean = body => String(body).replace(/\r/g, '').trim();
const dateOf = (v, ms) => {
  const s = v ? String(v).trim().replace(/\//g, '-').replace(/^(\d{4}-\d{1,2}-\d{1,2})$/, '$1 00:00') : '';
  const d = s ? new Date(s) : null;
  const t = d && !isNaN(d) ? d : new Date(ms || Date.now());
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
};

// 稳定 id（deepnotes-id 优先 + 相对路径散列兜底）、tagsOf 均来自 vaultRules

// —— 分类：按文件夹名识别；未识别的全部作为方法笔记。RULES 来自 vaultRules。
// 返回 {kind, root}：root 是分类根在 dirs 中的下标（-1 表示没有分类根——分类兜底或指定模块），
// 生成方法笔记 path 时分类根之后的子目录全链保留（与 CLI 同一规则，见 notePath）。 ——
const classify = dirs => {
  for (let i = 0; i < dirs.length; i++) for (const [kind, re] of RULES) if (re.test(dirs[i])) return {kind, root: i};
  return {kind: 'methods', root: -1};
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
  // 跳过目录里的 .md 同样不导入：桌面版有主进程 SKIP 兜底，网页版没有——
  // 不过滤的话 .trash 里已删除的笔记会整体复活，.obsidian / .git 里的说明文件也会混进来
  const skipped = p => p.split('/').some(seg => seg.startsWith('.') || SKIP_DIRS.has(seg));
  const all = fileList.filter(f => f && isMd(f.name) && !skipped(f.webkitRelativePath || f.name));
  const files = all.map(f => {
    // webkitRelativePath 形如「仓库名/子目录/文件.md」；第一段是所选文件夹名，分类时跳过
    const parts = (f.webkitRelativePath || f.name).split('/');
    const rel = parts.length > 1 ? parts.slice(1).join('/') : f.name;
    const dirs = rel.split('/').slice(0, -1).filter(seg => seg && !seg.startsWith('.') && !SKIP_DIRS.has(seg));
    const c = target !== 'auto' ? {kind: target, root: -1} : classify(dirs);
    return {file: f, rel, dirs, kind: c.kind, root: c.root};
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
      updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, // frontmatter 的 updated 收进编辑日期，写回不丢
      direction: String(pick(x.fm, ['direction', '研究方向', '方向']) || '').trim(),
      views: num(pick(x.fm, ['views', '观看', '浏览', '阅读', '播放'])) ?? 0,
      likes: num(pick(x.fm, ['likes', '点赞'])) ?? 0,
      comments: num(pick(x.fm, ['comments', '评论'])) ?? 0,
      saves: num(pick(x.fm, ['saves', '收藏'])) ?? 0,
      // 指标字段与 CLI 同一套别名（scripts/import-notes.mjs）：缺侧会让同一篇作品
      // 在命令行导入时有数据、应用内导入时分析面板全是 null
      follows: num(pick(x.fm, ['follows', '涨粉'])),
      shares: num(pick(x.fm, ['shares', '分享', '转发'])) ?? 0,
      impressions: num(pick(x.fm, ['impressions', '曝光'])),
      ctr: num(pick(x.fm, ['ctr', '点击率', '封面点击率'])),
      duration: num(pick(x.fm, ['duration', '平均观看', '平均观看时长', '时长'])),
      body: clean(x.body), tags: tagsOf(x.fm, x.body), media, keep: keepOf(x.fm, 'works')
    };
  }).sort(byDate);
  settleIds(worksRaw, 'w');
  const works = worksRaw.map(w => normalizeWork(w));

  const noteTags = [];
  // 方法笔记 path 由 notePath 统一生成（vaultRules，与 CLI 同一份）：分类根之后的子目录全链保留
  // （05-方法库/A/B/xx.md 三层以上不再压平，不同子目录里的同名文件也不再互相覆盖）；
  // 没有分类根（分类兜底 / 指定模块导入）时跳过第一层目录，rootName 用第一层做「笔记」兜底判断。
  const notes = bucket.methods.map(x => {
    const rootName = (x.root >= 0 ? x.dirs[x.root] : x.dirs[0]) || '';
    const rest = x.root >= 0 ? x.dirs.slice(x.root + 1) : x.dirs.slice(1);
    noteTags.push(...tagsOf(x.fm, x.body));
    return {fm: x.fm, rel: x.rel, title: x.title, path: notePath(rootName, rest, x.file.name), body: clean(x.body),
      updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'notes')};
  });
  settleIds(notes, 'n'); // rel 保留：含 iCloud 占位文件的同步要按真实路径匹配条目（main.jsx keepOld）

  // 选题 id 与其余五个模块同口径：优先 frontmatter 的 deepnotes-id，缺失时按标题散列补号。
  // 旧的「数组下标 + 1」会在增删一个 .md 后整体移位，草稿的 source 指向错误选题、图谱连线错乱。
  const ideas = bucket.ideas.map(x => {
    const status = String(pick(x.fm, ['status', '状态']) || '待写');
    // platform 默认值与 CLI / 应用内「新建选题」一致（小红书）
    return {fm: x.fm, title: x.title, platform: String(pick(x.fm, ['platform', '平台']) || '小红书'), priority: ['高', '中', '低'].includes(String(pick(x.fm, ['priority', '优先级']))) ? String(pick(x.fm, ['priority', '优先级'])) : '中',
      status: ['待写', '待扩展', '已转草稿'].includes(status) ? status : '待写', note: String(pick(x.fm, ['note', '备注', 'description', '简介']) || clean(x.body).replace(/^#.*\n/, '').trim().slice(0, 120)), keep: keepOf(x.fm, 'ideas')};
  });
  settleIds(ideas, 'idea-'); // 选题池常合并成一个 .md：以标题做稳定散列，顺序变化也不漂移

  const drafts = bucket.drafts.map(x => {
    const src = String(pick(x.fm, ['source', '来源选题', '选题']) || '');
    const idea = ideas.find(d => d.title === src);
    return {fm: x.fm, rel: x.rel, title: x.title, body: clean(x.body), source: idea ? idea.id : null,
      updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'drafts')};
  });
  settleIds(drafts, 'draft-');

  // 阅读区：别人写好的内容（作者 / 来源 / 分类可选，写在 frontmatter 里）。
  // folder 是应用内的左侧分类：落盘在每篇 .md 的 frontmatter 里，导入 / 自动同步都不会丢。
  const readings = bucket.readings.map(x => ({
    fm: x.fm, rel: x.rel, title: x.title,
    author: String(pick(x.fm, ['author', '作者', 'by']) || ''),
    source: String(pick(x.fm, ['source', '来源', '出处', 'url', '链接']) || ''),
    folder: String(pick(x.fm, ['folder', '分类', '目录', 'group']) || '').trim(),
    date: dateOf(pick(x.fm, ['date', '收藏日期', '发布日期', 'published']), x.file.lastModified).slice(0, 10),
    body: clean(x.body),
    updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'readings')
  }));
  settleIds(readings, 'reading-');
  readings.sort((a, b) => b.date.localeCompare(a.date));

  // 档案区：创作者自己的个人档案（简介、回顾、清单等），同样参与双链与图谱。
  const archives = bucket.archives.map(x => ({
    fm: x.fm, rel: x.rel, title: x.title,
    date: dateOf(pick(x.fm, ['date', '收档日期', '创建日期', 'published']), x.file.lastModified).slice(0, 10),
    body: clean(x.body),
    updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'archives')
  }));
  settleIds(archives, 'archive-');
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
