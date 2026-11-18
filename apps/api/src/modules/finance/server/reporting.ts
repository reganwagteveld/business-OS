import 'server-only';
// Finance's reporting read model (docs/reporting-r1.md §4). Finance owns these rules: which documents and
// payments count, by which date, in which currency. The Reporting module calls them through this module's
// public API and never reads finance tables itself, so there is one definition of each amount.
//
//   invoiced  = sum of `total` (tax included, after line discounts) of ISSUED invoices, by issue date.
//               DRAFT and VOID invoices never count: a voided invoice is removed from every period,
//               including the one it was issued in. Credit notes are reported separately, never netted.
//               Issuing an invoice is billing, not recognised revenue.
//   credited  = the same rule for ISSUED credit notes.
//   received  = sum of `amount` of RECORDED payments received from customers, by the date received,
//               whether or not they are allocated to an invoice. REVERSED payments never count.
//
// Issue and receipt dates are calendar dates already in the business's time zone (documents are dated
// in the business's zone), so no time zone conversion applies. Nothing is converted between currencies.
// Every statement runs on the tenant client (bos_app, forced RLS) with an explicit business_id predicate.
import type { AppTenantDb } from '@/core/db';
import { Decimal } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { formatAmount } from './money';

export type ReportingUnit = 'day' | 'week' | 'month';

/** One reporting query: an inclusive date range, a bucket size and the allowlisted filters. */
export interface FinancePeriodQuery {
  from: string;
  to: string;
  unit: ReportingUnit;
  byCustomer: boolean;
  currencyCode?: string;
  customerId?: string;
}

/** One (bucket, currency[, customer]) total. `amount` is exact at the currency's decimals. */
export interface FinancePeriodRow {
  bucket: string;
  currencyCode: string;
  customerId: string | null;
  amount: string;
  count: number;
}

type Raw = { bucket: string; currency_code: string; currency_scale: number; customer_id: string | null; amount: Decimal; count: number };

const rowsOf = (rows: Raw[]): FinancePeriodRow[] =>
  rows.map((r) => ({
    bucket: r.bucket, currencyCode: r.currency_code, customerId: r.customer_id, amount: formatAmount(new Decimal(r.amount), r.currency_scale), count: Number(r.count),
  }));

/** Issued (never draft, never void) invoices or credit notes per bucket of their issue date. */
export async function issuedDocumentTotals(db: AppTenantDb, kind: 'INVOICE' | 'CREDIT_NOTE', q: FinancePeriodQuery): Promise<FinancePeriodRow[]> {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT to_char(date_trunc(${q.unit}::text, d.issue_date::timestamp), 'YYYY-MM-DD') AS bucket,
           d.currency_code::text AS currency_code, max(d.currency_scale)::int AS currency_scale,
           CASE WHEN ${q.byCustomer}::boolean THEN d.customer_id::text END AS customer_id,
           sum(d.total) AS amount, count(*)::int AS count
      FROM finance_documents d
     WHERE d.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND d.kind = ${kind}::"FinanceDocumentKind" AND d.status = 'ISSUED'
       AND d.issue_date >= ${q.from}::date AND d.issue_date <= ${q.to}::date
       AND (${q.currencyCode ?? null}::text IS NULL OR d.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR d.customer_id = ${q.customerId ?? null}::uuid)
     GROUP BY 1, 2, 4
     ORDER BY 1, 2, 4`;
  return rowsOf(rows);
}

/** Recorded (never reversed) payments received from customers per bucket of the date received. */
export async function receivedPaymentTotals(db: AppTenantDb, q: FinancePeriodQuery): Promise<FinancePeriodRow[]> {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT to_char(date_trunc(${q.unit}::text, p.received_on::timestamp), 'YYYY-MM-DD') AS bucket,
           p.currency_code::text AS currency_code, max(p.currency_scale)::int AS currency_scale,
           CASE WHEN ${q.byCustomer}::boolean THEN p.customer_id::text END AS customer_id,
           sum(p.amount) AS amount, count(*)::int AS count
      FROM finance_payments p
     WHERE p.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND p.direction = 'RECEIVED' AND p.status = 'RECORDED'
       AND p.received_on >= ${q.from}::date AND p.received_on <= ${q.to}::date
       AND (${q.currencyCode ?? null}::text IS NULL OR p.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR p.customer_id = ${q.customerId ?? null}::uuid)
     GROUP BY 1, 2, 4
     ORDER BY 1, 2, 4`;
  return rowsOf(rows);
}

