import 'server-only';
// Opportunities (docs/sales-data-model.md §2–4). Runs inside a tenant unit of work. Every status
// change is a conditional UPDATE (… WHERE status = 'OPEN' AND archived_at IS NULL), so two people
// acting at once cannot both win, lose or move the same opportunity from a stale view.
import { randomUUID } from 'node:crypto';
import type { Opportunity as OpportunityDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb, Decimal } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { checkCurrency, formatAmount, toAmount } from './money';
import { activePipeline, activeStages } from './pipelines';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Status = 'OPEN' | 'WON' | 'LOST';
type Row = {
  id: string; title: string; customerId: string | null; contactId: string | null; pipelineId: string; stageId: string;
  amount: Decimal | null; currencyCode: string; probability: number | null; expectedCloseDate: Date | null; ownerUserId: string | null;
  description: string | null; status: Status; lossReason: string | null; closedAt: Date | null; createdById: string | null;
  updatedById: string | null; createdAt: Date; updatedAt: Date; archivedAt: Date | null;
};
const select = {
  id: true, title: true, customerId: true, contactId: true, pipelineId: true, stageId: true, amount: true, currencyCode: true,
  probability: true, expectedCloseDate: true, ownerUserId: true, description: true, status: true, lossReason: true, closedAt: true,
  createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;

const toDto = (r: Row): OpportunityDto => ({
  ...r,
  amount: formatAmount(r.amount, r.currencyCode),
  expectedCloseDate: r.expectedCloseDate ? r.expectedCloseDate.toISOString().slice(0, 10) : null,
  closedAt: r.closedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});

export type OpportunityInput = {
  title?: string; customerId?: string | null; contactId?: string | null; pipelineId?: string; stageId?: string;
  amount?: string | null; currencyCode?: string; probability?: number | null; expectedCloseDate?: string | null;
  ownerUserId?: string | null; description?: string | null;
};

async function load(db: AppTenantDb, id: string): Promise<Row> {
  const row = (await db.opportunity.findFirst({ where: { id }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** A newly linked customer must exist in this business and be active. Existing links stay readable after archiving. */
async function checkCustomer(db: AppTenantDb, customerId: string) {
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
  if (!customer) throw new RecordNotFoundError();
  if (customer.archivedAt) throw new StateConflictError('archived_reference');
}

async function contactOf(db: AppTenantDb, contactId: string) {
  const contact = await db.contact.findFirst({ where: { id: contactId }, select: { customerId: true, archivedAt: true } });
  if (!contact) throw new RecordNotFoundError();
  return contact;
}

/** The owner must be an active member of this business (the composite FK guarantees membership; this also checks status). */
async function checkOwner(db: AppTenantDb, ownerUserId: string) {
  const member = await db.membership.findFirst({ where: { userId: ownerUserId, status: 'ACTIVE' }, select: { id: true } });
  if (!member) throw new RuleViolationError('invalid_owner', 'The owner must be an active member of this business.');
}

/** The stage must be an active stage of the given pipeline (the three-column FK enforces membership too). */
async function checkStage(db: AppTenantDb, pipelineId: string, stageId: string) {
  const stage = await db.salesStage.findFirst({ where: { id: stageId, pipelineId }, select: { archivedAt: true } });
  if (!stage) throw new RuleViolationError('invalid_stage', 'Choose a stage of this pipeline.');
  if (stage.archivedAt) throw new StateConflictError('archived_reference');
}

/**
 * Customer and contact must agree: a contact that belongs to a customer can only be used with that
 * customer. When only the contact is given, its customer is filed too (as with activities).
 */
async function linkage(db: AppTenantDb, next: { customerId: string | null; contactId: string | null }, changed: { customer: boolean; contact: boolean }) {
  let customerId = next.customerId;
  if (changed.customer && customerId) await checkCustomer(db, customerId);
  if (next.contactId) {
    const contact = await contactOf(db, next.contactId);
    if (changed.contact && contact.archivedAt) throw new StateConflictError('archived_reference');
    if (contact.customerId) {
      if (customerId === null && changed.contact && !changed.customer) {
        customerId = contact.customerId;
        await checkCustomer(db, customerId);
      } else if (customerId !== contact.customerId) {
        throw new RuleViolationError('contact_customer_mismatch', 'This contact belongs to a different customer. Choose one of this customer\'s contacts or clear the contact.');
      }
    }
  }
  return customerId;
}

const changed = (before: Record<string, unknown>, data: Record<string, unknown>) =>
  Object.keys(data).filter((k) => {
    const a = before[k];
    const b = data[k];
    if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime() !== (b as Date | null)?.getTime();
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return String(a) !== String(b); // Decimal
    return a !== b;
  }).sort();

const dateOf = (v: string) => new Date(`${v}T00:00:00Z`);

export async function createOpportunity(db: AppTenantDb, actorUserId: string, input: OpportunityInput & { title: string }) {
  const pipeline = await activePipeline(db, actorUserId, input.pipelineId);
  let stageId = input.stageId;
  if (stageId) await checkStage(db, pipeline.id, stageId);
  else {
    const first = (await activeStages(db, pipeline.id))[0];
    if (!first) throw new RuleViolationError('invalid_stage', 'This pipeline has no active stages.');
    stageId = first.id;
  }
  // A customer counts as chosen only when one is given; a contact alone files its own customer.
  const customerId = await linkage(db, { customerId: input.customerId ?? null, contactId: input.contactId ?? null }, { customer: Boolean(input.customerId), contact: true });
  if (input.ownerUserId) await checkOwner(db, input.ownerUserId);
  const business = await db.business.findFirstOrThrow({ select: { currency: true } });
  const currencyCode = checkCurrency(input.currencyCode ?? business.currency);
  const id = randomUUID();
  const row = (await db.opportunity.create({
    data: {
      id, title: input.title, customerId, contactId: input.contactId ?? null, pipelineId: pipeline.id, stageId,
      amount: input.amount ? toAmount(input.amount, currencyCode) : null, currencyCode,
      probability: input.probability ?? null, expectedCloseDate: input.expectedCloseDate ? dateOf(input.expectedCloseDate) : null,
      ownerUserId: input.ownerUserId ?? null, description: input.description ?? null, createdById: actorUserId, updatedById: actorUserId,
    } as never,
    select,
  })) as Row;
  // Structured facts only: no title or description (they may hold customer details).
  await recordAudit(db, actorUserId, 'sales.opportunity.created', { type: 'opportunity', id }, {
    pipelineId: pipeline.id, stageId, customerId, ownerUserId: row.ownerUserId, currencyCode, hasAmount: row.amount ? 'true' : 'false',
  });
  return toDto(row);
}

export async function getOpportunity(db: AppTenantDb, id: string) {
  return toDto(await load(db, id));
}

/**
 * Edits details, moves an open opportunity to another stage (or pipeline + stage), reassigns it, or
 * changes its customer/contact links. Writes one audit entry for the edit plus dedicated entries for
 * a stage transition and an assignment change.
 */
export async function updateOpportunity(db: AppTenantDb, actorUserId: string, id: string, patch: OpportunityInput) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  const moving = patch.stageId !== undefined && (patch.stageId !== before.stageId || (patch.pipelineId ?? before.pipelineId) !== before.pipelineId);
  if (moving && before.status !== 'OPEN') throw new StateConflictError('not_open'); // reopen first

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.probability !== undefined) data.probability = patch.probability;
  if (patch.expectedCloseDate !== undefined) data.expectedCloseDate = patch.expectedCloseDate ? dateOf(patch.expectedCloseDate) : null;
  if (patch.ownerUserId !== undefined && patch.ownerUserId !== before.ownerUserId) {
    if (patch.ownerUserId) await checkOwner(db, patch.ownerUserId);
    data.ownerUserId = patch.ownerUserId;
  }
  if (patch.stageId !== undefined) {
    const pipelineId = patch.pipelineId ?? before.pipelineId;
    if (pipelineId !== before.pipelineId) await activePipeline(db, actorUserId, pipelineId);
    if (moving) await checkStage(db, pipelineId, patch.stageId);
    data.pipelineId = pipelineId;
    data.stageId = patch.stageId;
  }
  const currency = patch.currencyCode !== undefined ? checkCurrency(patch.currencyCode) : before.currencyCode;
  if (patch.currencyCode !== undefined) data.currencyCode = currency;
  if (patch.amount !== undefined) data.amount = patch.amount === null ? null : toAmount(patch.amount, currency);
  else if (patch.currencyCode !== undefined && before.amount !== null) data.amount = toAmount(before.amount.toString(), currency); // still valid in the new currency?

  const customerChanged = patch.customerId !== undefined && patch.customerId !== before.customerId;
  const contactChanged = patch.contactId !== undefined && patch.contactId !== before.contactId;
  if (customerChanged || contactChanged) {
    const next = { customerId: patch.customerId !== undefined ? patch.customerId : before.customerId, contactId: patch.contactId !== undefined ? patch.contactId : before.contactId };
    data.customerId = await linkage(db, next, { customer: customerChanged, contact: contactChanged });
    data.contactId = next.contactId;
  }

  const fields = changed(before as unknown as Record<string, unknown>, data);
  if (fields.length === 0) return toDto(before);
  // Conditional write: a concurrent archive, or a concurrent win/lose while moving stage, makes this match nothing.
  const result = await db.opportunity.updateMany({
    where: { id, archivedAt: null, ...(moving ? { status: 'OPEN' } : {}) },
    data: { ...data, updatedById: actorUserId } as never,
  });
  if (result.count === 0) {
    const now = await load(db, id);
    throw new StateConflictError(now.archivedAt ? 'archived' : 'not_open');
  }
  const after = await load(db, id);
  await recordAudit(db, actorUserId, 'sales.opportunity.updated', { type: 'opportunity', id }, { fields });
  if (fields.includes('stageId') || fields.includes('pipelineId')) {
    await recordAudit(db, actorUserId, 'sales.opportunity.stage_changed', { type: 'opportunity', id }, {
      fromPipelineId: before.pipelineId, fromStageId: before.stageId, toPipelineId: after.pipelineId, toStageId: after.stageId,
    });
  }
  if (fields.includes('ownerUserId')) {
    await recordAudit(db, actorUserId, 'sales.opportunity.assigned', { type: 'opportunity', id }, { from: before.ownerUserId, to: after.ownerUserId });
  }
  return toDto(after);
}

/** Why a conditional status change matched nothing: gone, archived, or not in the expected state. */
async function refuse(db: AppTenantDb, id: string, expected: 'not_open' | 'not_closed'): Promise<never> {
  const now = await load(db, id);
  throw new StateConflictError(now.archivedAt ? 'archived' : expected);
}

export async function winOpportunity(db: AppTenantDb, actorUserId: string, id: string) {
  await load(db, id);
  const result = await db.opportunity.updateMany({
    where: { id, status: 'OPEN', archivedAt: null },
    data: { status: 'WON', closedAt: new Date(), lossReason: null, updatedById: actorUserId } as never,
  });
  if (result.count === 0) await refuse(db, id, 'not_open');
  const after = await load(db, id);
  // The outcome as it stood: stage, amount and currency at the moment it was won.
  await recordAudit(db, actorUserId, 'sales.opportunity.won', { type: 'opportunity', id }, {
    stageId: after.stageId, amount: formatAmount(after.amount, after.currencyCode), currencyCode: after.currencyCode,
  });
  return toDto(after);
}

export async function loseOpportunity(db: AppTenantDb, actorUserId: string, id: string, input: { lossReason?: string | null }) {
  await load(db, id);
  const result = await db.opportunity.updateMany({
    where: { id, status: 'OPEN', archivedAt: null },
    data: { status: 'LOST', closedAt: new Date(), lossReason: input.lossReason ?? null, updatedById: actorUserId } as never,
  });
  if (result.count === 0) await refuse(db, id, 'not_open');
  const after = await load(db, id);
  await recordAudit(db, actorUserId, 'sales.opportunity.lost', { type: 'opportunity', id }, {
    stageId: after.stageId, amount: formatAmount(after.amount, after.currencyCode), currencyCode: after.currencyCode, hasReason: after.lossReason ? 'true' : 'false',
  });
  return toDto(after);
}

/**
 * Explicit transition back to OPEN from WON or LOST, optionally into another active stage of the same
 * pipeline. The previous outcome and close date are kept in the audit entry; the row is open again.
 */
export async function reopenOpportunity(db: AppTenantDb, actorUserId: string, id: string, input: { stageId?: string }) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.status === 'OPEN') throw new StateConflictError('not_closed');
  const stageId = input.stageId ?? before.stageId;
  await checkStage(db, before.pipelineId, stageId);
  const result = await db.opportunity.updateMany({
    where: { id, status: before.status, archivedAt: null },
    data: { status: 'OPEN', closedAt: null, lossReason: null, stageId, updatedById: actorUserId } as never,
  });
  if (result.count === 0) await refuse(db, id, 'not_closed');
  await recordAudit(db, actorUserId, 'sales.opportunity.reopened', { type: 'opportunity', id }, {
    previousStatus: before.status, previousClosedAt: before.closedAt?.toISOString() ?? null, stageId,
  });
  return toDto(await load(db, id));
}

export async function archiveOpportunity(db: AppTenantDb, actorUserId: string, id: string) {
  await load(db, id);
  const result = await db.opportunity.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date(), updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('archived');
  await recordAudit(db, actorUserId, 'sales.opportunity.archived', { type: 'opportunity', id });
  return toDto(await load(db, id));
}

export async function restoreOpportunity(db: AppTenantDb, actorUserId: string, id: string) {
  await load(db, id);
  const result = await db.opportunity.updateMany({ where: { id, archivedAt: { not: null } }, data: { archivedAt: null, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('not_archived');
  await recordAudit(db, actorUserId, 'sales.opportunity.restored', { type: 'opportunity', id });
  return toDto(await load(db, id));
}

export type OpportunityQuery = {
  q?: string; status: 'open' | 'won' | 'lost' | 'all'; archived: 'active' | 'archived' | 'all'; pipelineId?: string; stageId?: string;
  customerId?: string; contactId?: string; ownerUserId?: string; cursor?: string; limit: number;
};

/** Newest first (created_at, then id), keyset-paginated with an opaque cursor bound to this list. */
export async function listOpportunities(db: AppTenantDb, query: OpportunityQuery) {
  const after = decodeCursor(query.cursor, 'opportunities', ['t', 'i'] as const);
  const where: Record<string, unknown>[] = [];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  if (query.archived === 'active') where.push({ archivedAt: null });
  if (query.archived === 'archived') where.push({ archivedAt: { not: null } });
  for (const key of ['pipelineId', 'stageId', 'customerId', 'contactId', 'ownerUserId'] as const) if (query[key]) where.push({ [key]: query[key] });
  const term = query.q?.trim();
  if (term) where.push({ title: { contains: term, mode: 'insensitive' } });
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
  }
  const rows = (await db.opportunity.findMany({ where: { AND: where }, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 })) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    opportunities: page.map(toDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor('opportunities', { t: last.createdAt.toISOString(), i: last.id }) : null,
  };
}
