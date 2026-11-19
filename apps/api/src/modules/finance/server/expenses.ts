import 'server-only';
// Expense categories and expenses (docs/finance-data-model.md §2.8, §4.3, §19; ADR 0007).
// Runs inside one tenant unit of work per request: the change and its audit entry, nothing else.
//
// Every write to an expense first locks it (FOR NO KEY UPDATE) and is then conditional on the state
// and version it read. The database holds every rule again (migration 20261117000000_finance_expenses):
// amounts and the tax split, the tax and category snapshots, immutability once recorded, the payment
// counter, voiding only while unpaid and tenant-consistent links. Receipts are deferred (FD-P6).
import { randomUUID } from 'node:crypto';
import type {
  ExpenseAllocation as AllocationDto, ExpenseCategory as CategoryDto, FinanceExpense as ExpenseDto,
  FinanceExpenseListItem as ListItemDto,
} from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { isUniqueViolation, RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { checkCustomer, checkProjectCustomer } from './documents';
import { checkCurrency, currencyScale, formatAmount, formatPlain, roundTo, toAmount } from './money';
import { activeTaxRate } from './settings';
import { businessProfile, changedFields, dateOf, dayOf, todayIn } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null) => d?.toISOString() ?? null;
const AMOUNT_LIMIT = new Decimal('99999999999999.9999');

// ---- categories ------------------------------------------------------------------------------------

/**
 * Defaults seeded for every business (idempotently, by system_key). Generic, industry-independent
 * headings; every one can be renamed, reordered or archived like a custom category. No tax meaning is
 * attached to any of them.
 */
export const DEFAULT_CATEGORIES: readonly { key: string; name: string }[] = [
  { key: 'advertising', name: 'Advertising and marketing' },
  { key: 'bank_fees', name: 'Bank and payment fees' },
  { key: 'equipment', name: 'Equipment and tools' },
  { key: 'insurance', name: 'Insurance' },
  { key: 'materials', name: 'Materials and supplies' },
  { key: 'vehicle', name: 'Motor vehicle and fuel' },
  { key: 'office', name: 'Office expenses' },
  { key: 'professional_fees', name: 'Professional fees' },
  { key: 'rent', name: 'Rent and premises' },
  { key: 'software', name: 'Software and subscriptions' },
  { key: 'subcontractors', name: 'Subcontractors' },
  { key: 'telephone', name: 'Telephone and internet' },
  { key: 'travel', name: 'Travel and accommodation' },
  { key: 'utilities', name: 'Utilities' },
  { key: 'other', name: 'Other' },
];

type CategoryRow = {
  id: string; name: string; position: number; systemKey: string | null; archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
};
const categorySelect = { id: true, name: true, position: true, systemKey: true, archivedAt: true, version: true, createdAt: true, updatedAt: true } as const;
const categoryDto = (c: CategoryRow): CategoryDto => ({
  id: c.id, name: c.name, position: c.position, systemKey: c.systemKey, archivedAt: iso(c.archivedAt), version: c.version,
  createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
});

/**
 * Tenant initialisation of the default categories: INSERT … ON CONFLICT DO NOTHING keyed by
 * (business_id, system_key), so it is idempotent and safe under concurrency (a racing first call waits
 * for the winner and inserts nothing). A default that was renamed or archived is never recreated, and a
 * default whose name an active custom category already uses is skipped (the active-name index). It runs
 * on first use of the expense endpoints, as the Sales default pipeline does; business creation is a
 * privileged path and is not changed.
 */
export async function ensureDefaultCategories(db: AppTenantDb) {
  const seeded = await db.financeExpenseCategory.count({ where: { systemKey: { not: null } } });
  if (seeded >= DEFAULT_CATEGORIES.length) return;
  await db.financeExpenseCategory.createMany({
    data: DEFAULT_CATEGORIES.map((c, i) => ({ id: randomUUID(), name: c.name, systemKey: c.key, position: (i + 1) * 10 })) as never,
    skipDuplicates: true,
  });
}

export async function listCategories(db: AppTenantDb, query: { archived: 'active' | 'archived' | 'all' }) {
  await ensureDefaultCategories(db);
  const where = query.archived === 'active' ? { archivedAt: null } : query.archived === 'archived' ? { archivedAt: { not: null } } : {};
  const rows = (await db.financeExpenseCategory.findMany({
    where, select: categorySelect, orderBy: [{ position: 'asc' }, { name: 'asc' }, { id: 'asc' }],
  })) as CategoryRow[];
  return rows.map(categoryDto);
}

