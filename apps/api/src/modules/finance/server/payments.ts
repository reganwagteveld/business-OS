import 'server-only';
// Payments, allocations and their reversals (docs/finance-data-model.md §2.6–2.7, §4.2, §6, §18; ADR 0007).
// Manual records of money received outside Business OS: no gateway, no bank feed, no ledger.
//
// Every unit of work takes its row locks first, in the global order: payments (by id), then documents
// (by id), then writes. The database triggers maintain both counters (payment and invoice
// allocated_total) and their CHECKs refuse over-allocation and over-settlement under any concurrency;
// the checks here run on the locked rows and only exist to give clear errors.
import { randomUUID } from 'node:crypto';
import type { PaymentAllocation as AllocationDto, FinancePayment as PaymentDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { isUniqueViolation, RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { checkCustomer } from './documents';
import { checkCurrency, currencyScale, formatAmount, toAmount } from './money';
import { businessProfile, dateOf, dayOf, lockDocuments, lockIdempotencyKey, requestHash, todayIn } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null) => d?.toISOString() ?? null;

export type PaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'CHEQUE' | 'OTHER';
export type SettlementItem = { invoiceId: string; amount: string };

type PaymentRow = {
  id: string; customerId: string; currencyCode: string; currencyScale: number; amount: Decimal; allocatedTotal: Decimal; receivedOn: Date;
  method: PaymentMethod; reference: string | null; status: 'RECORDED' | 'REVERSED'; reversedAt: Date | null; reversalReason: string | null;
  idempotencyKey: string | null; requestHash: string | null; version: number; recordedById: string | null; reversedById: string | null;
  createdAt: Date; updatedAt: Date;
};
const paymentSelect = {
  id: true, customerId: true, currencyCode: true, currencyScale: true, amount: true, allocatedTotal: true, receivedOn: true, method: true,
  reference: true, status: true, reversedAt: true, reversalReason: true, idempotencyKey: true, requestHash: true, version: true,
  recordedById: true, reversedById: true, createdAt: true, updatedAt: true,
} as const;

type AllocationRow = {
  id: string; paymentId: string; invoiceId: string; currencyCode: string; amount: Decimal; createdAt: Date; createdById: string | null;
  reversedAt: Date | null; reversedById: string | null; invoice: { number: string | null; currencyScale: number };
};
const allocationSelect = {
  id: true, paymentId: true, invoiceId: true, currencyCode: true, amount: true, createdAt: true, createdById: true, reversedAt: true,
  reversedById: true, invoice: { select: { number: true, currencyScale: true } },
} as const;

export const allocationDto = (a: AllocationRow): AllocationDto => ({
  id: a.id, paymentId: a.paymentId, invoiceId: a.invoiceId, invoiceNumber: a.invoice.number, currencyCode: a.currencyCode,
  amount: formatAmount(a.amount, a.invoice.currencyScale), createdAt: a.createdAt.toISOString(), createdById: a.createdById,
  reversedAt: iso(a.reversedAt), reversedById: a.reversedById,
});

function headerDto(p: PaymentRow) {
  const s = p.currencyScale;
  return {
    id: p.id, customerId: p.customerId, currencyCode: p.currencyCode, currencyScale: s, amount: formatAmount(p.amount, s),
    allocatedTotal: formatAmount(p.allocatedTotal, s),
    unallocatedAmount: formatAmount(p.status === 'RECORDED' ? p.amount.sub(p.allocatedTotal) : new Decimal(0), s),
    receivedOn: dayOf(p.receivedOn)!, method: p.method, reference: p.reference, status: p.status, reversedAt: iso(p.reversedAt),
    reversalReason: p.reversalReason, version: p.version, recordedById: p.recordedById, reversedById: p.reversedById,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
  };
}

export async function allocationsOf(db: AppTenantDb, where: { paymentId?: string; invoiceId?: string }): Promise<AllocationRow[]> {
  return (await db.financePaymentAllocation.findMany({ where, select: allocationSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) as AllocationRow[];
}

async function dto(db: AppTenantDb, p: PaymentRow): Promise<PaymentDto> {
  return { ...headerDto(p), allocations: (await allocationsOf(db, { paymentId: p.id })).map(allocationDto) };
}

/** A payment of this business; another business's id answers exactly like a missing one (404). */
async function load(db: AppTenantDb, id: string): Promise<PaymentRow> {
  // F3: this module serves payments RECEIVED from customers; payments made (PAID) are expense-payments.ts's.
  const row = (await db.financePayment.findFirst({ where: { id, direction: 'RECEIVED' }, select: paymentSelect })) as PaymentRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** Locks payments FOR NO KEY UPDATE in id order: the first class of the global lock order (ADR 0007 §3). */
export async function lockPayments(db: AppTenantDb, ids: string[]) {
  if (ids.length === 0) return;
  await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM finance_payments
    WHERE id = ANY(${ids}::uuid[]) AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ORDER BY id FOR NO KEY UPDATE`;
}

export async function getPayment(db: AppTenantDb, id: string) {
  return dto(db, await load(db, id));
}

// ---- settlement targets ----------------------------------------------------------------------------

type Target = { id: string; status: string; customerId: string; currencyCode: string; total: Decimal; allocatedTotal: Decimal; creditAppliedTotal: Decimal };

/**
 * Validates settlement items against invoices that are already LOCKED (the caller locked them in id
 * order): each must be an issued invoice of this business, of the given customer and currency, with
 * enough outstanding for its amount. Amounts are exact decimals at the currency's precision.
 * Returns the parsed amounts in invoice-id order (the order the inserts run in).
 */
export async function checkTargets(
  db: AppTenantDb, items: SettlementItem[], party: { customerId: string; currencyCode: string; currencyScale: number },
): Promise<{ invoiceId: string; amount: Decimal }[]> {
  const ids = items.map((i) => i.invoiceId);
  const rows = (await db.financeDocument.findMany({
    where: { id: { in: ids }, kind: 'INVOICE' },
    select: { id: true, status: true, customerId: true, currencyCode: true, total: true, allocatedTotal: true, creditAppliedTotal: true },
  })) as Target[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parsed = items.map((i) => {
    const inv = byId.get(i.invoiceId);
    if (!inv) throw new RuleViolationError('invalid_invoice', 'Choose an issued invoice of this business.');
    if (inv.status !== 'ISSUED') throw new StateConflictError('invoice_not_open');
    if (inv.customerId !== party.customerId) throw new RuleViolationError('customer_mismatch', 'An invoice can only be settled with money or credit of its own customer.');
    if (inv.currencyCode !== party.currencyCode) throw new RuleViolationError('currency_mismatch', 'An invoice can only be settled in its own currency.');
    const amount = toAmount(i.amount, party.currencyScale, party.currencyCode);
    if (amount.lte(0)) throw new RuleViolationError('invalid_amount', 'An amount must be greater than zero.');
    if (amount.gt(inv.total.sub(inv.allocatedTotal).sub(inv.creditAppliedTotal))) throw new StateConflictError('over_settlement');
    return { invoiceId: i.invoiceId, amount };
  });
  return parsed.sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0));
}

/** Locked payment → locked invoices → checks → inserts in invoice-id order. Shared by record and allocate. */
async function allocateLocked(db: AppTenantDb, actorUserId: string, payment: PaymentRow, items: SettlementItem[]) {
  if (payment.status !== 'RECORDED') throw new StateConflictError('payment_not_open');
  await lockDocuments(db, [...items.map((i) => i.invoiceId)].sort());
  const parsed = await checkTargets(db, items, payment);
  const sum = parsed.reduce((s, i) => s.add(i.amount), new Decimal(0));
  if (sum.gt(payment.amount.sub(payment.allocatedTotal))) throw new StateConflictError('over_allocation');
  const live = await db.financePaymentAllocation.count({ where: { paymentId: payment.id, invoiceId: { in: parsed.map((p) => p.invoiceId) }, reversedAt: null } });
  if (live > 0) throw new StateConflictError('already_allocated');
  for (const item of parsed) {
    const id = randomUUID();
    try {
      await db.financePaymentAllocation.create({
        data: {
          id, paymentId: payment.id, invoiceId: item.invoiceId, customerId: payment.customerId, currencyCode: payment.currencyCode,
          amount: item.amount, createdById: actorUserId,
        } as never,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'finance_payment_allocations_active_key')) throw new StateConflictError('already_allocated');
      throw error;
    }
    await recordAudit(db, actorUserId, 'finance.allocation.created', { type: 'finance_payment_allocation', id }, {
      paymentId: payment.id, invoiceId: item.invoiceId, amount: formatAmount(item.amount, payment.currencyScale), currencyCode: payment.currencyCode,
    });
  }
}

// ---- record ----------------------------------------------------------------------------------------

export type RecordPaymentInput = {
  customerId: string; currencyCode?: string; amount: string; receivedOn: string; method: PaymentMethod; reference?: string | null;
  allocations?: SettlementItem[];
};

/**
 * Records a payment (Idempotency-Key required, §6.4). A repeat of the same request returns the
 * original payment (200) without re-applying anything; the same key with a different request is 409
 * idempotency_conflict. Racing duplicates are serialised by a transaction-scoped advisory lock on the
 * key, and the partial unique index is the database backstop. Optional allocations run in the same
 * unit of work: all of it commits, or none.
 */
export async function recordPayment(db: AppTenantDb, actorUserId: string, input: RecordPaymentInput, key: string | null) {
  if (!key) throw new RuleViolationError('idempotency_key_required', 'Recording a payment needs an Idempotency-Key header.');
  const hash = requestHash('payment.record', input);
  await lockIdempotencyKey(db, key);
  const existing = (await db.financePayment.findFirst({ where: { idempotencyKey: key }, select: paymentSelect })) as PaymentRow | null;
  if (existing) {
    if (existing.requestHash !== hash) throw new StateConflictError('idempotency_conflict');
    return { status: 200 as const, payment: await dto(db, existing) };
  }

  await checkCustomer(db, input.customerId);
  const business = await businessProfile(db);
  const currency = checkCurrency(input.currencyCode ?? business.currency);
  const scale = currencyScale(currency);
  const amount = toAmount(input.amount, scale, currency);
  if (amount.lte(0)) throw new RuleViolationError('invalid_amount', 'A payment must be greater than zero.');
  if (input.receivedOn > todayIn(business.timeZone)) throw new RuleViolationError('invalid_dates', 'A payment cannot be received in the future.');

  const id = randomUUID();
  try {
    await db.financePayment.create({
      data: {
        id, customerId: input.customerId, currencyCode: currency, currencyScale: scale, amount, receivedOn: dateOf(input.receivedOn),
        method: input.method, reference: input.reference ?? null, idempotencyKey: key, requestHash: hash, recordedById: actorUserId,
      } as never,
    });
  } catch (error) {
    // Unreachable while the advisory lock is held; kept as the documented backstop (§6.4).
    if (isUniqueViolation(error, 'finance_payments_idempotency_key')) throw new StateConflictError('idempotency_conflict');
    throw error;
  }
  await recordAudit(db, actorUserId, 'finance.payment.recorded', { type: 'finance_payment', id }, {
    customerId: input.customerId, currencyCode: currency, amount: formatAmount(amount, scale), method: input.method, receivedOn: input.receivedOn,
    hasReference: input.reference ? 'true' : 'false',
  });
  if (input.allocations?.length) {
    // Lock order: the new payment row (this transaction already holds it), then the invoices by id.
    await lockPayments(db, [id]);
    await allocateLocked(db, actorUserId, await load(db, id), input.allocations);
  }
  return { status: 201 as const, payment: await dto(db, await load(db, id)) };
}

// ---- edit, allocate, reverse --------------------------------------------------------------------------

/** The reference is the only business field of a payment that may change (guard allow-list). */
export async function updatePayment(db: AppTenantDb, actorUserId: string, id: string, input: { version: number; reference?: string | null }) {
  await lockPayments(db, [id]);
  const before = await load(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (before.status !== 'RECORDED') throw new StateConflictError('payment_not_open');
  const reference = input.reference === undefined ? before.reference : input.reference;
  if (reference === before.reference) return dto(db, before);
  const result = await db.financePayment.updateMany({ where: { id, version: input.version, status: 'RECORDED' }, data: { reference, version: { increment: 1 } } });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.payment.updated', { type: 'finance_payment', id }, { fields: ['reference'] });
  return dto(db, await load(db, id));
}

/** Allocates a recorded payment to one or more issued invoices, all or nothing. Lock order: payment, invoices by id. */
export async function allocatePayment(db: AppTenantDb, actorUserId: string, id: string, items: SettlementItem[]) {
  await lockPayments(db, [id]);
  await allocateLocked(db, actorUserId, await load(db, id), items);
  return dto(db, await load(db, id));
}

/** Reverses one live allocation (never deletes it). Lock order: payment, then the invoice. */
export async function reverseAllocation(db: AppTenantDb, actorUserId: string, paymentId: string, allocationId: string) {
  await lockPayments(db, [paymentId]);
  const payment = await load(db, paymentId);
  const allocation = await db.financePaymentAllocation.findFirst({ where: { id: allocationId, paymentId }, select: { invoiceId: true, amount: true, reversedAt: true } });
  if (!allocation) throw new RecordNotFoundError();
  if (allocation.reversedAt) throw new StateConflictError('already_reversed');
  await lockDocuments(db, [allocation.invoiceId]);
  const result = await db.financePaymentAllocation.updateMany({ where: { id: allocationId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: actorUserId } });
  if (result.count === 0) throw new StateConflictError('already_reversed'); // unreachable while the payment is locked
  await recordAudit(db, actorUserId, 'finance.allocation.reversed', { type: 'finance_payment_allocation', id: allocationId }, {
    paymentId, invoiceId: allocation.invoiceId, amount: formatAmount(allocation.amount as Decimal, payment.currencyScale), currencyCode: payment.currencyCode,
  });
  return dto(db, await load(db, paymentId));
}

/**
 * Reverses a payment (a bounced cheque, a payment recorded in error): its live allocations first, then
 * the payment, in one unit of work. Lock order: the payment, then its allocated invoices by id. The
 * database stamps reversed_at on every row, refuses a reversed payment that still holds allocations,
 * and requires the reason. Nothing is deleted.
 */
export async function reversePayment(db: AppTenantDb, actorUserId: string, id: string, input: { version: number; reason: string }) {
  await lockPayments(db, [id]);
  const before = await load(db, id);
  if (before.status !== 'RECORDED') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const live = await db.financePaymentAllocation.findMany({ where: { paymentId: id, reversedAt: null }, select: { id: true, invoiceId: true, amount: true }, orderBy: { invoiceId: 'asc' } });
  await lockDocuments(db, [...new Set(live.map((a) => a.invoiceId))].sort());
  for (const a of live) {
    await db.financePaymentAllocation.updateMany({ where: { id: a.id, reversedAt: null }, data: { reversedAt: new Date(), reversedById: actorUserId } });
    await recordAudit(db, actorUserId, 'finance.allocation.reversed', { type: 'finance_payment_allocation', id: a.id }, {
      paymentId: id, invoiceId: a.invoiceId, amount: formatAmount(a.amount as Decimal, before.currencyScale), currencyCode: before.currencyCode, cause: 'payment_reversal',
    });
  }
  const result = await db.financePayment.updateMany({
    where: { id, status: 'RECORDED', version: input.version },
    data: { status: 'REVERSED', reversalReason: input.reason, reversedById: actorUserId, version: { increment: 1 } } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale'); // unreachable while the row is locked
  await recordAudit(db, actorUserId, 'finance.payment.reversed', { type: 'finance_payment', id }, {
    currencyCode: before.currencyCode, amount: formatAmount(before.amount, before.currencyScale), method: before.method,
    reversedAllocations: String(live.length), hasReason: 'true',
  });
  return dto(db, await load(db, id));
}

// ---- list ------------------------------------------------------------------------------------------

export type ListPaymentsQuery = {
  status: 'recorded' | 'reversed' | 'all'; customerId?: string; currencyCode?: string; from?: string; to?: string;
  unallocated?: 'true' | 'false'; invoiceId?: string; cursor?: string; limit: number;
};

/** Most recently received first, keyset-paginated on (received_on, id): both round-trip exactly. */
export async function listPayments(db: AppTenantDb, query: ListPaymentsQuery) {
  const where: Record<string, unknown>[] = [{ direction: 'RECEIVED' }];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  if (query.customerId) where.push({ customerId: query.customerId });
  if (query.currencyCode) where.push({ currencyCode: query.currencyCode });
  if (query.from) where.push({ receivedOn: { gte: dateOf(query.from) } });
  if (query.to) where.push({ receivedOn: { lt: dateOf(query.to) } });
  if (query.unallocated === 'true') where.push({ status: 'RECORDED', allocatedTotal: { lt: db.financePayment.fields.amount } });
  if (query.unallocated === 'false') where.push({ OR: [{ status: 'REVERSED' }, { allocatedTotal: { equals: db.financePayment.fields.amount } }] });
  if (query.invoiceId) where.push({ allocations: { some: { invoiceId: query.invoiceId, reversedAt: null } } });
  const list = 'finance:payments';
  const after = decodeCursor(query.cursor, list, ['d', 'i'] as const);
  if (after) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(after.d) || !UUID.test(after.i)) invalidCursor();
    const d = dateOf(after.d);
    where.push({ OR: [{ receivedOn: { lt: d } }, { receivedOn: d, id: { lt: after.i } }] });
  }
  const rows = (await db.financePayment.findMany({
    where: { AND: where }, select: paymentSelect, orderBy: [{ receivedOn: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as PaymentRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    payments: page.map(headerDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, { d: dayOf(last.receivedOn)!, i: last.id }) : null,
  };
}
