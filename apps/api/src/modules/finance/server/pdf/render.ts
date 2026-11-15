import 'server-only';
// The F5 "standard" template (docs/finance-documents-f5.md §4): one A4 layout for quotes and invoices,
// with configurable branding. Pure: snapshot (+ logo bytes) in, PDF bytes out. No database, network or
// filesystem access; fonts are embedded from fonts.generated.ts. Every figure is printed from the
// snapshot's exact decimal strings (formatted, never recomputed).
//
// User-supplied text is drawn as text runs only: PDFKit encodes every string (no markup, links or
// scripts are interpreted), control characters are removed, and nothing is loaded from a URL.
import PDFDocument from 'pdfkit';
import { INTER_REGULAR_BASE64, INTER_SEMIBOLD_BASE64 } from './fonts.generated';
import type { DocumentSnapshot, SnapshotParty } from './snapshot';

export const RENDERER = 'pdfkit@0.20.2';

const REGULAR = Buffer.from(INTER_REGULAR_BASE64, 'base64');
const SEMIBOLD = Buffer.from(INTER_SEMIBOLD_BASE64, 'base64');

const A4 = { width: 595.28, height: 841.89 };
/** Printed in place of a character the fonts cannot draw. */
export const MISSING = '\u25A1';
const M = { top: 48, bottom: 64, left: 48, right: 48 };
const CONTENT = A4.width - M.left - M.right;
const FOOTER_Y = A4.height - 40;
const INK = '#1A1D23';
const MUTED = '#5B6270';
const RULE = '#D9DCE1';

export interface RenderResult { bytes: Buffer; pageCount: number; unsupportedCharacters: boolean }

/** Thrown when a document cannot be rendered (for example a logo that no longer decodes). */
export class RenderError extends Error {
  constructor(readonly code: 'invalid_logo' | 'too_large' | 'render_failed', message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

// ---- formatting -----------------------------------------------------------------------------------

/** Removes control characters (keeps newlines), normalises line endings and tabs. */
export function clean(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g, '');
}

function safeLocale(locale: string): string {
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length > 0 ? locale : 'en';
  } catch {
    return 'en';
  }
}

function formatters(s: DocumentSnapshot) {
  const locale = safeLocale(s.locale);
  // Exact: Intl formats decimal strings without converting them to binary floating point.
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: s.currencyCode, minimumFractionDigits: s.currencyScale, maximumFractionDigits: s.currencyScale });
  const price = new Intl.NumberFormat(locale, { style: 'currency', currency: s.currencyCode, minimumFractionDigits: s.currencyScale, maximumFractionDigits: 6 });
  const qty = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const asNumber = (v: string) => v as unknown as number; // Intl.NumberFormat.format accepts exact decimal strings (ES2023).
  return {
    locale,
    money: (v: string) => money.format(asNumber(v)),
    price: (v: string) => price.format(asNumber(v)),
    qty: (v: string) => qty.format(asNumber(v)),
    percent: (v: string) => `${qty.format(asNumber(v))}%`,
    date: (v: string | null) => (v ? date.format(new Date(`${v}T00:00:00Z`)) : '—'),
  };
}

function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

// ---- rendering ------------------------------------------------------------------------------------

/**
 * Renders a snapshot. `logo` must be the bytes of snapshot.branding.logo (or null when it is null).
 * Deterministic for the same snapshot, logo, template version and renderer version: the PDF's dates and
 * file id derive from snapshot.renderedAt.
 */