async function nameTaken(db: AppTenantDb, name: string, exceptId?: string) {
  const hit = await db.financeExpenseCategory.findFirst({
    where: { archivedAt: null, name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return hit !== null;
}

const duplicateName = (error: unknown) => isUniqueViolation(error, 'finance_expense_categories_active_name_key');

export async function createCategory(db: AppTenantDb, actorUserId: string, input: { name: string; position?: number }) {
  await ensureDefaultCategories(db);
  if (await nameTaken(db, input.name)) throw new StateConflictError('duplicate_name');
  const last = await db.financeExpenseCategory.findFirst({ select: { position: true }, orderBy: { position: 'desc' } });
  const id = randomUUID();
  let row: CategoryRow;
  try {
    row = (await db.financeExpenseCategory.create({
      data: { id, name: input.name, position: input.position ?? Math.min((last?.position ?? 0) + 10, 100000), createdById: actorUserId, updatedById: actorUserId } as never,
      select: categorySelect,
    })) as CategoryRow;
  } catch (error) {
    if (duplicateName(error)) throw new StateConflictError('duplicate_name'); // a concurrent create of the same name
    throw error;
  }
  await recordAudit(db, actorUserId, 'finance.settings.changed', { type: 'finance_expense_category', id }, {
    setting: 'expense_category', action: 'created', position: String(row.position),
  });
  return categoryDto(row);
}

/** Rename, reorder, archive or restore (optimistic version). Recorded expenses keep their snapshotted name. */
export async function updateCategory(
  db: AppTenantDb, actorUserId: string, id: string, input: { version: number; name?: string; position?: number; archived?: boolean },
) {
  const before = (await db.financeExpenseCategory.findFirst({ where: { id }, select: categorySelect })) as CategoryRow | null;
  if (!before) throw new RecordNotFoundError();
  if (before.version !== input.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== before.name) data.name = input.name;
  if (input.position !== undefined && input.position !== before.position) data.position = input.position;
  if (input.archived !== undefined && input.archived !== (before.archivedAt !== null)) data.archivedAt = input.archived ? new Date() : null;
  if (Object.keys(data).length === 0) return categoryDto(before);
  const activeAfter = data.archivedAt === undefined ? before.archivedAt === null : data.archivedAt === null;
  if (activeAfter && (data.name !== undefined || data.archivedAt === null) && (await nameTaken(db, (data.name as string | undefined) ?? before.name, id))) {
    throw new StateConflictError('duplicate_name');
  }
  let result;
  try {
    result = await db.financeExpenseCategory.updateMany({ where: { id, version: input.version }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never });
  } catch (error) {
    if (duplicateName(error)) throw new StateConflictError('duplicate_name');
    throw error;
  }
  if (result.count === 0) throw new StateConflictError('stale');
  const fields = Object.keys(data).sort();
  await recordAudit(db, actorUserId, 'finance.settings.changed', { type: 'finance_expense_category', id }, {
    setting: 'expense_category', fields,
    ...(data.position !== undefined ? { positionFrom: String(before.position), positionTo: String(data.position) } : {}),
    ...(data.archivedAt !== undefined ? { archived: input.archived ? 'true' : 'false' } : {}),
  });
  return categoryDto((await db.financeExpenseCategory.findFirstOrThrow({ where: { id }, select: categorySelect })) as CategoryRow);
}

// ---- expense rows and DTOs ------------------------------------------------------------------------

export type ExpenseStatus = 'DRAFT' | 'RECORDED' | 'VOID';
export type TaxTreatment = 'NO_TAX' | 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE';

type ExpenseRow = {
  id: string; status: ExpenseStatus; categoryId: string; categoryName: string | null; projectId: string | null; customerId: string | null;
  description: string; supplierName: string | null; referenceNumber: string | null; notes: string | null; incurredOn: Date; dueDate: Date | null;
  currencyCode: string; currencyScale: number; subtotal: Decimal; amount: Decimal; taxAmount: Decimal; taxTreatment: TaxTreatment;
  taxRateId: string | null; taxName: string | null; taxRatePercent: Decimal; paidTotal: Decimal; recordedAt: Date | null; voidedAt: Date | null;
  voidReason: string | null; version: number; createdById: string | null; updatedById: string | null; recordedById: string | null;
  voidedById: string | null; createdAt: Date; updatedAt: Date;
};
const expenseSelect = {
  id: true, status: true, categoryId: true, categoryName: true, projectId: true, customerId: true, description: true, supplierName: true,
  referenceNumber: true, notes: true, incurredOn: true, dueDate: true, currencyCode: true, currencyScale: true, subtotal: true, amount: true,
  taxAmount: true, taxTreatment: true, taxRateId: true, taxName: true, taxRatePercent: true, paidTotal: true, recordedAt: true, voidedAt: true,
  voidReason: true, version: true, createdById: true, updatedById: true, recordedById: true, voidedById: true, createdAt: true, updatedAt: true,
} as const;

/** Derived payment state of a RECORDED expense (never stored); null for drafts and void expenses. */
export function paymentStateOf(r: { status: ExpenseStatus; amount: Decimal; paidTotal: Decimal }) {
  if (r.status !== 'RECORDED') return null;
  if (r.paidTotal.isZero()) return 'UNPAID' as const;
  return r.paidTotal.gte(r.amount) ? ('PAID' as const) : ('PARTIALLY_PAID' as const);
}

function headerDto(r: ExpenseRow, today: string): ListItemDto {
  const s = r.currencyScale;
  const open = r.status === 'RECORDED' ? r.amount.sub(r.paidTotal) : new Decimal(0);
  return {
    id: r.id, status: r.status, categoryId: r.categoryId, categoryName: r.categoryName, projectId: r.projectId, customerId: r.customerId,
    description: r.description, supplierName: r.supplierName, referenceNumber: r.referenceNumber, notes: r.notes,
    incurredOn: dayOf(r.incurredOn)!, dueDate: dayOf(r.dueDate), currencyCode: r.currencyCode, currencyScale: s,
    subtotal: formatAmount(r.subtotal, s), taxAmount: formatAmount(r.taxAmount, s), total: formatAmount(r.amount, s), taxTreatment: r.taxTreatment,
    taxRateId: r.taxRateId, taxName: r.taxName, taxRatePercent: formatPlain(r.taxRatePercent), paidTotal: formatAmount(r.paidTotal, s),
    outstanding: formatAmount(open, s), paymentState: paymentStateOf(r),
    overdue: r.status === 'RECORDED' && open.gt(0) && r.dueDate !== null && dayOf(r.dueDate)! < today,
    recordedAt: iso(r.recordedAt), voidedAt: iso(r.voidedAt), voidReason: r.voidReason, version: r.version, createdById: r.createdById,
    updatedById: r.updatedById, recordedById: r.recordedById, voidedById: r.voidedById, createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

type AllocationRow = {
  id: string; paymentId: string; expenseId: string; currencyCode: string; amount: Decimal; createdAt: Date; createdById: string | null;
  reversedAt: Date | null; reversedById: string | null; payment: { receivedOn: Date; method: AllocationDto['method']; currencyScale: number };
};
const allocationSelect = {
  id: true, paymentId: true, expenseId: true, currencyCode: true, amount: true, createdAt: true, createdById: true, reversedAt: true, reversedById: true,
  payment: { select: { receivedOn: true, method: true, currencyScale: true } },
} as const;
export const expenseAllocationDto = (a: AllocationRow): AllocationDto => ({
  id: a.id, paymentId: a.paymentId, expenseId: a.expenseId, currencyCode: a.currencyCode, amount: formatAmount(a.amount, a.payment.currencyScale),
  paidOn: dayOf(a.payment.receivedOn)!, method: a.payment.method, createdAt: a.createdAt.toISOString(), createdById: a.createdById,
  reversedAt: iso(a.reversedAt), reversedById: a.reversedById,
});
export async function expenseAllocationsOf(db: AppTenantDb, where: { paymentId?: string; expenseId?: string }): Promise<AllocationRow[]> {
  return (await db.financeExpenseAllocation.findMany({ where, select: allocationSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) as AllocationRow[];
}

async function today(db: AppTenantDb) {
  return todayIn((await businessProfile(db)).timeZone);
}

async function dto(db: AppTenantDb, row: ExpenseRow): Promise<ExpenseDto> {
  const allocations = await expenseAllocationsOf(db, { expenseId: row.id });
  const day = await today(db);
  return { ...headerDto(row, day), allocations: allocations.map(expenseAllocationDto) };
}

/** An expense of this business; another business's id answers exactly like a missing one (404). */
async function load(db: AppTenantDb, id: string): Promise<ExpenseRow> {
  const row = (await db.financeExpense.findFirst({ where: { id }, select: expenseSelect })) as ExpenseRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** Locks expenses FOR NO KEY UPDATE in id order (lock order: payments, documents, then expenses). */
export async function lockExpenses(db: AppTenantDb, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM finance_expenses
    WHERE id = ANY(${ids}::uuid[]) AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ORDER BY id FOR NO KEY UPDATE`;
}

export async function getExpense(db: AppTenantDb, id: string) {
  return dto(db, await load(db, id));
}

// ---- amounts (FD-T2 rounding; treatments: docs §19.3) ---------------------------------------------

export type ExpenseAmounts = { subtotal: Decimal; taxAmount: Decimal; total: Decimal };

/**
 * Splits the entered figure into subtotal, tax and total. Exact decimals, one rounding of the tax,
 * half away from zero at the currency's scale. The database recomputes the same formula (CHECK
 * finance_expenses_tax_treatment) from its own snapshot of the rate and refuses any difference.
 */
export function expenseAmounts(treatment: TaxTreatment, entered: Decimal, ratePercent: Decimal | null, scale: number): ExpenseAmounts {
  if (entered.lte(0)) throw new RuleViolationError('invalid_amount', 'An expense must be greater than zero.');
  let result: ExpenseAmounts;
  if (treatment === 'NO_TAX') {
    result = { subtotal: entered, taxAmount: new Decimal(0), total: entered };
  } else {
    if (ratePercent === null) throw new RuleViolationError('tax_rate_required', 'Choose the tax rate on the receipt.');
    if (treatment === 'TAX_EXCLUSIVE') {
      const tax = roundTo(entered.mul(ratePercent).div(100), scale);
      result = { subtotal: entered, taxAmount: tax, total: entered.add(tax) };
    } else {
      const tax = roundTo(entered.mul(ratePercent).div(ratePercent.add(100)), scale);
      result = { subtotal: entered.sub(tax), taxAmount: tax, total: entered };
    }
  }
  if (result.total.gt(AMOUNT_LIMIT)) throw new RuleViolationError('invalid_amount', 'This expense is too large.');
  return result;
}

/** The figure a person entered for this expense: the subtotal for tax-exclusive, otherwise the total. */
const enteredOf = (r: { taxTreatment: TaxTreatment; subtotal: Decimal; amount: Decimal }) => (r.taxTreatment === 'TAX_EXCLUSIVE' ? r.subtotal : r.amount);

// ---- validation -------------------------------------------------------------------------------------

/** A newly linked category must be this business's and active; an existing link stays valid when archived. */
async function checkCategory(db: AppTenantDb, id: string) {
  const category = await db.financeExpenseCategory.findFirst({ where: { id }, select: { archivedAt: true } });
  if (!category) throw new RuleViolationError('invalid_category', 'Choose an expense category of this business.');
  if (category.archivedAt) throw new StateConflictError('archived_reference');
}

/**
 * A newly linked project must be this business's and active. I1 (WF-1 §5.3): an expense with a customer
 * links only a project of that customer; an expense without one (an internal cost) may link any project
 * (MATCH SIMPLE, as the composite FK). Checked when the project or the customer changes.
 */
async function checkProject(db: AppTenantDb, id: string, customerId: string | null, newlyLinked: boolean) {
  const project = await db.project.findFirst({ where: { id }, select: { archivedAt: true, customerId: true } });
  if (!project) throw new RuleViolationError('invalid_project', 'Choose a project of this business.');
  if (newlyLinked && project.archivedAt) throw new StateConflictError('archived_reference');
  checkProjectCustomer(project.customerId, customerId);
}

async function ratePercentOf(db: AppTenantDb, taxRateId: string | null, newlyLinked: boolean): Promise<Decimal | null> {
  if (!taxRateId) return null;
  if (newlyLinked) await activeTaxRate(db, taxRateId);
  const rate = await db.financeTaxRate.findFirst({ where: { id: taxRateId }, select: { ratePercent: true } });
  if (!rate) throw new RuleViolationError('invalid_tax_rate', 'Choose a tax rate of this business.');
  return rate.ratePercent as Decimal;
}

function checkDates(incurredOn: string, dueDate: string | null, todayDay: string) {
  if (incurredOn > todayDay) throw new RuleViolationError('invalid_dates', 'An expense cannot be incurred in the future.');
  if (dueDate !== null && dueDate < incurredOn) throw new RuleViolationError('invalid_dates', 'The due date cannot be before the expense date.');
}

function checkTreatmentRate(treatment: TaxTreatment, taxRateId: string | null) {
  if (treatment === 'NO_TAX' && taxRateId) throw new RuleViolationError('invalid_tax_rate', 'An expense without tax has no tax rate.');
  if (treatment !== 'NO_TAX' && !taxRateId) throw new RuleViolationError('tax_rate_required', 'Choose the tax rate on the receipt.');
}

// ---- create, edit -------------------------------------------------------------------------------------

export type ExpenseInput = {
  categoryId: string; description: string; supplierName?: string | null; referenceNumber?: string | null; notes?: string | null;
  incurredOn: string; dueDate?: string | null; currencyCode?: string; taxTreatment: TaxTreatment; taxRateId?: string | null; amount: string;
  projectId?: string | null; customerId?: string | null;
};

export async function createExpense(db: AppTenantDb, actorUserId: string, input: ExpenseInput) {
  await ensureDefaultCategories(db);
  const business = await businessProfile(db);
  const currency = checkCurrency(input.currencyCode ?? business.currency);
  const scale = currencyScale(currency);
  const taxRateId = input.taxRateId ?? null;
  checkTreatmentRate(input.taxTreatment, taxRateId);
  checkDates(input.incurredOn, input.dueDate ?? null, todayIn(business.timeZone));
  await checkCategory(db, input.categoryId);
  if (input.customerId) await checkCustomer(db, input.customerId);
  if (input.projectId) await checkProject(db, input.projectId, input.customerId ?? null, true);
  const amounts = expenseAmounts(input.taxTreatment, toAmount(input.amount, scale, currency), await ratePercentOf(db, taxRateId, true), scale);

  const id = randomUUID();
  await db.financeExpense.create({
    data: {
      id, categoryId: input.categoryId, description: input.description, supplierName: input.supplierName ?? null,
      referenceNumber: input.referenceNumber ?? null, notes: input.notes ?? null, incurredOn: dateOf(input.incurredOn),
      dueDate: input.dueDate ? dateOf(input.dueDate) : null, currencyCode: currency, currencyScale: scale, taxTreatment: input.taxTreatment,
      taxRateId, subtotal: amounts.subtotal, taxAmount: amounts.taxAmount, amount: amounts.total, projectId: input.projectId ?? null,
      customerId: input.customerId ?? null, createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  await recordAudit(db, actorUserId, 'finance.expense.created', { type: 'finance_expense', id }, {
    categoryId: input.categoryId, projectId: input.projectId ?? null, customerId: input.customerId ?? null, currencyCode: currency,
    total: formatAmount(amounts.total, scale), taxTreatment: input.taxTreatment,
  });
  return getExpense(db, id);
}

export type ExpensePatch = Partial<Omit<ExpenseInput, 'currencyCode'>> & { version: number };

/** Edits a draft (optimistic version). Recorded and void expenses are immutable (409 invalid_state). */
export async function updateExpense(db: AppTenantDb, actorUserId: string, id: string, input: ExpensePatch) {
  await lockExpenses(db, [id]);
  const before = await load(db, id);
  if (before.status !== 'DRAFT') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');

  const pick = <K extends keyof ExpensePatch>(k: K, current: ExpensePatch[K]) => (input[k] === undefined ? current : input[k]);
  const next = {
    categoryId: pick('categoryId', before.categoryId)!, description: pick('description', before.description)!,
    supplierName: pick('supplierName', before.supplierName) ?? null, referenceNumber: pick('referenceNumber', before.referenceNumber) ?? null,
    notes: pick('notes', before.notes) ?? null, incurredOn: pick('incurredOn', dayOf(before.incurredOn)!)!, dueDate: pick('dueDate', dayOf(before.dueDate)) ?? null,
    taxTreatment: pick('taxTreatment', before.taxTreatment)!, taxRateId: pick('taxRateId', before.taxRateId) ?? null,
    projectId: pick('projectId', before.projectId) ?? null, customerId: pick('customerId', before.customerId) ?? null,
  };
  const scale = before.currencyScale;
  checkTreatmentRate(next.taxTreatment, next.taxRateId);
  checkDates(next.incurredOn, next.dueDate, await today(db));
  if (next.categoryId !== before.categoryId) await checkCategory(db, next.categoryId);
  if (next.customerId && next.customerId !== before.customerId) await checkCustomer(db, next.customerId);
  if (next.projectId && (next.projectId !== before.projectId || next.customerId !== before.customerId)) {
    await checkProject(db, next.projectId, next.customerId, next.projectId !== before.projectId);
  }
  const entered = input.amount !== undefined ? toAmount(input.amount, scale, before.currencyCode) : enteredOf(before);
  const amounts = expenseAmounts(next.taxTreatment, entered, await ratePercentOf(db, next.taxRateId, next.taxRateId !== before.taxRateId), scale);

  const data: Record<string, unknown> = {
    categoryId: next.categoryId, description: next.description, supplierName: next.supplierName, referenceNumber: next.referenceNumber,
    notes: next.notes, incurredOn: dateOf(next.incurredOn), dueDate: next.dueDate ? dateOf(next.dueDate) : null, taxTreatment: next.taxTreatment,
    taxRateId: next.taxRateId, subtotal: amounts.subtotal, taxAmount: amounts.taxAmount, amount: amounts.total, projectId: next.projectId,
    customerId: next.customerId,
  };
  const fields = changedFields(before as unknown as Record<string, unknown>, data);
  if (fields.length === 0) return dto(db, before);
  const result = await db.financeExpense.updateMany({
    where: { id, version: input.version, status: 'DRAFT' }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale'); // unreachable while the row is locked
  await recordAudit(db, actorUserId, 'finance.expense.updated', { type: 'finance_expense', id }, { fields });
  return getExpense(db, id);
}

// ---- record, void -------------------------------------------------------------------------------------

export type PaidInFull = { paidOn: string; method: 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'CHEQUE' | 'OTHER'; reference?: string | null };

/**
 * Records (posts) a draft. The database snapshots the category name and stamps recorded_at; from then
 * on only voiding and payments change it. `payInFull` (from the route, which checked finance:payments)
 * records a payment of the whole total and allocates it in the same unit of work.
 */
export async function recordExpense(
  db: AppTenantDb, actorUserId: string, id: string, input: { version: number },
  payInFull?: (expense: { id: string; currencyCode: string; currencyScale: number; amount: Decimal; supplierName: string | null }) => Promise<void>,
) {
  await lockExpenses(db, [id]);
  const before = await load(db, id);
  if (before.status !== 'DRAFT') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const category = await db.financeExpenseCategory.findFirst({ where: { id: before.categoryId }, select: { archivedAt: true } });
  if (!category || category.archivedAt) throw new StateConflictError('archived_reference');
  const result = await db.financeExpense.updateMany({
    where: { id, version: input.version, status: 'DRAFT' },
    data: { status: 'RECORDED', recordedById: actorUserId, updatedById: actorUserId, version: { increment: 1 } } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.expense.recorded', { type: 'finance_expense', id }, {
    categoryId: before.categoryId, projectId: before.projectId, customerId: before.customerId, currencyCode: before.currencyCode,
    amount: formatAmount(before.amount, before.currencyScale), taxAmount: formatAmount(before.taxAmount, before.currencyScale),
    paidInFull: payInFull ? 'true' : 'false',
  });
  // Lock order note: the expense is locked before the new payment row here. No other transaction can
  // see or lock a payment inserted by this one, so this cannot form a cycle with payment → expense paths.
  if (payInFull) await payInFull(before);
  return getExpense(db, id);
}

/**
 * Voids a recorded expense (reason required), or discards a draft (reason optional). A recorded expense
 * with live payments cannot be voided (409 has_payments): reverse its payment allocations first, which
 * keeps them as history. A void expense is final. Nothing is deleted.
 */
export async function voidExpense(db: AppTenantDb, actorUserId: string, id: string, input: { version: number; reason?: string | null }) {
  await lockExpenses(db, [id]);
  const before = await load(db, id);
  if (before.status === 'VOID') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const reason = input.reason ?? null;
  if (before.status === 'RECORDED') {
    if (!reason) throw new RuleViolationError('reason_required', 'Give a reason for voiding a recorded expense.');
    if (!before.paidTotal.isZero()) throw new StateConflictError('has_payments');
  }
  const result = await db.financeExpense.updateMany({
    where: { id, version: input.version, status: before.status },
    data: { status: 'VOID', voidReason: reason, voidedById: actorUserId, updatedById: actorUserId, version: { increment: 1 } } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, before.status === 'DRAFT' ? 'finance.expense.discarded' : 'finance.expense.voided', { type: 'finance_expense', id }, {
    categoryId: before.categoryId, projectId: before.projectId, currencyCode: before.currencyCode, amount: formatAmount(before.amount, before.currencyScale),
    hasReason: reason ? 'true' : 'false',
  });
  return getExpense(db, id);
}

// ---- list and payables --------------------------------------------------------------------------------

export type ListExpensesQuery = {
  status: 'draft' | 'recorded' | 'void' | 'all'; payment?: 'unpaid' | 'partially_paid' | 'paid' | 'open' | 'overdue';
  categoryId?: string; projectId?: string; customerId?: string; currencyCode?: string; from?: string; to?: string; q?: string; supplier?: string;
  cursor?: string; limit: number;
};

/** Most recently incurred first, keyset-paginated on (incurred_on, id). */
export async function listExpenses(db: AppTenantDb, query: ListExpensesQuery) {
  const day = await today(db);
  const amount = db.financeExpense.fields.amount;
  const where: Record<string, unknown>[] = [];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  if (query.payment) {
    where.push({ status: 'RECORDED' });
    if (query.payment === 'unpaid') where.push({ paidTotal: 0 });
    if (query.payment === 'partially_paid') where.push({ paidTotal: { gt: 0 } }, { paidTotal: { lt: amount } });
    if (query.payment === 'paid') where.push({ paidTotal: { equals: amount } });
    if (query.payment === 'open' || query.payment === 'overdue') where.push({ paidTotal: { lt: amount } });
    if (query.payment === 'overdue') where.push({ dueDate: { lt: dateOf(day) } });
  }
  if (query.categoryId) where.push({ categoryId: query.categoryId });
  if (query.projectId) where.push({ projectId: query.projectId });
  if (query.customerId) where.push({ customerId: query.customerId });
  if (query.currencyCode) where.push({ currencyCode: query.currencyCode });
  if (query.from) where.push({ incurredOn: { gte: dateOf(query.from) } });
  if (query.to) where.push({ incurredOn: { lt: dateOf(query.to) } });
  if (query.supplier) where.push({ supplierName: { contains: query.supplier, mode: 'insensitive' } });
  if (query.q) {
    where.push({
      OR: [
        { supplierName: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } },
        { referenceNumber: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }
  const list = 'finance:expenses';
  const after = decodeCursor(query.cursor, list, ['d', 'i'] as const);
  if (after) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(after.d) || !UUID.test(after.i)) invalidCursor();
    const d = dateOf(after.d);
    where.push({ OR: [{ incurredOn: { lt: d } }, { incurredOn: d, id: { lt: after.i } }] });
  }
  const rows = (await db.financeExpense.findMany({
    where: { AND: where }, select: expenseSelect, orderBy: [{ incurredOn: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as ExpenseRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    expenses: page.map((r) => headerDto(r, day)),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, { d: dayOf(last.incurredOn)!, i: last.id }) : null,
  };
}

/**
 * Payables per currency: recorded expenses not fully paid. Drafts and void expenses never count
 * (status = RECORDED); paid amounts come from the database-maintained counter. One statement.
 */
export async function expensePayables(db: AppTenantDb) {
  const asOf = await today(db);
  const rows = await db.$queryRaw<{ currency_code: string; currency_scale: number; outstanding: Decimal; overdue: Decimal; open_count: number; overdue_count: number }[]>`
    SELECT currency_code::text, max(currency_scale)::int AS currency_scale, sum(amount - paid_total) AS outstanding,
           coalesce(sum(amount - paid_total) FILTER (WHERE due_date < ${asOf}::date), 0) AS overdue,
           count(*)::int AS open_count, count(*) FILTER (WHERE due_date < ${asOf}::date)::int AS overdue_count
      FROM finance_expenses
     WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid AND status = 'RECORDED' AND paid_total < amount
     GROUP BY currency_code ORDER BY currency_code`;
  return {
    asOf,
    currencies: rows.map((r) => ({
      currencyCode: r.currency_code, currencyScale: r.currency_scale, outstanding: formatAmount(new Decimal(r.outstanding), r.currency_scale),
      overdue: formatAmount(new Decimal(r.overdue), r.currency_scale), openCount: Number(r.open_count), overdueCount: Number(r.overdue_count),
    })),
  };
}
