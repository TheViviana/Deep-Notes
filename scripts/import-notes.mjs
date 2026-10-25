#!/usr/bin/env node
// 把一个 Markdown 笔记文件夹（例如 Obsidian 仓库）转换成看板数据 src/data/my-data.js，并让看板改读它。
// 只用 Node 自带模块，不联网，不修改你的笔记。
//
// 用法：
//   node scripts/import-notes.mjs --vault <笔记文件夹> [选项]
//   node scripts/import-notes.mjs --reset            # 切回示例数据
//
// 选项：
//   --works <文件夹>     作品所在文件夹（相对 vault，可多次传）；不传时按文件夹名自动识别
//   --methods <文件夹>   方法笔记所在文件夹
//   --ideas <文件夹>     选题所在文件夹
//   --drafts <文件夹>    草稿所在文件夹
//   --all-as-notes       没被识别的笔记也作为方法笔记导入
//   --account <名字>     账号名（默认「我的账号」）
//   --followers <数字>   粉丝数
//   --max-works <数字>   最多导入多少篇作品（默认不限制，按日期取最新）
//   --max-notes <数字>   最多导入多少篇方法笔记（默认不限制）
//   --out <文件>         输出到指定文件，且不切换看板数据（用于测试）
// frontmatter 解析 / keep / 分类规则 / 稳定 id 与软件内导入共用同一份 src/neural/vaultRules.js
// （零依赖纯模块）——两侧规则永不分叉，改规则必须两侧同时验证。
import {readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync} from 'node:fs';
import {join, relative, resolve, dirname, basename, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parse, pick, keepOf, num, tagsOf, RULES, notePath, settleIds} from '../src/neural/vaultRules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src/data');
const INDEX = join(DATA, 'index.js');
const indexFor = file => `// 看板读取的数据入口。默认使用虚构示例；运行 \`npm run import -- --vault <笔记文件夹>\` 后会切换到 my-data.js。\nexport * from './${file}';\n`;

// —— 参数 ——
const args = process.argv.slice(2);
const opt = {works: [], methods: [], ideas: [], drafts: [], readings: [], archives: []};
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => args[++i];
  if (a === '--vault') opt.vault = next();
  else if (['--works', '--methods', '--ideas', '--drafts', '--readings', '--archives'].includes(a)) opt[a.slice(2)].push(next());
  else if (a === '--all-as-notes') opt.allAsNotes = true;
  else if (a === '--account') opt.account = next();
  else if (a === '--followers') opt.followers = Number(next());
  else if (a === '--max-works') opt.maxWorks = Number(next());
  else if (a === '--max-notes') opt.maxNotes = Number(next());
  else if (a === '--out') opt.out = next();
  else if (a === '--reset') opt.reset = true;
  else if (a === '-h' || a === '--help') opt.help = true;
  else { console.error(`未知参数：${a}（用 --help 查看用法）`); process.exit(1); }
}
if (opt.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
if (opt.reset) { writeFileSync(INDEX, indexFor('sample.js')); console.log('已切回示例数据（src/data/sample.js）。'); process.exit(0); }
if (!opt.vault || !existsSync(opt.vault) || !statSync(opt.vault).isDirectory()) { console.error('请用 --vault 指定一个存在的笔记文件夹。'); process.exit(1); }
const VAULT = resolve(opt.vault);
const maxWorks = opt.maxWorks || Infinity, maxNotes = opt.maxNotes || Infinity;

// —— 读取 Markdown ——
const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store']);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    // 符号链接一律跳过（与主进程 readMd 同口径）：跟随链接会把库外内容静默导入
    // （如 ln -s ~/Documents docs），自引用链接更会无限递归直到路径超长崩溃
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(p); // 与软件内导入 isMd 同口径
  }
  return out;
}

