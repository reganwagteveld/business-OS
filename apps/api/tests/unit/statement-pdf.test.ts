// Finance F6-2 statement PDF (docs/finance-billing-f6.md §4, D-F6-9): the statement template renders
// with F5's fonts and branding, deterministically for the same snapshot, across pages for long
// statements, and flags characters the fonts cannot draw. With PDF_EXAMPLES_DIR set, the PDFs are also
// written there (docs/evidence/finance-f6-2 holds a copy).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderStatement, type StatementSnapshot } from '@/modules/finance/server/pdf/statement';
import { png } from '../support/png';

const LOGO = png(240, 80, [31, 75, 153], (x) => (x < 80 ? [31, 75, 153] : [255, 255, 255]));

const snap = (o: Partial<StatementSnapshot> = {}): StatementSnapshot => ({
  renderedAt: '2026-11-15T03:00:00.000Z', locale: 'en-AU', currencyCode: 'AUD', currencyScale: 2, from: '2026-10-01', to: '2026-10-31',
  seller: { name: 'Harbour Studio Pty Ltd', lines: ['12 Wharf Street', 'Fremantle WA 6160'], identifiers: [{ label: 'ABN', value: '12 345 678 901' }], email: 'accounts@harbour.example', phone: null, attention: null },
  billTo: { name: 'Acme Holdings', lines: ['1 Main Road', 'Perth WA 6000'], identifiers: [], email: 'ap@acme.example', phone: null, attention: 'Accounts payable' },
  openingBalance: '1200.00', closingBalance: '850.00',
  entries: [
    { date: '2026-10-03', label: 'Payment received', reference: 'EFT 4411', dueDate: null, amount: '-1200.00', balance: '0.00' },
    { date: '2026-10-10', label: 'Invoice', reference: 'INV-0042', dueDate: '2026-11-09', amount: '1100.00', balance: '1100.00' },
    { date: '2026-10-20', label: 'Credit note', reference: 'CN-0003', dueDate: null, amount: '-250.00', balance: '850.00' },
  ],
  ageing: [{ label: 'Current (not yet due)', amount: '850.00' }, { label: 'Total open on invoices', amount: '850.00' }],
  credits: [],
  branding: { accentColor: '#1F4B99', footerText: 'Harbour Studio · harbour.example', logo: null },
  ...o,
});

const many = Array.from({ length: 120 }, (_, i) => ({
  date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, label: i % 2 ? 'Payment received' : 'Invoice', reference: `REF-${i}`, dueDate: null,
  amount: i % 2 ? '-10.00' : '10.00', balance: i % 2 ? '0.00' : '10.00',
}));

const EXAMPLES: Record<string, { snap: StatementSnapshot; logo: Buffer | null }> = {
  'statement-standard': { snap: snap(), logo: null },
  'statement-logo-credit': {
    snap: snap({
      branding: { accentColor: '#0A7D4F', footerText: null, logo: { width: 240, height: 80 } }, closingBalance: '-150.00',
      ageing: [], credits: [{ label: 'Payments not yet matched to an invoice', amount: '150.00' }],
    }),
    logo: LOGO,
  },
  'statement-long': { snap: snap({ entries: many }), logo: null },
};

describe('statement PDF', () => {
  it('renders the examples as PDFs, deterministically', async () => {
    const dir = process.env.PDF_EXAMPLES_DIR;
    if (dir) mkdirSync(dir, { recursive: true });
    for (const [name, { snap: s, logo }] of Object.entries(EXAMPLES)) {
      const a = await renderStatement(s, logo);
      const b = await renderStatement(s, logo);
      expect(a.bytes.subarray(0, 5).toString(), name).toBe('%PDF-');
      expect(a.bytes.equals(b.bytes), name).toBe(true);
      expect(a.unsupportedCharacters, name).toBe(false);
      if (dir) writeFileSync(join(dir, `${name}.pdf`), a.bytes);
    }
  });

  it('a long statement flows onto further pages', async () => {
    expect((await renderStatement(EXAMPLES['statement-long']!.snap, null)).pageCount).toBeGreaterThan(1);
    expect((await renderStatement(snap(), null)).pageCount).toBe(1);
  });

  it('flags characters the embedded fonts cannot draw, never drops them', async () => {
    const r = await renderStatement(snap({ billTo: { ...snap().billTo, name: '株式会社 Acme' } }), null);
    expect(r.unsupportedCharacters).toBe(true);
  });

  it('refuses a missing logo rather than rendering without it', async () => {
    await expect(renderStatement(snap({ branding: { accentColor: '#1F4B99', footerText: null, logo: { width: 10, height: 10 } } }), null)).rejects.toThrow(/logo/);
  });
});
