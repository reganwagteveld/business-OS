import 'server-only';
// Credit applications, settlement projections and customer balances (docs/finance-data-model.md §4.2, §18).
//
// A credit note settles nothing by being issued. Its credit reaches an invoice only through an explicit
// credit application (FD-A2, provisional): to any issued invoice of the same customer and currency,
// partially or in full, reversible, never deleted. The database maintains credit_applied_total on both
// documents and its CHECKs refuse over-application of the credit note and over-settlement of the
// invoice (payments and credit together) under any concurrency. Refunds are not implemented.
//
// Projections (unpaid, partly paid, paid, overdue, unallocated and unapplied credit) are derived from
// the counters on every read and never stored.
import { randomUUID } from 'node:crypto';
import type { CreditApplication as ApplicationDto, CreditNoteCredit, CustomerBalance, InvoiceSettlement } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { isUniqueViolation, RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { settlementStateOf } from './documents';
import { formatAmount } from './money';
import { allocationDto, allocationsOf, checkTargets, type SettlementItem } from './payments';
import { businessProfile, dayOf, lockDocuments, todayIn, type Kind, type Status } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null) => d?.toISOString() ?? null;

type DocRow = {
  id: string; kind: Kind; status: Status; number: string | null; customerId: string; currencyCode: string; currencyScale: number;
  total: Decimal; allocatedTotal: Decimal; creditAppliedTotal: Decimal; dueDate: Date | null;
};
const docSelect = {
  id: true, kind: true, status: true, number: true, customerId: true, currencyCode: true, currencyScale: true, total: true, allocatedTotal: true,
  creditAppliedTotal: true, dueDate: true,
} as const;

