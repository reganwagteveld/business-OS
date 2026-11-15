import { z } from 'zod';
import { FinanceLineInput } from './finance.ts';
import { CalendarDate, CurrencyCode, Money } from './sales.ts';

// Finance F6-1 (docs/finance-billing-f6.md): recurring invoice templates and their generation runs.
// Every path is under /api/v1/b/:slug/finance/recurring-invoices. A run only ever creates a DRAFT
// invoice: generating, issuing and sending are three separate facts and F6 performs only the first.
//
// The calendar rules below are shared by the API and the clients, so a preview in the app and the
// worker agree on every date. Pure functions on calendar dates (YYYY-MM-DD) with no time zone; the
// time zone only decides which calendar date "today" is.

const Uuid = z.string().uuid();
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const RecurringFrequency = z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL']);
export type RecurringFrequency = z.infer<typeof RecurringFrequency>;
export const RecurringStatus = z.enum(['ACTIVE', 'PAUSED', 'CANCELLED', 'ENDED']);
export type RecurringStatus = z.infer<typeof RecurringStatus>;
export const RecurringRunStatus = z.enum(['PENDING', 'RUNNING', 'GENERATED', 'FAILED', 'SKIPPED']);
export type RecurringRunStatus = z.infer<typeof RecurringRunStatus>;

// ---- calendar rules (D-F6-6) ---------------------------------------------------------------------

const DAY_MS = 86_400_000;
const parse = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { y, m, d };
};
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const format = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Adds whole days to a calendar date. */
export function addCalendarDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Adds whole months, keeping the anchor's day of the month and clamping it to the last day of a
 * shorter month: 31 Jan + 1 month = 28 Feb (29 in a leap year), + 2 months = 31 Mar. The anchor day is
 * always taken from the original date, never from the previous (clamped) period, so the schedule
 * never drifts.
 */
