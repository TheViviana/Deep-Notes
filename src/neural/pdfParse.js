// —— PDF 文本抽取（pdfjs-dist 纯本地解析，不经网络；由 docImport.js 按需动态加载，不拖慢首屏） ——
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB：更大的文件直接拒绝，防止整个读进内存把应用打爆
const MAX_PDF_PAGES = 500;              // 单次最多抽取 500 页：超过部分不导入（结果里显式标注，绝不静默截断）

export async function pdfToMarkdown(file) {
  if (file.size > MAX_PDF_SIZE) throw new Error(`PDF 超过 100MB（${Math.round(file.size / 1048576)}MB），已拒绝导入 · PDF too large (max 100MB)`);
  const pdf = await pdfjs.getDocument({data: await file.arrayBuffer()}).promise;
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const total = pdf.numPages;
    const pages = [];
    for (let i = 1; i <= Math.min(total, MAX_PDF_PAGES); i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      let out = '';
      for (const it of tc.items) out += it.str + (it.hasEOL ? '\n' : '');
      pages.push(out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    }
    const title = String(meta?.info?.Title || '').trim();
    const head = title ? `# ${title}\n\n` : '';
    const tail = total > MAX_PDF_PAGES ? `\n\n> 共 ${total} 页，已导入前 ${MAX_PDF_PAGES} 页 · Imported first ${MAX_PDF_PAGES} of ${total} pages.` : '';
    return head + pages.map((p, i) => `## 第 ${i + 1} 页 · Page ${i + 1}\n\n${p || '（本页无可提取文本 · No text layer on this page）'}`).join('\n\n') + tail;
  } finally {
    // 无论成功失败都释放解析器资源：连续导入多本大 PDF 时内存不再累积
    await pdf.destroy().catch(() => {});
  }
}
