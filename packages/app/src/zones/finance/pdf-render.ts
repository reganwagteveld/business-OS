// Finance F5 fix: draws a PDF's pages onto canvases with PDF.js, instead of handing a blob: URL to the
// browser's built-in PDF viewer in a frame. The built-in viewer is not dependable inside this app:
// Safari on macOS showed an empty frame, and the desktop app's web view may have no PDF viewer at all.
// PDF.js runs as ordinary script and a same-origin module worker, so it needs no plugin, no frame and
// no blob: source in the Content Security Policy. It is loaded only when a preview is opened.
//
// The legacy build is used on purpose: it carries polyfills for older Safari and WebKit web views.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export interface RenderedPdf {
  pageCount: number;
  /**
   * Draws page `n` (from 1) at a size that stays sharp when shown `cssWidth` CSS pixels wide on this
   * screen. Only the canvas's own pixel size is set; the page scales it to its width with CSS.
   */
  drawPage(n: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  /** Releases the document and its worker. Safe to call more than once. */
  destroy(): Promise<void>;
}

export type OpenPdf = (bytes: Uint8Array) => Promise<RenderedPdf>;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  }).catch((e: unknown) => {
    pdfjs = null; // let a later attempt try again (for example after a dropped connection)
    throw e;
  });
  return pdfjs;
}

/** Opens PDF bytes that are already in memory. Nothing is fetched: fonts are embedded by the API's renderer. */
export const openPdf: OpenPdf = async (bytes) => {
  const lib = await loadPdfJs();
  const task = lib.getDocument({
    // PDF.js may transfer the buffer to its worker, so give it a copy and keep the caller's bytes intact.
    data: bytes.slice(),
    // Our PDFs embed their fonts; never reach out for font, colour-profile or wasm files.
    useSystemFonts: false,
    disableFontFace: false,
    useWorkerFetch: false,
    enableXfa: false,
    stopAtErrors: true,
  });
  const doc = await task.promise;
  let destroyed = false;
  return {
    pageCount: doc.numPages,
    async drawPage(n, canvas, cssWidth) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = cssWidth / base.width;
      const ratio = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await task.destroy();
    },
  };
};
