// —— 思维导图的数据层：大纲 Markdown ↔ 树 ——
// 导图以「嵌套无序列表」的 Markdown 大纲为唯一事实源（往返无损、可读可手改）：
//   - 根
//     - 分支一
//       - 子节点
// 存储走 .deepnotes/meta.json（mindmaps 键），随知识库跨设备同步，不进图谱与 .md diff 通道。
// 节点 id 用「路径序号」（0、0-0、0-1-2…）：同结构多次解析 id 稳定——选中态 / 折叠态跨
// 保存重解析不失效；结构变化（增删兄弟）只影响其后兄弟的序号，其余节点 id 原位保持。

// —— 节点装饰：颜色标记与备注 ——
// 为了随大纲文本一起往返（增删兄弟后仍跟随节点而不是位置），直接编码在行里：
//   `{{gold}} 文本 :: 备注`。旧数据（只有 :: 备注）照常解析；颜色只认 NODE_COLORS 里的值。
export const NODE_COLORS = ['gold', 'mint', 'lav', 'cyan', 'rose'];
const COLOR_RE = /^\{\{([a-z]+)\}\}\s+/;
export function parseNodeText(raw) {
  let s = String(raw || '');
  let color = '';
  const m = s.match(COLOR_RE);
  if (m && NODE_COLORS.includes(m[1])) { color = m[1]; s = s.slice(m[0].length); }
  const i = s.indexOf('::');
  return {label: (i >= 0 ? s.slice(0, i) : s).trim(), note: i >= 0 ? s.slice(i + 2).trim() : '', color};
}
export function formatNodeText(label, note, color) {
  const head = (NODE_COLORS.includes(color) ? `{{${color}}} ` : '') + String(label || '').trim();
  const n = String(note || '').trim().replace(/\s*\n\s*/g, ' ');
  return n ? `${head} :: ${n}` : head;
}

export function outlineToTree(md) {
  const root = {id: '0', text: '中心主题', children: []};
  const stack = [{node: root, depth: -1}];
  for (const raw of String(md || '').split('\n')) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(\s*)[-*]\s+(.*)$/);
    if (!m) continue; // 非列表行跳过（标题行等）
    const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
    const text = m[2].trim();
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node = {id: parent.id + '-' + parent.children.length, text, children: []};
    parent.children.push(node);
    stack.push({node, depth});
  }
  return root;
}

