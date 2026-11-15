import 'server-only';
// Finance F6-2 (docs/finance-billing-f6.md §4): customer statements and receivables ageing as of a date.
// Read-only and derived on every request from the F1–F3 records: no table, no stored balance, no
// second ledger. The current-day counters (allocated_total, credit_applied_total) are not used for past
// dates; the dated allocations, credit applications, voids and reversals are, through the effective-date
// rules in receivables-core.ts. As of today the result equals the F2/F4 counters (and so R1's
// receivables metrics) for every invoice not issued with a future date (tested).
import type {
  AgeingCustomerRow, AgeingCurrencyTotal, AgeingPosition, ReceivablesAgeing, ReceivablesAgeingDetail, Statement,
} from '@business-os/contracts';
import { createHash } from 'node:crypto';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, ServiceFailureError, StateConflictError } from '@/core/http/errors';
import { loadBranding, loadLogoAsset, logoBytes } from './branding';
import { billToParty, PDF_MAX_BYTES, safeFileName, sellerParty, type BillTo, type Seller } from './document-pdfs';
import { billToSnapshot } from './documents';
import { RenderError } from './pdf/render';
import { renderStatement, STATEMENT_TEMPLATE, type StatementSnapshot } from './pdf/statement';
import { sellerSnapshot } from './settings';
import { currencyScale, formatAmount } from './money';
import {
  BUCKETS, isEmptyPosition, positionsAt, statementOf, type Bucket, type Position, type ReceivableRecord,
} from './receivables-core';
import { businessProfile, todayIn } from './shared';

/** A statement longer than this is refused (narrow the range); the PDF stays well under F5's size limit. */
export const STATEMENT_MAX_ENTRIES = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  rec: 'INVOICE' | 'CREDIT_NOTE' | 'PAYMENT' | 'ALLOCATION' | 'APPLICATION'; id: string; from_id: string | null; to_id: string | null;
  customer_id: string; currency_code: string; currency_scale: number; amount: Decimal; reference: string | null; start_on: string;
  end_on: string | null; due_on: string | null;
};

/**
 * Every receivable record of the business (optionally one customer and/or currency) that starts on or
 * before `upTo`, with its effective dates in `timeZone`, in one statement (one snapshot). Received
 * payments only (direction RECEIVED); documents only once numbered, so discarded drafts never appear.
 */
