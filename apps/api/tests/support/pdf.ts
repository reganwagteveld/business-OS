// Test helper (Finance F5): reads generated PDFs back with Mozilla's pdf.js, so tests assert on the
// document's actual text and structure, not just on an HTTP status.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfInfo { pages: string[]; text: string; info: Record<string, unknown>; pageSizes: [number, number][] }

export async function readPdf(bytes: Uint8Array | Buffer): Promise<PdfInfo> {
  const data = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const task = getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const pdf = await task.promise;
  const pages: string[] = [];
  const pageSizes: [number, number][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const [, , w, h] = page.view as [number, number, number, number];
    pageSizes.push([Math.round(w * 100) / 100, Math.round(h * 100) / 100]);
    const content = await page.getTextContent();
    let line = '';
    const out: string[] = [];
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      line += item.str ?? '';
      if (item.hasEOL) { out.push(line); line = ''; } else if (item.str) line += ' ';
    }
    if (line) out.push(line);
    pages.push(out.join('\n').replace(/ +/g, ' '));
  }
  const meta = await pdf.getMetadata();
  await task.destroy();
  return { pages, text: pages.join('\n'), info: meta.info as Record<string, unknown>, pageSizes };
}
