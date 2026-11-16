import 'server-only';
// Payment reminders (Finance F6-3, docs/finance-billing-f6.md §10). A policy lists stages (days relative
// to an invoice's due date); a customer uses the business's default policy or one assigned to it; holds
// suppress reminders for a customer or one invoice. The worker plans the stage that is due today for each
// open invoice, then checks each planned reminder again with the invoice row locked (still issued, still
// unpaid, no hold, same policy and stage) immediately before handing it to C2-C's outbox. Without an
// outbox (until C2-C) an eligible reminder stops at READY. Nothing here sends mail.
//
// Financial correctness: the outstanding amount is the F2 formula on the locked invoice row
// (total − allocated − credit applied, DB-maintained counters, exact decimals), the same as the
// settlement projection, receivables and ageing as of today. Nothing new is stored as a balance.
//
// Concurrency and idempotency, in four layers:
//   1. UNIQUE (invoice, offset): a stage is planned at most once, whatever retries or workers do
//      (INSERT … ON CONFLICT DO NOTHING). A skipped stage is never planned again.
//   2. A worker claims a reminder with a lease (FOR UPDATE SKIP LOCKED); every later step requires the
//      lease to be held and unexpired on database time, so a worker whose lease expired changes nothing.
//   3. The pre-dispatch check locks the invoice row (FOR NO KEY UPDATE, the F1–F3 document lock), so a
//      payment, credit application or void either commits before the check (and is seen) or waits for it.
//      Placing a hold takes the customer's reminder lock exclusively, and policy or assignment changes take
//      the business's configuration lock exclusively; the check takes both shared, so either is seen or waits.
//   4. Hand-over to the outbox and the move to QUEUED commit in one transaction, with an idempotency key
//      only the system can produce (it contains a space).
import { randomUUID } from 'node:crypto';
import {
  daysPastDue, reminderStageDate, reminderStageState, dueReminderStage, type Reminder as ReminderDto, type ReminderHold as HoldDto,
  type ReminderPolicy as PolicyDto, type ReminderReason, type ReminderStage,
} from '@business-os/contracts';
import { recordAudit, recordSystemAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { formatAmount } from './money';
import type { BeforeSendResult, ReminderDispatchRequest, ReminderOutbox, ReminderOutboundState, ReminderRecipient } from './reminder-outbox';
import { businessProfile, dateOf, dayOf, lockDocuments, todayIn } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null) => d?.toISOString() ?? null;
const day = (d: Date) => dayOf(d)!;
const checkId = (id: string) => {
  if (!UUID.test(id)) throw new RecordNotFoundError();
};

/** Invoices considered per planning call (one short transaction each); the worker calls again with the cursor. */
export const INVOICES_PER_PLAN_BATCH = 500;
/** A READY reminder (no outbox yet, or the outbox refused it) is checked again this long after its last check. */
const READY_RECHECK_MS = 3_600_000;
const REFUSED_RECHECK_MS = 6 * 3_600_000;

// ---- locks ---------------------------------------------------------------------------------------
//
// One lock order for every path that touches reminders, so no two transactions can wait on each other
// in a cycle (a deadlock would abort one of them, possibly a person's hold or policy change):
//
//   1. the configuration lock (advisory; policy and assignment changes exclusive, checks shared)
//   2. the customer's reminder lock (advisory; holds exclusive, checks shared)
//   3. invoice rows (lockDocuments, FOR NO KEY UPDATE; same order as payments and credits)
//   4. reminder rows (FOR UPDATE, or the row locks an UPDATE takes)
//
// A path may skip a level but never takes an earlier level after a later one. The worker and the
// pre-send check therefore read a reminder's customer and invoice WITHOUT locking it (both columns are
// immutable: bos_app has no UPDATE on them), take levels 1 to 3, and only then lock the reminder row and
// re-check its lease or state. Claiming (SKIP LOCKED) and recording a failure run in their own
// transactions and take level 4 alone.

/**
 * The business's reminder configuration lock. Policy and assignment changes take it exclusively (default
 * flag, archive vs assign); a pre-dispatch check takes it shared, so a check never hands over a stage
 * that a policy change committed while it ran had removed.
 */
async function lockReminderConfig(db: AppTenantDb, mode: 'shared' | 'exclusive' = 'exclusive') {
  if (mode === 'shared') {
    await db.$queryRaw`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock_shared(hashtextextended(
        'finance.reminders.config:' || current_setting('app.business_id', true), 0))) AS l`;
  } else {
    await db.$queryRaw`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(
        'finance.reminders.config:' || current_setting('app.business_id', true), 0))) AS l`;
  }
}

/**
 * The customer's reminder lock. Placing a hold takes it exclusively; a pre-dispatch check takes it
 * shared, so a check never misses a hold committed while it runs.
 */
async function lockCustomerReminders(db: AppTenantDb, customerId: string, mode: 'shared' | 'exclusive') {
  if (mode === 'shared') {
    await db.$queryRaw`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock_shared(hashtextextended(
        'finance.reminders.customer:' || current_setting('app.business_id', true) || ':' || ${customerId}::text, 0))) AS l`;
  } else {
    await db.$queryRaw`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(
        'finance.reminders.customer:' || current_setting('app.business_id', true) || ':' || ${customerId}::text, 0))) AS l`;
  }
}

// ---- policies ------------------------------------------------------------------------------------

type PolicyRow = {
  id: string; name: string; status: string; isDefault: boolean; stages: unknown; version: number; archivedAt: Date | null;
  createdById: string | null; updatedById: string | null; createdAt: Date; updatedAt: Date;
};
const policySelect = {
  id: true, name: true, status: true, isDefault: true, stages: true, version: true, archivedAt: true, createdById: true, updatedById: true,
  createdAt: true, updatedAt: true,
} as const;
const stagesOf = (p: { stages: unknown }) => p.stages as ReminderStage[];

async function assignmentCounts(db: AppTenantDb, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await db.financeReminderCustomerPolicy.groupBy({ by: ['policyId'], where: { policyId: { in: ids } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.policyId!, r._count._all]));
}

