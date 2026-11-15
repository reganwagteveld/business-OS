import 'server-only';
// Recurring invoices (Finance F6-1, docs/finance-billing-f6.md §3). A template describes what to bill
// a customer every week, month, quarter or year; a run is one period of it. Generating a period
// creates a DRAFT invoice through the same service as a person creating one (pricing, tax rates,
// links, idempotency, audit), so it never takes an invoice number: numbers are assigned only at issue
// (FD-L1). Nothing here issues or sends a document (D-F6-4).
//
// Concurrency and idempotency, in three layers:
//   1. Planning locks the template (FOR UPDATE SKIP LOCKED) and inserts runs with ON CONFLICT DO
//      NOTHING on UNIQUE (template, period), so a period is planned at most once.
//   2. A worker claims a run with a lease (FOR UPDATE SKIP LOCKED); every later step requires that
//      lease to be held and unexpired on database time, so a worker whose lease expired changes nothing.
//   3. The draft is created with a system idempotency key that no client can send (it contains a
//      space; client keys are visible ASCII only), unique per business in the database, and the move to
//      GENERATED commits in the same transaction as the draft. A crash at any point either leaves no
//      draft and a reclaimable run, or a draft and a GENERATED run; never a draft without its run.
import { randomUUID } from 'node:crypto';
import {
  billingPeriodDate, firstPeriodOnOrAfter, upcomingPeriodDates, type RecurringFrequency, type RecurringInvoice as TemplateDto,
  type RecurringRun as RunDto,
} from '@business-os/contracts';
import { recordAudit, recordSystemAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { checkLinks, createInvoice, priceLines, totalsOf, type LineInput } from './documents';
import { checkCurrency, currencyScale, formatAmount, toAmount } from './money';
import { loadSettings } from './settings';
import { addDays, businessProfile, dateOf, dayOf, todayIn } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most this many periods are planned per template per worker pass (D-F6-5); the rest follow next pass. */
export const MAX_PERIODS_PER_PASS = 12;

// ---- rows and DTOs -------------------------------------------------------------------------------

type TemplateRow = {
  id: string; name: string; customerId: string; contactId: string | null; projectId: string | null; currencyCode: string; currencyScale: number;
  frequency: string; intervalCount: number; startDate: Date; endDate: Date | null; timeZone: string; paymentTermsDays: number | null;
  notes: string | null; lines: unknown; status: string; nextPeriodIndex: number; nextRunOn: Date | null; pausedAt: Date | null;
  cancelledAt: Date | null; endedAt: Date | null; version: number; createdById: string | null; updatedById: string | null; createdAt: Date; updatedAt: Date;
};
const templateSelect = {
  id: true, name: true, customerId: true, contactId: true, projectId: true, currencyCode: true, currencyScale: true, frequency: true,
  intervalCount: true, startDate: true, endDate: true, timeZone: true, paymentTermsDays: true, notes: true, lines: true, status: true,
  nextPeriodIndex: true, nextRunOn: true, pausedAt: true, cancelledAt: true, endedAt: true, version: true, createdById: true, updatedById: true,
  createdAt: true, updatedAt: true,
} as const;

type RunRow = {
  id: string; templateId: string; periodIndex: number; periodDate: Date; status: string; trigger: string; requestedById: string | null;
  attempts: number; maxAttempts: number; runAfter: Date; documentId: string | null; errorCode: string | null; startedAt: Date | null;
  finishedAt: Date | null; createdAt: Date;
};
const runSelect = {
  id: true, templateId: true, periodIndex: true, periodDate: true, status: true, trigger: true, requestedById: true, attempts: true,
  maxAttempts: true, runAfter: true, documentId: true, errorCode: true, startedAt: true, finishedAt: true, createdAt: true,
} as const;

type StoredLine = { description: string; quantity: string; unitPrice: string; discountAmount: string; taxRateId: string | null };

const iso = (d: Date | null) => d?.toISOString() ?? null;
const day = (d: Date) => dayOf(d)!;
const linesOf = (t: { lines: unknown }) => t.lines as StoredLine[];

async function counts(db: AppTenantDb, templateIds: string[]) {
  if (templateIds.length === 0) return new Map<string, { generated: number; failed: number }>();
  const rows = await db.financeRecurringRun.groupBy({
    by: ['templateId', 'status'], where: { templateId: { in: templateIds }, status: { in: ['GENERATED', 'FAILED'] } }, _count: { _all: true },
  });
  const out = new Map<string, { generated: number; failed: number }>();
  for (const r of rows) {
    const c = out.get(r.templateId) ?? { generated: 0, failed: 0 };
    if (r.status === 'GENERATED') c.generated = r._count._all;
    else c.failed = r._count._all;
    out.set(r.templateId, c);
  }
  return out;
}

function templateDto(t: TemplateRow, c: { generated: number; failed: number } | undefined): TemplateDto {
  return {
    id: t.id, name: t.name, customerId: t.customerId, contactId: t.contactId, projectId: t.projectId, currencyCode: t.currencyCode,
    currencyScale: t.currencyScale, frequency: t.frequency as RecurringFrequency, intervalCount: t.intervalCount, startDate: day(t.startDate),
    endDate: dayOf(t.endDate), timeZone: t.timeZone, paymentTermsDays: t.paymentTermsDays, notes: t.notes, lines: linesOf(t),
    status: t.status as TemplateDto['status'], nextPeriodIndex: t.nextPeriodIndex, nextRunOn: dayOf(t.nextRunOn),
    generatedCount: c?.generated ?? 0, failedCount: c?.failed ?? 0, pausedAt: iso(t.pausedAt), cancelledAt: iso(t.cancelledAt),
    endedAt: iso(t.endedAt), version: t.version, createdById: t.createdById, updatedById: t.updatedById, createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

async function oneDto(db: AppTenantDb, t: TemplateRow) {
  return templateDto(t, (await counts(db, [t.id])).get(t.id));
}

async function runDtos(db: AppTenantDb, runs: RunRow[]): Promise<RunDto[]> {
  const ids = runs.map((r) => r.documentId).filter((v): v is string => !!v);
  const docs = ids.length
    ? await db.financeDocument.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, number: true } })
    : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return runs.map((r) => ({
    id: r.id, recurringInvoiceId: r.templateId, periodIndex: r.periodIndex, periodDate: day(r.periodDate), status: r.status as RunDto['status'],
    attempts: r.attempts, maxAttempts: r.maxAttempts, runAfter: r.runAfter.toISOString(), errorCode: r.errorCode, documentId: r.documentId,
    documentStatus: r.documentId ? (byId.get(r.documentId)?.status ?? null) : null, documentNumber: r.documentId ? (byId.get(r.documentId)?.number ?? null) : null,
    trigger: r.trigger as RunDto['trigger'], requestedById: r.requestedById, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt),
    createdAt: r.createdAt.toISOString(),
  }));
}