async function loadRecords(db: AppTenantDb, timeZone: string, upTo: string, f: { customerId?: string; currencyCode?: string }): Promise<ReceivableRecord[]> {
  const customerId = f.customerId ?? null;
  const currencyCode = f.currencyCode ?? null;
  const rows = await db.$queryRaw<Row[]>`
    WITH b AS (SELECT nullif(current_setting('app.business_id', true), '')::uuid AS id),
    docs AS (
      SELECT d.id, d.kind::text AS kind, d.customer_id, d.currency_code, d.currency_scale, d.total, d.number, d.issue_date, d.due_date,
             CASE WHEN d.status = 'VOID' THEN greatest((d.voided_at AT TIME ZONE ${timeZone})::date, d.issue_date) END AS void_on
        FROM finance_documents d, b
       WHERE d.business_id = b.id AND d.kind IN ('INVOICE', 'CREDIT_NOTE') AND d.number IS NOT NULL AND d.issue_date IS NOT NULL
         AND (${customerId}::uuid IS NULL OR d.customer_id = ${customerId}::uuid)
         AND (${currencyCode}::text IS NULL OR d.currency_code = ${currencyCode}::text)),
    pays AS (
      SELECT p.id, p.customer_id, p.currency_code, p.currency_scale, p.amount, p.reference, p.received_on,
             CASE WHEN p.status = 'REVERSED' THEN greatest((p.reversed_at AT TIME ZONE ${timeZone})::date, p.received_on) END AS reversed_on
        FROM finance_payments p, b
       WHERE p.business_id = b.id AND p.direction = 'RECEIVED' AND p.customer_id IS NOT NULL
         AND (${customerId}::uuid IS NULL OR p.customer_id = ${customerId}::uuid)
         AND (${currencyCode}::text IS NULL OR p.currency_code = ${currencyCode}::text))
    SELECT kind AS rec, id::text, NULL::text AS from_id, NULL::text AS to_id, customer_id::text, currency_code::text, currency_scale::int,
           total AS amount, number AS reference, issue_date::text AS start_on, void_on::text AS end_on, due_date::text AS due_on
      FROM docs WHERE issue_date <= ${upTo}::date
    UNION ALL
    SELECT 'PAYMENT', id::text, NULL, NULL, customer_id::text, currency_code::text, currency_scale::int, amount, reference,
           received_on::text, reversed_on::text, NULL
      FROM pays WHERE received_on <= ${upTo}::date
    UNION ALL
    SELECT 'ALLOCATION', a.id::text, a.payment_id::text, a.invoice_id::text, a.customer_id::text, a.currency_code::text, i.currency_scale::int, a.amount, NULL,
           greatest((a.created_at AT TIME ZONE ${timeZone})::date, p.received_on, i.issue_date)::text,
           CASE WHEN a.reversed_at IS NOT NULL THEN greatest((a.reversed_at AT TIME ZONE ${timeZone})::date, p.received_on, i.issue_date)::text END, NULL
      FROM finance_payment_allocations a
      JOIN pays p ON p.id = a.payment_id
      JOIN docs i ON i.id = a.invoice_id
     WHERE greatest((a.created_at AT TIME ZONE ${timeZone})::date, p.received_on, i.issue_date) <= ${upTo}::date
    UNION ALL
    SELECT 'APPLICATION', c.id::text, c.credit_note_id::text, c.invoice_id::text, c.customer_id::text, c.currency_code::text, i.currency_scale::int, c.amount, NULL,
           greatest((c.created_at AT TIME ZONE ${timeZone})::date, n.issue_date, i.issue_date)::text,
           CASE WHEN c.reversed_at IS NOT NULL THEN greatest((c.reversed_at AT TIME ZONE ${timeZone})::date, n.issue_date, i.issue_date)::text END, NULL
      FROM finance_credit_applications c
      JOIN docs n ON n.id = c.credit_note_id
      JOIN docs i ON i.id = c.invoice_id
     WHERE greatest((c.created_at AT TIME ZONE ${timeZone})::date, n.issue_date, i.issue_date) <= ${upTo}::date`;
  return rows.map((r): ReceivableRecord => {
    const common = { id: r.id, customerId: r.customer_id, currencyCode: r.currency_code, amount: new Decimal(r.amount), start: r.start_on, end: r.end_on };
    if (r.rec === 'ALLOCATION' || r.rec === 'APPLICATION') return { ...common, type: r.rec, fromId: r.from_id!, toId: r.to_id! };
    if (r.rec === 'PAYMENT') return { ...common, type: 'PAYMENT', currencyScale: r.currency_scale, reference: r.reference };
    return { ...common, type: r.rec, currencyScale: r.currency_scale, reference: r.reference, dueDate: r.due_on };
  });
}

/** The business's zone and today in it; a requested date after today is refused (nothing has happened yet). */
async function dateContext(db: AppTenantDb, ...days: (string | undefined)[]) {
  const { timeZone } = await businessProfile(db);
  const today = todayIn(timeZone);
  if (days.some((d) => d !== undefined && d > today)) throw new RuleViolationError('invalid_dates', 'Choose a date on or before today.');
  return { timeZone, today };
}

async function ensureCustomer(db: AppTenantDb, customerId: string) {
  const found = await db.customer.findFirst({ where: { id: customerId }, select: { id: true } });
  if (!found) throw new RecordNotFoundError();
}

const BUCKET_FIELD: Record<Bucket, keyof AgeingPosition['buckets']> = {
  CURRENT: 'current', DAYS_1_30: 'days1To30', DAYS_31_60: 'days31To60', DAYS_61_90: 'days61To90', DAYS_90_PLUS: 'days90Plus', NO_DUE_DATE: 'noDueDate',
};