export function addCalendarMonths(day: string, months: number): string {
  const { y, m, d } = parse(day);
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return format(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

const MONTHS: Record<Exclude<RecurringFrequency, 'WEEKLY'>, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

/** The date of period `index` (0 = the start date) of a schedule. */
export function billingPeriodDate(startDate: string, frequency: RecurringFrequency, intervalCount: number, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('period index must be a non-negative integer');
  if (frequency === 'WEEKLY') return addCalendarDays(startDate, 7 * intervalCount * index);
  return addCalendarMonths(startDate, MONTHS[frequency] * intervalCount * index);
}

/** Today's calendar date in an IANA time zone. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** True when the runtime knows this IANA zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The first period index whose date is on or after `day` (used when a paused schedule resumes). */
export function firstPeriodOnOrAfter(startDate: string, frequency: RecurringFrequency, intervalCount: number, day: string, from = 0): number {
  let index = from;
  // Bounded: a schedule is at most 100 years long at weekly frequency (5,300 periods).
  for (let guard = 0; guard < 10_000; guard++, index++) {
    if (billingPeriodDate(startDate, frequency, intervalCount, index) >= day) return index;
  }
  throw new RangeError('schedule too long');
}

/** Upcoming period dates from `fromIndex`, stopping at the end date (inclusive). */
export function upcomingPeriodDates(
  s: { startDate: string; frequency: RecurringFrequency; intervalCount: number; endDate: string | null },
  fromIndex: number, count: number,
): { index: number; date: string }[] {
  const out: { index: number; date: string }[] = [];
  for (let i = fromIndex; out.length < count; i++) {
    const date = billingPeriodDate(s.startDate, s.frequency, s.intervalCount, i);
    if (s.endDate && date > s.endDate) break;
    out.push({ index: i, date });
  }
  return out;
}

// ---- requests -------------------------------------------------------------------------------------

const Lines = z.array(FinanceLineInput).min(1, 'A recurring invoice needs at least one line').max(200, 'A document has at most 200 lines');
const TimeZone = z.string().trim().min(1).max(64).refine(isKnownTimeZone, 'Use an IANA time zone such as Australia/Perth');
const Terms = z.number().int().min(0).max(365).nullable().optional();

export const CreateRecurringInvoiceRequest = z
  .object({
    name: z.string().trim().min(1, 'Name this recurring invoice').max(200),
    customerId: Uuid,
    contactId: Uuid.nullable().optional(),
    projectId: Uuid.nullable().optional(),
    currencyCode: CurrencyCode.optional(),
    frequency: RecurringFrequency,
    /** Every n weeks, months, quarters or years. */
    intervalCount: z.number().int().min(1).max(12).optional(),
    /** The first period's date; later periods keep its day of the month. */
    startDate: CalendarDate,
    endDate: CalendarDate.nullable().optional(),
    /** Defaults to the business's time zone. Decides which calendar day "today" is for this schedule. */
    timeZone: TimeZone.optional(),
    /** Due date of each generated invoice = its period date + these days; defaults to the Finance setting. */
    paymentTermsDays: Terms,
    notes: optionalText(5000),
    lines: Lines,
  })
  .strict()
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { message: 'The end date is before the start date', path: ['endDate'] });

/**
 * Edits apply to periods generated afterwards; drafts already generated never change. Customer,
 * currency, frequency, interval and start date are fixed once any period has been generated (cancel
 * and create a new schedule instead), so the period history stays meaningful.
 */
export const UpdateRecurringInvoiceRequest = z
  .object({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    customerId: Uuid.optional(),
    contactId: Uuid.nullable().optional(),
    projectId: Uuid.nullable().optional(),
    currencyCode: CurrencyCode.optional(),
    frequency: RecurringFrequency.optional(),
    intervalCount: z.number().int().min(1).max(12).optional(),
    startDate: CalendarDate.optional(),
    endDate: CalendarDate.nullable().optional(),
    timeZone: TimeZone.optional(),
    paymentTermsDays: Terms,
    notes: optionalText(5000),
    lines: Lines.optional(),
  })
  .strict();

export const RecurringTransitionRequest = z.object({ version: z.number().int().min(1) }).strict();
export const CancelRecurringInvoiceRequest = z
  .object({ version: z.number().int().min(1), reason: optionalText(1000) })
  .strict();
export const RecurringRunActionRequest = z.object({}).strict();

export const ListRecurringInvoicesQuery = z
  .object({
    status: z.enum(['active', 'paused', 'cancelled', 'ended', 'all']).default('all'),
    customerId: Uuid.optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const ListRecurringRunsQuery = z
  .object({
    status: z.enum(['pending', 'running', 'generated', 'failed', 'skipped', 'all']).default('all'),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const RecurringPreviewQuery = z.object({ count: z.coerce.number().int().min(1).max(24).default(6) }).strict();

// ---- responses ------------------------------------------------------------------------------------

const Line = z
  .object({
    description: z.string(), quantity: z.string(), unitPrice: z.string(), discountAmount: z.string(), taxRateId: Uuid.nullable(),
  })
  .strict();

export const RecurringInvoice = z
  .object({
    id: Uuid,
    name: z.string(),
    customerId: Uuid,
    contactId: Uuid.nullable(),
    projectId: Uuid.nullable(),
    currencyCode: z.string(),
    currencyScale: z.number().int(),
    frequency: RecurringFrequency,
    intervalCount: z.number().int(),
    startDate: CalendarDate,
    endDate: CalendarDate.nullable(),
    timeZone: z.string(),
    paymentTermsDays: z.number().int().nullable(),
    notes: z.string().nullable(),
    lines: z.array(Line),
    status: RecurringStatus,
    /** The next period that will be generated, or null when the schedule has ended or was cancelled. */
    nextPeriodIndex: z.number().int(),
    nextRunOn: CalendarDate.nullable(),
    generatedCount: z.number().int(),
    failedCount: z.number().int(),
    pausedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    version: z.number().int(),
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type RecurringInvoice = z.infer<typeof RecurringInvoice>;
export const RecurringInvoiceResponse = z.object({ recurringInvoice: RecurringInvoice }).strict();
export const ListRecurringInvoicesResponse = z.object({ recurringInvoices: z.array(RecurringInvoice), nextCursor: z.string().nullable() }).strict();

export const RecurringRun = z
  .object({
    id: Uuid,
    recurringInvoiceId: Uuid,
    periodIndex: z.number().int(),
    periodDate: CalendarDate,
    status: RecurringRunStatus,
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    runAfter: z.string(),
    errorCode: z.string().nullable(),
    /** The draft invoice this run created (GENERATED only). Its current status is reported beside it. */
    documentId: Uuid.nullable(),
    documentStatus: z.string().nullable(),
    documentNumber: z.string().nullable(),
    /** SCHEDULE for the worker, MANUAL for "generate now". */
    trigger: z.enum(['SCHEDULE', 'MANUAL']),
    requestedById: Uuid.nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type RecurringRun = z.infer<typeof RecurringRun>;
export const RecurringRunResponse = z.object({ run: RecurringRun }).strict();
export const ListRecurringRunsResponse = z.object({ runs: z.array(RecurringRun), nextCursor: z.string().nullable() }).strict();

export const RecurringPreview = z
  .object({
    /** Priced with today's tax rates; a later change to a rate changes later drafts. */
    currencyCode: z.string(),
    subtotal: Money,
    taxTotal: Money,
    total: Money,
    /** Set when the template could not be priced right now (an archived tax rate, an archived customer). */
    problem: z.string().nullable(),
    periods: z.array(z.object({ periodIndex: z.number().int(), periodDate: CalendarDate, dueDate: CalendarDate.nullable() }).strict()),
  })
  .strict();
export const RecurringPreviewResponse = z.object({ preview: RecurringPreview }).strict();
export const GenerateRecurringInvoiceResponse = z.object({ run: RecurringRun, recurringInvoice: RecurringInvoice }).strict();