async function loadDoc(db: AppTenantDb, kind: Kind, id: string): Promise<DocRow> {
  const row = (await db.financeDocument.findFirst({ where: { id, kind }, select: docSelect })) as DocRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

type ApplicationRow = {
  id: string; creditNoteId: string; invoiceId: string; currencyCode: string; amount: Decimal; createdAt: Date; createdById: string | null;
  reversedAt: Date | null; reversedById: string | null; creditNote: { number: string | null; currencyScale: number }; invoice: { number: string | null };
};
const applicationSelect = {
  id: true, creditNoteId: true, invoiceId: true, currencyCode: true, amount: true, createdAt: true, createdById: true, reversedAt: true,
  reversedById: true, creditNote: { select: { number: true, currencyScale: true } }, invoice: { select: { number: true } },
} as const;

const applicationDto = (a: ApplicationRow): ApplicationDto => ({
  id: a.id, creditNoteId: a.creditNoteId, creditNoteNumber: a.creditNote.number, invoiceId: a.invoiceId, invoiceNumber: a.invoice.number,
  currencyCode: a.currencyCode, amount: formatAmount(a.amount, a.creditNote.currencyScale), createdAt: a.createdAt.toISOString(),
  createdById: a.createdById, reversedAt: iso(a.reversedAt), reversedById: a.reversedById,
});

async function applicationsOf(db: AppTenantDb, where: { creditNoteId?: string; invoiceId?: string }): Promise<ApplicationRow[]> {
  return (await db.financeCreditApplication.findMany({ where, select: applicationSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) as ApplicationRow[];
}

async function creditDto(db: AppTenantDb, cn: DocRow): Promise<CreditNoteCredit> {
  const s = cn.currencyScale;
  return {
    creditNoteId: cn.id, number: cn.number, status: cn.status, customerId: cn.customerId, currencyCode: cn.currencyCode, total: formatAmount(cn.total, s),
    appliedTotal: formatAmount(cn.creditAppliedTotal, s),
    available: formatAmount(cn.status === 'ISSUED' ? cn.total.sub(cn.creditAppliedTotal) : new Decimal(0), s),
    applications: (await applicationsOf(db, { creditNoteId: cn.id })).map(applicationDto),
  };
}

export async function getCreditNoteCredit(db: AppTenantDb, creditNoteId: string) {
  return creditDto(db, await loadDoc(db, 'CREDIT_NOTE', creditNoteId));
}

/**
 * Applies an issued credit note to issued invoices of its customer and currency, all or nothing. Lock
 * order: documents by id (the credit note and the invoices together, ADR 0007 §3). The checks run on
 * the locked rows; the database counters and CHECKs hold the same rules independently.
 */
export async function applyCreditNote(db: AppTenantDb, actorUserId: string, creditNoteId: string, items: SettlementItem[]) {
  const locked = await lockDocuments(db, [creditNoteId, ...items.map((i) => i.invoiceId)].sort());
  if (!locked.includes(creditNoteId)) throw new RecordNotFoundError();
  const cn = await loadDoc(db, 'CREDIT_NOTE', creditNoteId);
  if (cn.status !== 'ISSUED') throw new StateConflictError('credit_note_not_open');
  const parsed = await checkTargets(db, items, cn);
  const sum = parsed.reduce((s, i) => s.add(i.amount), new Decimal(0));
  if (sum.gt(cn.total.sub(cn.creditAppliedTotal))) throw new StateConflictError('over_application');
  const live = await db.financeCreditApplication.count({ where: { creditNoteId, invoiceId: { in: parsed.map((p) => p.invoiceId) }, reversedAt: null } });
  if (live > 0) throw new StateConflictError('already_applied');
  for (const item of parsed) {
    const id = randomUUID();
    try {
      await db.financeCreditApplication.create({
        data: {
          id, creditNoteId, invoiceId: item.invoiceId, customerId: cn.customerId, currencyCode: cn.currencyCode, amount: item.amount, createdById: actorUserId,
        } as never,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'finance_credit_applications_active_key')) throw new StateConflictError('already_applied');
      throw error;
    }
    await recordAudit(db, actorUserId, 'finance.credit_application.created', { type: 'finance_credit_application', id }, {
      creditNoteId, invoiceId: item.invoiceId, amount: formatAmount(item.amount, cn.currencyScale), currencyCode: cn.currencyCode,
    });
  }
  return creditDto(db, await loadDoc(db, 'CREDIT_NOTE', creditNoteId));
}

/** Reverses one live credit application (kept as history). Lock order: both documents by id. */
export async function reverseCreditApplication(db: AppTenantDb, actorUserId: string, creditNoteId: string, applicationId: string) {
  const application = await db.financeCreditApplication.findFirst({
    where: { id: applicationId, creditNoteId }, select: { invoiceId: true, amount: true, reversedAt: true },
  });
  if (!application) throw new RecordNotFoundError();
  await lockDocuments(db, [creditNoteId, application.invoiceId].sort());
  const cn = await loadDoc(db, 'CREDIT_NOTE', creditNoteId);
  const result = await db.financeCreditApplication.updateMany({ where: { id: applicationId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: actorUserId } });
  if (result.count === 0) throw new StateConflictError('already_reversed');
  await recordAudit(db, actorUserId, 'finance.credit_application.reversed', { type: 'finance_credit_application', id: applicationId }, {
    creditNoteId, invoiceId: application.invoiceId, amount: formatAmount(application.amount as Decimal, cn.currencyScale), currencyCode: cn.currencyCode,
  });
  return creditDto(db, await loadDoc(db, 'CREDIT_NOTE', creditNoteId));
}

// ---- projections (read-only) -------------------------------------------------------------------------

/** One invoice's settlement: payments, applied credit, outstanding amount and overdue state, as of today in the business's zone. */
export async function getInvoiceSettlement(db: AppTenantDb, invoiceId: string): Promise<InvoiceSettlement> {
  const inv = await loadDoc(db, 'INVOICE', invoiceId);
  const asOf = todayIn((await businessProfile(db)).timeZone);
  const s = inv.currencyScale;
  const state = settlementStateOf(inv);
  const outstanding = inv.status === 'ISSUED' ? inv.total.sub(inv.allocatedTotal).sub(inv.creditAppliedTotal) : new Decimal(0);
  const due = dayOf(inv.dueDate);
  const [allocations, applications] = await Promise.all([allocationsOf(db, { invoiceId }), applicationsOf(db, { invoiceId })]);
  return {
    invoiceId, number: inv.number, status: inv.status, customerId: inv.customerId, currencyCode: inv.currencyCode, total: formatAmount(inv.total, s),
    allocatedTotal: formatAmount(inv.allocatedTotal, s), creditAppliedTotal: formatAmount(inv.creditAppliedTotal, s), outstanding: formatAmount(outstanding, s),
    settlementState: state, dueDate: due, overdue: inv.status === 'ISSUED' && outstanding.gt(0) && due !== null && due < asOf, asOf,
    allocations: allocations.map(allocationDto), creditApplications: applications.map(applicationDto),
  };
}

type BalanceRow = {
  customer_id: string; currency_code: string; currency_scale: number; receivable: Decimal; overdue: Decimal; unallocated: Decimal; unapplied: Decimal;
};

/**
 * Per customer and currency (no conversion): receivable and overdue on issued invoices, unallocated
 * payment balances, unapplied credit-note balances, and their sum as credit available. One statement,
 * so all four come from one snapshot. Keyset-paginated on (customer_id, currency_code).
 */
export async function listCustomerBalances(db: AppTenantDb, query: { customerId?: string; currencyCode?: string; cursor?: string; limit: number }) {
  const asOf = todayIn((await businessProfile(db)).timeZone);
  const list = 'finance:balances';
  const after = decodeCursor(query.cursor, list, ['c', 'k'] as const);
  if (after && (!UUID.test(after.c) || !/^[A-Z]{3}$/.test(after.k))) invalidCursor();
  const rows = await db.$queryRaw<BalanceRow[]>`
    WITH b AS (SELECT nullif(current_setting('app.business_id', true), '')::uuid AS id),
    parts AS (
      SELECT d.customer_id, d.currency_code, d.currency_scale,
             CASE WHEN d.kind = 'INVOICE' THEN d.total - d.allocated_total - d.credit_applied_total ELSE 0 END AS receivable,
             CASE WHEN d.kind = 'INVOICE' AND d.due_date < ${asOf}::date THEN d.total - d.allocated_total - d.credit_applied_total ELSE 0 END AS overdue,
             0::numeric AS unallocated,
             CASE WHEN d.kind = 'CREDIT_NOTE' THEN d.total - d.credit_applied_total ELSE 0 END AS unapplied
        FROM finance_documents d, b
       WHERE d.business_id = b.id AND d.status = 'ISSUED' AND d.kind IN ('INVOICE', 'CREDIT_NOTE')
      UNION ALL
      SELECT p.customer_id, p.currency_code, p.currency_scale, 0, 0, p.amount - p.allocated_total, 0
        FROM finance_payments p, b
       WHERE p.business_id = b.id AND p.status = 'RECORDED' AND p.direction = 'RECEIVED')
    SELECT customer_id::text, currency_code::text, max(currency_scale)::int AS currency_scale, sum(receivable) AS receivable, sum(overdue) AS overdue,
           sum(unallocated) AS unallocated, sum(unapplied) AS unapplied
      FROM parts
     WHERE (${query.customerId ?? null}::uuid IS NULL OR customer_id = ${query.customerId ?? null}::uuid)
       AND (${query.currencyCode ?? null}::text IS NULL OR currency_code = ${query.currencyCode ?? null}::text)
       AND (${after?.c ?? null}::uuid IS NULL OR (customer_id, currency_code::text) > (${after?.c ?? null}::uuid, ${after?.k ?? null}::text))
     GROUP BY customer_id, currency_code
    HAVING sum(receivable) <> 0 OR sum(unallocated) <> 0 OR sum(unapplied) <> 0
     ORDER BY customer_id, currency_code
     LIMIT ${query.limit + 1}`;
  const page = rows.slice(0, query.limit);
  const balances: CustomerBalance[] = page.map((r) => {
    const s = r.currency_scale;
    const unallocated = new Decimal(r.unallocated);
    const unapplied = new Decimal(r.unapplied);
    return {
      customerId: r.customer_id, currencyCode: r.currency_code, currencyScale: s, receivable: formatAmount(new Decimal(r.receivable), s),
      overdue: formatAmount(new Decimal(r.overdue), s), unallocatedPayments: formatAmount(unallocated, s), unappliedCredit: formatAmount(unapplied, s),
      creditAvailable: formatAmount(unallocated.add(unapplied), s),
    };
  });
  const last = page[page.length - 1];
  return { balances, asOf, nextCursor: rows.length > query.limit && last ? encodeCursor(list, { c: last.customer_id, k: last.currency_code }) : null };
}
