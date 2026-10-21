// —— PDF 文本抽取（pdfjs-dist 纯本地解析，不经网络；由 docImport.js 按需动态加载，不拖慢首屏） ——
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function pdfToMarkdown(file) {
  const pdf = await pdfjs.getDocument({data: await file.arrayBuffer()}).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let out = '';
    for (const it of tc.items) out += it.str + (it.hasEOL ? '\n' : '');
    pages.push(out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  const title = String(meta?.info?.Title || '').trim();
  const head = title ? `# ${title}\n\n` : '';
  return head + pages.map((p, i) => `## 第 ${i + 1} 页 · Page ${i + 1}\n\n${p || '（本页无可提取文本 · No text layer on this page）'}`).join('\n\n');
}
