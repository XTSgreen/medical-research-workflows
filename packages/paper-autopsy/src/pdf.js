import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const normalizeText = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
export async function extractPdf(path, options = {}) {
  const {maxBytes=50_000_000,signal}=options;
  signal?.throwIfAborted();
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error('输入需为不超过 50 MB 的 PDF 文件');
  const bytes = await readFile(path,{signal});
  return extractPdfBytes(bytes,options);
}
export async function extractPdfBytes(input, { selectedPages, allowPartial = false, maxBytes = 50_000_000, maxPages = 500, signal } = {}) {
  signal?.throwIfAborted();
  if (!(input instanceof Uint8Array) || input.byteLength>maxBytes) throw new Error('输入需为不超过 50 MB 的 PDF 字节');
  const bytes=Buffer.from(input);
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new Error('输入不是 PDF');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  let pdf;
  try {
    pdf = await task.promise;
    signal?.throwIfAborted();
    if (pdf.numPages > maxPages) throw new Error('PDF 超过 500 页，请先拆分并记录原始页码对应关系');
    if (selectedPages !== undefined && (!Array.isArray(selectedPages) || !selectedPages.length || selectedPages.some(p => !Number.isInteger(p) || p < 1 || p > pdf.numPages) || new Set(selectedPages).size !== selectedPages.length)) throw new Error('所选页码超出范围、重复或为空');
    const selected = selectedPages ? [...selectedPages].sort((a, b) => a - b) : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    const pages = []; let titleCandidate = '';
    for (const n of selected) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      if (n === 1) {
        const top = content.items.filter(item => typeof item.str === 'string' && item.str.trim()).slice(0, 20);
        const first = top[0];
        if (first) {
          const rest = top.slice(1).map(item => item.height).filter(h => h > 0).sort((a, b) => a - b);
          const median = rest[Math.floor(rest.length / 2)] ?? first.height;
          const titleParts = [first.str];
          if (first.height > median * 1.15) for (const item of top.slice(1)) {
            if (Math.abs(item.height - first.height) > first.height * 0.08 || titleParts.join(' ').length > 350) break;
            titleParts.push(item.str);
          }
          titleCandidate = normalizeText(titleParts.join(' '));
        }
      }
      const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
      const readable = [...text].filter(c => /[\p{L}\p{N}]/u.test(c)).length;
      let hasImages = false;
      if (readable < 30) {
        const ops = await page.getOperatorList();
        hasImages = ops.fnArray.some(op => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat].includes(op));
      }
      pages.push({ page: n, text, textHash: createHash('sha256').update(text).digest('hex'), needsReview: readable < 30, needsOcr: readable < 30 && hasImages });
      page.cleanup();
    }
    signal?.throwIfAborted();
    const sparse = pages.filter(page => page.needsReview).map(page => page.page);
    if (sparse.length && !allowPartial) throw new Error(`以下物理页文本不足，需 OCR 或人工检查：${sparse.join(', ')}。若只处理可读节选，请显式 --allow-partial`);
    if (!pages.some(page => !page.needsReview)) throw new Error('没有可可靠提取的文字页，请先 OCR；不生成空白论文卡');
    const metadata = await pdf.getMetadata();
    const excludedPages = Array.from({ length: pdf.numPages }, (_, i) => i + 1).filter(n => !selected.includes(n) || sparse.includes(n));
    return { schemaVersion: 1, documentId: `PDF-${hash.slice(0, 16)}`, sourceFileHash: hash, title: typeof metadata.info?.Title === 'string' && metadata.info.Title.trim() ? metadata.info.Title : titleCandidate, pageCount: pdf.numPages, readScope: excludedPages.length ? 'excerpt' : 'all-extracted-pages', excludedPages, pages, warnings: ['文本按 PDF 内容流提取，双栏、公式和表格可能需要人工核对；提取成功不证明阅读顺序正确。', '题名来自PDF元数据或首页字体线索，需与原文核对。'] };
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('PDF 已加密，需要先使用有权访问的解密副本');
    throw error;
  } finally { await task.destroy(); }
}