const pad = n => String(n).padStart(2, '0');
function dateOf(v, file) {
  // 只有日期时按本地时间的 00:00 解析（避免被当成 UTC 而跨天）
  const s = v ? String(v).trim().replace(/\//g, '-').replace(/^(\d{4}-\d{1,2}-\d{1,2})$/, '$1 00:00') : '';
  const d = s ? new Date(s) : null;
  const t = d && !isNaN(d) ? d : statSync(file).mtime;
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
const clean = body => body.replace(/\r/g, '').trim();

// —— 分类 ——
const norm = p => p.split(/[\\/]/).filter(Boolean).join('/');
function classify(rel) {
  const dirs = rel.split(sep).slice(0, -1);
  for (const kind of ['works', 'readings', 'archives', 'drafts', 'ideas', 'methods']) for (const f of opt[kind]) {
    const prefix = norm(f);
    if (norm(rel).startsWith(prefix + '/')) return {kind, root: prefix.split('/').length};
  }
  for (let i = 0; i < dirs.length; i++) for (const [kind, re] of RULES) {
    if (opt[kind].length) continue;
    if (re.test(dirs[i])) return {kind, root: i + 1};
  }
  return opt.allAsNotes ? {kind: 'methods', root: 0} : null;
}

const files = walk(VAULT);
const bucket = {works: [], methods: [], ideas: [], drafts: [], readings: [], archives: []};
for (const file of files) {
  const rel = relative(VAULT, file), c = classify(rel);
  if (!c) continue;
  const {fm, body} = parse(readFileSync(file, 'utf8'));
  const title = String(pick(fm, ['title', '标题', 'name']) || basename(file).replace(/\.(md|markdown)$/i, '')).trim();
  bucket[c.kind].push({file, rel, root: c.root, fm, body, title});
}

// —— 生成数据（frontmatter 里的 updated 收进 updatedAt；未消费键进 keep 随内容走） ——
const worksRaw = bucket.works.map(x => {
  const media = /视频|video/i.test(String(pick(x.fm, ['media', '类型', 'type', '形式']) || '')) ? 'video' : 'images';
  const p = {
    title: x.title, date: dateOf(pick(x.fm, ['date', '发布时间', '发布日期', 'published', 'publishedAt', 'created', '创建时间']), x.file),
    views: num(pick(x.fm, ['views', '观看', '浏览', '阅读', '播放'])) ?? 0,
    likes: num(pick(x.fm, ['likes', '点赞'])) ?? 0,
    comments: num(pick(x.fm, ['comments', '评论'])) ?? 0,
    saves: num(pick(x.fm, ['saves', '收藏'])) ?? 0,
    follows: num(pick(x.fm, ['follows', '涨粉'])),
    shares: num(pick(x.fm, ['shares', '分享', '转发'])) ?? 0,
    impressions: num(pick(x.fm, ['impressions', '曝光'])),
    ctr: num(pick(x.fm, ['ctr', '点击率', '封面点击率'])),
    duration: num(pick(x.fm, ['duration', '平均观看', '平均观看时长', '时长']))
  };
  return {fm: x.fm, rel: x.rel, post: p, content: {title: x.title, body: clean(x.body), tags: tagsOf(x.fm, x.body), media},
    updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'works')};
}).sort((a, b) => b.post.date.localeCompare(a.post.date));
settleIds(worksRaw, 'w');
for (const w of worksRaw) delete w.rel;
const works = worksRaw.slice(0, maxWorks)
  .map(w => ({...w, post: {id: w.id, ...w.post, updatedAt: w.updatedAt || null}}));

const notes = bucket.methods.slice(0, maxNotes).map(x => {
  const parts = x.rel.split(sep);
  // 方法笔记 path 由 notePath 统一生成（与软件内导入同一份规则）：分类根之后的子目录全链保留，
  // 三层以上不再压平——不同子目录里的同名文件不再互相覆盖；没有分类根（--all-as-notes）时
  // 跳过库内第一层目录，与软件内 dirs.slice(1) 对齐。
  // 文件直接在库根（parts 只有文件名一段）时没有第一层目录可跳：rootName 取空，
  // 与软件内导入（dirs 为空 → rootName ''）同口径，否则文件名会被当成分类目录双层嵌套
  const rootName = (x.root > 0 ? parts[x.root - 1] : (parts.length > 1 ? parts[0] : '')) || '';
  const rest = x.root > 0 ? parts.slice(x.root, parts.length - 1) : parts.slice(1, parts.length - 1);
  return {fm: x.fm, rel: x.rel, title: x.title, path: notePath(rootName, rest, parts[parts.length - 1]), body: clean(x.body),
    updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'notes')};
});
settleIds(notes, 'n');
for (const n of notes) delete n.rel;

