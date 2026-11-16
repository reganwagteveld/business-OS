/**
 * Finance F6-2 (docs/finance-billing-f6.md §4): the pure accounting core of statements and receivables
 * ageing. Effective-dated records in, statements and positions out. The database loader and routes are
 * covered by tests/integration/finance-statements.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '@/core/db/decimal';
import {
  accountEvents, bucketOf, dayBefore, positionsAt, statementOf, type DocRecord, type LinkRecord, type PaymentRecord, type ReceivableRecord,
} from '@/modules/finance/server/receivables-core';

const C = '00000000-0000-4000-8000-000000000001';
const base = { customerId: C, currencyCode: 'AUD', currencyScale: 2 };
const inv = (id: string, amount: string, start: string, dueDate: string | null, end: string | null = null): DocRecord =>
  ({ ...base, type: 'INVOICE', id, amount: new Decimal(amount), reference: `INV-${id}`, start, end, dueDate });
const cn = (id: string, amount: string, start: string, end: string | null = null): DocRecord =>
  ({ ...base, type: 'CREDIT_NOTE', id, amount: new Decimal(amount), reference: `CN-${id}`, start, end, dueDate: null });
const pay = (id: string, amount: string, start: string, end: string | null = null): PaymentRecord =>
  ({ ...base, type: 'PAYMENT', id, amount: new Decimal(amount), reference: null, start, end });
const link = (type: 'ALLOCATION' | 'APPLICATION', id: string, fromId: string, toId: string, amount: string, start: string, end: string | null = null): LinkRecord =>
  ({ type, id, fromId, toId, customerId: C, currencyCode: 'AUD', amount: new Decimal(amount), start, end });

const str = (d: Decimal) => d.toFixed(2);

describe('ageing buckets (D-F6-11)', () => {
  it('due on the date is current; then 1–30, 31–60, 61–90, 90+; no due date is its own bucket', () => {
    expect([null, -5, 0, 1, 30, 31, 60, 61, 90, 91, 400].map(bucketOf)).toEqual([
      'NO_DUE_DATE', 'CURRENT', 'CURRENT', 'DAYS_1_30', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_31_60', 'DAYS_61_90', 'DAYS_61_90', 'DAYS_90_PLUS', 'DAYS_90_PLUS',
    ]);
  });
});

describe('statements (D-F6-10)', () => {
  const records: ReceivableRecord[] = [
    inv('a', '100.00', '2026-01-05', '2026-02-04'),
    inv('b', '50.00', '2026-02-10', '2026-03-12', '2026-02-20'), // voided ten days later
    cn('c', '20.00', '2026-02-15'),
    pay('p', '60.00', '2026-02-01', '2026-03-03'), // reversed in March
    link('ALLOCATION', 'al', 'p', 'a', '60.00', '2026-02-01', '2026-03-03'),
    link('APPLICATION', 'ap', 'c', 'a', '20.00', '2026-02-16'),
  ];

  it('balance forward: opening from events before the range, signed entries, voids and reversals offset on their own date', () => {
    const s = statementOf(records, '2026-02-01', '2026-02-28');
    expect(str(s.opening)).toBe('100.00');
    expect(s.entries.map((e) => [e.date, e.type, str(e.amount), str(e.balance)])).toEqual([
      ['2026-02-01', 'PAYMENT', '-60.00', '40.00'],
      ['2026-02-10', 'INVOICE', '50.00', '90.00'],
      ['2026-02-15', 'CREDIT_NOTE', '-20.00', '70.00'],
      ['2026-02-20', 'INVOICE_VOID', '-50.00', '20.00'],
    ]);
    expect(str(s.closing)).toBe('20.00');
  });

  it('allocations and credit applications never appear as entries or move the balance', () => {
    expect(accountEvents(records).map((e) => e.type)).not.toContain('ALLOCATION');
    const without = records.filter((r) => r.type !== 'ALLOCATION' && r.type !== 'APPLICATION');
    expect(str(statementOf(without, '2026-01-01', '2026-03-31').closing)).toBe(str(statementOf(records, '2026-01-01', '2026-03-31').closing));
  });

  it('events after the end date never reach the statement (the March reversal)', () => {
    const feb = statementOf(records, '2026-02-01', '2026-02-28');
    expect(feb.entries.some((e) => e.type === 'PAYMENT_REVERSAL')).toBe(false);
    const march = statementOf(records, '2026-03-01', '2026-03-31');
    expect(str(march.opening)).toBe(str(feb.closing));
    expect(march.entries.map((e) => [e.type, str(e.amount)])).toEqual([['PAYMENT_REVERSAL', '60.00']]);
    expect(str(march.closing)).toBe('80.00');
  });

  it('an empty range closes at the opening balance; same-day items order before their void', () => {
    expect(str(statementOf(records, '2026-04-01', '2026-04-30').closing)).toBe('80.00');
    const sameDay = statementOf([inv('x', '10.00', '2026-05-01', null, '2026-05-01')], '2026-05-01', '2026-05-01');
    expect(sameDay.entries.map((e) => e.type)).toEqual(['INVOICE', 'INVOICE_VOID']);
    expect(str(sameDay.closing)).toBe('0.00');
  });
});

describe('positions as of a date', () => {
  const records: ReceivableRecord[] = [
    inv('a', '100.00', '2026-01-05', '2026-02-04'),
    inv('n', '30.00', '2026-01-06', null),
    cn('c', '20.00', '2026-02-15'),
    pay('p', '60.00', '2026-02-01', '2026-03-03'),
    link('ALLOCATION', 'al', 'p', 'a', '60.00', '2026-02-10', '2026-03-03'),
    link('APPLICATION', 'ap', 'c', 'a', '15.00', '2026-02-16'),
  ];

  it('reconstructs history from dated links, not current counters; credit stays separate', () => {
    // 5 Feb: the payment is received but not yet allocated: it is credit on account, the invoice is fully open.
    const [feb5] = positionsAt(records, '2026-02-05');
    expect(feb5!.invoices.map((i) => [i.doc.id, str(i.outstanding), i.bucket])).toEqual([['a', '100.00', 'DAYS_1_30'], ['n', '30.00', 'NO_DUE_DATE']]);
    expect(str(feb5!.unallocatedPayments)).toBe('60.00');
    expect(str(feb5!.receivable)).toBe('130.00');
    expect(str(feb5!.overdue)).toBe('100.00');
    expect(feb5!.balanced).toBe(true);

    // 20 Feb: allocated and part credited; 5 unapplied credit left.
    const [feb20] = positionsAt(records, '2026-02-20');
    expect(str(feb20!.invoices[0]!.outstanding)).toBe('25.00');
    expect(str(feb20!.unallocatedPayments)).toBe('0.00');
    expect(str(feb20!.unappliedCredit)).toBe('5.00');
    expect(str(feb20!.accountBalance)).toBe('50.00');
    expect(feb20!.balanced).toBe(true);

    // 10 Mar: the payment was reversed with its allocation; the invoice reopens and is 34 days past due.
    const [mar10] = positionsAt(records, '2026-03-10');
    expect(str(mar10!.invoices[0]!.outstanding)).toBe('85.00');
    expect(mar10!.invoices[0]!.bucket).toBe('DAYS_31_60');
    expect(mar10!.balanced).toBe(true);
  });

  it('balance = receivable − unallocated − unapplied, and matches the statement closing balance, on every day', () => {
    for (let d = '2026-01-01'; d <= '2026-04-10'; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const p = positionsAt(records, d)[0];
      const closing = statementOf(records, '2026-01-01', d).closing;
      if (!p) {
        expect(str(closing)).toBe('0.00');
        continue;
      }
      expect(p.balanced, d).toBe(true);
      expect(str(p.accountBalance), d).toBe(str(closing));
    }
  });

  it('a link reversed on the day it took effect is never in effect', () => {
    const [p] = positionsAt([inv('a', '10.00', '2026-01-01', '2026-01-31'), pay('p', '10.00', '2026-01-01'), link('ALLOCATION', 'l', 'p', 'a', '10.00', '2026-01-02', '2026-01-02')], '2026-01-02');
    expect(str(p!.receivable)).toBe('10.00');
    expect(str(p!.unallocatedPayments)).toBe('10.00');
  });

  it('keeps currencies apart and never converts', () => {
    const eur = { ...inv('e', '40.00', '2026-01-01', '2026-01-31'), currencyCode: 'EUR' };
    const out = positionsAt([inv('a', '10.00', '2026-01-01', '2026-01-31'), eur], '2026-01-10');
    expect(out.map((p) => [p.currencyCode, str(p.receivable)])).toEqual([['AUD', '10.00'], ['EUR', '40.00']]);
  });

  it('dayBefore crosses month and year ends', () => {
    expect([dayBefore('2026-03-01'), dayBefore('2026-01-01')]).toEqual(['2026-02-28', '2025-12-31']);
  });
});