async function load(db: AppTenantDb, id: string): Promise<TemplateRow> {
  const row = (await db.financeRecurringTemplate.findFirst({ where: { id }, select: templateSelect })) as TemplateRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** Locks the template row (FOR NO KEY UPDATE) before any change, then reads it. */
async function lockAndLoad(db: AppTenantDb, id: string): Promise<TemplateRow> {
  if (!UUID.test(id)) throw new RecordNotFoundError();
  await db.$queryRaw`
    SELECT 1 FROM finance_recurring_templates
    WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR NO KEY UPDATE`;
  return load(db, id);
}

export async function getRecurringInvoice(db: AppTenantDb, id: string) {
  if (!UUID.test(id)) throw new RecordNotFoundError();
  return oneDto(db, await load(db, id));
}

// ---- validation ----------------------------------------------------------------------------------

/** Validates lines like a draft would (tax rates of this business and active, amounts in the currency) and stores them normalised. */
async function normaliseLines(db: AppTenantDb, lines: LineInput[], currency: string, scale: number, alreadyUsed: Set<string>): Promise<StoredLine[]> {
  await priceLines(db, lines, currency, scale, alreadyUsed);
  return lines.map((l) => ({
    description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
    discountAmount: formatAmount(toAmount(l.discountAmount ?? '0', scale, currency, 'discount'), scale), taxRateId: l.taxRateId ?? null,
  }));
}

function checkZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new RuleViolationError('invalid_time_zone', 'Use an IANA time zone such as Australia/Perth.');
  }
}

/** The schedule's first date that is not yet planned, or null (and ENDED) when none is left. */
function nextOf(t: { startDate: string; frequency: RecurringFrequency; intervalCount: number; endDate: string | null }, index: number) {
  const date = billingPeriodDate(t.startDate, t.frequency, t.intervalCount, index);
  return t.endDate && date > t.endDate ? null : date;
}

// ---- create / update -----------------------------------------------------------------------------

export type RecurringInput = {
  name: string; customerId: string; contactId?: string | null; projectId?: string | null; currencyCode?: string; frequency: RecurringFrequency;
  intervalCount?: number; startDate: string; endDate?: string | null; timeZone?: string; paymentTermsDays?: number | null; notes?: string | null;
  lines: LineInput[];
};