// 树 → 大纲（根的文本不进大纲：它作为导图标题单独存）
export function treeToOutline(root) {
  const lines = [];
  const walk = (node, depth) => {
    for (const c of node.children || []) {
      lines.push('  '.repeat(depth) + '- ' + String(c.text || '').replace(/\n/g, ' '));
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

// 导图 → 草稿 Markdown：一级分支转成 ## 小节，更深层级转成缩进列表，节点备注转为引用行
export function mapToDraftMarkdown(map) {
  const tree = outlineToTree(map?.outline || '');
  const lines = [];
  const walk = (node, depth) => {
    for (const c of node.children || []) {
      const p = parseNodeText(c.text);
      const label = p.label || '未命名';
      if (depth === 0) {
        lines.push(`## ${label}`, '');
        if (p.note) lines.push(`> ${p.note}`, '');
        walk(c, 1);
        if (lines[lines.length - 1] !== '') lines.push('');
      } else {
        lines.push('  '.repeat(depth - 1) + `- ${label}${p.note ? `（${p.note}）` : ''}`);
        walk(c, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 文章正文 → 树：单遍走正文行，标题行入栈成枝、正文段落按位置挂在「当时栈顶」的标题下
// （此前先收标题再挂段落的实现会把所有段落错挂到最后一节）。
// 代码块里的内容不当段落；无标题时正文直接挂根。
export function headingsToTree(title, body) {
  const root = {id: '0', text: title || '未命名', children: []};
  const stack = [{node: root, level: 0}];
  const pushHeading = (level, text) => {
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node = {id: parent.id + '-' + parent.children.length, text, children: []};
    parent.children.push(node);
    stack.push({node, level});
  };
  const addLeaf = text => {
    const parent = stack[stack.length - 1].node;
    parent.children.push({id: parent.id + '-' + parent.children.length, text: '¶ ' + text, children: []});
  };
  const lines = String(body || '').split('\n');
  let fence = false;
  let para = [];
  const flushPara = () => {
    const t = para.join(' ').replace(/\s+/g, ' ').trim();
    para = [];
    if (t.length >= 12) addLeaf(t.slice(0, 40) + (t.length > 40 ? '…' : ''));
  };
  for (const ln of lines) {
    if (/^\s*(```|~~~)/.test(ln)) { flushPara(); fence = !fence; continue; }
    if (fence) continue;
    const h = ln.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flushPara(); pushHeading(h[1].length, h[2].trim()); continue; }
    if (!ln.trim()) { flushPara(); continue; }
    para.push(ln.trim());
  }
  flushPara();
  return root;
}

// —— 画布布局：经典横向树。叶子按序纵向排开，父节点纵坐标取首末可见子节点中点；x 按深度推进。
// folded: {路径id: true}——折叠态持久化在导图记录里（不入大纲语法，往返不破坏文本）。
// heights: Map<id, 像素高>（按文字换行行数估算，由调用方传入）；gapY 为同级节点像素间距。
// 输出 y/h 均为像素（此前以「行」为单位乘 ROW，长文字节点自适应高度后必须按真实高度排列）。
export const NODE_W = 150, NODE_GAP_X = 64, NODE_GAP_Y = 12;
export function layoutTree(root, folded, heights = null, gapY = NODE_GAP_Y) {
  const out = [];
  let cursorY = 0; // px
  const hOf = id => (heights && heights.get(id)) || 34;
  const fold = id => !!(folded && folded[id]);
  const walk = (node, depth, pid) => {
    const visible = fold(node.id) ? [] : (node.children || []);
    const entry = {node, pid, depth, x: depth * (NODE_W + NODE_GAP_X), y: 0, h: hOf(node.id)};
    out.push(entry);
    if (!visible.length) { entry.y = cursorY; cursorY += entry.h + gapY; }
    else {
      let firstY = 0, lastY = 0;
      visible.forEach((c, i) => { const e = walk(c, depth + 1, node.id); if (i === 0) firstY = e.y; lastY = e.y; });
      entry.y = (firstY + lastY) / 2;
    }
    return entry;
  };
  walk(root, 0, null);
  return {entries: out, height: Math.max(1, cursorY)};
}

// 节点高度估算：按文字宽度（CJK 记 1em、其余记 0.55em）换算换行行数，
// 高 = 行数 × 行高(1.4em) + 上下 padding。与 CSS 的 word-break 渲染基本一致（略保守多留一行空间）。
// 节点文字里的图片标记（![[图.png]] / ![alt](src)）按固定缩略图高度逐张累加，不参与换行计数。
export const MM_FONT = 12.5, MM_PAD_Y = 10, MM_MIN_H = 34, MM_IMG_H = 96;
const MM_IMG_TOKEN = /!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\s]+\)/g;
export function estimateNodeHeight(label, widthPx) {
  const s = String(label || '');
  const imgCount = (s.match(MM_IMG_TOKEN) || []).length;
  const text = imgCount ? s.replace(MM_IMG_TOKEN, ' ').replace(/\s+/g, ' ').trim() : s;
  const inner = Math.max(40, widthPx - 20); // 左右 padding 与边框
  const cap = inner / MM_FONT;
  let lines = 1, w = 0;
  for (const ch of text) {
    const cw = /[\u2E80-\u9FFF\uF900-\uFFEF\u3000-\u303F\uFF00-\uFF20]/.test(ch) ? 1 : 0.55;
    if (w + cw > cap) { lines += 1; w = cw; } else w += cw;
  }
  let h = Math.max(MM_MIN_H, Math.round(lines * MM_FONT * 1.4 + MM_PAD_Y));
  return h + imgCount * MM_IMG_H;
}

export const nodeCount = root => {
  let n = 0;
  const walk = x => { for (const c of x.children || []) { n += 1; walk(c); } };
  walk(root);
  return n;
};