function positionDto(p: Pick<Position, 'buckets' | 'receivable' | 'overdue' | 'unallocatedPayments' | 'unappliedCredit' | 'accountBalance' | 'balanced'>, scale: number): AgeingPosition {
  const f = (d: Decimal) => formatAmount(d, scale);
  return {
    buckets: Object.fromEntries(BUCKETS.map((b) => [BUCKET_FIELD[b], f(p.buckets[b])])) as AgeingPosition['buckets'],
    receivable: f(p.receivable), overdue: f(p.overdue), unallocatedPayments: f(p.unallocatedPayments), unappliedCredit: f(p.unappliedCredit),
    accountBalance: f(p.accountBalance), balanced: p.balanced,
  };
}

const emptyPosition = (customerId: string, currencyCode: string, currencyScale: number): Position => ({
  customerId, currencyCode, currencyScale, buckets: Object.fromEntries(BUCKETS.map((b) => [b, new Decimal(0)])) as Record<Bucket, Decimal>,
  receivable: new Decimal(0), overdue: new Decimal(0), unallocatedPayments: new Decimal(0), unappliedCredit: new Decimal(0), accountBalance: new Decimal(0),
  balanced: true, invoices: [], credits: [],
});

function logImbalance(p: Position) {
  // Never expected (the effective-date rules make it an identity); surfaced, not hidden, and without amounts.
  if (!p.balanced) console.error('[finance] receivables position does not reconcile', { currencyCode: p.currencyCode });
}

// ---- statement --------------------------------------------------------------------------------------

/**
 * A statement for one customer and currency over [from, to] (D-F6-10): balance forward from every
 * event before `from`, the dated entries, the closing balance, and the aged position at the end of `to`.
 */
export async function getStatement(db: AppTenantDb, q: { customerId: string; currencyCode: string; from: string; to: string }): Promise<Statement> {
  const { timeZone } = await dateContext(db, q.from, q.to);
  await ensureCustomer(db, q.customerId);
  const records = await loadRecords(db, timeZone, q.to, { customerId: q.customerId, currencyCode: q.currencyCode });
  const { opening, entries, closing } = statementOf(records, q.from, q.to);
  if (entries.length > STATEMENT_MAX_ENTRIES) throw new StateConflictError('statement_too_large');
  const doc = records.find((r) => r.type !== 'ALLOCATION' && r.type !== 'APPLICATION') as { currencyScale: number } | undefined;
  const scale = doc?.currencyScale ?? currencyScale(q.currencyCode);
  const position = positionsAt(records, q.to)[0] ?? emptyPosition(q.customerId, q.currencyCode, scale);
  logImbalance(position);
  const f = (d: Decimal) => formatAmount(d, scale);
  return {
    customerId: q.customerId, currencyCode: q.currencyCode, currencyScale: scale, from: q.from, to: q.to, timeZone, openingBalance: f(opening),
    entries: entries.map((e) => ({ date: e.date, type: e.type, sourceId: e.sourceId, reference: e.reference, dueDate: e.dueDate, amount: f(e.amount), balance: f(e.balance) })),
    closingBalance: f(closing),
    position: positionDto(position, scale),
  };
}

// ---- ageing -----------------------------------------------------------------------------------------

/**
 * Accounts-receivable ageing as of a date (D-F6-11): per customer and currency, open invoice balances in
 * buckets by days past due, with unallocated payments and unapplied credit beside them (never netted
 * into a bucket). Totals per currency cover every customer after the filters; rows are keyset-paginated.
 */
