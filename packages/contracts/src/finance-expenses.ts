import { z } from 'zod';
import { FinancePaymentMethod, FinancePaymentStatus } from './finance.ts';
import { CalendarDate, CurrencyCode, Money } from './sales.ts';

// Finance Zone F3 (docs/finance-data-model.md §19): expense categories, expenses and payments made against
// expenses. Receipt attachments are deferred (FD-P6): no receipt records, uploads or downloads.
// Same rules as F1/F2: every path is under /api/v1/b/:slug/finance, so
// no request carries a business id; bodies are strict (an unknown field is rejected, never ignored);
// amounts are exact decimal strings, never JSON numbers; counters, snapshots and transition times
// belong to the database.
//
// Payments to suppliers live in the same payments ledger as F2's customer receipts (direction PAID).
// They settle recorded expenses through their own link table, never invoices. This is a record of
// money paid outside Business OS: no bank feed, no payment provider, no general ledger.

const Uuid = z.string().uuid();
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const Version = { version: z.number().int().min(1) };
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();

// ---- categories ----------------------------------------------------------------------------------

export const ExpenseCategory = z
  .object({
    id: Uuid,
    name: z.string(),
    position: z.number().int(),
    /** Set on the defaults seeded for every business (for example "travel"); null for custom categories. */
    systemKey: z.string().nullable(),
    archivedAt: z.string().datetime().nullable(),
    version: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ExpenseCategory = z.infer<typeof ExpenseCategory>;

export const ListExpenseCategoriesQuery = z.object({ archived: z.enum(['active', 'archived', 'all']).default('active') }).strict();
export const ListExpenseCategoriesResponse = z.object({ categories: z.array(ExpenseCategory) }).strict();
export const ExpenseCategoryResponse = z.object({ category: ExpenseCategory }).strict();
const CategoryName = z.string().trim().min(1, 'Enter a name').max(100);
export const CreateExpenseCategoryRequest = z.object({ name: CategoryName, position: z.number().int().min(0).max(100000).optional() }).strict();
/** Rename, reorder, archive or restore. A category is never deleted: recorded expenses keep it. */
export const UpdateExpenseCategoryRequest = z
  .object({ ...Version, name: CategoryName.optional(), position: z.number().int().min(0).max(100000).optional(), archived: z.boolean().optional() })
  .strict();

// ---- expenses ------------------------------------------------------------------------------------

export const FinanceExpenseStatus = z.enum(['DRAFT', 'RECORDED', 'VOID']);
export type FinanceExpenseStatus = z.infer<typeof FinanceExpenseStatus>;
/**
 * NO_TAX: no tax; `amount` is the total. TAX_EXCLUSIVE: `amount` is the subtotal and tax is added.
 * TAX_INCLUSIVE: `amount` is the total and the tax inside it is computed. Both taxed treatments need a
 * tax rate of this business; the server computes the split and the database checks it.
 */
export const ExpenseTaxTreatment = z.enum(['NO_TAX', 'TAX_EXCLUSIVE', 'TAX_INCLUSIVE']);
export type ExpenseTaxTreatment = z.infer<typeof ExpenseTaxTreatment>;
/** Derived from payments, never stored. Null unless RECORDED. */
export const ExpensePaymentState = z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']);
export type ExpensePaymentState = z.infer<typeof ExpensePaymentState>;

export const ExpenseAllocation = z
  .object({
    id: Uuid,
    paymentId: Uuid,
    expenseId: Uuid,
    currencyCode: z.string(),
    amount: z.string(),
    /** The payment's date and method, for display. */
    paidOn: z.string(),
    method: FinancePaymentMethod,
    createdAt: z.string().datetime(),
    createdById: Uuid.nullable(),
    /** Null while live. Reversal is one way; the row is kept. */
    reversedAt: z.string().datetime().nullable(),
    reversedById: Uuid.nullable(),
  })
  .strict();
export type ExpenseAllocation = z.infer<typeof ExpenseAllocation>;

const expenseFields = {
  id: Uuid,
  status: FinanceExpenseStatus,
  categoryId: Uuid,
  /** The category's name as it was when the expense was recorded (null while a draft). */
  categoryName: z.string().nullable(),
  projectId: Uuid.nullable(),
  customerId: Uuid.nullable(),
  description: z.string(),
  supplierName: z.string().nullable(),
  referenceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  incurredOn: z.string(),
  dueDate: z.string().nullable(),
  currencyCode: z.string(),
  currencyScale: z.number().int(),
  subtotal: z.string(),
  taxAmount: z.string(),
  total: z.string(),
  taxTreatment: ExpenseTaxTreatment,
  taxRateId: Uuid.nullable(),
  /** The rate's name and percentage as the expense uses them (copied by the database). */
  taxName: z.string().nullable(),
  taxRatePercent: z.string(),
  /** Sum of live payment allocations (maintained by the database). */
  paidTotal: z.string(),
  /** total − paidTotal while RECORDED; "0" otherwise. */
  outstanding: z.string(),
  paymentState: ExpensePaymentState.nullable(),
  /** RECORDED, not fully paid, and due before today in the business's time zone. */
  overdue: z.boolean(),
  recordedAt: z.string().datetime().nullable(),
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string().nullable(),
  version: z.number().int().min(1),
  createdById: Uuid.nullable(),
  updatedById: Uuid.nullable(),
  recordedById: Uuid.nullable(),
  voidedById: Uuid.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
export const FinanceExpenseListItem = z.object(expenseFields).strict();
export type FinanceExpenseListItem = z.infer<typeof FinanceExpenseListItem>;
export const FinanceExpense = z
  .object({ ...expenseFields, allocations: z.array(ExpenseAllocation) })
  .strict();
export type FinanceExpense = z.infer<typeof FinanceExpense>;

const expenseInput = {
  categoryId: Uuid,
  description: z.string().trim().min(1, 'Enter a description').max(500),
  supplierName: optionalText(200),
  referenceNumber: optionalText(100),
  notes: optionalText(5000),
  /** In the business's calendar; not in the future. */
  incurredOn: CalendarDate,
  /** For an expense to be paid later (a bill); on or after incurredOn. */
  dueDate: CalendarDate.nullable().optional(),
  /** Defaults to the business's currency. Fixed once created. */
  currencyCode: CurrencyCode.optional(),
  taxTreatment: ExpenseTaxTreatment,
  taxRateId: Uuid.nullable().optional(),
  /** The figure from the receipt: the subtotal for TAX_EXCLUSIVE, otherwise the total. Greater than zero. */
  amount: Money,
  projectId: Uuid.nullable().optional(),
  customerId: Uuid.nullable().optional(),
};
export const CreateExpenseRequest = z.object(expenseInput).strict();
/** Drafts only. Send the complete amount fields together (taxTreatment, taxRateId, amount). */
export const UpdateExpenseRequest = z
  .object({
    ...Version,
    categoryId: Uuid.optional(),
    description: expenseInput.description.optional(),
    supplierName: expenseInput.supplierName,
    referenceNumber: expenseInput.referenceNumber,
    notes: expenseInput.notes,
    incurredOn: CalendarDate.optional(),
    dueDate: expenseInput.dueDate,
    taxTreatment: ExpenseTaxTreatment.optional(),
    taxRateId: expenseInput.taxRateId,
    amount: Money.optional(),
    projectId: expenseInput.projectId,
    customerId: expenseInput.customerId,
  })
  .strict();

const PaymentDetails = z
  .object({
    /** In the business's calendar; not in the future. */
    paidOn: CalendarDate,
    method: FinancePaymentMethod,
    reference: optionalText(200),
  })
  .strict();
/**
 * Records (posts) a draft: the category name and tax rate are frozen and the expense becomes
 * immutable. With `paidInFull`, a payment of the whole total is recorded and allocated in the same unit
 * of work (needs finance:payments as well as finance:expenses). Without it the expense stays unpaid.
 */
export const RecordExpenseRequest = z.object({ ...Version, paidInFull: PaymentDetails.optional() }).strict();
/** Voids a recorded expense (no live payments) or discards a draft. A reason is required for a recorded one. */
export const VoidExpenseRequest = z.object({ ...Version, reason: optionalText(500) }).strict();

export const ListExpensesQuery = z
  .object({
    status: z.enum(['draft', 'recorded', 'void', 'all']).default('all'),
    /** Recorded expenses by derived payment state; `open` = not fully paid; `overdue` = open and past due. */
    payment: z.enum(['unpaid', 'partially_paid', 'paid', 'open', 'overdue']).optional(),
    categoryId: Uuid.optional(),
    projectId: Uuid.optional(),
    customerId: Uuid.optional(),
    currencyCode: CurrencyCode.optional(),
    /** Incurred date range, half-open [from, to). */
    from: CalendarDate.optional(),
    to: CalendarDate.optional(),
    /** Case-insensitive text in the supplier, description or reference number. */
    q: z.string().trim().min(1).max(100).optional(),
    /** Case-insensitive supplier name (contains). */
    supplier: z.string().trim().min(1).max(200).optional(),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();
export const FinanceExpenseResponse = z.object({ expense: FinanceExpense }).strict();
export const ListExpensesResponse = z.object({ expenses: z.array(FinanceExpenseListItem), nextCursor: z.string().nullable() }).strict();

/** Per currency: recorded, not fully paid expenses. Drafts and void expenses never count. */
export const ExpensePayables = z
  .object({
    asOf: z.string(),
    currencies: z.array(
      z
        .object({
          currencyCode: z.string(),
          currencyScale: z.number().int(),
          outstanding: z.string(),
          overdue: z.string(),
          openCount: z.number().int(),
          overdueCount: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
export const ExpensePayablesResponse = z.object({ payables: ExpensePayables }).strict();

// ---- payments made (direction PAID) ----------------------------------------------------------------

const ExpenseSettlementItem = z.object({ expenseId: Uuid, amount: Money }).strict();
const ExpenseSettlementItems = z
  .array(ExpenseSettlementItem)
  .min(1)
  .max(50, 'At most 50 expenses at once')
  .refine((items) => new Set(items.map((i) => i.expenseId)).size === items.length, 'Each expense at most once');

const expensePaymentFields = {
  id: Uuid,
  payeeName: z.string().nullable(),
  currencyCode: z.string(),
  currencyScale: z.number().int(),
  amount: z.string(),
  allocatedTotal: z.string(),
  /** amount − allocatedTotal while RECORDED: paid but not yet matched to an expense. */
  unallocatedAmount: z.string(),
  paidOn: z.string(),
  method: FinancePaymentMethod,
  reference: z.string().nullable(),
  status: FinancePaymentStatus,
  reversedAt: z.string().datetime().nullable(),
  reversalReason: z.string().nullable(),
  version: z.number().int().min(1),
  recordedById: Uuid.nullable(),
  reversedById: Uuid.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
export const ExpensePaymentListItem = z.object(expensePaymentFields).strict();
export const ExpensePayment = z.object({ ...expensePaymentFields, allocations: z.array(ExpenseAllocation) }).strict();
export type ExpensePayment = z.infer<typeof ExpensePayment>;

/**
 * Records a payment made outside Business OS. Requires an Idempotency-Key header (as F2's payments).
 * `allocations` settle recorded expenses of the same currency in the same unit of work.
 */
export const RecordExpensePaymentRequest = z
  .object({
    payeeName: optionalText(200),
    currencyCode: CurrencyCode.optional(),
    amount: Money,
    paidOn: CalendarDate,
    method: FinancePaymentMethod,
    reference: optionalText(200),
    allocations: ExpenseSettlementItems.optional(),
  })
  .strict();
export const AllocateExpensePaymentRequest = z.object({ allocations: ExpenseSettlementItems }).strict();
export const ReverseExpenseAllocationRequest = z.object({}).strict();
export const ReverseExpensePaymentRequest = z.object({ ...Version, reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
export const ListExpensePaymentsQuery = z
  .object({
    status: z.enum(['recorded', 'reversed', 'all']).default('all'),
    currencyCode: CurrencyCode.optional(),
    from: CalendarDate.optional(),
    to: CalendarDate.optional(),
    expenseId: Uuid.optional(),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();
export const ExpensePaymentResponse = z.object({ payment: ExpensePayment }).strict();
export const ListExpensePaymentsResponse = z.object({ payments: z.array(ExpensePaymentListItem), nextCursor: z.string().nullable() }).strict();

/** Error codes of the F3 endpoints (docs/finance-data-model.md §19.9), besides the shared ones. */
export const FinanceExpenseErrorCode = z.enum([
  'invalid_category', 'archived_reference', 'duplicate_name', 'invalid_tax_rate', 'tax_rate_required', 'invalid_project', 'invalid_customer',
  'invalid_currency', 'invalid_amount', 'invalid_dates', 'stale', 'invalid_state', 'immutable', 'has_payments', 'expense_not_open',
  'payment_not_open', 'over_payment', 'over_allocation', 'already_allocated', 'already_reversed', 'idempotency_key_required',
  'invalid_idempotency_key', 'idempotency_conflict', 'invalid_expense', 'currency_mismatch', 'reason_required',
  'invalid_cursor',
]);
export type FinanceExpenseErrorCode = z.infer<typeof FinanceExpenseErrorCode>;
