// Finance F5 visual fixtures (docs/finance-documents-f5.md §9). Renders the example documents with the
// real template and checks that rendering is deterministic: the same snapshot gives the same bytes.
// With PDF_EXAMPLES_DIR set, the PDFs are also written there (docs/evidence/finance-f5 holds a copy).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDocument } from '@/modules/finance/server/pdf/render';
import type { DocumentSnapshot } from '@/modules/finance/server/pdf/snapshot';
import { line, snapshot } from '../support/pdf-fixtures';
import { png } from '../support/png';

/** A simple two-tone mark, 240 × 80. */
const LOGO = png(240, 80, [31, 75, 153], (x, y) => (x < 80 ? ((x - 40) ** 2 + (y - 40) ** 2 < 1300 ? [31, 75, 153] : [255, 255, 255]) : y > 30 && y < 50 ? [120, 140, 170] : [255, 255, 255]));
const LOGO_META = { assetId: '00000000-0000-4000-8000-0000000000aa', sha256: createHash('sha256').update(LOGO).digest('hex'), contentType: 'image/png' as const, width: 240, height: 80 };

const many = Array.from({ length: 64 }, (_, i) => line({
  position: (i + 1) * 1000,
  description: i % 9 === 0
    ? `Site visit ${i + 1}: inspection of the north-east stormwater line, replacement of two cracked junctions, and a written report with photographs for the strata manager`
    : `Labour, item ${i + 1}`,
  quantity: i % 4 === 0 ? '1.5' : '1', unitPrice: '120', discountAmount: i % 7 === 0 ? '10.00' : '0.00',
  lineNet: i % 4 === 0 ? (i % 7 === 0 ? '170.00' : '180.00') : i % 7 === 0 ? '110.00' : '120.00',
}));
for (const l of many) l.lineTax = (Number(l.lineNet) / 10).toFixed(2);
const manyNet = many.reduce((s, l) => s + Math.round(Number(l.lineNet) * 100), 0);
const manyTax = many.reduce((s, l) => s + Math.round(Number(l.lineTax) * 100), 0);
const cents = (n: number) => (n / 100).toFixed(2);

const EXAMPLES: Record<string, { snap: DocumentSnapshot; logo: Buffer | null }> = {
  'invoice-issued': {
    snap: snapshot({ branding: { ...snapshot().branding, logo: LOGO_META } }),
    logo: LOGO,
  },
  'quote-issued': {
    snap: snapshot({
      kind: 'QUOTE', number: 'QUO-0017', dueDate: null, validUntil: '2026-12-15', paymentInstructions: null,
      notes: 'Price includes removal of old fixtures.\nWork can start within two weeks of acceptance.',
      branding: { accentColor: '#0A7D4F', title: 'Quote', terms: 'This quote is valid for 30 days.', footerText: 'Harbour Studio · harbour.example', logo: null },
    }),
    logo: null,
  },
  'invoice-draft-preview': { snap: snapshot({ status: 'DRAFT', number: null }), logo: null },
  'invoice-void': { snap: snapshot({ status: 'VOID' }), logo: null },
  'invoice-multipage': {
    snap: snapshot({
      number: 'INV-0108', lines: many,
      taxBreakdown: [{ taxName: 'GST', taxRatePercent: '10', net: cents(manyNet), tax: cents(manyTax) }],
      totals: { subtotal: cents(manyNet), taxTotal: cents(manyTax), total: cents(manyNet + manyTax) },
      notes: 'Long notes wrap across lines and pages. '.repeat(20),
    }),
    logo: null,
  },
  'invoice-eur-unicode': {
    snap: snapshot({
      number: 'RE-2026-0042', locale: 'de-DE', currencyCode: 'EUR',
      seller: { name: 'Müller & Söhne GmbH', lines: ['Königstraße 5', '70173 Stuttgart', 'Deutschland'], identifiers: [{ label: 'USt-IdNr.', value: 'DE123456789' }], email: 'büro@müller.example', phone: null, attention: null },
      billTo: { name: 'Café Øresund ApS', lines: ['Strøget 1', '1160 København K'], identifiers: [], email: null, phone: null, attention: 'Zoë Ångström' },
      lines: [
        line({ description: 'Beratung – Façade “Élan” (½ Tag)', quantity: '0.5', unitPrice: '800', lineNet: '400.00', taxName: 'MwSt.', taxRatePercent: '19', lineTax: '76.00' }),
        line({ position: 2000, description: 'Reisekosten ≈ 120 km · Ünterkunft', quantity: '1', unitPrice: '95.5', lineNet: '95.50', taxName: 'MwSt.', taxRatePercent: '7', lineTax: '6.69' }),
      ],
      taxBreakdown: [{ taxName: 'MwSt.', taxRatePercent: '19', net: '400.00', tax: '76.00' }, { taxName: 'MwSt.', taxRatePercent: '7', net: '95.50', tax: '6.69' }],
      totals: { subtotal: '495.50', taxTotal: '82.69', total: '578.19' },
      paymentInstructions: 'IBAN DE00 0000 0000 0000 0000 00 · BIC XXXXDEXX',
      branding: { accentColor: '#7A1F5C', title: 'Rechnung', terms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.', footerText: null, logo: null },
    }),
    logo: null,
  },
};

describe('F5 example documents', () => {
  it.each(Object.entries(EXAMPLES))('%s renders, deterministically', async (name, { snap, logo }) => {
    const a = await renderDocument(snap, logo);
    const b = await renderDocument(snap, logo);
    expect(Buffer.from(a.bytes).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(a.unsupportedCharacters).toBe(false);
    if (name === 'invoice-multipage') expect(a.pageCount).toBeGreaterThan(1);
    const dir = process.env.PDF_EXAMPLES_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.pdf`), a.bytes);
    }
  }, 20_000);
});