export async function getReceivablesAgeing(
  db: AppTenantDb, q: { asOf?: string; currencyCode?: string; customerId?: string; cursor?: string; limit: number },
): Promise<ReceivablesAgeing> {
  const { timeZone, today } = await dateContext(db, q.asOf);
  const asOf = q.asOf ?? today;
  const list = 'finance:ageing';
  // Keys must not be `k`: encodeCursor stores the list name under `k`.
  const after = decodeCursor(q.cursor, list, ['c', 'u', 'd'] as const);
  if (after && (!UUID.test(after.c) || !/^[A-Z]{3}$/.test(after.u) || after.d !== asOf)) invalidCursor();
  const records = await loadRecords(db, timeZone, asOf, { customerId: q.customerId, currencyCode: q.currencyCode });
  const positions = positionsAt(records, asOf).filter((p) => !isEmptyPosition(p));
  positions.forEach(logImbalance);

  const totals = new Map<string, Position & { openInvoiceCount: number; customerCount: number }>();
  for (const p of positions) {
    const t = totals.get(p.currencyCode) ?? { ...emptyPosition('', p.currencyCode, p.currencyScale), openInvoiceCount: 0, customerCount: 0 };
    for (const b of BUCKETS) t.buckets[b] = t.buckets[b].add(p.buckets[b]);
    t.receivable = t.receivable.add(p.receivable);
    t.overdue = t.overdue.add(p.overdue);
    t.unallocatedPayments = t.unallocatedPayments.add(p.unallocatedPayments);
    t.unappliedCredit = t.unappliedCredit.add(p.unappliedCredit);
    t.accountBalance = t.accountBalance.add(p.accountBalance);
    t.balanced = t.balanced && p.balanced;
    t.openInvoiceCount += p.invoices.length;
    t.customerCount += 1;
    totals.set(p.currencyCode, t);
  }

  const startAt = after ? positions.findIndex((p) => p.customerId > after.c || (p.customerId === after.c && p.currencyCode > after.u)) : 0;
  const page = startAt < 0 ? [] : positions.slice(startAt, startAt + q.limit);
  const more = startAt >= 0 && startAt + q.limit < positions.length;
  const last = page[page.length - 1];
  const rows: AgeingCustomerRow[] = page.map((p) => ({
    customerId: p.customerId, currencyCode: p.currencyCode, currencyScale: p.currencyScale, openInvoiceCount: p.invoices.length, ...positionDto(p, p.currencyScale),
  }));
  const currencyTotals: AgeingCurrencyTotal[] = [...totals.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)).map((t) => ({
    currencyCode: t.currencyCode, currencyScale: t.currencyScale, openInvoiceCount: t.openInvoiceCount, customerCount: t.customerCount, ...positionDto(t, t.currencyScale),
  }));
  return {
    asOf, timeZone, totals: currencyTotals, rows,
    nextCursor: more && last ? encodeCursor(list, { c: last.customerId, u: last.currencyCode, d: asOf }) : null,
  };
}

/** One customer and currency as of a date: each open invoice with its bucket, and each credit separately. */
export async function getReceivablesAgeingDetail(db: AppTenantDb, q: { asOf?: string; customerId: string; currencyCode: string }): Promise<ReceivablesAgeingDetail> {
  const { timeZone, today } = await dateContext(db, q.asOf);
  const asOf = q.asOf ?? today;
  await ensureCustomer(db, q.customerId);
  const records = await loadRecords(db, timeZone, asOf, { customerId: q.customerId, currencyCode: q.currencyCode });
  const doc = records.find((r) => r.type !== 'ALLOCATION' && r.type !== 'APPLICATION') as { currencyScale: number } | undefined;
  const scale = doc?.currencyScale ?? currencyScale(q.currencyCode);
  const p = positionsAt(records, asOf)[0] ?? emptyPosition(q.customerId, q.currencyCode, scale);
  logImbalance(p);
  const f = (d: Decimal) => formatAmount(d, scale);
  return {
    asOf, timeZone, customerId: q.customerId, currencyCode: q.currencyCode, currencyScale: scale, position: positionDto(p, scale),
    invoices: p.invoices.map((i) => ({
      invoiceId: i.doc.id, number: i.doc.reference, issueDate: i.doc.start, dueDate: i.doc.dueDate, total: f(i.doc.amount), paid: f(i.paid),
      credited: f(i.credited), outstanding: f(i.outstanding), daysPastDue: i.daysPastDue, bucket: i.bucket,
    })),
    credits: p.credits.map((c) => ({ kind: c.kind, sourceId: c.record.id, reference: c.record.reference, date: c.record.start, available: f(c.available) })),
  };
}

// ---- statement PDF (D-F6-9) --------------------------------------------------------------------------