// ---- drill-down: the records behind the totals above, with exactly the same predicates -----------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface FinanceDetailQuery { from: string; to: string; currencyCode?: string; customerId?: string; cursor?: string; limit: number }

export interface IssuedDocumentDetail {
  id: string; number: string | null; customerId: string; issueDate: string; dueDate: string | null; currencyCode: string; total: string;
}

/** Issued invoices or credit notes in the range, newest issue date first, keyset-paginated on (issue_date, id). */
export async function issuedDocumentDetails(db: AppTenantDb, kind: 'INVOICE' | 'CREDIT_NOTE', q: FinanceDetailQuery) {
  const list = `reporting:finance.${kind}`;
  const after = decodeCursor(q.cursor, list, ['d', 'i'] as const);
  if (after && (!DAY.test(after.d) || !UUID.test(after.i))) invalidCursor();
  const rows = await db.$queryRaw<{
    id: string; number: string | null; customer_id: string; issue_date: string; due_date: string | null; currency_code: string; currency_scale: number; total: Decimal;
  }[]>`
    SELECT d.id::text, d.number, d.customer_id::text, to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date, to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
           d.currency_code::text, d.currency_scale::int, d.total
      FROM finance_documents d
     WHERE d.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND d.kind = ${kind}::"FinanceDocumentKind" AND d.status = 'ISSUED'
       AND d.issue_date >= ${q.from}::date AND d.issue_date <= ${q.to}::date
       AND (${q.currencyCode ?? null}::text IS NULL OR d.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR d.customer_id = ${q.customerId ?? null}::uuid)
       AND (${after?.d ?? null}::date IS NULL OR (d.issue_date, d.id) < (${after?.d ?? null}::date, ${after?.i ?? null}::uuid))
     ORDER BY d.issue_date DESC, d.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): IssuedDocumentDetail => ({
      id: r.id, number: r.number, customerId: r.customer_id, issueDate: r.issue_date, dueDate: r.due_date, currencyCode: r.currency_code,
      total: formatAmount(new Decimal(r.total), r.currency_scale),
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(list, { d: last.issue_date, i: last.id }) : null,
  };
}

export interface ReceivedPaymentDetail {
  id: string; customerId: string; receivedOn: string; method: string; reference: string | null; currencyCode: string; amount: string;
}

/** Recorded payments received in the range, newest first, keyset-paginated on (received_on, id). */
export async function receivedPaymentDetails(db: AppTenantDb, q: FinanceDetailQuery) {
  const list = 'reporting:finance.received';
  const after = decodeCursor(q.cursor, list, ['d', 'i'] as const);
  if (after && (!DAY.test(after.d) || !UUID.test(after.i))) invalidCursor();
  const rows = await db.$queryRaw<{
    id: string; customer_id: string; received_on: string; method: string; reference: string | null; currency_code: string; currency_scale: number; amount: Decimal;
  }[]>`
    SELECT p.id::text, p.customer_id::text, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.method::text, p.reference,
           p.currency_code::text, p.currency_scale::int, p.amount
      FROM finance_payments p
     WHERE p.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND p.direction = 'RECEIVED' AND p.status = 'RECORDED'
       AND p.received_on >= ${q.from}::date AND p.received_on <= ${q.to}::date
       AND (${q.currencyCode ?? null}::text IS NULL OR p.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR p.customer_id = ${q.customerId ?? null}::uuid)
       AND (${after?.d ?? null}::date IS NULL OR (p.received_on, p.id) < (${after?.d ?? null}::date, ${after?.i ?? null}::uuid))
     ORDER BY p.received_on DESC, p.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): ReceivedPaymentDetail => ({
      id: r.id, customerId: r.customer_id, receivedOn: r.received_on, method: r.method, reference: r.reference, currencyCode: r.currency_code,
      amount: formatAmount(new Decimal(r.amount), r.currency_scale),
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(list, { d: last.received_on, i: last.id }) : null,
  };
}

