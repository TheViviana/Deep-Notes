// —— 本地文档导入：PDF / HTML / Markdown / TXT → 阅读条目（全部离线解析，不经网络） ——
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
