import 'server-only';
// F6-2 accounting core (docs/finance-billing-f6.md §4): pure functions over effective-dated records.
// No database access: statements.ts loads the records in one SQL statement (one snapshot) and these
// functions compute statements, positions and ageing from them, so every rule here is unit-tested.
//
// A record is in effect on calendar day D when `start <= D` and (`end` is null or `end > D`). The loader
// derives start and end in the business's zone (§4.1):
//   invoice / credit note   start = issue date;         end = void date (never before the issue date)
//   payment received        start = received date;      end = reversal date (never before receipt)
//   allocation              start = allocated date, never before the payment's receipt or the invoice's issue;
//                           end = reversal date, never before that start
//   credit application      the same, with the credit note's and the invoice's issue dates
// Allocations and applications only match items; they never change the account balance. With these
// rules every allocation in effect links a payment and an invoice in effect, so on every day
//   account balance = receivable − unallocated payments − unapplied credit
// holds exactly (`balanced`; tested).
import { Decimal } from '@/core/db/decimal';

export type DocRecord = {
  type: 'INVOICE' | 'CREDIT_NOTE'; id: string; customerId: string; currencyCode: string; currencyScale: number; amount: Decimal;
  reference: string | null; start: string; end: string | null; dueDate: string | null;
};
export type PaymentRecord = {
  type: 'PAYMENT'; id: string; customerId: string; currencyCode: string; currencyScale: number; amount: Decimal; reference: string | null;
  start: string; end: string | null;
};
/** A payment allocation (from = payment, to = invoice) or a credit application (from = credit note, to = invoice). */
export type LinkRecord = {
  type: 'ALLOCATION' | 'APPLICATION'; id: string; fromId: string; toId: string; customerId: string; currencyCode: string; amount: Decimal;
  start: string; end: string | null;
};
export type ReceivableRecord = DocRecord | PaymentRecord | LinkRecord;

export type Bucket = 'CURRENT' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'DAYS_90_PLUS' | 'NO_DUE_DATE';
export const BUCKETS: readonly Bucket[] = ['CURRENT', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'DAYS_90_PLUS', 'NO_DUE_DATE'];

const isLink = (r: ReceivableRecord): r is LinkRecord => r.type === 'ALLOCATION' || r.type === 'APPLICATION';

export const inEffect = (r: { start: string; end: string | null }, day: string) => r.start <= day && (r.end === null || r.end > day);

const DAY_MS = 86_400_000;
/** Whole days from `a` to `b` (calendar dates). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** The calendar day before. */
export const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/**
 * D-F6-11 buckets by days past due as of the date. Matches F4/R1 "overdue" (due date before the date):
 * due on the date itself is current. Without a due date an invoice is receivable but never aged.
 */
export function bucketOf(daysPastDue: number | null): Bucket {
  if (daysPastDue === null) return 'NO_DUE_DATE';
  if (daysPastDue <= 0) return 'CURRENT';
  if (daysPastDue <= 30) return 'DAYS_1_30';
  if (daysPastDue <= 60) return 'DAYS_31_60';
  if (daysPastDue <= 90) return 'DAYS_61_90';
  return 'DAYS_90_PLUS';
}

export type OpenInvoice = {
  doc: DocRecord; paid: Decimal; credited: Decimal; outstanding: Decimal; daysPastDue: number | null; bucket: Bucket;
};
export type Credit = { kind: 'PAYMENT' | 'CREDIT_NOTE'; record: DocRecord | PaymentRecord; available: Decimal };
export type Position = {
  customerId: string; currencyCode: string; currencyScale: number;
  buckets: Record<Bucket, Decimal>; receivable: Decimal; overdue: Decimal; unallocatedPayments: Decimal; unappliedCredit: Decimal;
  accountBalance: Decimal; balanced: boolean; invoices: OpenInvoice[]; credits: Credit[];
};

const zero = () => new Decimal(0);
const keyOf = (r: { customerId: string; currencyCode: string }) => `${r.customerId}|${r.currencyCode}`;
const emptyBuckets = (): Record<Bucket, Decimal> => Object.fromEntries(BUCKETS.map((b) => [b, zero()])) as Record<Bucket, Decimal>;

/**
 * Positions per customer and currency at the end of `day`. Includes every (customer, currency) with an
 * account event in effect, even if everything nets to zero; callers drop all-zero positions.
 */