const policyDto = (p: PolicyRow, assigned: number): PolicyDto => ({
  id: p.id, name: p.name, status: p.status as PolicyDto['status'], isDefault: p.isDefault, stages: stagesOf(p), assignedCustomers: assigned,
  version: p.version, archivedAt: iso(p.archivedAt), createdById: p.createdById, updatedById: p.updatedById, createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

async function loadPolicy(db: AppTenantDb, id: string): Promise<PolicyRow> {
  checkId(id);
  const row = (await db.financeReminderPolicy.findFirst({ where: { id }, select: policySelect })) as PolicyRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}
async function policyOut(db: AppTenantDb, id: string) {
  const p = await loadPolicy(db, id);
  return policyDto(p, (await assignmentCounts(db, [id])).get(id) ?? 0);
}

export async function listReminderPolicies(db: AppTenantDb, query: { status: 'active' | 'archived' | 'all' }) {
  const rows = (await db.financeReminderPolicy.findMany({
    where: query.status === 'all' ? {} : { status: query.status.toUpperCase() }, select: policySelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200,
  })) as PolicyRow[];
  const counts = await assignmentCounts(db, rows.map((r) => r.id));
  return { policies: rows.map((r) => policyDto(r, counts.get(r.id) ?? 0)) };
}

export async function getReminderPolicy(db: AppTenantDb, id: string) {
  return policyOut(db, id);
}

/** Normalised stages (trimmed labels, integers), refusing what the contracts refuse, as a second line. */
function normaliseStages(stages: ReminderStage[]): ReminderStage[] {
  const out = stages.map((s) => ({ offsetDays: s.offsetDays, label: s.label.trim() }));
  if (out.length < 1 || out.length > 8 || out.some((s, i) => !Number.isInteger(s.offsetDays) || (i > 0 && s.offsetDays <= out[i - 1]!.offsetDays))) {
    throw new RuleViolationError('invalid_stages', 'Stages must be in order, each later than the one before, at most 8.');
  }
  return out;
}

async function clearDefault(db: AppTenantDb, exceptId: string) {
  await db.financeReminderPolicy.updateMany({ where: { isDefault: true, id: { not: exceptId } }, data: { isDefault: false, version: { increment: 1 } } as never });
}

/** Ends open reminders that a configuration change made inapplicable (PENDING and READY only; a running check sees it itself). */
async function skipOpen(db: AppTenantDb, where: Record<string, unknown>, reason: ReminderReason): Promise<number> {
  const result = await db.financeReminder.updateMany({
    where: { ...where, status: { in: ['PENDING', 'READY'] } }, data: { status: 'SKIPPED', outcomeCode: reason } as never,
  });
  return result.count;
}

export async function createReminderPolicy(db: AppTenantDb, actorUserId: string, input: { name: string; stages: ReminderStage[]; isDefault?: boolean }) {
  await lockReminderConfig(db);
  const id = randomUUID();
  const stages = normaliseStages(input.stages);
  if (input.isDefault) await clearDefault(db, id);
  await db.financeReminderPolicy.create({
    data: { id, name: input.name, stages, isDefault: input.isDefault ?? false, createdById: actorUserId, updatedById: actorUserId } as never,
  });
  await recordAudit(db, actorUserId, 'finance.reminder_policy.created', { type: 'finance_reminder_policy', id }, {
    stageOffsets: stages.map((s) => String(s.offsetDays)), isDefault: input.isDefault ? 'true' : 'false',
  });
  return policyOut(db, id);
}

/**
 * Edits a policy. A new stage list applies to stages not yet reached: open reminders (PENDING, READY)
 * for an offset that is no longer in the list are skipped (`stage_removed`); reminders already handed
 * over never change.
 */
export async function updateReminderPolicy(
  db: AppTenantDb, actorUserId: string, id: string, patch: { version: number; name?: string; stages?: ReminderStage[]; isDefault?: boolean },
) {
  await lockReminderConfig(db);
  const before = await loadPolicy(db, id);
  if (before.status !== 'ACTIVE') throw new StateConflictError('archived');
  if (before.version !== patch.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  const fields: string[] = [];
  if (patch.name !== undefined && patch.name !== before.name) { data.name = patch.name; fields.push('name'); }
  let removed: number[] = [];
  if (patch.stages !== undefined) {
    const stages = normaliseStages(patch.stages);
    if (JSON.stringify(stages) !== JSON.stringify(stagesOf(before))) {
      data.stages = stages;
      fields.push('stages');
      const keep = new Set(stages.map((s) => s.offsetDays));
      removed = stagesOf(before).map((s) => s.offsetDays).filter((o) => !keep.has(o));
    }
  }
  if (patch.isDefault !== undefined && patch.isDefault !== before.isDefault) {
    if (patch.isDefault) await clearDefault(db, id);
    data.isDefault = patch.isDefault;
    fields.push('isDefault');
  }
  if (fields.length === 0) return policyOut(db, id);
  const result = await db.financeReminderPolicy.updateMany({ where: { id, version: patch.version }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('stale');
  const skipped = removed.length ? await skipOpen(db, { policyId: id, offsetDays: { in: removed } }, 'stage_removed') : 0;
  // A business that loses its default: open reminders of customers on the default no longer apply.
  const lostDefault = patch.isDefault === false && before.isDefault ? await skipOpenOfDefaultCustomers(db, id) : 0;
  await recordAudit(db, actorUserId, 'finance.reminder_policy.updated', { type: 'finance_reminder_policy', id }, {
    fields: fields.sort(), skippedReminders: String(skipped + lostDefault),
  });
  return policyOut(db, id);
}

/** Open reminders made under policy `id` for customers with no assignment of their own (they were on the default). */
async function skipOpenOfDefaultCustomers(db: AppTenantDb, id: string) {
  const assigned = await db.financeReminderCustomerPolicy.findMany({ where: { policyId: id }, select: { customerId: true } });
  return skipOpen(db, { policyId: id, customerId: { notIn: assigned.map((a) => a.customerId) } }, 'policy_changed');
}

/** Archives a policy (final). Refused while customers are assigned to it; their reminders would otherwise change silently. */
export async function archiveReminderPolicy(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  await lockReminderConfig(db);
  const before = await loadPolicy(db, id);
  if (before.status !== 'ACTIVE') throw new StateConflictError('archived');
  if (before.version !== input.version) throw new StateConflictError('stale');
  if ((await db.financeReminderCustomerPolicy.count({ where: { policyId: id } })) > 0) throw new StateConflictError('in_use');
  await db.financeReminderPolicy.updateMany({
    where: { id, version: input.version }, data: { status: 'ARCHIVED', isDefault: false, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  const skipped = await skipOpen(db, { policyId: id }, 'policy_changed');
  await recordAudit(db, actorUserId, 'finance.reminder_policy.archived', { type: 'finance_reminder_policy', id }, {
    wasDefault: before.isDefault ? 'true' : 'false', skippedReminders: String(skipped),
  });
  return policyOut(db, id);
}

// ---- holds ---------------------------------------------------------------------------------------

type HoldRow = {
  id: string; scope: string; customerId: string; invoiceId: string | null; reason: string; note: string | null; untilDate: Date | null;
  releasedAt: Date | null; releasedById: string | null; createdById: string; createdAt: Date;
};
const holdSelect = {
  id: true, scope: true, customerId: true, invoiceId: true, reason: true, note: true, untilDate: true, releasedAt: true, releasedById: true,
  createdById: true, createdAt: true,
} as const;

const inEffect = (h: { releasedAt: Date | null; untilDate: Date | null }, today: string) => h.releasedAt === null && (h.untilDate === null || day(h.untilDate) >= today);

async function holdDtos(db: AppTenantDb, rows: HoldRow[], today: string): Promise<HoldDto[]> {
  const ids = rows.map((r) => r.invoiceId).filter((v): v is string => !!v);
  const docs = ids.length ? await db.financeDocument.findMany({ where: { id: { in: ids } }, select: { id: true, number: true } }) : [];
  const numbers = new Map(docs.map((d) => [d.id, d.number]));
  return rows.map((h) => ({
    id: h.id, scope: h.scope as HoldDto['scope'], customerId: h.customerId, invoiceId: h.invoiceId, invoiceNumber: h.invoiceId ? (numbers.get(h.invoiceId) ?? null) : null,
    reason: h.reason as HoldDto['reason'], note: h.note, untilDate: dayOf(h.untilDate), inEffect: inEffect(h, today), releasedAt: iso(h.releasedAt),
    releasedById: h.releasedById, createdById: h.createdById, createdAt: h.createdAt.toISOString(),
  }));
}

async function businessToday(db: AppTenantDb) {
  return todayIn((await businessProfile(db)).timeZone);
}

/**
 * Places a hold on a customer (every invoice) or one issued invoice. Open reminders in its scope are
 * skipped at once (`on_hold`); stages that come due while it is in effect are skipped too, never sent
 * after it ends (as a paused recurring schedule, D-F6-12).
 */
export async function createReminderHold(
  db: AppTenantDb, actorUserId: string,
  input: { customerId: string; invoiceId?: string | null; reason: string; note?: string | null; untilDate?: string | null },
) {
  const today = await businessToday(db);
  const customer = await db.customer.findFirst({ where: { id: input.customerId }, select: { id: true } });
  if (!customer) throw new RecordNotFoundError();
  if (input.untilDate && input.untilDate < today) throw new RuleViolationError('invalid_dates', 'The hold ends before today.');
  await lockCustomerReminders(db, input.customerId, 'exclusive');
  if (input.invoiceId) {
    const [locked] = await lockDocuments(db, [input.invoiceId]);
    const inv = locked ? await db.financeDocument.findFirst({ where: { id: input.invoiceId, kind: 'INVOICE' }, select: { customerId: true, status: true } }) : null;
    if (!inv || inv.customerId !== input.customerId) throw new RecordNotFoundError();
    if (inv.status !== 'ISSUED') throw new StateConflictError('invoice_not_open');
  }
  const id = randomUUID();
  const scope = input.invoiceId ? 'INVOICE' : 'CUSTOMER';
  await db.financeReminderHold.create({
    data: {
      id, scope, customerId: input.customerId, invoiceId: input.invoiceId ?? null, reason: input.reason, note: input.note ?? null,
      untilDate: input.untilDate ? dateOf(input.untilDate) : null, createdById: actorUserId,
    } as never,
  });
  const skipped = await skipOpen(db, input.invoiceId ? { invoiceId: input.invoiceId } : { customerId: input.customerId }, 'on_hold');
  await recordAudit(db, actorUserId, 'finance.reminder_hold.placed', { type: 'finance_reminder_hold', id }, {
    scope, customerId: input.customerId, invoiceId: input.invoiceId ?? null, reason: input.reason, untilDate: input.untilDate ?? null,
    skippedReminders: String(skipped),
  });
  const row = (await db.financeReminderHold.findFirst({ where: { id }, select: holdSelect })) as HoldRow;
  return (await holdDtos(db, [row], today))[0]!;
}

/** Ends a hold. Stages that came due during it stay skipped; later stages are reminded as usual. */
export async function releaseReminderHold(db: AppTenantDb, actorUserId: string, id: string) {
  checkId(id);
  const locked = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM finance_reminder_holds
    WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
  if (locked.length === 0) throw new RecordNotFoundError();
  const before = (await db.financeReminderHold.findFirst({ where: { id }, select: holdSelect })) as HoldRow;
  if (before.releasedAt) throw new StateConflictError('already_reversed');
  await db.financeReminderHold.updateMany({ where: { id, releasedAt: null }, data: { releasedById: actorUserId } as never });
  await recordAudit(db, actorUserId, 'finance.reminder_hold.released', { type: 'finance_reminder_hold', id }, {
    scope: before.scope, customerId: before.customerId, invoiceId: before.invoiceId,
  });
  const row = (await db.financeReminderHold.findFirst({ where: { id }, select: holdSelect })) as HoldRow;
  return (await holdDtos(db, [row], await businessToday(db)))[0]!;
}

export async function listReminderHolds(
  db: AppTenantDb, query: { state: 'in_effect' | 'ended' | 'all'; customerId?: string; invoiceId?: string; cursor?: string; limit: number },
) {
  const today = await businessToday(db);
  const where: Record<string, unknown>[] = [];
  if (query.customerId) where.push({ customerId: query.customerId });
  if (query.invoiceId) where.push({ invoiceId: query.invoiceId });
  const live = { releasedAt: null, OR: [{ untilDate: null }, { untilDate: { gte: dateOf(today) } }] };
  if (query.state === 'in_effect') where.push(live);
  if (query.state === 'ended') where.push({ OR: [{ releasedAt: { not: null } }, { untilDate: { lt: dateOf(today) } }] });
  const list = `finance:reminder-holds:${query.state}`;
  const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
  }
  const rows = (await db.financeReminderHold.findMany({
    where: { AND: where }, select: holdSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as HoldRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    holds: await holdDtos(db, page, today),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, { t: last.createdAt.toISOString(), i: last.id }) : null,
  };
}

async function holdInEffect(db: AppTenantDb, customerId: string, invoiceId: string, today: string): Promise<boolean> {
  const n = await db.financeReminderHold.count({
    where: {
      customerId, releasedAt: null, AND: [{ OR: [{ untilDate: null }, { untilDate: { gte: dateOf(today) } }] }, { OR: [{ scope: 'CUSTOMER' }, { invoiceId }] }],
    },
  });
  return n > 0;
}

// ---- customer settings ---------------------------------------------------------------------------

async function effectivePolicy(db: AppTenantDb, customerId: string): Promise<PolicyRow | null> {
  const own = await db.financeReminderCustomerPolicy.findFirst({ where: { customerId }, select: { policyId: true } });
  if (own?.policyId) {
    const p = (await db.financeReminderPolicy.findFirst({ where: { id: own.policyId, status: 'ACTIVE' }, select: policySelect })) as PolicyRow | null;
    if (p) return p;
  }
  return (await db.financeReminderPolicy.findFirst({ where: { isDefault: true, status: 'ACTIVE' }, select: policySelect })) as PolicyRow | null;
}

export async function getCustomerReminderSettings(db: AppTenantDb, customerId: string) {
  checkId(customerId);
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { id: true } });
  if (!customer) throw new RecordNotFoundError();
  const today = await businessToday(db);
  const own = await db.financeReminderCustomerPolicy.findFirst({ where: { customerId }, select: { policyId: true, version: true } });
  const effective = await effectivePolicy(db, customerId);
  const holds = (await db.financeReminderHold.findMany({
    where: { customerId, releasedAt: null, OR: [{ untilDate: null }, { untilDate: { gte: dateOf(today) } }] }, select: holdSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
  })) as HoldRow[];
  return {
    customerId, policyId: own?.policyId ?? null, effectivePolicyId: effective?.id ?? null, version: own?.version ?? null,
    holdsInEffect: await holdDtos(db, holds, today),
  };
}

/** Assigns a customer its own policy, or (null) puts it back on the default. Open reminders under another policy are skipped. */
export async function updateCustomerReminderSettings(db: AppTenantDb, actorUserId: string, customerId: string, input: { policyId: string | null; version?: number }) {
  checkId(customerId);
  await lockReminderConfig(db);
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
  if (!customer) throw new RecordNotFoundError();
  if (customer.archivedAt) throw new StateConflictError('archived');
  if (input.policyId) {
    const p = await loadPolicy(db, input.policyId);
    if (p.status !== 'ACTIVE') throw new StateConflictError('archived');
  }
  const own = await db.financeReminderCustomerPolicy.findFirst({ where: { customerId }, select: { policyId: true, version: true } });
  if (own) {
    if (input.version !== own.version) throw new StateConflictError('stale');
    if (own.policyId === input.policyId) return getCustomerReminderSettings(db, customerId);
    const result = await db.financeReminderCustomerPolicy.updateMany({
      where: { customerId, version: own.version }, data: { policyId: input.policyId, version: { increment: 1 }, updatedById: actorUserId } as never,
    });
    if (result.count === 0) throw new StateConflictError('stale');
  } else {
    if (input.version !== undefined) throw new StateConflictError('stale');
    if (input.policyId === null) return getCustomerReminderSettings(db, customerId);
    await db.financeReminderCustomerPolicy.create({ data: { customerId, policyId: input.policyId, createdById: actorUserId, updatedById: actorUserId } as never });
  }
  const effective = await effectivePolicy(db, customerId);
  const skipped = await skipOpen(db, { customerId, ...(effective ? { policyId: { not: effective.id } } : {}) }, 'policy_changed');
  await recordAudit(db, actorUserId, 'finance.reminder_customer.updated', { type: 'customer', id: customerId }, {
    policyId: input.policyId, previousPolicyId: own?.policyId ?? null, skippedReminders: String(skipped),
  });
  return getCustomerReminderSettings(db, customerId);
}

// ---- eligibility ---------------------------------------------------------------------------------

type InvoiceRow = {
  id: string; status: string; number: string | null; customerId: string; contactId: string | null; currencyCode: string; currencyScale: number;
  total: Decimal; allocatedTotal: Decimal; creditAppliedTotal: Decimal; dueDate: Date | null;
};
const invoiceSelect = {
  id: true, status: true, number: true, customerId: true, contactId: true, currencyCode: true, currencyScale: true, total: true, allocatedTotal: true,
  creditAppliedTotal: true, dueDate: true,
} as const;

async function loadInvoice(db: AppTenantDb, id: string): Promise<InvoiceRow | null> {
  return (await db.financeDocument.findFirst({ where: { id, kind: 'INVOICE' }, select: invoiceSelect })) as InvoiceRow | null;
}

/** The F2 formula on the invoice's DB-maintained counters: what is still owed on an issued invoice. */
export const outstandingOf = (inv: { status: string; total: Decimal; allocatedTotal: Decimal; creditAppliedTotal: Decimal }) =>
  inv.status === 'ISSUED' ? new Decimal(inv.total).sub(inv.allocatedTotal).sub(inv.creditAppliedTotal) : new Decimal(0);

/** Who a reminder goes to: the invoice's contact, else the customer's primary contact, else the customer's own address. */
async function recipientOf(db: AppTenantDb, inv: InvoiceRow): Promise<ReminderRecipient | null> {
  const customer = await db.customer.findFirst({ where: { id: inv.customerId }, select: { email: true, primaryContactId: true } });
  const contactAddress = async (id: string | null) => {
    if (!id) return null;
    const c = await db.contact.findFirst({ where: { id, archivedAt: null }, select: { email: true } });
    return c?.email?.trim() || null;
  };
  const fromInvoice = await contactAddress(inv.contactId);
  if (fromInvoice) return { source: 'invoice_contact', contactId: inv.contactId, address: fromInvoice };
  const fromPrimary = await contactAddress(customer?.primaryContactId ?? null);
  if (fromPrimary) return { source: 'primary_contact', contactId: customer!.primaryContactId, address: fromPrimary };
  const own = customer?.email?.trim();
  return own ? { source: 'customer', contactId: null, address: own } : null;
}

type Stage = { policyId: string; offsetDays: number; dueDate: string };
type Assessment =
  | { ok: true; invoice: InvoiceRow; outstanding: Decimal; policy: PolicyRow; recipient: ReminderRecipient }
  | { ok: false; reason: ReminderReason; invoice: InvoiceRow | null; outstanding: Decimal; policy: PolicyRow | null };

/**
 * Every rule a reminder must pass, read from the current rows (callers lock the invoice first when the
 * answer decides a hand-over). With `stage`, also that this exact stage is still the one to send today.
 */
async function assess(db: AppTenantDb, invoiceId: string, today: string, stage: Stage | null): Promise<Assessment> {
  const invoice = await loadInvoice(db, invoiceId);
  const zero = new Decimal(0);
  if (!invoice || invoice.status !== 'ISSUED') return { ok: false, reason: 'not_issued', invoice, outstanding: zero, policy: null };
  const outstanding = outstandingOf(invoice);
  const no = (reason: ReminderReason, policy: PolicyRow | null = null) => ({ ok: false as const, reason, invoice, outstanding, policy });
  if (outstanding.lte(0)) return no('settled');
  const due = dayOf(invoice.dueDate);
  if (due === null) return no('no_due_date');
  if (stage && stage.dueDate !== due) return no('due_date_changed');
  const customer = await db.customer.findFirst({ where: { id: invoice.customerId }, select: { archivedAt: true } });
  if (!customer || customer.archivedAt) return no('customer_archived');
  if (await holdInEffect(db, invoice.customerId, invoice.id, today)) return no('on_hold');
  const policy = await effectivePolicy(db, invoice.customerId);
  if (!policy) return no('no_policy');
  if (stage) {
    if (stage.policyId !== policy.id) return no('policy_changed', policy);
    const stages = stagesOf(policy);
    if (!stages.some((s) => s.offsetDays === stage.offsetDays)) return no('stage_removed', policy);
    const state = reminderStageState(stages, due, today, stage.offsetDays);
    if (state !== 'due') return no(state, policy);
  }
  const recipient = await recipientOf(db, invoice);
  if (!recipient) return no('no_recipient', policy);
  return { ok: true, invoice, outstanding, policy, recipient };
}

// ---- reminders: read -----------------------------------------------------------------------------

type ReminderRow = {
  id: string; invoiceId: string; customerId: string; policyId: string; policyVersion: number; offsetDays: number; stageLabel: string; dueDate: Date;
  scheduledOn: Date; status: string; attempts: number; maxAttempts: number; outcomeCode: string | null; checkedOutstanding: Decimal | null;
  checkedAt: Date | null; outboundId: string | null; outboundState: string | null; readyAt: Date | null; queuedAt: Date | null; finishedAt: Date | null;
  dismissedById: string | null; createdAt: Date;
};
const reminderSelect = {
  id: true, invoiceId: true, customerId: true, policyId: true, policyVersion: true, offsetDays: true, stageLabel: true, dueDate: true, scheduledOn: true,
  status: true, attempts: true, maxAttempts: true, outcomeCode: true, checkedOutstanding: true, checkedAt: true, outboundId: true, outboundState: true,
  readyAt: true, queuedAt: true, finishedAt: true, dismissedById: true, createdAt: true,
} as const;

async function reminderDtos(db: AppTenantDb, rows: ReminderRow[]): Promise<ReminderDto[]> {
  const ids = [...new Set(rows.map((r) => r.invoiceId))];
  const docs = ids.length
    ? await db.financeDocument.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, currencyCode: true, currencyScale: true } })
    : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows.map((r) => {
    const d = byId.get(r.invoiceId)!;
    return {
      id: r.id, invoiceId: r.invoiceId, invoiceNumber: d.number, customerId: r.customerId, policyId: r.policyId, offsetDays: r.offsetDays,
      stageLabel: r.stageLabel, dueDate: day(r.dueDate), scheduledOn: day(r.scheduledOn), status: r.status as ReminderDto['status'],
      outcomeCode: r.outcomeCode, currencyCode: d.currencyCode,
      checkedOutstanding: r.checkedOutstanding === null ? null : formatAmount(new Decimal(r.checkedOutstanding), d.currencyScale),
      checkedAt: iso(r.checkedAt), outboundId: r.outboundId, outboundState: r.outboundState as ReminderDto['outboundState'], readyAt: iso(r.readyAt),
      queuedAt: iso(r.queuedAt), finishedAt: iso(r.finishedAt), dismissedById: r.dismissedById, createdAt: r.createdAt.toISOString(),
    };
  });
}

async function loadReminder(db: AppTenantDb, id: string): Promise<ReminderRow> {
  checkId(id);
  const row = (await db.financeReminder.findFirst({ where: { id }, select: reminderSelect })) as ReminderRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export async function listReminders(
  db: AppTenantDb, query: { status: string; customerId?: string; invoiceId?: string; cursor?: string; limit: number },
) {
  const where: Record<string, unknown>[] = [];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  if (query.customerId) where.push({ customerId: query.customerId });
  if (query.invoiceId) where.push({ invoiceId: query.invoiceId });
  const list = 'finance:reminders';
  const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
  }
  const rows = (await db.financeReminder.findMany({
    where: { AND: where }, select: reminderSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as ReminderRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    reminders: await reminderDtos(db, page),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, { t: last.createdAt.toISOString(), i: last.id }) : null,
  };
}

/** One invoice's reminder position today: eligibility, each stage of its policy, and its history. Writes nothing. */
export async function getInvoiceReminders(db: AppTenantDb, invoiceId: string) {
  checkId(invoiceId);
  const today = await businessToday(db);
  const invoice = await loadInvoice(db, invoiceId);
  if (!invoice || invoice.status === 'DRAFT') throw new RecordNotFoundError();
  const a = await assess(db, invoiceId, today, null);
  const policy = a.policy ?? (invoice.status === 'ISSUED' ? await effectivePolicy(db, invoice.customerId) : null);
  const rows = (await db.financeReminder.findMany({ where: { invoiceId }, select: reminderSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })) as ReminderRow[];
  const due = dayOf(invoice.dueDate);
  const stages = policy ? stagesOf(policy) : [];
  return {
    invoiceId, asOf: today, eligible: a.ok, reason: a.ok ? null : a.reason, currencyCode: invoice.currencyCode,
    outstanding: formatAmount(a.outstanding, invoice.currencyScale), dueDate: due, policyId: policy?.id ?? null,
    stages: stages.map((s) => ({
      offsetDays: s.offsetDays, label: s.label, scheduledOn: due ? reminderStageDate(due, s.offsetDays) : null,
      state: due ? reminderStageState(stages, due, today, s.offsetDays) : null,
      reminderId: rows.find((r) => r.offsetDays === s.offsetDays)?.id ?? null,
    })),
    reminders: await reminderDtos(db, rows),
  };
}

/** A person decides a pending or ready reminder should not be sent. Final for that stage. */
export async function dismissReminder(db: AppTenantDb, actorUserId: string, id: string) {
  checkId(id);
  await db.$queryRaw`SELECT 1 FROM finance_reminders WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
  const r = await loadReminder(db, id);
  if (r.status !== 'PENDING' && r.status !== 'READY') throw new StateConflictError('invalid_state');
  await db.financeReminder.updateMany({ where: { id, status: r.status }, data: { status: 'SKIPPED', outcomeCode: 'dismissed', dismissedById: actorUserId } as never });
  await recordAudit(db, actorUserId, 'finance.reminder.dismissed', { type: 'finance_reminder', id }, {
    invoiceId: r.invoiceId, offsetDays: String(r.offsetDays), previousStatus: r.status,
  });
  return (await reminderDtos(db, [await loadReminder(db, id)]))[0]!;
}

// ---- worker: plan --------------------------------------------------------------------------------

type Candidate = { id: string; customer_id: string; due_date: Date; policy_id: string; policy_version: number; stages: ReminderStage[] };

/**
 * Plans today's due stage for up to INVOICES_PER_PLAN_BATCH open invoices of this business (keyset on
 * invoice id from `after`): one PENDING reminder per invoice for the single stage that may be sent today
 * (dueReminderStage: the latest stage whose date has come, unless stale or expired). Inserting the same
 * stage twice is a no-op (UNIQUE (invoice, offset)). Runs as the worker (no session user).
 */
export async function planDueReminders(db: AppTenantDb, opts: { after?: string | null; limit?: number } = {}): Promise<{ planned: number; next: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? INVOICES_PER_PLAN_BATCH, 1), 2000);
  const today = await businessToday(db);
  // Due dates outside [today − 365 − 14, today + 60] can have no due stage (offset bounds and lateness).
  const rows = await db.$queryRaw<Candidate[]>`
    WITH b AS (SELECT nullif(current_setting('app.business_id', true), '')::uuid AS id),
    def AS (SELECT p.id FROM finance_reminder_policies p, b WHERE p.business_id = b.id AND p.is_default AND p.status = 'ACTIVE')
    SELECT d.id::text, d.customer_id::text, d.due_date, p.id::text AS policy_id, p.version AS policy_version, p.stages
      FROM finance_documents d
      JOIN b ON d.business_id = b.id
      JOIN customers c ON c.business_id = d.business_id AND c.id = d.customer_id AND c.archived_at IS NULL
      LEFT JOIN finance_reminder_customer_policies cp ON cp.business_id = d.business_id AND cp.customer_id = d.customer_id
      LEFT JOIN finance_reminder_policies own ON own.business_id = d.business_id AND own.id = cp.policy_id AND own.status = 'ACTIVE'
      JOIN finance_reminder_policies p ON p.business_id = d.business_id AND p.status = 'ACTIVE' AND p.id = coalesce(own.id, (SELECT id FROM def))
     WHERE d.kind = 'INVOICE' AND d.status = 'ISSUED' AND d.due_date IS NOT NULL
       AND d.total - d.allocated_total - d.credit_applied_total > 0
       AND d.due_date BETWEEN ${today}::date - 379 AND ${today}::date + 60
       AND (${opts.after ?? null}::uuid IS NULL OR d.id > ${opts.after ?? null}::uuid)
     ORDER BY d.id
     LIMIT ${limit + 1}`;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const ins = { id: [] as string[], invoice: [] as string[], customer: [] as string[], policy: [] as string[], version: [] as number[], offset: [] as number[], label: [] as string[], due: [] as string[] };
  for (const r of page) {
    const due = day(r.due_date);
    const stage = dueReminderStage(r.stages, due, today);
    if (!stage) continue;
    ins.id.push(randomUUID()); ins.invoice.push(r.id); ins.customer.push(r.customer_id); ins.policy.push(r.policy_id); ins.version.push(r.policy_version);
    ins.offset.push(stage.offsetDays); ins.label.push(stage.label); ins.due.push(due);
  }
  let planned = 0;
  if (ins.id.length > 0) {
    const inserted = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO finance_reminders (id, business_id, invoice_id, customer_id, policy_id, policy_version, offset_days, stage_label, due_date, scheduled_on)
      SELECT p.id, nullif(current_setting('app.business_id', true), '')::uuid, p.inv, p.cust, p.pol, p.ver, p.off, p.label, p.due, p.due + p.off
        FROM unnest(${ins.id}::uuid[], ${ins.invoice}::uuid[], ${ins.customer}::uuid[], ${ins.policy}::uuid[], ${ins.version}::int[], ${ins.offset}::int[],
                    ${ins.label}::text[], ${ins.due}::date[]) AS p(id, inv, cust, pol, ver, off, label, due)
      ON CONFLICT (business_id, invoice_id, offset_days) DO NOTHING RETURNING id::text`;
    planned = inserted.length;
  }
  const last = page[page.length - 1];
  return { planned, next: more && last ? last.id : null };
}

/** Records that this business's policies were fully planned now (the due-business function waits an hour). */
export async function markRemindersPlanned(db: AppTenantDb) {
  await db.$queryRaw`
    UPDATE finance_reminder_policies SET last_planned_at = now()
    WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid AND status = 'ACTIVE' RETURNING id`;
}

// ---- worker: claim, check, hand over -------------------------------------------------------------

export interface ClaimedReminder { reminderId: string; leaseId: string }

/**
 * Claims the oldest due reminder of this business: PENDING or READY whose next check is due, or RUNNING
 * with an expired lease. FOR UPDATE SKIP LOCKED, so concurrent workers get different reminders. One
 * whose lease expired with no attempts left fails instead (`lease_expired`).
 */
export async function claimReminder(db: AppTenantDb, opts: { leaseSeconds?: number } = {}): Promise<ClaimedReminder | null> {
  const leaseSeconds = Math.min(Math.max(opts.leaseSeconds ?? 120, 10), 900);
  await db.$queryRaw`
    UPDATE finance_reminders SET status = 'FAILED', lease_id = NULL, lease_expires_at = NULL, outcome_code = 'lease_expired'
    WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid
      AND status = 'RUNNING' AND lease_expires_at < now() AND attempts >= max_attempts
    RETURNING id`;
  const leaseId = randomUUID();
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE finance_reminders r SET status = 'RUNNING', lease_id = ${leaseId}::uuid,
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int), attempts = r.attempts + 1
    WHERE (r.business_id, r.id) = (
      SELECT d.business_id, d.id FROM finance_reminders d
      WHERE d.business_id = nullif(current_setting('app.business_id', true), '')::uuid
        AND ((d.status IN ('PENDING', 'READY') AND d.run_after <= now()) OR (d.status = 'RUNNING' AND d.lease_expires_at < now()))
        AND d.attempts < d.max_attempts
      ORDER BY d.run_after, d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED)
    RETURNING r.id::text`;
  const hit = claimed[0];
  return hit ? { reminderId: hit.id, leaseId } : null;
}

/** The reminder's customer and invoice, read without a lock (both immutable), so the caller can take the advisory and invoice locks first. */
async function reminderTarget(db: AppTenantDb, reminderId: string): Promise<{ customerId: string; invoiceId: string } | null> {
  return db.financeReminder.findFirst({ where: { id: reminderId }, select: { customerId: true, invoiceId: true } });
}

/** Locks the reminder if, and only if, the caller still holds an unexpired lease on it (database time). Level 4 of the lock order. */
async function holdLease(db: AppTenantDb, c: ClaimedReminder): Promise<ReminderRow | null> {
  const held = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM finance_reminders
    WHERE id = ${c.reminderId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
      AND status = 'RUNNING' AND lease_id = ${c.leaseId}::uuid AND lease_expires_at > now()
    FOR UPDATE`;
  if (held.length === 0) return null;
  return (await db.financeReminder.findFirst({ where: { id: c.reminderId }, select: reminderSelect })) as ReminderRow;
}

/** Idempotency key of a reminder's outbound message. Contains a space, which client Idempotency-Keys cannot. */
export const reminderOutboundKey = (reminderId: string) => `system reminder ${reminderId}`;

function dispatchRequest(r: ReminderRow, a: Extract<Assessment, { ok: true }>, today: string): ReminderDispatchRequest {
  const s = a.invoice.currencyScale;
  return {
    reminderId: r.id, idempotencyKey: reminderOutboundKey(r.id), invoiceId: a.invoice.id, invoiceNumber: a.invoice.number!, customerId: a.invoice.customerId,
    recipient: a.recipient, currencyCode: a.invoice.currencyCode, total: formatAmount(new Decimal(a.invoice.total), s), outstanding: formatAmount(a.outstanding, s),
    dueDate: day(r.dueDate), daysPastDue: daysPastDue(day(r.dueDate), today), offsetDays: r.offsetDays, stageLabel: r.stageLabel, policyId: r.policyId,
  };
}

/**
 * Locks what a hand-over decision depends on (levels 1 to 3 of the lock order): the configuration lock
 * (shared, vs policy and assignment changes), the customer's reminder lock (shared, vs holds), then the
 * invoice row (vs payments, credit applications and voids). Taken BEFORE the reminder row.
 */
async function lockForCheck(db: AppTenantDb, r: { customerId: string; invoiceId: string }) {
  await lockReminderConfig(db, 'shared');
  await lockCustomerReminders(db, r.customerId, 'shared');
  await lockDocuments(db, [r.invoiceId]);
}

export type ReminderOutcome = 'ready' | 'queued' | 'refused' | 'skipped' | 'lease_lost';

/**
 * The pre-dispatch check of a claimed reminder, in this one transaction: lock, re-check every rule
 * against the current rows, then (if still due) hand it to the outbox and mark it QUEUED, or mark it
 * READY when there is no outbox. A reminder that is no longer due is SKIPPED with its reason. Earlier
 * open stages of the same invoice are skipped as superseded. If the lease was lost nothing is written.
 * Any error rolls the whole transaction back (including the outbox's insert); the caller then records
 * the failure with failReminder in a new transaction.
 */
export async function executeReminder(db: AppTenantDb, c: ClaimedReminder, outbox: ReminderOutbox | null): Promise<ReminderOutcome> {
  const target = await reminderTarget(db, c.reminderId);
  if (!target) return 'lease_lost';
  await lockForCheck(db, target);
  const r = await holdLease(db, c);
  if (!r) return 'lease_lost';
  const today = await businessToday(db);
  const a = await assess(db, r.invoiceId, today, { policyId: r.policyId, offsetDays: r.offsetDays, dueDate: day(r.dueDate) });
  const checked = { checkedOutstanding: a.outstanding, checkedAt: new Date() };
  const release = { leaseId: null, leaseExpiresAt: null };
  if (!a.ok) {
    await db.financeReminder.updateMany({ where: { id: r.id, leaseId: c.leaseId }, data: { status: 'SKIPPED', outcomeCode: a.reason, ...release, ...checked } as never });
    await recordSystemAudit(db, 'finance.system.reminder.skipped', { type: 'finance_reminder', id: r.id }, {
      invoiceId: r.invoiceId, offsetDays: String(r.offsetDays), reason: a.reason,
    });
    return 'skipped';
  }
  // One reminder per invoice at a time: earlier stages still waiting are superseded by this one.
  await db.financeReminder.updateMany({
    where: { invoiceId: r.invoiceId, offsetDays: { lt: r.offsetDays }, status: { in: ['PENDING', 'READY'] } },
    data: { status: 'SKIPPED', outcomeCode: 'superseded' } as never,
  });
  const firstReady = r.readyAt === null;
  if (!outbox) {
    await db.financeReminder.updateMany({
      where: { id: r.id, leaseId: c.leaseId },
      data: { status: 'READY', outcomeCode: null, attempts: 0, runAfter: new Date(Date.now() + READY_RECHECK_MS), ...release, ...checked } as never,
    });
    if (firstReady) {
      await recordSystemAudit(db, 'finance.system.reminder.ready', { type: 'finance_reminder', id: r.id }, { invoiceId: r.invoiceId, offsetDays: String(r.offsetDays) });
    }
    return 'ready';
  }
  const result = await outbox.enqueue(db, dispatchRequest(r, a, today));
  if (result.status === 'refused') {
    const code = /^[a-z][a-z_]{1,48}$/.test(result.code) ? result.code : 'outbox_refused';
    await db.financeReminder.updateMany({
      where: { id: r.id, leaseId: c.leaseId },
      data: { status: 'READY', outcomeCode: code, attempts: 0, runAfter: new Date(Date.now() + REFUSED_RECHECK_MS), ...release, ...checked } as never,
    });
    await recordSystemAudit(db, 'finance.system.reminder.refused', { type: 'finance_reminder', id: r.id }, { invoiceId: r.invoiceId, code });
    return 'refused';
  }
  await db.financeReminder.updateMany({
    where: { id: r.id, leaseId: c.leaseId },
    data: { status: 'QUEUED', outcomeCode: null, outboundId: result.outboundId, outboundState: 'QUEUED', ...release, ...checked } as never,
  });
  await recordSystemAudit(db, 'finance.system.reminder.queued', { type: 'finance_reminder', id: r.id }, {
    invoiceId: r.invoiceId, offsetDays: String(r.offsetDays), outboundId: result.outboundId,
  });
  return 'queued';
}

/** Backoff for retry n (1-based): 1 min × 4^(n-1), capped at 6 h (as recurring billing). */
const retryDelayMs = (attempt: number) => Math.min(60_000 * 4 ** Math.max(attempt - 1, 0), 6 * 3_600_000);

/** Records a failed attempt (an unexpected error), only while the caller holds the lease. Retried with backoff, then FAILED. */
export async function failReminder(db: AppTenantDb, c: ClaimedReminder): Promise<'failed' | 'retrying' | 'lease_lost'> {
  const r = await holdLease(db, c);
  if (!r) return 'lease_lost';
  const final = r.attempts >= r.maxAttempts;
  // A READY reminder that hits an error goes back to PENDING (it is re-checked from scratch either way).
  await db.financeReminder.updateMany({
    where: { id: r.id, leaseId: c.leaseId },
    data: (final
      ? { status: 'FAILED', outcomeCode: 'internal_error', leaseId: null, leaseExpiresAt: null }
      : { status: 'PENDING', outcomeCode: 'internal_error', leaseId: null, leaseExpiresAt: null, runAfter: new Date(Date.now() + retryDelayMs(r.attempts)) }) as never,
  });
  await recordSystemAudit(db, final ? 'finance.system.reminder.failed' : 'finance.system.reminder.retrying', { type: 'finance_reminder', id: r.id }, {
    invoiceId: r.invoiceId, attempts: String(r.attempts),
  });
  return final ? 'failed' : 'retrying';
}

// ---- the C2-C side of the boundary (reminder-outbox.ts) ------------------------------------------

/**
 * Called by C2-C immediately before it contacts the provider for a reminder's outbound message, in the
 * transaction that moves that message out of QUEUED. Locks the invoice and re-checks every rule. If the
 * reminder is no longer due it is SKIPPED here and C2-C must cancel its message.
 */
export async function confirmReminderBeforeSend(db: AppTenantDb, input: { reminderId: string; outboundId: string }): Promise<BeforeSendResult> {
  checkId(input.reminderId);
  const target = await reminderTarget(db, input.reminderId);
  if (!target) return { send: false, reason: 'not_queued' };
  await lockForCheck(db, target);
  await db.$queryRaw`
    SELECT 1 FROM finance_reminders WHERE id = ${input.reminderId}::uuid
      AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
  const r = (await db.financeReminder.findFirst({ where: { id: input.reminderId }, select: reminderSelect })) as ReminderRow | null;
  if (!r || r.status !== 'QUEUED' || r.outboundId !== input.outboundId || r.outboundState !== 'QUEUED') return { send: false, reason: 'not_queued' };
  const today = await businessToday(db);
  const a = await assess(db, r.invoiceId, today, { policyId: r.policyId, offsetDays: r.offsetDays, dueDate: day(r.dueDate) });
  if (!a.ok) {
    await db.financeReminder.updateMany({
      where: { id: r.id, status: 'QUEUED', outboundState: 'QUEUED' },
      data: { status: 'SKIPPED', outcomeCode: a.reason, checkedOutstanding: a.outstanding, checkedAt: new Date() } as never,
    });
    await recordSystemAudit(db, 'finance.system.reminder.skipped', { type: 'finance_reminder', id: r.id }, {
      invoiceId: r.invoiceId, offsetDays: String(r.offsetDays), reason: a.reason, stage: 'before_send',
    });
    return { send: false, reason: a.reason };
  }
  await db.financeReminder.updateMany({ where: { id: r.id }, data: { checkedOutstanding: a.outstanding, checkedAt: new Date() } as never });
  return { send: true, request: dispatchRequest(r, a, today) };
}

/**
 * Called by C2-C's worker (no session user) for each later state of the outbound message. The database
 * enforces C2's register (UNKNOWN never becomes FAILED; there is no "delivered").
 */
export async function recordReminderOutboundState(db: AppTenantDb, input: { reminderId: string; outboundId: string; state: ReminderOutboundState }) {
  checkId(input.reminderId);
  const r = await loadReminder(db, input.reminderId);
  if (r.outboundId !== input.outboundId) throw new RecordNotFoundError();
  if (r.outboundState === input.state) return;
  await db.financeReminder.updateMany({ where: { id: r.id, outboundId: input.outboundId }, data: { outboundState: input.state } as never });
  await recordSystemAudit(db, 'finance.system.reminder.outbound_state', { type: 'finance_reminder', id: r.id }, {
    outboundId: input.outboundId, state: input.state, previousState: r.outboundState,
  });
}
