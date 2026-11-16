import 'server-only';
// F6-2 statement PDF (docs/finance-billing-f6.md §4, D-F6-9): the F5 standard layout's fonts, branding,
// margins and footer, with a statement body. Pure: snapshot (+ logo bytes) in, PDF bytes out; rendered
// on demand and never stored. Every figure is printed from the snapshot's exact decimal strings.
// User-supplied text is drawn as text runs only (see render.ts), and characters the embedded fonts
// cannot draw are printed as a visible box and flagged, as in F5.
import PDFDocument from 'pdfkit';
import { A4, clean, CONTENT, FOOTER_Y, INK, M, MISSING, MUTED, REGULAR, RenderError, RULE, safeLocale, SEMIBOLD, tint, type RenderResult } from './render';
import type { SnapshotParty } from './snapshot';

export const STATEMENT_TEMPLATE = { id: 'statement-standard', version: 1 } as const;

export interface StatementSnapshot {
  renderedAt: string;
  locale: string;
  currencyCode: string;
  currencyScale: number;
  from: string;
  to: string;
  seller: SnapshotParty;
  billTo: SnapshotParty;
  openingBalance: string;
  closingBalance: string;
  entries: { date: string; label: string; reference: string | null; dueDate: string | null; amount: string; balance: string }[];
  /** Aged open invoices at the end of `to`, and credit kept separate. */
  ageing: { label: string; amount: string }[];
  credits: { label: string; amount: string }[];
  branding: {
    accentColor: string; footerText: string | null;
    logo: { width: number; height: number } | null;
  };
}