export function positionsAt(records: readonly ReceivableRecord[], day: string): Position[] {
  const settledTo = new Map<string, { paid: Decimal; credited: Decimal }>();
  const usedFrom = new Map<string, Decimal>();
  for (const r of records) {
    if (!isLink(r) || !inEffect(r, day)) continue;
    const s = settledTo.get(r.toId) ?? { paid: zero(), credited: zero() };
    if (r.type === 'ALLOCATION') s.paid = s.paid.add(r.amount);
    else s.credited = s.credited.add(r.amount);
    settledTo.set(r.toId, s);
    usedFrom.set(r.fromId, (usedFrom.get(r.fromId) ?? zero()).add(r.amount));
  }
  const positions = new Map<string, Position>();
  const positionOf = (r: DocRecord | PaymentRecord) => {
    const key = keyOf(r);
    let p = positions.get(key);
    if (!p) {
      p = {
        customerId: r.customerId, currencyCode: r.currencyCode, currencyScale: r.currencyScale, buckets: emptyBuckets(), receivable: zero(), overdue: zero(),
        unallocatedPayments: zero(), unappliedCredit: zero(), accountBalance: zero(), balanced: true, invoices: [], credits: [],
      };
      positions.set(key, p);
    }
    return p;
  };
  for (const r of records) {
    if (isLink(r) || !inEffect(r, day)) continue;
    const p = positionOf(r);
    if (r.type === 'INVOICE') {
      p.accountBalance = p.accountBalance.add(r.amount);
      const s = settledTo.get(r.id) ?? { paid: zero(), credited: zero() };
      const outstanding = r.amount.sub(s.paid).sub(s.credited);
      if (outstanding.isZero()) continue;
      const daysPastDue = r.dueDate === null ? null : daysBetween(r.dueDate, day);
      const bucket = bucketOf(daysPastDue);
      p.buckets[bucket] = p.buckets[bucket].add(outstanding);
      p.receivable = p.receivable.add(outstanding);
      if (daysPastDue !== null && daysPastDue > 0) p.overdue = p.overdue.add(outstanding);
      p.invoices.push({ doc: r, paid: s.paid, credited: s.credited, outstanding, daysPastDue, bucket });
    } else {
      p.accountBalance = p.accountBalance.sub(r.amount);
      const available = r.amount.sub(usedFrom.get(r.id) ?? zero());
      if (available.isZero()) continue;
      if (r.type === 'PAYMENT') p.unallocatedPayments = p.unallocatedPayments.add(available);
      else p.unappliedCredit = p.unappliedCredit.add(available);
      p.credits.push({ kind: r.type === 'PAYMENT' ? 'PAYMENT' : 'CREDIT_NOTE', record: r, available });
    }
  }
  const out = [...positions.values()];
  for (const p of out) {
    p.balanced = p.accountBalance.eq(p.receivable.sub(p.unallocatedPayments).sub(p.unappliedCredit));
    p.invoices.sort((a, b) => (a.doc.dueDate ?? '9999-12-31').localeCompare(b.doc.dueDate ?? '9999-12-31') || a.doc.start.localeCompare(b.doc.start)
      || (a.doc.reference ?? '').localeCompare(b.doc.reference ?? '') || a.doc.id.localeCompare(b.doc.id));
    p.credits.sort((a, b) => a.record.start.localeCompare(b.record.start) || a.record.id.localeCompare(b.record.id));
  }
  return out.sort((a, b) => a.customerId.localeCompare(b.customerId) || a.currencyCode.localeCompare(b.currencyCode));
}

/** True when nothing is open and there is no credit (the position is not listed). */
export const isEmptyPosition = (p: Position) => p.receivable.isZero() && p.unallocatedPayments.isZero() && p.unappliedCredit.isZero();

// ---- statement --------------------------------------------------------------------------------------

export type EntryType = 'INVOICE' | 'INVOICE_VOID' | 'CREDIT_NOTE' | 'CREDIT_NOTE_VOID' | 'PAYMENT' | 'PAYMENT_REVERSAL';
/** Within one day: new items first, then reversals and voids (a void never precedes what it voids). */
const ORDER: Record<EntryType, number> = { INVOICE: 1, CREDIT_NOTE: 2, PAYMENT: 3, PAYMENT_REVERSAL: 4, CREDIT_NOTE_VOID: 5, INVOICE_VOID: 6 };

export type Entry = { date: string; type: EntryType; sourceId: string; reference: string | null; dueDate: string | null; amount: Decimal; balance: Decimal };

/** The signed account events of one customer and currency (D-F6-10): documents and payments, never links. */
export function accountEvents(records: readonly ReceivableRecord[]): Omit<Entry, 'balance'>[] {
  const events: Omit<Entry, 'balance'>[] = [];
  for (const r of records) {
    if (isLink(r)) continue;
    const base = { sourceId: r.id, reference: r.reference, dueDate: r.type === 'INVOICE' ? r.dueDate : null };
    // Invoices raise the balance; credit notes and payments lower it. Voids and reversals offset on their own date.
    const sign = r.type === 'INVOICE' ? 1 : -1;
    const created: EntryType = r.type;
    const undone: EntryType = r.type === 'INVOICE' ? 'INVOICE_VOID' : r.type === 'CREDIT_NOTE' ? 'CREDIT_NOTE_VOID' : 'PAYMENT_REVERSAL';
    events.push({ ...base, date: r.start, type: created, amount: sign > 0 ? r.amount : r.amount.neg() });
    if (r.end !== null) events.push({ ...base, date: r.end, type: undone, amount: sign > 0 ? r.amount.neg() : r.amount });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.type] - ORDER[b.type] || (a.reference ?? '').localeCompare(b.reference ?? '')
    || a.sourceId.localeCompare(b.sourceId));
}

/** Opening balance (events before `from`), the dated entries in [from, to] with a running balance, and the closing balance. */
export function statementOf(records: readonly ReceivableRecord[], from: string, to: string) {
  let opening = zero();
  const entries: Entry[] = [];
  let running = zero();
  for (const e of accountEvents(records)) {
    if (e.date > to) continue; // later events never reach a statement that ends before them
    if (e.date < from) {
      opening = opening.add(e.amount);
      running = opening;
      continue;
    }
    running = running.add(e.amount);
    entries.push({ ...e, balance: running });
  }
  return { opening, entries, closing: entries.length ? running : opening };
}
