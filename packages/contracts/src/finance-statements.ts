import { z } from 'zod';
import { CalendarDate, CurrencyCode } from './sales.ts';

// Finance F6-2 (docs/finance-billing-f6.md §4): customer statements and accounts-receivable ageing,
// both as of a date in the business's time zone. Read-only: computed on every request from the F1–F3
// records (documents, payments, allocations, credit applications); nothing is stored and no second
// ledger exists. Amounts are exact decimal strings in the currency's scale; nothing is converted or
// added across currencies.
//
// Effective dates (§4.1): an issued document counts from its issue date, a payment from its received
// date. Voids, reversals, allocations and credit applications carry only a database time; each counts
// from that time's calendar date in the business's zone, but never before the records it links (an
// allocation never before its payment was received or its invoice issued).

const Uuid = z.string().uuid();
const Amount = z.string();
const Limit = z.coerce.number().int().min(1).max(100).default(50);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();

// ---- statements -----------------------------------------------------------------------------------

/** One customer, one currency, an inclusive date range. `to` may not be after today in the business's zone. */
export const StatementQuery = z
  .object({ customerId: Uuid, currencyCode: CurrencyCode, from: CalendarDate, to: CalendarDate })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'The start date must not be after the end date.', path: ['from'] });
export type StatementQuery = z.infer<typeof StatementQuery>;

/**
 * What moves the account balance. Positive amounts increase what the customer owes. Payment
 * allocations and credit applications are not entries: they only match items and never change the balance.
 */
export const StatementEntryType = z.enum(['INVOICE', 'INVOICE_VOID', 'CREDIT_NOTE', 'CREDIT_NOTE_VOID', 'PAYMENT', 'PAYMENT_REVERSAL']);
export type StatementEntryType = z.infer<typeof StatementEntryType>;

export const StatementEntry = z
  .object({
    date: z.string(),
    type: StatementEntryType,
    /** The finance document (invoice or credit note) or payment the entry belongs to. */
    sourceId: Uuid,
    /** Document number; for a payment, its reference (may be null). */
    reference: z.string().nullable(),
    /** Invoices only. */
    dueDate: z.string().nullable(),
    /** Signed: positive raises the balance, negative lowers it. */
    amount: Amount,
    /** Running balance after this entry. */
    balance: Amount,
  })
  .strict();
export type StatementEntry = z.infer<typeof StatementEntry>;

export const AgeingBuckets = z
  .object({
    current: Amount,
    days1To30: Amount,
    days31To60: Amount,
    days61To90: Amount,
    days90Plus: Amount,
    /** Open invoices issued without a due date: receivable, but never aged or overdue. */
    noDueDate: Amount,
  })
  .strict();
export type AgeingBuckets = z.infer<typeof AgeingBuckets>;

/**
 * As of a date: what is open on invoices (aged), and the customer's credit kept separate. The account
 * balance always equals receivable − unallocatedPayments − unappliedCredit (`balanced`).
 */
export const AgeingPosition = z
  .object({
    buckets: AgeingBuckets,
    /** Σ buckets: open on issued invoices after allocated payments and applied credit. */
    receivable: Amount,
    /** The part of `receivable` past its due date. */
    overdue: Amount,
    unallocatedPayments: Amount,
    unappliedCredit: Amount,
    /** Signed sum of every account event up to the date. */
    accountBalance: Amount,
    /** accountBalance === receivable − unallocatedPayments − unappliedCredit. */
    balanced: z.boolean(),
  })
  .strict();
export type AgeingPosition = z.infer<typeof AgeingPosition>;

export const Statement = z
  .object({
    customerId: Uuid,
    currencyCode: z.string(),
    currencyScale: z.number().int(),
    from: z.string(),
    to: z.string(),
    timeZone: z.string(),
    /** Balance at the end of the day before `from`. */
    openingBalance: Amount,
    entries: z.array(StatementEntry),
    /** openingBalance + Σ entries. */
    closingBalance: Amount,
    /** The position at the end of `to`: aged open invoices and the credit kept separate. */
    position: AgeingPosition,
  })
  .strict();
export type Statement = z.infer<typeof Statement>;
export const StatementResponse = z.object({ statement: Statement }).strict();