export async function renderStatement(s: StatementSnapshot, logo: Buffer | null): Promise<RenderResult> {
  if (s.branding.logo && !logo) throw new RenderError('invalid_logo', 'The logo for this statement is missing.');
  const locale = safeLocale(s.locale);
  const asNumber = (v: string) => v as unknown as number;
  const moneyFmt = new Intl.NumberFormat(locale, { style: 'currency', currency: s.currencyCode, minimumFractionDigits: s.currencyScale, maximumFractionDigits: s.currencyScale });
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const money = (v: string) => moneyFmt.format(asNumber(v));
  const date = (v: string | null) => (v ? dateFmt.format(new Date(`${v}T00:00:00Z`)) : '—');
  const created = new Date(s.renderedAt);
  const doc = new PDFDocument({
    size: 'A4', margins: M, bufferPages: true, autoFirstPage: true, compress: true, pdfVersion: '1.7', font: REGULAR as unknown as string, lang: locale,
    displayTitle: true,
    info: {
      Title: `Statement ${s.from} to ${s.to}`, Author: clean(s.seller.name), Subject: `Statement for ${clean(s.billTo.name)}`,
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

  let unsupported = false;
  doc.font('regular');
  const glyphs = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } })._font?.font;
  const fit = (value: string): string => {
    if (!glyphs?.hasGlyphForCodePoint) return value;
    let out = '';
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0x20 && cp !== 0xa0 && !glyphs.hasGlyphForCodePoint(cp)) {
        unsupported = true;
        out += MISSING;
      } else out += ch;
    }
    return out;
  };
  const text = (value: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) => doc.text(fit(value), x, y, { lineGap: 1.5, ...opts });
  const accent = s.branding.accentColor;
  const bottom = A4.height - M.bottom;

  // ---- header ----
  let y = M.top;
  let logoHeight = 0;
  if (s.branding.logo && logo) {
    try {
      const ratio = Math.min(170 / s.branding.logo.width, 60 / s.branding.logo.height, 1);
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
  text('Statement', M.left + CONTENT / 2, y - 3, { width: CONTENT / 2, align: 'right' });
  doc.font('regular').fontSize(10).fillColor(INK);
  text(`${date(s.from)} – ${date(s.to)}`, M.left + CONTENT / 2, doc.y + 2, { width: CONTENT / 2, align: 'right' });
  y = Math.max(y + logoHeight, doc.y) + 22;
  doc.moveTo(M.left, y).lineTo(M.left + CONTENT, y).lineWidth(2).strokeColor(accent).stroke();
  y += 16;

  // ---- parties and summary ----
  const col = (CONTENT - 32) / 3;
  const party = (label: string, p: SnapshotParty, x: number) => {
    doc.font('semibold').fontSize(8).fillColor(MUTED);
    text(label.toUpperCase(), x, y, { width: col, characterSpacing: 0.6 });
    doc.font('semibold').fontSize(10).fillColor(INK);
    text(clean(p.name), x, doc.y + 3, { width: col });
    doc.font('regular').fontSize(9).fillColor(INK);
    const rest = [...(p.attention ? [`Attn: ${p.attention}`] : []), ...p.lines, ...p.identifiers.map((i) => `${i.label}: ${i.value}`), ...(p.email ? [p.email] : [])]
      .map(clean).filter(Boolean);
    if (rest.length) text(rest.join('\n'), x, doc.y + 1, { width: col });
    return doc.y;
  };
  const fromEnd = party('From', s.seller, M.left);
  const toEnd = party('Statement for', s.billTo, M.left + col + 16);
  const summary: [string, string][] = [
    ['Currency', s.currencyCode], ['Opening balance', money(s.openingBalance)], ['Closing balance', money(s.closingBalance)],
  ];
  const dx = M.left + 2 * (col + 16);
  let dy = y;
  for (const [label, value] of summary) {
    doc.font('regular').fontSize(8).fillColor(MUTED);
    text(label.toUpperCase(), dx, dy, { width: col, characterSpacing: 0.6 });
    doc.font('semibold').fontSize(9.5).fillColor(INK);
    text(value, dx, doc.y + 1, { width: col });
    dy = doc.y + 5;
  }
  y = Math.max(fromEnd, toEnd, dy) + 20;

  // ---- activity ----
  const PAD = 6;
  const cols = [
    { key: 'date', label: 'Date', width: 72, align: 'left' as const },
    { key: 'label', label: 'Activity', width: 0, align: 'left' as const },
    { key: 'due', label: 'Due', width: 72, align: 'left' as const },
    { key: 'amount', label: 'Amount', width: 92, align: 'right' as const },
    { key: 'balance', label: 'Balance', width: 92, align: 'right' as const },
  ];
  cols[1]!.width = CONTENT - cols.reduce((sum, c) => sum + c.width, 0);
  const header = () => {
    doc.rect(M.left, y, CONTENT, 20).fill(tint(accent, 0.88));
    doc.font('semibold').fontSize(8).fillColor(INK);
    let x = M.left;
    for (const c of cols) {
      text(c.label.toUpperCase(), x + PAD, y + 6.5, { width: c.width - 2 * PAD, align: c.align, characterSpacing: 0.4, lineBreak: false });
      x += c.width;
    }
    y += 24;
  };
  const row = (cells: Record<string, string>, strong = false) => {
    doc.font(strong ? 'semibold' : 'regular').fontSize(9);
    const height = Math.max(...cols.map((c) => doc.heightOfString(fit(cells[c.key] ?? ''), { width: c.width - 2 * PAD, lineGap: 1.5 }))) + 10;
    if (y + height > bottom) {
      doc.addPage();
      y = M.top;
      header();
      doc.font(strong ? 'semibold' : 'regular').fontSize(9);
    }
    doc.fillColor(INK);
    let x = M.left;
    for (const c of cols) {
      text(cells[c.key] ?? '', x + PAD, y + 5, { width: c.width - 2 * PAD, align: c.align });
      x += c.width;
    }
    y += height;
    doc.moveTo(M.left, y).lineTo(M.left + CONTENT, y).lineWidth(0.5).strokeColor(RULE).stroke();
  };
  header();
  row({ date: date(s.from), label: 'Opening balance', due: '', amount: '', balance: money(s.openingBalance) }, true);
  for (const e of s.entries) {
    row({ date: date(e.date), label: clean(e.reference ? `${e.label} ${e.reference}` : e.label), due: e.dueDate ? date(e.dueDate) : '', amount: money(e.amount), balance: money(e.balance) });
  }
  if (s.entries.length === 0) row({ date: '', label: 'No activity in this period.', due: '', amount: '', balance: '' });
  row({ date: date(s.to), label: 'Closing balance', due: '', amount: '', balance: money(s.closingBalance) }, true);
  y += 18;

  // ---- ageing and credit at the end of the period ----
  const table = (title: string, items: { label: string; amount: string }[]) => {
    if (items.length === 0) return;
    const needed = 20 + items.length * 16;
    if (y + needed > bottom) {
      doc.addPage();
      y = M.top;
    }
    doc.font('semibold').fontSize(8).fillColor(MUTED);
    text(title.toUpperCase(), M.left, y, { width: CONTENT, characterSpacing: 0.6 });
    y = doc.y + 4;
    const w = 260;
    for (const item of items) {
      doc.font('regular').fontSize(9).fillColor(INK);
      text(item.label, M.left, y, { width: w * 0.6, lineBreak: false });
      text(money(item.amount), M.left + w * 0.6, y, { width: w * 0.4, align: 'right', lineBreak: false });
      y += 16;
    }
    y += 10;
  };
  table(`Open invoices by age at ${date(s.to)}`, s.ageing);
  table(`Credit on account at ${date(s.to)}`, s.credits);
  doc.font('regular').fontSize(7.5).fillColor(MUTED);
  if (y + 24 > bottom) {
    doc.addPage();
    y = M.top;
  }
  text('Payments and credit already matched to invoices are reflected in the balances above. Amounts are not converted between currencies.', M.left, y, { width: CONTENT });

  // ---- footer on every page ----
  const range = doc.bufferedPageRange();
  const footer = clean(s.branding.footerText).replace(/\n+/g, ' ').trim();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.moveTo(M.left, FOOTER_Y - 8).lineTo(M.left + CONTENT, FOOTER_Y - 8).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('regular').fontSize(7.5).fillColor(MUTED);
    if (footer) text(footer, M.left, FOOTER_Y, { width: CONTENT - 120, height: 20, ellipsis: true, lineBreak: true });
    text(`Statement · Page ${i + 1} of ${range.count}`, M.left + CONTENT - 120, FOOTER_Y, { width: 120, align: 'right', lineBreak: false });
  }
  doc.flushPages();
  doc.end();
  await finished;
  return { bytes: Buffer.concat(chunks), pageCount: range.count, unsupportedCharacters: unsupported };
}