export async function renderDocument(s: DocumentSnapshot, logo: Buffer | null): Promise<RenderResult> {
  if (s.branding.logo && !logo) throw new RenderError('invalid_logo', 'The logo for this document is missing.');
  const f = formatters(s);
  const created = new Date(s.renderedAt);
  const titleText = clean(s.branding.title);
  const doc = new PDFDocument({
    size: 'A4', margins: M, bufferPages: true, autoFirstPage: true, compress: true, pdfVersion: '1.7', font: REGULAR as unknown as string, lang: f.locale,
    displayTitle: true,
    info: {
      Title: `${titleText} ${s.number ?? 'draft'}`.trim(), Author: clean(s.seller.name), Subject: `${titleText} for ${clean(s.billTo.name)}`,
      Creator: 'Business OS', Producer: 'Business OS', CreationDate: created, ModDate: created,
    },
  } as PDFKit.PDFDocumentOptions);
  doc.registerFont('regular', REGULAR);
  doc.registerFont('semibold', SEMIBOLD);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });

  // Characters the embedded fonts cannot draw (for example CJK, Arabic, Hebrew or Indic scripts) are
  // never dropped silently or left as invisible .notdef glyphs: each is printed as a visible box (U+25A1)
  // and the result is flagged, so the version records it and the interface warns before anyone relies on it.
  let unsupported = false;
  doc.font('regular');
  // Inter Regular and SemiBold cover the same characters.
  const glyphs = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } })._font?.font;
  const fit = (value: string): string => {
    if (!glyphs?.hasGlyphForCodePoint) return value;
    let out = '';
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0x20 && cp !== 0xa0 && !glyphs.hasGlyphForCodePoint(cp)) {
        unsupported = true;
        out += MISSING;
      } else {
        out += ch;
      }
    }
    return out;
  };
  const text = (value: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) => {
    doc.text(fit(value), x, y, { lineGap: 1.5, ...opts });
  };
  const accent = s.branding.accentColor;
  const bottom = A4.height - M.bottom;

  // ---- header ----
  let y = M.top;
  let logoHeight = 0;
  if (s.branding.logo && logo) {
    try {
      const box = { w: 170, h: 60 };
      const ratio = Math.min(box.w / s.branding.logo.width, box.h / s.branding.logo.height, 1);
      logoHeight = s.branding.logo.height * ratio;
      doc.image(logo, M.left, y, { width: s.branding.logo.width * ratio, height: logoHeight });
    } catch {
      throw new RenderError('invalid_logo', 'The logo could not be embedded.');
    }
  } else {
    doc.font('semibold').fontSize(15).fillColor(INK);
    text(clean(s.seller.name), M.left, y, { width: CONTENT / 2 });
    logoHeight = doc.y - y;
  }
  doc.font('semibold').fontSize(22).fillColor(accent);
  text(titleText, M.left + CONTENT / 2, y - 3, { width: CONTENT / 2, align: 'right' });
  doc.font('regular').fontSize(11).fillColor(INK);
  text(s.number ?? 'Draft, not issued', M.left + CONTENT / 2, doc.y + 2, { width: CONTENT / 2, align: 'right' });
  if (s.status === 'VOID') {
    doc.font('semibold').fontSize(10).fillColor('#B42318');
    text('VOID', M.left + CONTENT / 2, doc.y + 2, { width: CONTENT / 2, align: 'right' });
  }
  y = Math.max(y + logoHeight, doc.y) + 22;
  doc.moveTo(M.left, y).lineTo(M.left + CONTENT, y).lineWidth(2).strokeColor(accent).stroke();
  y += 16;

  // ---- parties and details ----
  const col = (CONTENT - 32) / 3;
  const party = (label: string, p: SnapshotParty, x: number) => {
    let py = y;
    doc.font('semibold').fontSize(8).fillColor(MUTED);
    text(label.toUpperCase(), x, py, { width: col, characterSpacing: 0.6 });
    py = doc.y + 3;
    doc.font('semibold').fontSize(10).fillColor(INK);
    text(clean(p.name), x, py, { width: col });
    doc.font('regular').fontSize(9).fillColor(INK);
    const rest = [
      ...(p.attention ? [`Attn: ${p.attention}`] : []),
      ...p.lines,
      ...p.identifiers.map((i) => `${i.label}: ${i.value}`),
      ...(p.email ? [p.email] : []),
      ...(p.phone ? [p.phone] : []),
    ].map(clean).filter(Boolean);
    if (rest.length) text(rest.join('\n'), x, doc.y + 1, { width: col });
    return doc.y;
  };
  const fromEnd = party('From', s.seller, M.left);
  const toEnd = party(s.kind === 'QUOTE' ? 'Prepared for' : 'Bill to', s.billTo, M.left + col + 16);
  const details: [string, string][] = [
    [s.kind === 'QUOTE' ? 'Quote number' : 'Invoice number', s.number ?? 'Not issued'],
    ['Issue date', s.issueDate ? f.date(s.issueDate) : 'Not issued'],
    ...(s.kind === 'INVOICE' ? [['Due date', f.date(s.dueDate)] as [string, string]] : []),
    ...(s.kind === 'QUOTE' ? [['Valid until', f.date(s.validUntil)] as [string, string]] : []),
    ...(s.source.sourceQuoteNumber ? [['Quote reference', s.source.sourceQuoteNumber] as [string, string]] : []),
    ['Currency', s.currencyCode],
  ];
  const dx = M.left + 2 * (col + 16);
  let dy = y;
  for (const [label, value] of details) {
    doc.font('regular').fontSize(8).fillColor(MUTED);
    text(label.toUpperCase(), dx, dy, { width: col, characterSpacing: 0.6 });
    doc.font('semibold').fontSize(9.5).fillColor(INK);
    text(clean(value), dx, doc.y + 1, { width: col });
    dy = doc.y + 5;
  }
  y = Math.max(fromEnd, toEnd, dy) + 20;

  // ---- lines ----
  const hasDiscount = s.lines.some((l) => !/^0(\.0+)?$/.test(l.discountAmount));
  const cols = [
    { key: 'description', label: 'Description', width: 0, align: 'left' as const },
    { key: 'quantity', label: 'Qty', width: 52, align: 'right' as const },
    { key: 'unitPrice', label: 'Unit price', width: 76, align: 'right' as const },
    ...(hasDiscount ? [{ key: 'discount', label: 'Discount', width: 62, align: 'right' as const }] : []),
    { key: 'tax', label: 'Tax', width: 84, align: 'right' as const },
    { key: 'amount', label: 'Amount', width: 82, align: 'right' as const },
  ];
  const PAD = 6;
  cols[0]!.width = CONTENT - cols.slice(1).reduce((sum, c) => sum + c.width, 0);
  const tableHeader = () => {
    doc.rect(M.left, y, CONTENT, 20).fill(tint(accent, 0.88));
    doc.font('semibold').fontSize(8).fillColor(INK);
    let x = M.left;
    for (const c of cols) {
      text(c.label.toUpperCase(), x + PAD, y + 6.5, { width: c.width - 2 * PAD, align: c.align, characterSpacing: 0.4, lineBreak: false });
      x += c.width;
    }
    y += 24;
  };
  const newPage = () => {
    doc.addPage();
    y = M.top;
  };
  tableHeader();
  if (s.lines.length === 0) {
    doc.font('regular').fontSize(9).fillColor(MUTED);
    text('No lines yet.', M.left + PAD, y, { width: CONTENT - 2 * PAD });
    y = doc.y + 8;
  }
  for (const l of s.lines) {
    const cells: Record<string, string> = {
      description: fit(clean(l.description)),
      quantity: f.qty(l.quantity),
      unitPrice: f.price(l.unitPrice),
      discount: /^0(\.0+)?$/.test(l.discountAmount) ? '—' : f.money(l.discountAmount),
      tax: l.taxName ? fit(`${clean(l.taxName)} ${f.percent(l.taxRatePercent)}`) : 'No tax',
      amount: f.money(l.lineNet),
    };
    doc.font('regular').fontSize(9);
    const height = Math.max(...cols.map((c) => doc.heightOfString(cells[c.key]!, { width: c.width - 2 * PAD, lineGap: 1.5 }))) + 10;
    if (y + height > bottom) {
      newPage();
      tableHeader();
    }
    let x = M.left;
    // The repeated header leaves the semibold font selected: every row is set in the regular face.
    doc.font('regular').fontSize(9).fillColor(INK);
    for (const c of cols) {
      text(cells[c.key]!, x + PAD, y + 5, { width: c.width - 2 * PAD, align: c.align });
      x += c.width;
    }
    y += height;
    doc.moveTo(M.left, y).lineTo(M.left + CONTENT, y).lineWidth(0.5).strokeColor(RULE).stroke();
  }
  y += 12;

  // ---- totals and tax breakdown ----
  const totalsWidth = 230;
  const totalsX = M.left + CONTENT - totalsWidth;
  const rows: [string, string, boolean][] = [['Subtotal', f.money(s.totals.subtotal), false]];
  for (const t of s.taxBreakdown) {
    if (!t.taxName && /^0(\.0+)?$/.test(t.tax)) continue;
    rows.push([`${t.taxName ? clean(t.taxName) : 'Tax'} ${f.percent(t.taxRatePercent)} on ${f.money(t.net)}`, f.money(t.tax), false]);
  }
  if (rows.length === 1) rows.push(['Tax', f.money(s.totals.taxTotal), false]);
  rows.push([`Total ${s.currencyCode}`, f.money(s.totals.total), true]);
  const totalsHeight = rows.length * 17 + 14;
  if (y + totalsHeight > bottom) newPage();
  for (const [label, value, strong] of rows) {
    if (strong) {
      doc.moveTo(totalsX, y).lineTo(totalsX + totalsWidth, y).lineWidth(1).strokeColor(accent).stroke();
      y += 6;
    }
    doc.font(strong ? 'semibold' : 'regular').fontSize(strong ? 11 : 9).fillColor(strong ? accent : INK);
    text(label, totalsX, y, { width: totalsWidth * 0.62, lineBreak: false });
    text(value, totalsX + totalsWidth * 0.62, y, { width: totalsWidth * 0.38, align: 'right', lineBreak: false });
    y += strong ? 20 : 16;
  }
  doc.font('regular').fontSize(7.5).fillColor(MUTED);
  text('Prices exclude tax.', totalsX, y, { width: totalsWidth, align: 'right' });
  y = doc.y + 18;

  // ---- text blocks: payment instructions, terms, notes ----
  const block = (label: string, body: string | null) => {
    const value = fit(clean(body).trim());
    if (!value) return;
    doc.font('regular').fontSize(9);
    const needed = 16 + Math.min(doc.heightOfString(value, { width: CONTENT, lineGap: 1.5 }), 60);
    if (y + needed > bottom) newPage();
    doc.font('semibold').fontSize(8).fillColor(MUTED);
    text(label.toUpperCase(), M.left, y, { width: CONTENT, characterSpacing: 0.6 });
    doc.font('regular').fontSize(9).fillColor(INK);
    // Long text flows onto further pages; PDFKit keeps it inside the margins.
    text(value, M.left, doc.y + 3, { width: CONTENT });
    y = doc.y + 14;
  };
  if (s.kind === 'INVOICE') block('Payment instructions', s.paymentInstructions);
  block(s.kind === 'QUOTE' ? 'Terms of this quote' : 'Terms', s.branding.terms);
  block('Notes', s.notes);

  // ---- every page: footer, page numbers, draft or void marking ----
  const range = doc.bufferedPageRange();
  const footer = clean(s.branding.footerText).replace(/\n+/g, ' ').trim();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // the footer sits in the bottom margin; without this PDFKit would add a page
    doc.moveTo(M.left, FOOTER_Y - 8).lineTo(M.left + CONTENT, FOOTER_Y - 8).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('regular').fontSize(7.5).fillColor(MUTED);
    const pageLabel = `${s.number ?? 'Draft'} · Page ${i + 1} of ${range.count}`;
    if (footer) text(footer, M.left, FOOTER_Y, { width: CONTENT - 120, height: 20, ellipsis: true, lineBreak: true });
    text(pageLabel, M.left + CONTENT - 120, FOOTER_Y, { width: 120, align: 'right', lineBreak: false });
    const mark = s.status === 'DRAFT' ? 'DRAFT' : s.status === 'VOID' ? 'VOID' : null;
    if (mark) {
      doc.save();
      doc.rotate(-30, { origin: [A4.width / 2, A4.height / 2] });
      doc.font('semibold').fontSize(110).fillColor(s.status === 'VOID' ? '#B42318' : '#7A808C', 0.1);
      doc.text(mark, 0, A4.height / 2 - 70, { width: A4.width, align: 'center', lineBreak: false });
      doc.restore();
    }
    if (s.status === 'DRAFT') {
      doc.font('semibold').fontSize(8).fillColor('#7A808C', 1);
      doc.text('Draft preview: not issued, not a valid document', M.left, 22, { width: CONTENT, align: 'center', lineBreak: false });
    }
  }
  doc.flushPages();
  doc.end();
  await finished;
  const bytes = Buffer.concat(chunks);
  return { bytes, pageCount: range.count, unsupportedCharacters: unsupported };
}