// ---- ageing ---------------------------------------------------------------------------------------

/** `asOf` defaults to today in the business's zone and may not be after it. */
export const ReceivablesAgeingQuery = z
  .object({ asOf: CalendarDate.optional(), currencyCode: CurrencyCode.optional(), customerId: Uuid.optional(), cursor: Cursor, limit: Limit })
  .strict();
export type ReceivablesAgeingQuery = z.infer<typeof ReceivablesAgeingQuery>;

export const AgeingCustomerRow = z
  .object({ customerId: Uuid, currencyCode: z.string(), currencyScale: z.number().int(), openInvoiceCount: z.number().int() })
  .extend(AgeingPosition.shape)
  .strict();
export type AgeingCustomerRow = z.infer<typeof AgeingCustomerRow>;

export const AgeingCurrencyTotal = z
  .object({ currencyCode: z.string(), currencyScale: z.number().int(), openInvoiceCount: z.number().int(), customerCount: z.number().int() })
  .extend(AgeingPosition.shape)
  .strict();
export type AgeingCurrencyTotal = z.infer<typeof AgeingCurrencyTotal>;

export const ReceivablesAgeing = z
  .object({
    asOf: z.string(),
    timeZone: z.string(),
    /** All customers (after the filters), per currency: not paginated. */
    totals: z.array(AgeingCurrencyTotal),
    /** Per customer and currency with anything open or any credit; keyset-paginated. */
    rows: z.array(AgeingCustomerRow),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ReceivablesAgeing = z.infer<typeof ReceivablesAgeing>;
export const ReceivablesAgeingResponse = z.object({ ageing: ReceivablesAgeing }).strict();

export const AgeingBucket = z.enum(['CURRENT', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'DAYS_90_PLUS', 'NO_DUE_DATE']);
export type AgeingBucket = z.infer<typeof AgeingBucket>;

export const ReceivablesAgeingDetailQuery = z
  .object({ asOf: CalendarDate.optional(), customerId: Uuid, currencyCode: CurrencyCode })
  .strict();
export type ReceivablesAgeingDetailQuery = z.infer<typeof ReceivablesAgeingDetailQuery>;

export const AgeingInvoice = z
  .object({
    invoiceId: Uuid,
    number: z.string().nullable(),
    issueDate: z.string(),
    dueDate: z.string().nullable(),
    total: Amount,
    /** Allocated payments in effect at the date. */
    paid: Amount,
    /** Applied credit in effect at the date. */
    credited: Amount,
    outstanding: Amount,
    /** asOf − dueDate in days; null without a due date. Zero or less is not overdue. */
    daysPastDue: z.number().int().nullable(),
    bucket: AgeingBucket,
  })
  .strict();
export type AgeingInvoice = z.infer<typeof AgeingInvoice>;

export const AgeingCredit = z
  .object({
    kind: z.enum(['PAYMENT', 'CREDIT_NOTE']),
    sourceId: Uuid,
    /** Credit note number, or the payment's reference. */
    reference: z.string().nullable(),
    date: z.string(),
    /** Unallocated or unapplied remainder at the date. */
    available: Amount,
  })
  .strict();
export type AgeingCredit = z.infer<typeof AgeingCredit>;

export const ReceivablesAgeingDetail = z
  .object({
    asOf: z.string(),
    timeZone: z.string(),
    customerId: Uuid,
    currencyCode: z.string(),
    currencyScale: z.number().int(),
    position: AgeingPosition,
    invoices: z.array(AgeingInvoice),
    credits: z.array(AgeingCredit),
  })
  .strict();
export type ReceivablesAgeingDetail = z.infer<typeof ReceivablesAgeingDetail>;
export const ReceivablesAgeingDetailResponse = z.object({ detail: ReceivablesAgeingDetail }).strict();

/**
 * Every `error` value of the F6-2 endpoints besides the generic not_found, forbidden, invalid_query and
 * retryable: `invalid_dates` (400: a date after today), `statement_too_large` (409: narrow the range),
 * `branding_logo_invalid` (409, PDF), `generation_failed` (503, PDF).
 */
export const STATEMENT_ERROR_CODES = ['invalid_dates', 'statement_too_large', 'branding_logo_invalid', 'generation_failed'] as const;
