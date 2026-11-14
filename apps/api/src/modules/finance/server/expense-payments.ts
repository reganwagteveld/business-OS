import 'server-only';
// Payments made against expenses (docs/finance-data-model.md §19.4; ADR 0007). They are rows of F2's
// payments ledger with direction PAID: the same table, idempotency, immutability guard, reversal rules
// and counter (allocated_total), linked to recorded expenses through finance_expense_allocations instead
// of to invoices. No second ledger exists. Manual records of money paid outside Business OS.
//
// Lock order, as F2: the payment first, then the expenses by id, then writes. The database triggers
// maintain both counters (payment allocated_total, expense paid_total) and their CHECKs refuse
// over-allocation and over-payment under any concurrency; the checks here give clear errors.
import { randomUUID } from 'node:crypto';
import type { ExpensePayment as PaymentDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { isUniqueViolation, RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { expenseAllocationDto, expenseAllocationsOf, lockExpenses } from './expenses';
import { checkCurrency, currencyScale, formatAmount, toAmount } from './money';
import { lockPayments, type PaymentMethod } from './payments';
import { businessProfile, dateOf, dayOf, lockIdempotencyKey, requestHash, todayIn } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null) => d?.toISOString() ?? null;

export type ExpenseSettlementItem = { expenseId: string; amount: string };

type PaymentRow = {
  id: string; payeeName: string | null; currencyCode: string; currencyScale: number; amount: Decimal; allocatedTotal: Decimal; receivedOn: Date;
  method: PaymentMethod; reference: string | null; status: 'RECORDED' | 'REVERSED'; reversedAt: Date | null; reversalReason: string | null;
  requestHash: string | null; direction: 'RECEIVED' | 'PAID'; version: number; recordedById: string | null; reversedById: string | null;
  createdAt: Date; updatedAt: Date;
};
const paymentSelect = {
  id: true, payeeName: true, currencyCode: true, currencyScale: true, amount: true, allocatedTotal: true, receivedOn: true, method: true,
  reference: true, status: true, reversedAt: true, reversalReason: true, requestHash: true, direction: true, version: true, recordedById: true,
  reversedById: true, createdAt: true, updatedAt: true,
} as const;

function headerDto(p: PaymentRow) {
  const s = p.currencyScale;
  return {
    id: p.id, payeeName: p.payeeName, currencyCode: p.currencyCode, currencyScale: s, amount: formatAmount(p.amount, s),
    allocatedTotal: formatAmount(p.allocatedTotal, s),
    unallocatedAmount: formatAmount(p.status === 'RECORDED' ? p.amount.sub(p.allocatedTotal) : new Decimal(0), s),
    paidOn: dayOf(p.receivedOn)!, method: p.method, reference: p.reference, status: p.status, reversedAt: iso(p.reversedAt),
    reversalReason: p.reversalReason, version: p.version, recordedById: p.recordedById, reversedById: p.reversedById,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
  };
}

async function dto(db: AppTenantDb, p: PaymentRow): Promise<PaymentDto> {
  return { ...headerDto(p), allocations: (await expenseAllocationsOf(db, { paymentId: p.id })).map(expenseAllocationDto) };
}

/** A payment made by this business; a received payment, or another business's id, answers 404. */
async function load(db: AppTenantDb, id: string): Promise<PaymentRow> {
  const row = (await db.financePayment.findFirst({ where: { id, direction: 'PAID' }, select: paymentSelect })) as PaymentRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export async function getExpensePayment(db: AppTenantDb, id: string) {
  return dto(db, await load(db, id));
}

/**
 * Validates and inserts allocations of a LOCKED payment to recorded expenses, all or nothing. Lock
 * order: the payment (already held), then the expenses by id. Inserts run in expense-id order.
 */
async function allocateLocked(db: AppTenantDb, actorUserId: string, payment: PaymentRow, items: ExpenseSettlementItem[]) {
  if (payment.status !== 'RECORDED') throw new StateConflictError('payment_not_open');
  const ids = [...items.map((i) => i.expenseId)].sort();
  await lockExpenses(db, ids);
  const rows = await db.financeExpense.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, currencyCode: true, amount: true, paidTotal: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parsed = items.map((i) => {
    const e = byId.get(i.expenseId);
    if (!e) throw new RuleViolationError('invalid_expense', 'Choose a recorded expense of this business.');
    if (e.status !== 'RECORDED') throw new StateConflictError('expense_not_open');
    if (e.currencyCode !== payment.currencyCode) throw new RuleViolationError('currency_mismatch', 'An expense can only be paid in its own currency.');
    const amount = toAmount(i.amount, payment.currencyScale, payment.currencyCode);
    if (amount.lte(0)) throw new RuleViolationError('invalid_amount', 'An amount must be greater than zero.');
    if (amount.gt((e.amount as Decimal).sub(e.paidTotal as Decimal))) throw new StateConflictError('over_payment');
    return { expenseId: i.expenseId, amount };
  }).sort((a, b) => (a.expenseId < b.expenseId ? -1 : a.expenseId > b.expenseId ? 1 : 0));
  const sum = parsed.reduce((s, i) => s.add(i.amount), new Decimal(0));
  if (sum.gt(payment.amount.sub(payment.allocatedTotal))) throw new StateConflictError('over_allocation');
  const live = await db.financeExpenseAllocation.count({ where: { paymentId: payment.id, expenseId: { in: ids }, reversedAt: null } });
  if (live > 0) throw new StateConflictError('already_allocated');
  for (const item of parsed) {
    const id = randomUUID();
    try {
      await db.financeExpenseAllocation.create({
        data: { id, paymentId: payment.id, expenseId: item.expenseId, currencyCode: payment.currencyCode, amount: item.amount, createdById: actorUserId } as never,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'finance_expense_allocations_active_key')) throw new StateConflictError('already_allocated');
      throw error;
    }
    await recordAudit(db, actorUserId, 'finance.expense_allocation.created', { type: 'finance_expense_allocation', id }, {
      paymentId: payment.id, expenseId: item.expenseId, amount: formatAmount(item.amount, payment.currencyScale), currencyCode: payment.currencyCode,
    });
  }
}

export type RecordExpensePaymentInput = {
  payeeName?: string | null; currencyCode?: string; amount: string; paidOn: string; method: PaymentMethod; reference?: string | null;
  allocations?: ExpenseSettlementItem[];
};

/**
 * Records a payment made (Idempotency-Key required, as F2 §6.4): a repeat of the same request returns
 * the original (200); the same key with a different request, or a key already used for a received
 * payment, is 409 idempotency_conflict. Keys are shared with F2's payments (one ledger, one key space).
 */
export async function recordExpensePayment(db: AppTenantDb, actorUserId: string, input: RecordExpensePaymentInput, key: string | null) {
  if (!key) throw new RuleViolationError('idempotency_key_required', 'Recording a payment needs an Idempotency-Key header.');
  const hash = requestHash('expense_payment.record', input);
  await lockIdempotencyKey(db, key);
  const existing = (await db.financePayment.findFirst({ where: { idempotencyKey: key }, select: paymentSelect })) as PaymentRow | null;
  if (existing) {
    if (existing.requestHash !== hash || existing.direction !== 'PAID') throw new StateConflictError('idempotency_conflict');
    return { status: 200 as const, payment: await dto(db, existing) };
  }
  const id = await insertPaid(db, actorUserId, input, { key, hash });
  if (input.allocations?.length) {
    await lockPayments(db, [id]);
    await allocateLocked(db, actorUserId, await load(db, id), input.allocations);
  }
  return { status: 201 as const, payment: await dto(db, await load(db, id)) };
}

async function insertPaid(
  db: AppTenantDb, actorUserId: string, input: Omit<RecordExpensePaymentInput, 'allocations'>, idem: { key: string; hash: string } | null,
): Promise<string> {
  const business = await businessProfile(db);
  const currency = checkCurrency(input.currencyCode ?? business.currency);
  const scale = currencyScale(currency);
  const amount = toAmount(input.amount, scale, currency);
  if (amount.lte(0)) throw new RuleViolationError('invalid_amount', 'A payment must be greater than zero.');
  if (input.paidOn > todayIn(business.timeZone)) throw new RuleViolationError('invalid_dates', 'A payment cannot be made in the future.');
  const id = randomUUID();
  try {
    await db.financePayment.create({
      data: {
        id, direction: 'PAID', customerId: null, payeeName: input.payeeName ?? null, currencyCode: currency, currencyScale: scale, amount,
        receivedOn: dateOf(input.paidOn), method: input.method, reference: input.reference ?? null, idempotencyKey: idem?.key ?? null,
        requestHash: idem?.hash ?? null, recordedById: actorUserId,
      } as never,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'finance_payments_idempotency_key')) throw new StateConflictError('idempotency_conflict');
    throw error;
  }
  await recordAudit(db, actorUserId, 'finance.payment.recorded', { type: 'finance_payment', id }, {
    direction: 'PAID', currencyCode: currency, amount: formatAmount(amount, scale), method: input.method, receivedOn: input.paidOn,
    hasReference: input.reference ? 'true' : 'false',
  });
  return id;
}

/**
 * Pays one just-recorded expense in full, in the recording unit of work (record with paidInFull). The
 * expense row is already locked by the caller; the payment is new, so no other transaction can hold it.
 */
export async function payExpenseInFull(
  db: AppTenantDb, actorUserId: string,
  expense: { id: string; currencyCode: string; currencyScale: number; amount: Decimal; supplierName: string | null },
  details: { paidOn: string; method: PaymentMethod; reference?: string | null },
) {
  const amount = formatAmount(expense.amount, expense.currencyScale);
  const id = await insertPaid(db, actorUserId, {
    payeeName: expense.supplierName, currencyCode: expense.currencyCode, amount, paidOn: details.paidOn, method: details.method, reference: details.reference,
  }, null);
  await allocateLocked(db, actorUserId, await load(db, id), [{ expenseId: expense.id, amount }]);
}

export async function allocateExpensePayment(db: AppTenantDb, actorUserId: string, id: string, items: ExpenseSettlementItem[]) {
  await lockPayments(db, [id]);
  await allocateLocked(db, actorUserId, await load(db, id), items);
  return dto(db, await load(db, id));
}

/** Reverses one live allocation (never deletes it). Lock order: payment, then the expense. */
export async function reverseExpenseAllocation(db: AppTenantDb, actorUserId: string, paymentId: string, allocationId: string) {
  await lockPayments(db, [paymentId]);
  const payment = await load(db, paymentId);
  const allocation = await db.financeExpenseAllocation.findFirst({ where: { id: allocationId, paymentId }, select: { expenseId: true, amount: true, reversedAt: true } });
  if (!allocation) throw new RecordNotFoundError();
  if (allocation.reversedAt) throw new StateConflictError('already_reversed');
  await lockExpenses(db, [allocation.expenseId]);
  const result = await db.financeExpenseAllocation.updateMany({ where: { id: allocationId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: actorUserId } });
  if (result.count === 0) throw new StateConflictError('already_reversed');
  await recordAudit(db, actorUserId, 'finance.expense_allocation.reversed', { type: 'finance_expense_allocation', id: allocationId }, {
    paymentId, expenseId: allocation.expenseId, amount: formatAmount(allocation.amount as Decimal, payment.currencyScale), currencyCode: payment.currencyCode,
  });
  return dto(db, await load(db, paymentId));
}

/** Reverses a payment made: its live allocations, then the payment, in one unit of work. Nothing is deleted. */
export async function reverseExpensePayment(db: AppTenantDb, actorUserId: string, id: string, input: { version: number; reason: string }) {
  await lockPayments(db, [id]);
  const before = await load(db, id);
  if (before.status !== 'RECORDED') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const live = await db.financeExpenseAllocation.findMany({ where: { paymentId: id, reversedAt: null }, select: { id: true, expenseId: true, amount: true }, orderBy: { expenseId: 'asc' } });
  await lockExpenses(db, [...new Set(live.map((a) => a.expenseId))].sort());
  for (const a of live) {
    await db.financeExpenseAllocation.updateMany({ where: { id: a.id, reversedAt: null }, data: { reversedAt: new Date(), reversedById: actorUserId } });
    await recordAudit(db, actorUserId, 'finance.expense_allocation.reversed', { type: 'finance_expense_allocation', id: a.id }, {
      paymentId: id, expenseId: a.expenseId, amount: formatAmount(a.amount as Decimal, before.currencyScale), currencyCode: before.currencyCode, cause: 'payment_reversal',
    });
  }
  const result = await db.financePayment.updateMany({
    where: { id, status: 'RECORDED', version: input.version, direction: 'PAID' },
    data: { status: 'REVERSED', reversalReason: input.reason, reversedById: actorUserId, version: { increment: 1 } } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.payment.reversed', { type: 'finance_payment', id }, {
    direction: 'PAID', currencyCode: before.currencyCode, amount: formatAmount(before.amount, before.currencyScale), method: before.method,
    reversedAllocations: String(live.length), hasReason: 'true',
  });
  return dto(db, await load(db, id));
}

export type ListExpensePaymentsQuery = {
  status: 'recorded' | 'reversed' | 'all'; currencyCode?: string; from?: string; to?: string; expenseId?: string; cursor?: string; limit: number;
};

/** Most recent first, keyset-paginated on (paid_on, id). */
export async function listExpensePayments(db: AppTenantDb, query: ListExpensePaymentsQuery) {
  const where: Record<string, unknown>[] = [{ direction: 'PAID' }];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  if (query.currencyCode) where.push({ currencyCode: query.currencyCode });
  if (query.from) where.push({ receivedOn: { gte: dateOf(query.from) } });
  if (query.to) where.push({ receivedOn: { lt: dateOf(query.to) } });
  if (query.expenseId) where.push({ expenseAllocations: { some: { expenseId: query.expenseId, reversedAt: null } } });
  const list = 'finance:expense-payments';
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
