// Representative snapshots for the F5 renderer tests and the visual fixtures (docs/finance-documents-f5.md §9).
import type { DocumentSnapshot, SnapshotLine } from '@/modules/finance/server/pdf/snapshot';

export const line = (over: Partial<SnapshotLine> = {}): SnapshotLine => ({
  position: 1000, description: 'Consulting', quantity: '2', unitPrice: '150', discountAmount: '0.00', taxName: 'GST', taxRatePercent: '10',
  lineNet: '300.00', lineTax: '30.00', ...over,
});

export function snapshot(over: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    schema: 1, template: { id: 'standard', version: 1 }, renderedAt: '2026-11-15T08:00:00.000Z', kind: 'INVOICE', status: 'ISSUED', number: 'INV-0042',
    issueDate: '2026-11-15', dueDate: '2026-12-15', validUntil: null, locale: 'en-AU', currencyCode: 'AUD', currencyScale: 2, taxMode: 'EXCLUSIVE',
    seller: {
      name: 'Harbour Studio Pty Ltd', lines: ['12 Wharf Street', 'Fremantle WA 6160'], identifiers: [{ label: 'ABN', value: '12 345 678 901' }],
      email: 'accounts@harbour.example', phone: '+61 8 9000 0000', attention: null,
    },
    billTo: {
      name: 'Acme Pty Ltd', lines: ['1 Old Street', 'Perth WA 6000', 'Australia'], identifiers: [{ label: 'ABN', value: '51 824 753 556' }],
      email: 'ap@acme.example', phone: null, attention: 'Jordan Lee',
    },
    lines: [line(), line({ position: 2000, description: 'Travel', quantity: '1', unitPrice: '99.99', taxName: null, taxRatePercent: '0', lineNet: '99.99', lineTax: '0.00' })],
    taxBreakdown: [{ taxName: 'GST', taxRatePercent: '10', net: '300.00', tax: '30.00' }, { taxName: null, taxRatePercent: '0', net: '99.99', tax: '0.00' }],
    totals: { subtotal: '399.99', taxTotal: '30.00', total: '429.99' },
    paymentInstructions: 'BSB 000-000, account 12345678\nReference: INV-0042',
    notes: null,
    branding: { accentColor: '#1F4B99', title: 'Tax invoice', terms: 'Payment within 30 days.', footerText: 'Thank you for your business.', logo: null },
    source: { documentId: '00000000-0000-4000-8000-000000000001', documentVersion: 2, contentSha256: 'a'.repeat(64), sourceQuoteNumber: null },
    ...over,
  };
}