export async function createRecurringInvoice(db: AppTenantDb, actorUserId: string, input: RecurringInput) {
  const business = await businessProfile(db);
  const currency = checkCurrency(input.currencyCode ?? business.currency);
  const scale = currencyScale(currency);
  const timeZone = input.timeZone ?? business.timeZone;
  checkZone(timeZone);
  const links = { customerId: input.customerId, contactId: input.contactId ?? null, opportunityId: null, projectId: input.projectId ?? null };
  await checkLinks(db, links, { customer: true, contact: true, opportunity: false, project: true });
  const lines = await normaliseLines(db, input.lines, currency, scale, new Set());
  const id = randomUUID();
  const schedule = { startDate: input.startDate, frequency: input.frequency, intervalCount: input.intervalCount ?? 1, endDate: input.endDate ?? null };
  const next = nextOf(schedule, 0)!; // start ≤ end is a contract rule, so period 0 always exists
  await db.financeRecurringTemplate.create({
    data: {
      id, name: input.name, customerId: input.customerId, contactId: links.contactId, projectId: links.projectId, currencyCode: currency,
      currencyScale: scale, frequency: input.frequency, intervalCount: schedule.intervalCount, startDate: dateOf(input.startDate),
      endDate: input.endDate ? dateOf(input.endDate) : null, timeZone, paymentTermsDays: input.paymentTermsDays ?? null, notes: input.notes ?? null,
      lines, nextPeriodIndex: 0, nextRunOn: dateOf(next), createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  await recordAudit(db, actorUserId, 'finance.recurring.created', { type: 'finance_recurring_template', id }, {
    customerId: input.customerId, currencyCode: currency, frequency: input.frequency, intervalCount: String(schedule.intervalCount),
    startDate: input.startDate, endDate: input.endDate ?? null, timeZone, lineCount: String(lines.length),
  });
  return oneDto(db, await load(db, id));
}

export type RecurringPatch = Partial<Omit<RecurringInput, 'lines'>> & { lines?: LineInput[]; version: number };

const SCHEDULE_FIELDS = ['customerId', 'currencyCode', 'frequency', 'intervalCount', 'startDate'] as const;

/**
 * Edits a schedule. Changes apply to periods generated afterwards; drafts already generated never
 * change. The schedule's identity (customer, currency, frequency, interval, start) is fixed once any
 * period exists (the database refuses it too, FN030). The end date may move, but not before a period
 * that already exists.
 */
export async function updateRecurringInvoice(db: AppTenantDb, actorUserId: string, id: string, patch: RecurringPatch) {
  const before = await lockAndLoad(db, id);
  if (before.status === 'CANCELLED' || before.status === 'ENDED') throw new StateConflictError('invalid_state');
  if (before.version !== patch.version) throw new StateConflictError('stale');
  const hasRuns = (await db.financeRecurringRun.count({ where: { templateId: id } })) > 0;
  const changesSchedule = SCHEDULE_FIELDS.some((f) => {
    if (patch[f] === undefined) return false;
    const was = f === 'startDate' ? day(before.startDate) : (before as unknown as Record<string, unknown>)[f];
    return patch[f] !== was;
  });
  if (hasRuns && changesSchedule) {
    throw new RuleViolationError('schedule_fixed', 'Customer, currency, frequency and start date are fixed once a period has been generated. Cancel this schedule and create a new one.');
  }
  const data: Record<string, unknown> = {};
  const fields: string[] = [];
  const set = (k: string, v: unknown) => { data[k] = v; fields.push(k); };
  const currency = patch.currencyCode !== undefined ? checkCurrency(patch.currencyCode) : before.currencyCode;
  const scale = currencyScale(currency);
  if (patch.name !== undefined && patch.name !== before.name) set('name', patch.name);
  if (patch.currencyCode !== undefined && currency !== before.currencyCode) { set('currencyCode', currency); set('currencyScale', scale); }
  if (patch.frequency !== undefined && patch.frequency !== before.frequency) set('frequency', patch.frequency);
  if (patch.intervalCount !== undefined && patch.intervalCount !== before.intervalCount) set('intervalCount', patch.intervalCount);
  if (patch.startDate !== undefined && patch.startDate !== day(before.startDate)) set('startDate', dateOf(patch.startDate));
  if (patch.endDate !== undefined && patch.endDate !== dayOf(before.endDate)) set('endDate', patch.endDate ? dateOf(patch.endDate) : null);
  if (patch.timeZone !== undefined && patch.timeZone !== before.timeZone) { checkZone(patch.timeZone); set('timeZone', patch.timeZone); }
  if (patch.paymentTermsDays !== undefined && patch.paymentTermsDays !== before.paymentTermsDays) set('paymentTermsDays', patch.paymentTermsDays);
  if (patch.notes !== undefined && patch.notes !== before.notes) set('notes', patch.notes);

  const next = {
    customerId: patch.customerId ?? before.customerId,
    contactId: patch.contactId !== undefined ? patch.contactId : before.contactId,
    opportunityId: null,
    projectId: patch.projectId !== undefined ? patch.projectId : before.projectId,
  };
  const changed = { customer: next.customerId !== before.customerId, contact: next.contactId !== before.contactId, opportunity: false, project: next.projectId !== before.projectId };
  await checkLinks(db, next, changed);
  if (changed.customer) set('customerId', next.customerId);
  if (changed.contact) set('contactId', next.contactId);
  if (changed.project) set('projectId', next.projectId);
  // Lines are validated as a new draft's would be: an archived tax rate cannot be (re)used, because
  // every later period would fail on it.
  if (patch.lines !== undefined) {
    set('lines', await normaliseLines(db, patch.lines, currency, scale, new Set()));
  } else if (data.currencyScale !== undefined) {
    // A new currency must fit the existing line amounts too.
    await normaliseLines(db, linesOf(before).map((l) => ({ ...l })), currency, scale, new Set());
  }
  if (fields.length === 0) return oneDto(db, before);

  // Re-derive the next run from the (possibly new) schedule. Without runs the schedule restarts at
  // period 0; with runs only the end date can change it.
  const schedule = {
    startDate: patch.startDate ?? day(before.startDate), frequency: (patch.frequency ?? before.frequency) as RecurringFrequency,
    intervalCount: patch.intervalCount ?? before.intervalCount, endDate: patch.endDate !== undefined ? patch.endDate : dayOf(before.endDate),
  };
  if (schedule.endDate && schedule.endDate < schedule.startDate) throw new RuleViolationError('invalid_dates', 'The end date is before the start date.');
  if (hasRuns && schedule.endDate) {
    const last = await db.financeRecurringRun.findFirst({ where: { templateId: id }, orderBy: { periodIndex: 'desc' }, select: { periodDate: true } });
    if (last && day(last.periodDate) > schedule.endDate) {
      throw new RuleViolationError('invalid_dates', 'The end date is before a period that has already been generated.');
    }
  }
  const nextRun = nextOf(schedule, before.nextPeriodIndex);
  if (nextRun === null && before.status === 'ACTIVE') {
    Object.assign(data, { status: 'ENDED', nextRunOn: null });
  } else if (nextRun === null) {
    throw new RuleViolationError('invalid_dates', 'Resume this schedule before ending it, or cancel it.');
  } else {
    data.nextRunOn = dateOf(nextRun);
  }
  const result = await db.financeRecurringTemplate.updateMany({
    where: { id, version: patch.version }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.recurring.updated', { type: 'finance_recurring_template', id }, { fields: [...new Set(fields)].sort() });
  return oneDto(db, await load(db, id));
}

// ---- transitions ---------------------------------------------------------------------------------

export async function pauseRecurringInvoice(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await lockAndLoad(db, id);
  if (before.status !== 'ACTIVE') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  await db.financeRecurringTemplate.updateMany({ where: { id, version: input.version }, data: { status: 'PAUSED', version: { increment: 1 }, updatedById: actorUserId } as never });
  await recordAudit(db, actorUserId, 'finance.recurring.paused', { type: 'finance_recurring_template', id }, {});
  return oneDto(db, await load(db, id));
}

/**
 * Resumes a paused schedule from the first period on or after today (in the schedule's zone):
 * periods that fell inside the pause are not billed (D-F6-12). Periods already planned before the
 * pause (PENDING runs) are processed as usual.
 */
export async function resumeRecurringInvoice(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await lockAndLoad(db, id);
  if (before.status !== 'PAUSED') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const schedule = { startDate: day(before.startDate), frequency: before.frequency as RecurringFrequency, intervalCount: before.intervalCount, endDate: dayOf(before.endDate) };
  const today = todayIn(before.timeZone);
  const index = firstPeriodOnOrAfter(schedule.startDate, schedule.frequency, schedule.intervalCount, today, before.nextPeriodIndex);
  const nextRun = nextOf(schedule, index);
  // A schedule whose remaining periods all fell inside the pause resumes straight into ENDED.
  await db.financeRecurringTemplate.updateMany({ where: { id, version: input.version }, data: { status: 'ACTIVE', version: { increment: 1 }, updatedById: actorUserId } as never });
  await db.financeRecurringTemplate.updateMany({
    where: { id }, data: (nextRun === null ? { status: 'ENDED', nextPeriodIndex: index, nextRunOn: null } : { nextPeriodIndex: index, nextRunOn: dateOf(nextRun) }) as never,
  });
  await recordAudit(db, actorUserId, 'finance.recurring.resumed', { type: 'finance_recurring_template', id }, {
    skippedPeriods: String(index - before.nextPeriodIndex), nextRunOn: nextRun,
  });
  return oneDto(db, await load(db, id));
}

/** Cancels a schedule for good. Periods planned but not yet generated are skipped in the same transaction. */
export async function cancelRecurringInvoice(db: AppTenantDb, actorUserId: string, id: string, input: { version: number; reason?: string | null }) {
  const before = await lockAndLoad(db, id);
  if (before.status !== 'ACTIVE' && before.status !== 'PAUSED') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  // A run a worker is generating right now holds a row lock on its run; FOR UPDATE waits for it, so a
  // period being generated at the moment of cancelling either finishes first or is skipped here.
  await db.$queryRaw`
    SELECT 1 FROM finance_recurring_runs WHERE template_id = ${id}::uuid
      AND business_id = nullif(current_setting('app.business_id', true), '')::uuid AND status IN ('PENDING', 'RUNNING', 'FAILED') FOR UPDATE`;
  const skipped = await db.financeRecurringRun.updateMany({
    where: { templateId: id, status: { in: ['PENDING', 'RUNNING', 'FAILED'] } },
    data: { status: 'SKIPPED', errorCode: 'template_cancelled', leaseId: null, leaseExpiresAt: null, finishedAt: new Date() } as never,
  });
  await db.financeRecurringTemplate.updateMany({
    where: { id, version: input.version },
    data: { status: 'CANCELLED', nextRunOn: null, cancelledById: actorUserId, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  await recordAudit(db, actorUserId, 'finance.recurring.cancelled', { type: 'finance_recurring_template', id }, {
    hasReason: input.reason ? 'true' : 'false', skippedRuns: String(skipped.count),
  });
  return oneDto(db, await load(db, id));
}

// ---- list ----------------------------------------------------------------------------------------

export async function listRecurringInvoices(db: AppTenantDb, query: { status: string; customerId?: string; cursor?: string; limit: number }) {
  const where: Record<string, unknown>[] = [];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  if (query.customerId) where.push({ customerId: query.customerId });
  const list = 'finance:recurring';
  const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
  }
  const rows = (await db.financeRecurringTemplate.findMany({
    where: { AND: where }, select: templateSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as TemplateRow[];
  const page = rows.slice(0, query.limit);
  const c = await counts(db, page.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    recurringInvoices: page.map((r) => templateDto(r, c.get(r.id))),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, { t: last.createdAt.toISOString(), i: last.id }) : null,
  };
}

/** A template's runs, newest period first (keyset on period_index). */
export async function listRecurringRuns(db: AppTenantDb, templateId: string, query: { status: string; cursor?: string; limit: number }) {
  await getRecurringInvoice(db, templateId);
  const where: Record<string, unknown>[] = [{ templateId }];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  const list = `finance:recurring-runs:${templateId}`;
  const after = decodeCursor(query.cursor, list, ['p'] as const);
  if (after) {
    const p = Number(after.p);
    if (!Number.isInteger(p) || p < 0) invalidCursor();
    where.push({ periodIndex: { lt: p } });
  }
  const rows = (await db.financeRecurringRun.findMany({
    where: { AND: where }, select: runSelect, orderBy: [{ periodIndex: 'desc' }], take: query.limit + 1,
  })) as RunRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { runs: await runDtos(db, page), nextCursor: rows.length > query.limit && last ? encodeCursor(list, { p: String(last.periodIndex) }) : null };
}

async function loadRun(db: AppTenantDb, templateId: string, runId: string): Promise<RunRow> {
  if (!UUID.test(runId)) throw new RecordNotFoundError();
  const run = (await db.financeRecurringRun.findFirst({ where: { id: runId, templateId }, select: runSelect })) as RunRow | null;
  if (!run) throw new RecordNotFoundError();
  return run;
}

// ---- preview -------------------------------------------------------------------------------------

async function dueDateFor(db: AppTenantDb, t: { paymentTermsDays: number | null }, periodDate: string): Promise<string | null> {
  const terms = t.paymentTermsDays ?? (await loadSettings(db)).defaultPaymentTermsDays ?? null;
  return terms === null ? null : addDays(periodDate, terms);
}

/**
 * The next `count` periods with their dates and due dates, and the amount each draft would have if it
 * were generated now (today's tax rates). Writes nothing.
 */
export async function previewRecurringInvoice(db: AppTenantDb, id: string, count: number) {
  const t = await getRecurringInvoice(db, id);
  const live = t.status === 'ACTIVE' || t.status === 'PAUSED';
  const periods = live ? upcomingPeriodDates(t, t.nextPeriodIndex, count) : [];
  const terms = t.paymentTermsDays ?? (await loadSettings(db)).defaultPaymentTermsDays ?? null;
  let problem: string | null = null;
  let totals = { subtotal: '', taxTotal: '', total: '' };
  try {
    await checkLinks(db, { customerId: t.customerId, contactId: t.contactId, opportunityId: null, projectId: t.projectId }, { customer: true, contact: true, opportunity: false, project: true });
    const priced = await priceLines(db, t.lines, t.currencyCode, t.currencyScale, new Set());
    const sum = totalsOf(priced);
    totals = { subtotal: formatAmount(sum.subtotal, t.currencyScale), taxTotal: formatAmount(sum.taxTotal, t.currencyScale), total: formatAmount(sum.total, t.currencyScale) };
  } catch (error) {
    problem = codeOf(error);
  }
  if (problem) {
    const zero = formatAmount(new Decimal(0), t.currencyScale);
    totals = { subtotal: zero, taxTotal: zero, total: zero };
  }
  return {
    currencyCode: t.currencyCode, ...totals, problem,
    periods: periods.map((p) => ({ periodIndex: p.index, periodDate: p.date, dueDate: terms === null ? null : addDays(p.date, terms) })),
  };
}

// ---- generation ----------------------------------------------------------------------------------

/** A stable error code for a failed run, never error text (CHECK on error_code). */
export function codeOf(error: unknown): string {
  if (error instanceof RuleViolationError || error instanceof StateConflictError) return error.code;
  if (error instanceof RecordNotFoundError) return 'not_found';
  return 'internal_error';
}

/** Rule and state errors need a person (fix the template, then retry); anything else may be transient. */
function needsPerson(error: unknown) {
  return error instanceof RuleViolationError || error instanceof StateConflictError || error instanceof RecordNotFoundError;
}

/** The idempotency key of a period's draft. Contains a space, which client Idempotency-Keys cannot. */
const draftKey = (templateId: string, periodIndex: number) => `system recurring ${templateId}:${periodIndex}`;

/** Creates the draft for one period of a template, as `author`, through the ordinary invoice service. */
async function createPeriodDraft(db: AppTenantDb, t: TemplateRow, periodIndex: number, periodDate: string, author: string | null) {
  const dueDate = await dueDateFor(db, t, periodDate);
  const input = {
    customerId: t.customerId, contactId: t.contactId, projectId: t.projectId, currencyCode: t.currencyCode, dueDate,
    notes: t.notes, lines: linesOf(t).map((l) => ({ ...l })),
  };
  const who = author ?? { system: 'recurring' as const, templateId: t.id, periodIndex };
  const created = await createInvoice(db, who, input, draftKey(t.id, periodIndex));
  return created.document.id;
}

/**
 * Plans every due period of this business's active schedules: inserts a PENDING run per period
 * (oldest first, at most MAX_PERIODS_PER_PASS per template) and moves each template's next run. A
 * schedule whose next period falls after its end date ends. Runs as the worker (no session user).
 * Templates another worker is planning are skipped (SKIP LOCKED); planning the same period twice is a
 * no-op (UNIQUE (template, period) with ON CONFLICT DO NOTHING).
 */
export async function planDueRuns(db: AppTenantDb): Promise<{ planned: number; ended: number }> {
  const due = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM finance_recurring_templates
    WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid AND status = 'ACTIVE'
      AND next_run_on <= (now() AT TIME ZONE time_zone)::date
    ORDER BY next_run_on, id FOR NO KEY UPDATE SKIP LOCKED`;
  let planned = 0;
  let ended = 0;
  for (const { id } of due) {
    const t = await load(db, id);
    const schedule = { startDate: day(t.startDate), frequency: t.frequency as RecurringFrequency, intervalCount: t.intervalCount, endDate: dayOf(t.endDate) };
    const today = todayIn(t.timeZone);
    let index = t.nextPeriodIndex;
    for (let n = 0; n < MAX_PERIODS_PER_PASS; n++, index++) {
      const date = nextOf(schedule, index);
      if (date === null || date > today) break;
      const inserted = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO finance_recurring_runs (id, business_id, template_id, period_index, period_date)
        VALUES (${randomUUID()}::uuid, nullif(current_setting('app.business_id', true), '')::uuid, ${id}::uuid, ${index}::int, ${date}::date)
        ON CONFLICT (business_id, template_id, period_index) DO NOTHING RETURNING id::text`;
      planned += inserted.length;
    }
    const nextRun = nextOf(schedule, index);
    await db.financeRecurringTemplate.updateMany({
      where: { id, status: 'ACTIVE' },
      data: (nextRun === null ? { nextPeriodIndex: index, nextRunOn: null, status: 'ENDED' } : { nextPeriodIndex: index, nextRunOn: dateOf(nextRun) }) as never,
    });
    if (nextRun === null) {
      ended++;
      await recordSystemAudit(db, 'finance.system.recurring.ended', { type: 'finance_recurring_template', id }, { lastPeriodIndex: String(index - 1) });
    }
  }
  return { planned, ended };
}

export interface ClaimedRun { runId: string; leaseId: string }

/**
 * Claims the oldest due run of this business: PENDING and due, or RUNNING with an expired lease, of a
 * template that is ACTIVE or ENDED (never PAUSED or CANCELLED). FOR UPDATE SKIP LOCKED, so concurrent
 * workers get different runs. A run whose lease expired with no attempts left fails instead.
 */
export async function claimRecurringRun(db: AppTenantDb, opts: { leaseSeconds?: number } = {}): Promise<ClaimedRun | null> {
  const leaseSeconds = Math.min(Math.max(opts.leaseSeconds ?? 120, 10), 900);
  await db.$queryRaw`
    UPDATE finance_recurring_runs SET status = 'FAILED', lease_id = NULL, lease_expires_at = NULL, finished_at = now(), error_code = 'lease_expired'
    WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid
      AND status = 'RUNNING' AND lease_expires_at < now() AND attempts >= max_attempts
    RETURNING id`;
  const leaseId = randomUUID();
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE finance_recurring_runs r SET status = 'RUNNING', lease_id = ${leaseId}::uuid,
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int), attempts = r.attempts + 1,
      started_at = coalesce(r.started_at, now()), error_code = NULL
    WHERE (r.business_id, r.id) = (
      SELECT d.business_id, d.id FROM finance_recurring_runs d
      JOIN finance_recurring_templates t ON t.business_id = d.business_id AND t.id = d.template_id AND t.status IN ('ACTIVE', 'ENDED')
      WHERE d.business_id = nullif(current_setting('app.business_id', true), '')::uuid
        AND ((d.status = 'PENDING' AND d.run_after <= now()) OR (d.status = 'RUNNING' AND d.lease_expires_at < now()))
        AND d.attempts < d.max_attempts
      ORDER BY d.run_after, d.template_id, d.period_index LIMIT 1 FOR UPDATE OF d SKIP LOCKED)
    RETURNING r.id::text`;
  const hit = claimed[0];
  return hit ? { runId: hit.id, leaseId } : null;
}

/** Locks the run if, and only if, the caller still holds an unexpired lease on it (database time). */
async function holdLease(db: AppTenantDb, c: ClaimedRun): Promise<RunRow | null> {
  const held = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM finance_recurring_runs
    WHERE id = ${c.runId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
      AND status = 'RUNNING' AND lease_id = ${c.leaseId}::uuid AND lease_expires_at > now()
    FOR UPDATE`;
  if (held.length === 0) return null;
  return (await db.financeRecurringRun.findFirst({ where: { id: c.runId }, select: runSelect })) as RunRow;
}

export type RunOutcome = 'generated' | 'lease_lost' | 'skipped';

/**
 * Generates the claimed run's draft and marks it GENERATED, in this one transaction. If the lease was
 * lost (expired, reclaimed, or the schedule was cancelled meanwhile) nothing is written. Any error
 * rolls the whole transaction back, so no draft exists without its GENERATED run; the caller then
 * records the failure with failRecurringRun in a new transaction.
 */
export async function executeRecurringRun(db: AppTenantDb, c: ClaimedRun): Promise<RunOutcome> {
  const run = await holdLease(db, c);
  if (!run) return 'lease_lost';
  const t = await load(db, run.templateId);
  if (t.status !== 'ACTIVE' && t.status !== 'ENDED') {
    await db.financeRecurringRun.updateMany({
      where: { id: run.id, leaseId: c.leaseId }, data: { status: 'SKIPPED', errorCode: 'template_not_active', leaseId: null, leaseExpiresAt: null, finishedAt: new Date() } as never,
    });
    return 'skipped';
  }
  const documentId = await createPeriodDraft(db, t, run.periodIndex, day(run.periodDate), null);
  await db.financeRecurringRun.updateMany({
    where: { id: run.id, leaseId: c.leaseId },
    data: { status: 'GENERATED', documentId, leaseId: null, leaseExpiresAt: null, finishedAt: new Date(), errorCode: null } as never,
  });
  await recordSystemAudit(db, 'finance.system.recurring.generated', { type: 'finance_recurring_run', id: run.id }, {
    recurringTemplateId: t.id, periodIndex: String(run.periodIndex), periodDate: day(run.periodDate), documentId,
  });
  return 'generated';
}

/** Backoff for retry n (1-based): 1 min × 4^(n-1), capped at 6 h. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000 * 4 ** Math.max(attempt - 1, 0), 6 * 3_600_000);
}

/**
 * Records a failed attempt, only while the caller holds the lease. A rule or state error (archived
 * customer or tax rate, invalid lines) fails the run at once: it needs a person to fix the template and
 * retry. Anything else is retried with backoff until max_attempts, then fails.
 */
export async function failRecurringRun(db: AppTenantDb, c: ClaimedRun, error: unknown): Promise<'failed' | 'retrying' | 'lease_lost'> {
  const run = await holdLease(db, c);
  if (!run) return 'lease_lost';
  const code = codeOf(error);
  const final = needsPerson(error) || run.attempts >= run.maxAttempts;
  await db.financeRecurringRun.updateMany({
    where: { id: run.id, leaseId: c.leaseId },
    data: (final
      ? { status: 'FAILED', errorCode: code, leaseId: null, leaseExpiresAt: null, finishedAt: new Date() }
      : { status: 'PENDING', errorCode: code, leaseId: null, leaseExpiresAt: null, runAfter: new Date(Date.now() + retryDelayMs(run.attempts)) }) as never,
  });
  await recordSystemAudit(db, final ? 'finance.system.recurring.failed' : 'finance.system.recurring.retrying', { type: 'finance_recurring_run', id: run.id }, {
    recurringTemplateId: run.templateId, periodIndex: String(run.periodIndex), errorCode: code, attempts: String(run.attempts),
  });
  return final ? 'failed' : 'retrying';
}

// ---- people acting on runs -------------------------------------------------------------------------

/**
 * "Generate now": plans the next period immediately (ahead of its date if need be) and generates its
 * draft as the signed-in member, in this one transaction. On any error nothing is planned or created
 * and the error is returned to the person. The schedule then continues with the following period.
 */
export async function generateNextPeriod(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const t = await lockAndLoad(db, id);
  if (t.status !== 'ACTIVE' && t.status !== 'PAUSED') throw new StateConflictError('invalid_state');
  if (t.version !== input.version) throw new StateConflictError('stale');
  const schedule = { startDate: day(t.startDate), frequency: t.frequency as RecurringFrequency, intervalCount: t.intervalCount, endDate: dayOf(t.endDate) };
  const index = t.nextPeriodIndex;
  const date = nextOf(schedule, index);
  if (date === null) throw new StateConflictError('invalid_state');
  const runId = randomUUID();
  const leaseId = randomUUID();
  await db.$queryRaw`
    INSERT INTO finance_recurring_runs (id, business_id, template_id, period_index, period_date, trigger, requested_by_id)
    VALUES (${runId}::uuid, nullif(current_setting('app.business_id', true), '')::uuid, ${id}::uuid, ${index}::int, ${date}::date, 'MANUAL',
            nullif(current_setting('app.user_id', true), '')::uuid)
    RETURNING id`;
  await db.financeRecurringRun.updateMany({
    where: { id: runId }, data: { status: 'RUNNING', attempts: 1, leaseId, leaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date() } as never,
  });
  const documentId = await createPeriodDraft(db, t, index, date, actorUserId);
  await db.financeRecurringRun.updateMany({
    where: { id: runId, leaseId }, data: { status: 'GENERATED', documentId, leaseId: null, leaseExpiresAt: null, finishedAt: new Date() } as never,
  });
  const nextRun = nextOf(schedule, index + 1);
  if (nextRun !== null) {
    await db.financeRecurringTemplate.updateMany({ where: { id }, data: { nextPeriodIndex: index + 1, nextRunOn: dateOf(nextRun), version: { increment: 1 }, updatedById: actorUserId } as never });
  } else {
    // That was the last period: the schedule ends (a paused one is resumed first, PAUSED → ENDED is not a transition).
    if (t.status === 'PAUSED') await db.financeRecurringTemplate.updateMany({ where: { id }, data: { status: 'ACTIVE' } as never });
    await db.financeRecurringTemplate.updateMany({ where: { id }, data: { nextPeriodIndex: index + 1, nextRunOn: null, status: 'ENDED', version: { increment: 1 }, updatedById: actorUserId } as never });
  }
  await recordAudit(db, actorUserId, 'finance.recurring.generated', { type: 'finance_recurring_run', id: runId }, {
    recurringTemplateId: id, periodIndex: String(index), periodDate: date, documentId, trigger: 'MANUAL',
  });
  const run = await loadRun(db, id, runId);
  return { run: (await runDtos(db, [run]))[0]!, recurringInvoice: await oneDto(db, await load(db, id)) };
}

/** Puts a FAILED run back in the queue (at least three more attempts), after the person fixed its cause. */
export async function retryRecurringRun(db: AppTenantDb, actorUserId: string, templateId: string, runId: string) {
  await lockAndLoad(db, templateId);
  const run = await loadRun(db, templateId, runId);
  if (run.status !== 'FAILED') throw new StateConflictError('invalid_state');
  await db.financeRecurringRun.updateMany({
    where: { id: runId, status: 'FAILED' },
    data: { status: 'PENDING', runAfter: new Date(), finishedAt: null, maxAttempts: Math.min(Math.max(run.maxAttempts, run.attempts + 3), 50) } as never,
  });
  await recordAudit(db, actorUserId, 'finance.recurring.run_retried', { type: 'finance_recurring_run', id: runId }, {
    recurringTemplateId: templateId, periodIndex: String(run.periodIndex), previousErrorCode: run.errorCode,
  });
  return (await runDtos(db, [await loadRun(db, templateId, runId)]))[0]!;
}

/** Decides not to bill a pending or failed period. Final. */
export async function skipRecurringRun(db: AppTenantDb, actorUserId: string, templateId: string, runId: string) {
  await lockAndLoad(db, templateId);
  await db.$queryRaw`SELECT 1 FROM finance_recurring_runs WHERE id = ${runId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
  const run = await loadRun(db, templateId, runId);
  if (run.status !== 'PENDING' && run.status !== 'FAILED') throw new StateConflictError('invalid_state');
  await db.financeRecurringRun.updateMany({
    where: { id: runId, status: run.status }, data: { status: 'SKIPPED', errorCode: run.errorCode ?? 'skipped_by_user', finishedAt: new Date() } as never,
  });
  await recordAudit(db, actorUserId, 'finance.recurring.run_skipped', { type: 'finance_recurring_run', id: runId }, {
    recurringTemplateId: templateId, periodIndex: String(run.periodIndex),
  });
  return (await runDtos(db, [await loadRun(db, templateId, runId)]))[0]!;
}
