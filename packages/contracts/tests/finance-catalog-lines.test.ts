import { describe, expect, it } from 'vitest';
import { CreateInvoiceRequest, CreateCreditNoteRequest, CreateRecurringInvoiceRequest, FinanceDraftLineInput, UpdateCreditNoteRequest, UpdateQuoteRequest } from '../src';

// Finance F7-B (docs/finance-catalog-f7b.md): draft quote and invoice lines may name a catalog item.
const ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('draft line input', () => {
  it('a manual line still needs a description, quantity and price; a catalog line needs only the item', () => {
    expect(FinanceDraftLineInput.safeParse({ description: 'x', quantity: '1', unitPrice: '2' }).success).toBe(true);
    for (const missing of ['description', 'quantity', 'unitPrice']) {
      const line: Record<string, string> = { description: 'x', quantity: '1', unitPrice: '2' };
      delete line[missing];
      const parsed = FinanceDraftLineInput.safeParse(line);
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues[0]!.path).toEqual([missing]);
    }
    expect(FinanceDraftLineInput.parse({ catalogItemId: ID })).toEqual({ catalogItemId: ID });
    expect(FinanceDraftLineInput.parse({ catalogItemId: ID, quantity: ' 2 ', taxRateId: null })).toEqual({ catalogItemId: ID, quantity: '2', taxRateId: null });
  });

  it('is strict and keeps every field rule (no JSON numbers, no blank description, ids are uuids)', () => {
    for (const bad of [
      { catalogItemId: 'nope' }, { catalogItemId: ID, unitPrice: 5 }, { catalogItemId: ID, description: '   ' }, { catalogItemId: ID, itemName: 'x' },
      { catalogItemId: ID, quantity: '1.1234567' },
    ]) expect(FinanceDraftLineInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('is accepted by quote and invoice drafts only: credit notes and recurring schedules refuse catalogItemId', () => {
    expect(CreateInvoiceRequest.safeParse({ customerId: ID, lines: [{ catalogItemId: ID }] }).success).toBe(true);
    expect(UpdateQuoteRequest.safeParse({ version: 1, lines: [{ catalogItemId: ID }] }).success).toBe(true);
    expect(CreateCreditNoteRequest.safeParse({ lines: [{ catalogItemId: ID }] }).success).toBe(false);
    expect(UpdateCreditNoteRequest.safeParse({ version: 1, lines: [{ catalogItemId: ID, description: 'x', quantity: '1', unitPrice: '1' }] }).success).toBe(false);
    const recurring = CreateRecurringInvoiceRequest.safeParse({ lines: [{ catalogItemId: ID, description: 'x', quantity: '1', unitPrice: '1' }] });
    expect(recurring.success).toBe(false);
    expect(recurring.error!.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });
});