// ---- WP-R1: expenses recorded ----------------------------------------------------------------------------
//
//   expenses  = sum of `amount` (gross: net plus tax, as the supplier billed it) of RECORDED expenses, by the
//               date the cost was incurred (`incurred_on`, a business-local calendar date). DRAFT expenses never
//               count; a VOID expense is removed from every period, including the one it was incurred in.
//               Payments to suppliers are not expenses and are not counted again. Nothing is converted
//               between currencies. Only the expense's own cost fields leave this module (no notes, no
//               receipt reference).

/** Recorded (never draft, never void) expenses per bucket of `incurred_on`; the customer is optional on an expense. */
export async function recordedExpenseTotals(db: AppTenantDb, q: FinancePeriodQuery): Promise<FinancePeriodRow[]> {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT to_char(date_trunc(${q.unit}::text, e.incurred_on::timestamp), 'YYYY-MM-DD') AS bucket,
           e.currency_code::text AS currency_code, max(e.currency_scale)::int AS currency_scale,
           CASE WHEN ${q.byCustomer}::boolean THEN e.customer_id::text END AS customer_id,
           sum(e.amount) AS amount, count(*)::int AS count
      FROM finance_expenses e
     WHERE e.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND e.status = 'RECORDED'
       AND e.incurred_on >= ${q.from}::date AND e.incurred_on <= ${q.to}::date
       AND (${q.currencyCode ?? null}::text IS NULL OR e.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR e.customer_id = ${q.customerId ?? null}::uuid)
     GROUP BY 1, 2, 4
     ORDER BY 1, 2, 4`;
  return rowsOf(rows);
}

export interface RecordedExpenseDetail {
  id: string; customerId: string | null; incurredOn: string; description: string; supplierName: string | null; categoryName: string | null; currencyCode: string; amount: string;
}

/** Recorded expenses in the range, newest first, keyset-paginated on (incurred_on, id). */
export async function recordedExpenseDetails(db: AppTenantDb, q: FinanceDetailQuery) {
  const list = 'reporting:finance.expenses';
  const after = decodeCursor(q.cursor, list, ['d', 'i'] as const);
  if (after && (!DAY.test(after.d) || !UUID.test(after.i))) invalidCursor();
  const rows = await db.$queryRaw<{
    id: string; customer_id: string | null; incurred_on: string; description: string; supplier_name: string | null; category_name: string | null;
    currency_code: string; currency_scale: number; amount: Decimal;
  }[]>`
    SELECT e.id::text, e.customer_id::text, to_char(e.incurred_on, 'YYYY-MM-DD') AS incurred_on, e.description, e.supplier_name, e.category_name,
           e.currency_code::text, e.currency_scale::int, e.amount
      FROM finance_expenses e
     WHERE e.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND e.status = 'RECORDED'
       AND e.incurred_on >= ${q.from}::date AND e.incurred_on <= ${q.to}::date
       AND (${q.currencyCode ?? null}::text IS NULL OR e.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR e.customer_id = ${q.customerId ?? null}::uuid)
       AND (${after?.d ?? null}::date IS NULL OR (e.incurred_on, e.id) < (${after?.d ?? null}::date, ${after?.i ?? null}::uuid))
     ORDER BY e.incurred_on DESC, e.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): RecordedExpenseDetail => ({
      id: r.id, customerId: r.customer_id, incurredOn: r.incurred_on, description: r.description, supplierName: r.supplier_name, categoryName: r.category_name,
      currencyCode: r.currency_code, amount: formatAmount(new Decimal(r.amount), r.currency_scale),
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(list, { d: last.incurred_on, i: last.id }) : null,
  };
}