const ideas = bucket.ideas.map(x => {
  const status = String(pick(x.fm, ['status', '状态']) || '待写');
  // 与应用内导入同口径：选题池常合并成一个 .md，id 不能再用数组下标（增删一篇会整体漂移）
  return {fm: x.fm, title: x.title, platform: String(pick(x.fm, ['platform', '平台']) || '小红书'), priority: ['高', '中', '低'].includes(String(pick(x.fm, ['priority', '优先级']))) ? String(pick(x.fm, ['priority', '优先级'])) : '中',
    status: ['待写', '待扩展', '已转草稿'].includes(status) ? status : '待写', note: String(pick(x.fm, ['note', '备注', 'description', '简介']) || clean(x.body).replace(/^#.*\n/, '').trim().slice(0, 120)), keep: keepOf(x.fm, 'ideas')};
});
settleIds(ideas, 'idea-'); // 无 deepnotes-id 时按标题散列，顺序变化也不漂移

const drafts = bucket.drafts.map(x => {
  const src = String(pick(x.fm, ['source', '来源选题', '选题']) || '');
  // 兼容两种写法：旧数据按标题，新落盘写选题 id（与应用内 importer 同口径，规则不分叉）
  const idea = ideas.find(d => d.title === src) || ideas.find(d => src && String(d.id) === src);
  return {fm: x.fm, rel: x.rel, title: x.title, body: clean(x.body), source: idea ? idea.id : null,
    updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'drafts')};
});
settleIds(drafts, 'draft-');
for (const d of drafts) delete d.rel;

// 阅读区：别人写好的内容（作者 / 来源 / 分类可选，写在 frontmatter 里；folder 是应用内左侧分类）。
const readings = bucket.readings.map(x => ({
  fm: x.fm, rel: x.rel, title: x.title,
  author: String(pick(x.fm, ['author', '作者', 'by']) || ''),
  source: String(pick(x.fm, ['source', '来源', '出处', 'url', '链接']) || ''),
  folder: String(pick(x.fm, ['folder', '分类', '目录', 'group']) || '').trim(),
  date: dateOf(pick(x.fm, ['date', '收藏日期', '发布日期', 'published']), x.file).slice(0, 10),
  body: clean(x.body),
  updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'readings')
}));
settleIds(readings, 'reading-');
for (const r of readings) delete r.rel;
readings.sort((a, b) => b.date.localeCompare(a.date));

// 档案区：创作者自己的个人档案（简介、回顾、清单等），同样参与双链与图谱。
const archives = bucket.archives.map(x => ({
  fm: x.fm, rel: x.rel, title: x.title,
  date: dateOf(pick(x.fm, ['date', '收档日期', '创建日期', 'published']), x.file).slice(0, 10),
  body: clean(x.body),
  updatedAt: String(pick(x.fm, ['updated']) || '') || undefined, keep: keepOf(x.fm, 'archives')
}));
settleIds(archives, 'archive-');
for (const a of archives) delete a.rel;
archives.sort((a, b) => b.date.localeCompare(a.date));

// 概念词：内容里出现的全部话题标签（不设数量上限），出现越多在概念网络里越靠前。
// 方法笔记的话题标签单独收集（与软件内导入同款：noteTags.push(...tagsOf(...))）
const noteTags = [];
for (const x of bucket.methods) noteTags.push(...tagsOf(x.fm, x.body));
const count = new Map();
for (const t of [...works.flatMap(w => w.content.tags), ...noteTags]) count.set(t, (count.get(t) || 0) + 1);
const concepts = [...count].sort((a, b) => b[1] - a[1]).map(([t]) => [t, [t.toLowerCase()]]);

const dates = works.map(w => w.post.date.slice(0, 10)).sort();
const today = new Date();
const snapshot = {
  account: opt.account || '我的账号', followers: Number.isFinite(opt.followers) ? opt.followers : null,
  capturedAt: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
  publishedFrom: dates[0] || '', publishedTo: dates[dates.length - 1] || '', source: '导入自本地笔记'
};

if (!works.length) {
  console.error(`没有找到作品笔记。请确认作品放在名字包含「作品 / works」的文件夹里，或用 --works <文件夹> 指定。\n识别到：方法笔记 ${notes.length}、选题 ${ideas.length}、草稿 ${drafts.length}。`);
  process.exit(2);
}

const J = v => JSON.stringify(v, null, 1);
// postContent 带 id：与 posts 按 id 关联，两篇同名作品不再共享第一篇的正文
// （软件内 worksStore.seedWorks 优先按 id 匹配，无 id 的老数据回退按 title）。
// stripTemp 只剥导入期临时字段 fm / rel；updatedAt 必须保留——写盘时它就是 frontmatter 的 updated。
const stripTemp = ({fm, rel, ...rest}) => rest;
const out = `// 由 scripts/import-notes.mjs 从「${basename(VAULT)}」生成。包含你的个人笔记内容，默认不提交到 git（见 .gitignore）。
// 重新导入：npm run import -- --vault <笔记文件夹>；切回示例数据：npm run import -- --reset

export const snapshot = ${J(snapshot)};

export const posts = ${J(works.map(w => w.post))};

export const postContent = ${J(works.map(w => ({id: w.id, ...w.content, ...(w.keep ? {keep: w.keep} : {})})))};

export const notes = ${J(notes.map(n => stripTemp(n)))};

export const seedIdeas = ${J(ideas)};

export const seedDrafts = ${J(drafts.map(stripTemp))};

export const seedReadings = ${J(readings.map(stripTemp))};

export const seedArchives = ${J(archives.map(stripTemp))};

export const concepts = ${J(concepts)};
`;
const target = opt.out ? resolve(opt.out) : join(DATA, 'my-data.js');
if (opt.out && !target.startsWith(ROOT + sep) && target !== ROOT) console.warn(`提示：--out 输出在项目之外：${target}`);
mkdirSync(dirname(target), {recursive: true});
// 原子替换（临时文件 + rename，与主进程 vault:write 同款）：写到一半被中断也不会留下
// 半截 JS——上一次导入已把 index.js 指到它，半截文件会让 build / dev 直接白屏。
const tmp = target + '.tmp-' + process.pid;
writeFileSync(tmp, out);
renameSync(tmp, target);
if (!opt.out) {
  // 数据落定后才切指针
  writeFileSync(INDEX, indexFor('my-data.js'));
  // index.js 被 git 跟踪而 my-data.js 被忽略时，提交会让别人克隆后构建失败——醒目提醒而不是默默改
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '--error-unmatch', 'src/data/index.js'], {stdio: 'pipe'}).status === 0;
  const ignored = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', 'src/data/my-data.js'], {stdio: 'pipe'}).status === 0;
  if (tracked && ignored) console.warn('⚠️  src/data/index.js 是被 git 跟踪的文件，本次已把它切到被 .gitignore 忽略的 my-data.js。\n   直接提交会让别人克隆后构建失败；提交前请运行 `npm run import -- --reset` 切回示例数据。');
}

console.log(`导入完成：作品 ${works.length}、方法笔记 ${notes.length}、选题 ${ideas.length}、草稿 ${drafts.length}、阅读 ${readings.length}、档案 ${archives.length}、概念词 ${concepts.length}`);
console.log(`输出：${relative(process.cwd(), target) || target}${opt.out ? '' : '（看板已切换到这份数据）'}`);
if (!concepts.length) console.log('提示：没有生成概念词（给笔记加 #话题标签 就会自动生成概念），也可以手动编辑输出文件末尾的 concepts。');
if (Number.isFinite(maxWorks) && bucket.works.length > maxWorks) console.log(`提示：作品共 ${bucket.works.length} 篇，只取了最新的 ${maxWorks} 篇（--max-works 可调整）。`);
