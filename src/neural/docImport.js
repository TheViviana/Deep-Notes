// —— 本地文档导入：PDF / HTML / Word(.docx) / Markdown / TXT → 阅读条目（全部离线解析，不经网络） ——
// PDF 走 pdfParse.js（按需加载）；HTML 朴素转 Markdown；纯文本直接收录。
import {headingAt} from './vaultRules';

// 从纯文本中提取第一个标题（ATX 或 Setext），找不到返回 null
function firstHeading(text) {
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines, i);
    if (h) return h.text;
  }
  return null;
}

// —— .docx 解析（零依赖）：docx 是 ZIP 包，正文在 word/document.xml ——
// ZIP 定位走中央目录（局部头的尺寸在「数据描述符」标志置位时不可靠）；解压用浏览器原生
// DecompressionStream('deflate-raw')，Electron / 现代浏览器都内置，不需要任何第三方库。
const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
// XML 实体解码：OOXML 强制转义 & < > 等五个字符，不解码则正文出现字面 &amp;
function decodeXmlEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
    }
    return {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[e];
  });
}
// 解压输出上限：deflate 最高约千倍压缩比，不限大小的「zip 炸弹」可把渲染进程撑爆
const INFLATE_CAP = 64 * 1024 * 1024;
async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > INFLATE_CAP) { await reader.cancel().catch(() => {}); throw new Error('docx 解压后超过 64MB，已拒绝 · Decompressed docx too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
function zipEntries(buf) {
  const dv = new DataView(buf);
  // 从尾部找 End of Central Directory（PK\x05\x06），注释区最长 65535 字节
  const min = Math.max(0, dv.byteLength - 65557);
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= min; i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .docx（缺少 ZIP 目录）· Not a valid docx');
  const count = u16(dv, eocd + 10);
  let p = u32(dv, eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > dv.byteLength || u32(dv, p) !== 0x02014b50) break;
    const method = u16(dv, p + 10), compSize = u32(dv, p + 20);
    const nameLen = u16(dv, p + 28), extraLen = u16(dv, p + 30), commentLen = u16(dv, p + 32);
    const localOff = u32(dv, p + 42);
    if (p + 46 + nameLen > dv.byteLength) break;
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    out.set(name, {method, compSize, localOff});
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
async function zipReadText(buf, name) {
  const dv = new DataView(buf);
  const entry = zipEntries(buf).get(name);
  if (!entry) return null;
  // 局部头的 extra 长度与中央目录可能不同：按局部头自己声明的跳到数据区
  const lo = entry.localOff;
  if (lo + 30 > dv.byteLength || u32(dv, lo) !== 0x04034b50) return null;
  const nameLen = u16(dv, lo + 26), extraLen = u16(dv, lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  if (dataStart + entry.compSize > dv.byteLength) throw new Error('不是有效的 .docx（数据区损坏）· Corrupted docx');
  const comp = new Uint8Array(buf, dataStart, entry.compSize);
  if (entry.method === 0) return new TextDecoder().decode(comp); // stored
  if (entry.method !== 8) throw new Error('不支持的 docx 压缩方式 · Unsupported compression');
  return new TextDecoder().decode(await inflateRaw(comp));
}

// 极简 XML 树解析（只服务 OOXML 子集：元素 / 属性 / 文本；跳过声明与注释）——
// 不依赖 DOMParser，渲染层与 Node 测试环境行为一致；文本与属性值解码 XML 实体
function xmlTree(xml) {
  const root = {tag: '', attrs: {}, kids: [], text: ''};
  const stack = [root];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    const text = xml.slice(i, lt);
    if (text.trim()) stack[stack.length - 1].text += decodeXmlEntities(text);
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const c1 = xml[lt + 1];
    if (c1 === '/') { if (stack.length > 1) stack.pop(); i = gt + 1; continue; }
    if (c1 === '?' || c1 === '!') { i = gt + 1; continue; } // 声明 / DOCTYPE / 注释
    const selfClose = xml[gt - 1] === '/';
    const inner = xml.slice(lt + 1, selfClose ? gt - 1 : gt);
    const sp = inner.indexOf(' ');
    const tag = sp < 0 ? inner : inner.slice(0, sp);
    const attrs = {};
    for (const m of (sp < 0 ? '' : inner.slice(sp + 1)).matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[m[1]] = decodeXmlEntities(m[2]);
    const el = {tag, attrs, kids: [], text: ''};
    stack[stack.length - 1].kids.push(el);
    if (!selfClose) stack.push(el);
    i = gt + 1;
  }
  return root;
}

// word/document.xml → Markdown：标题（Heading1-6）/ 段落 / 加粗斜体 / 列表（编号简化为 "- "）/ 表格
function docxXmlToMd(xml) {
  const tree = xmlTree(xml);
  const tag = el => String(el.tag || '').replace(/^.*:/, '');
  const kids = el => el.kids;
  const findKid = (el, name) => kids(el).find(c => tag(c) === name);
  // run 可能嵌在 w:hyperlink / w:ins（未接受修订）/ w:fldSimple / w:smartTag 里，展开一层才不丢文字
  const runsOf = p => kids(p).flatMap(c => tag(c) === 'r' ? [c]
    : ['hyperlink', 'ins', 'fldSimple', 'smartTag'].includes(tag(c)) ? kids(c).filter(g => tag(g) === 'r') : []);
  const runsMd = p => runsOf(p).map(r => {
    const txt = kids(r).filter(c => tag(c) === 't').map(t => t.text).join('');
    if (!txt) return '';
    const rPr = findKid(r, 'rPr');
    const on = name => !!rPr && kids(rPr).some(c => tag(c) === name);
    return on('b') && on('i') ? `***${txt}***` : on('b') ? `**${txt}**` : on('i') ? `*${txt}*` : txt;
  }).join('');
  const isListItem = p => { const pPr = findKid(p, 'pPr'); return !!pPr && !!findKid(pPr, 'numPr'); };
  const headingLevel = p => {
    const pPr = findKid(p, 'pPr');
    if (!pPr) return 0;
    // outlineLvl（0-5 → 一到六级）是 Word 目录视图的依据、与界面语言无关，优先于样式名
    const ol = findKid(pPr, 'outlineLvl');
    if (ol) { const v = parseInt(ol.attrs?.['w:val'] ?? ol.attrs?.val, 10); if (v >= 0 && v <= 5) return v + 1; }
    const style = findKid(pPr, 'pStyle');
    const m = /heading\s*([1-6])/i.exec(style?.attrs?.['w:val'] || style?.attrs?.val || '');
    return m ? +m[1] : 0;
  };
  const tableMd = tbl => {
    const rows = kids(tbl).filter(c => tag(c) === 'tr');
    const cells = tr => kids(tr).filter(c => tag(c) === 'tc').map(tc => kids(tc).map(p => runsMd(p).trim()).join(' ').replace(/\|/g, '\\|'));
    if (!rows.length) return '';
    const head = cells(rows[0]);
    const body = rows.slice(1).map(cells);
    return '\n\n| ' + head.join(' | ') + ' |\n| ' + head.map(() => '---').join(' | ') + ' |'
      + body.map(r => `\n| ${r.join(' | ')} |`).join('') + '\n\n';
  };
  const docEl = findKid(tree, 'document') || tree; // 根 → w:document → w:body
  const body = findKid(docEl, 'body');
  if (!body) throw new Error('docx 里找不到正文 · No body found');
  const parts = [];
  for (const el of kids(body)) {
    const t = tag(el);
    if (t === 'tbl') { const md = tableMd(el); if (md) parts.push(md); continue; }
    if (t !== 'p') continue;
    const lv = headingLevel(el);
    const text = runsMd(el).trim();
    if (lv) parts.push(`\n\n${'#'.repeat(lv)} ${text}\n\n`);
    else if (isListItem(el)) parts.push(`\n- ${text}`);
    else if (text) parts.push(`\n\n${text}\n\n`);
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}
export async function docxToMarkdown(buf) {
  // 统一成 ArrayBuffer（File.arrayBuffer 之外，测试环境可能给 Node Buffer / TypedBuffer）
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let xml;
  try { xml = await zipReadText(ab, 'word/document.xml'); }
  catch (err) {
    if (err?.message?.includes('docx') || err?.message?.includes('压缩') || err?.message?.includes('Decompressed')) throw err;
    throw new Error('不是有效的 .docx（压缩包结构损坏或不支持 ZIP64）· Malformed or unsupported docx');
  }
  if (!xml) throw new Error('不是有效的 .docx（缺少 word/document.xml）· Not a valid docx');
  return docxXmlToMd(xml);
}

// HTML → Markdown：标题 / 段落 / 列表 / 引用 / 代码块 / 链接图片 / 加粗斜体 / 表格行
export function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,form,button,input,select').forEach(n => n.remove());
  const walk = (node, depth = 0) => [...node.childNodes].map(ch => {
    if (ch.nodeType === 3) return ch.textContent.replace(/\s+/g, ' ');
    if (ch.nodeType !== 1) return '';
    // 深度上限：恶意构造的超深嵌套 HTML 不再递归展开（防打爆调用栈），该子树退化为纯文本
    if (depth > 200) return ch.textContent.replace(/\s+/g, ' ');
    const tag = ch.tagName.toLowerCase();
    const inner = () => walk(ch, depth + 1);
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(+tag[1]) + ' ' + inner().trim() + '\n\n';
    if (tag === 'p') return '\n\n' + inner().trim() + '\n\n';
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'blockquote') return '\n\n> ' + inner().trim().replace(/\n{2,}/g, '\n>\n>') + '\n\n';
    if (tag === 'pre') return '\n\n```\n' + ch.textContent.replace(/\n$/, '') + '\n```\n\n';
    if (tag === 'ul' || tag === 'ol') {
      const items = [...ch.children].filter(li => li.tagName.toLowerCase() === 'li');
      return '\n\n' + items.map((li, i) => (tag === 'ol' ? `${i + 1}. ` : '- ') + walk(li, depth + 1).join('').trim().replace(/\n+/g, ' ')).join('\n') + '\n\n';
    }
    if (tag === 'img') { const alt = ch.getAttribute('alt') || '图片'; const src = ch.getAttribute('src') || ''; return src ? `![${alt}](${src})` : `（图片：${alt}）`; }
    if (tag === 'a') { const href = ch.getAttribute('href') || ''; const t = inner().trim(); return href && !href.startsWith('#') ? `[${t}](${href})` : t; }
    if (tag === 'strong' || tag === 'b') return `**${inner().trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${inner().trim()}*`;
    if (tag === 'code') return '`' + ch.textContent + '`';
    if (tag === 'tr') return '\n| ' + [...ch.children].map(td => td.textContent.trim().replace(/\|/g, '\\|')).join(' | ') + ' |';
    return inner();
  }).join('');
  return walk(doc.body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 解析一个本地文件 → {title, body, source}；不支持的扩展名抛错
export async function parseDocFile(file) {
  const name = file.name.replace(/\.[a-z0-9]+$/i, '');
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (ext === 'pdf') {
    const {pdfToMarkdown} = await import('./pdfParse.js');
    const body = await pdfToMarkdown(file);
    return {title: firstHeading(body) || name, body, source: file.name};
  }
  if (ext === 'docx') {
    const body = await docxToMarkdown(await file.arrayBuffer());
    return {title: firstHeading(body) || name, body, source: file.name};
  }
  if (ext === 'doc') throw new Error('旧版 .doc 二进制格式不支持，请先在 Word 里另存为 .docx · Legacy .doc unsupported, save as .docx first');
  if (ext === 'html' || ext === 'htm') {
    const html = await file.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = (doc.querySelector('title')?.textContent || doc.querySelector('h1')?.textContent || '').trim() || name;
    const body = htmlToMarkdown(html);
    return {title, body: `# ${title}\n\n${body}`, source: file.name};
  }
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
    const text = await file.text();
    return {title: firstHeading(text) || name, body: text, source: file.name};
  }
  throw new Error(`暂不支持 .${ext || '?'} 格式 · Unsupported file type`);
}
