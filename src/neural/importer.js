// 软件内知识库导入：把一个 Markdown 文件夹（如 Obsidian 仓库）解析成看板数据。
// 解析规则与 scripts/import-notes.mjs 一致；区别是纯浏览器完成（目录选择器 + File API），
// 未识别的文件夹一律作为方法笔记导入（知识库不丢文件），且不要求必须有「作品」文件夹。
// 不联网，不读取选择范围之外的任何文件。
import {normalizeWork} from './worksStore';

const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// 容量上限：超出时按日期/顺序截断，并在结果里报告，避免图谱节点过多导致卡顿。
const CAPS = {works: 40, notes: 80, files: 600};
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const isMd = name => /\.(md|markdown)$/i.test(name);
const clean = body => String(body).replace(/\r/g, '').trim().slice(0, 6000);
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
function tagsOf(fm, body) {
  const raw = pick(fm, ['tags', 'tag', '标签', '话题']);
  const list = Array.isArray(raw) ? raw : raw ? String(raw).split(/[,，\s]+/) : [];
  for (const m of body.matchAll(/(?:^|\s)#([^\s#，。,.!?！？、；;:：()（）[\]]+)/g)) list.push(m[1]);
  return [...new Set(list.map(t => t.replace(/^#/, '').trim()).filter(t => t && !/^\d+$/.test(t)))].slice(0, 12);
}

// —— 分类：作品 / 草稿 / 选题 / 方法笔记，按文件夹名识别；未识别的全部作为方法笔记 ——
const RULES = [
  ['works', /(作品|works?$|published|已发布)/i],
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

// —— 主入口：File 列表 → 看板数据（works / ideas / drafts / snapshot / concepts） ——
// target：'auto' 按文件夹名自动分类；也可指定 'works' | 'methods' | 'ideas' | 'drafts'，把全部文件归入所选模块
export async function parseVault(fileList, target = 'auto') {
  const all = fileList.filter(f => f && isMd(f.name) && !f.name.startsWith('.'));
  const files = all.slice(0, CAPS.files).map(f => {
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

  const bucket = {works: [], methods: [], ideas: [], drafts: []};
  for (const x of read) {
    const title = String(pick(x.fm, ['title', '标题', 'name']) || x.file.name.replace(/\.(md|markdown)$/i, '')).trim();
    bucket[x.kind].push({...x, title});
  }
  const byDate = (a, b) => b.date.localeCompare(a.date);

  const works = bucket.works.map(x => {
    const media = /视频|video/i.test(String(pick(x.fm, ['media', '类型', 'type', '形式']) || '')) ? 'video' : 'images';
    const date = dateOf(pick(x.fm, ['date', '发布时间', '发布日期', 'published', 'publishedAt', 'created', '创建时间']), x.file.lastModified);
    return {
      title: x.title, date,
      direction: String(pick(x.fm, ['direction', '研究方向', '方向']) || '').trim(),
      views: num(pick(x.fm, ['views', '观看', '浏览', '阅读', '播放'])) ?? 0,
      likes: num(pick(x.fm, ['likes', '点赞'])) ?? 0,
      comments: num(pick(x.fm, ['comments', '评论'])) ?? 0,
      saves: num(pick(x.fm, ['saves', '收藏'])) ?? 0,
      body: clean(x.body), tags: tagsOf(x.fm, x.body), media
    };
  }).sort(byDate).slice(0, CAPS.works)
    .map((w, i) => normalizeWork({id: 'w' + (i + 1), ...w}));

  const noteTags = [];
  const notes = bucket.methods.slice(0, CAPS.notes).map((x, i) => {
    const sub = x.dirs.length > 1 ? x.dirs[1] : (x.dirs[0] || '笔记');
    noteTags.push(...tagsOf(x.fm, x.body));
    return {id: 'n' + (i + 1), title: x.title, path: `05-方法库 methods/${sub}/${x.file.name}`, body: clean(x.body)};
  });

  const ideas = bucket.ideas.map((x, i) => {
    const status = String(pick(x.fm, ['status', '状态']) || '待写');
    return {id: i + 1, title: x.title, platform: String(pick(x.fm, ['platform', '平台']) || '本地'), priority: ['高', '中', '低'].includes(String(pick(x.fm, ['priority', '优先级']))) ? String(pick(x.fm, ['priority', '优先级'])) : '中',
      status: ['待写', '待扩展', '已转草稿'].includes(status) ? status : '待写', note: String(pick(x.fm, ['note', '备注', 'description', '简介']) || clean(x.body).replace(/^#.*\n/, '').trim().slice(0, 120))};
  });

  const drafts = bucket.drafts.map((x, i) => {
    const src = String(pick(x.fm, ['source', '来源选题', '选题']) || '');
    const idea = ideas.find(d => d.title === src);
    return {id: 'draft-' + (i + 1), title: x.title, body: clean(x.body), source: idea ? idea.id : null};
  });

  // 概念词：至少在两条内容里出现的话题标签，取出现最多的 20 个（与导入脚本同规则）。
  const count = new Map();
  for (const t of [...works.flatMap(w => w.tags), ...noteTags]) count.set(t, (count.get(t) || 0) + 1);
  const concepts = [...count].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t]) => [t, [t.toLowerCase()]]);

  const dates = works.map(w => w.date.slice(0, 10)).sort();
  const snapshot = {
    account: '我的知识库', followers: null, capturedAt: today(),
    publishedFrom: dates[0] || '', publishedTo: dates[dates.length - 1] || '', source: '导入自本地笔记'
  };

  return {
    vault: (fileList[0]?.webkitRelativePath || '').split('/')[0] || '所选文件夹',
    works, notes, ideas, drafts, snapshot, concepts,
    counts: {all: read.length, works: works.length, notes: notes.length, ideas: ideas.length, drafts: drafts.length},
    truncated: {
      files: all.length > CAPS.files ? all.length - CAPS.files : 0,
      works: bucket.works.length > CAPS.works ? bucket.works.length - CAPS.works : 0,
      notes: bucket.methods.length > CAPS.notes ? bucket.methods.length - CAPS.notes : 0
    }
  };
}