const ENTRY_LABEL: Record<Statement['entries'][number]['type'], string> = {
  INVOICE: 'Invoice', INVOICE_VOID: 'Invoice voided', CREDIT_NOTE: 'Credit note', CREDIT_NOTE_VOID: 'Credit note voided', PAYMENT: 'Payment received',
  PAYMENT_REVERSAL: 'Payment reversed',
};
const AGE_LABEL: [keyof AgeingPosition['buckets'], string][] = [
  ['current', 'Current (not yet due)'], ['days1To30', '1–30 days past due'], ['days31To60', '31–60 days past due'], ['days61To90', '61–90 days past due'],
  ['days90Plus', 'Over 90 days past due'], ['noDueDate', 'No due date'],
];
const nonZero = (v: string) => !/^0(\.0+)?$/.test(v);

/**
 * The statement as a PDF, rendered now and never stored. Uses the business's current seller details,
 * the customer's current billing details and F5's document branding. The download is audited
 * (finance.statement_pdf.downloaded) with the customer, currency, period and the sha256 of the bytes
 * served: never amounts, entries or customer details.
 */
export async function statementPdf(db: AppTenantDb, actorUserId: string, q: { customerId: string; currencyCode: string; from: string; to: string }) {
  const statement = await getStatement(db, q);
  const [business, branding, seller, billTo] = await Promise.all([
    db.business.findFirstOrThrow({ select: { locale: true } }), loadBranding(db), sellerSnapshot(db) as Promise<Seller>,
    billToSnapshot(db, q.customerId, null) as Promise<BillTo>,
  ]);
  const asset = branding.logoAssetId ? await loadLogoAsset(db, branding.logoAssetId) : null;
  const logo = asset ? await logoBytes(db, asset.id) : null;
  const p = statement.position;
  const snapshot: StatementSnapshot = {
    renderedAt: new Date().toISOString(), locale: business.locale, currencyCode: statement.currencyCode, currencyScale: statement.currencyScale,
    from: statement.from, to: statement.to, seller: sellerParty(seller), billTo: billToParty(billTo, business.locale),
    openingBalance: statement.openingBalance, closingBalance: statement.closingBalance,
    entries: statement.entries.map((e) => ({ date: e.date, label: ENTRY_LABEL[e.type], reference: e.reference, dueDate: e.dueDate, amount: e.amount, balance: e.balance })),
    ageing: nonZero(p.receivable)
      ? [...AGE_LABEL.filter(([k]) => nonZero(p.buckets[k])).map(([k, label]) => ({ label, amount: p.buckets[k] })), { label: 'Total open on invoices', amount: p.receivable }]
      : [],
    credits: [
      ...(nonZero(p.unallocatedPayments) ? [{ label: 'Payments not yet matched to an invoice', amount: p.unallocatedPayments }] : []),
      ...(nonZero(p.unappliedCredit) ? [{ label: 'Credit notes not yet applied', amount: p.unappliedCredit }] : []),
    ],
    branding: {
      accentColor: branding.accentColor, footerText: branding.footerText,
      logo: asset && logo ? { width: asset.width, height: asset.height } : null,
    },
  };
  let result;
  try {
    result = await renderStatement(snapshot, logo);
  } catch (error) {
    if (error instanceof RenderError && error.code === 'invalid_logo') throw new StateConflictError('branding_logo_invalid');
    console.error('[finance] statement rendering failed', error instanceof Error ? error.name : typeof error);
    throw new ServiceFailureError(503, 'generation_failed');
  }
  if (result.bytes.length > PDF_MAX_BYTES) throw new StateConflictError('statement_too_large');
  const sha256 = createHash('sha256').update(result.bytes).digest('hex');
  await recordAudit(db, actorUserId, 'finance.statement_pdf.downloaded', { type: 'customer', id: q.customerId }, {
    currencyCode: q.currencyCode, from: q.from, to: q.to, fileSha256: sha256, template: `${STATEMENT_TEMPLATE.id}@${STATEMENT_TEMPLATE.version}`,
  });
  const name = `statement-${q.currencyCode}-${q.from}-to-${q.to}`;
  return { bytes: result.bytes, fileName: safeFileName(name), utf8FileName: `${name}.pdf`, sha256, unsupportedCharacters: result.unsupportedCharacters };
}
