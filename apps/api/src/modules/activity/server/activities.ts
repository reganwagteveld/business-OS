import 'server-only';
// Activity timeline (data-model §4.7): the business-facing history of customers and contacts.
// Not the security audit log. User activities are logged by people; system activities are written
// by the customers module in the same unit of work as the change they describe.
import { randomUUID } from 'node:crypto';
import type { Activity as ActivityDto } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { recordAudit } from '@/core/audit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';

/** Types a person can log, and the system types this module knows. Unknown types are rejected. */
export const USER_ACTIVITY_TYPES = ['note', 'call', 'meeting', 'email'] as const;
export const SYSTEM_ACTIVITY_TYPES = [
  'customer.created', 'customer.updated', 'customer.archived', 'customer.restored', 'customer.primary_contact_changed',
  'contact.created', 'contact.updated', 'contact.archived', 'contact.restored', 'contact.customer_changed', 'contact.customer_removed',
] as const;
export type SystemActivityType = (typeof SYSTEM_ACTIVITY_TYPES)[number];

const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000; // a meeting can be logged ahead, but not years ahead

type Row = {
  id: string; type: string; occurredAt: Date; actorType: 'USER' | 'SYSTEM' | 'AI'; actorUserId: string | null;
  customerId: string | null; contactId: string | null; subject: string | null; body: string | null; data: unknown; createdAt: Date;
};
const select = {
  id: true, type: true, occurredAt: true, actorType: true, actorUserId: true, customerId: true, contactId: true,
  subject: true, body: true, data: true, createdAt: true,
} as const;

export function toActivity(r: Row): ActivityDto {
  return {
    id: r.id, type: r.type, occurredAt: r.occurredAt.toISOString(), actorType: r.actorType, actorUserId: r.actorUserId,
    customerId: r.customerId, contactId: r.contactId, subject: r.subject, body: r.body,
    data: (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>, createdAt: r.createdAt.toISOString(),
  };
}

/**
 * System activity attributed to the person whose action caused it. Called by the customers module
 * inside its unit of work, so the activity and the change commit or roll back together.
 */
export async function recordSystemActivity(
  db: AppTenantDb,
  actorUserId: string,
  type: SystemActivityType,
  link: { customerId?: string | null; contactId?: string | null },
  data: Record<string, string | string[] | null> = {},
): Promise<void> {
  await db.activity.create({
    data: {
      id: randomUUID(), type, occurredAt: new Date(), actorType: 'USER', actorUserId,
      customerId: link.customerId ?? null, contactId: link.contactId ?? null, data,
    } as never,
  });
}

/**
 * A person logs a note, call, meeting or email against a customer and/or contact.
 * - The records must exist in this business (scoped lookup, RLS and composite FKs agree) and not be archived.
 * - An activity on a contact that belongs to a customer is also filed under that customer (at the
 *   time of writing); a different customer supplied with it is rejected.
 */
export async function createActivity(
  db: AppTenantDb,
  actorUserId: string,
  input: { type: (typeof USER_ACTIVITY_TYPES)[number]; occurredAt?: string; customerId?: string; contactId?: string; subject?: string | null; body?: string | null },
): Promise<ActivityDto> {
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (occurredAt.getTime() > Date.now() + MAX_FUTURE_MS) throw new RuleViolationError('invalid_date', 'The date is too far in the future.');
  let customerId = input.customerId ?? null;
  const contactId = input.contactId ?? null;

  if (contactId) {
    const contact = await db.contact.findFirst({ where: { id: contactId }, select: { customerId: true, archivedAt: true } });
    if (!contact) throw new RecordNotFoundError();
    if (contact.archivedAt) throw new StateConflictError('archived_reference');
    if (contact.customerId) {
      if (customerId && customerId !== contact.customerId) {
        throw new RuleViolationError('customer_mismatch', 'This contact belongs to a different customer.');
      }
      customerId = contact.customerId;
    }
  }
  if (customerId) {
    const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
    if (!customer) throw new RecordNotFoundError();
    if (customer.archivedAt) throw new StateConflictError('archived_reference');
  }

  const row = (await db.activity.create({
    data: {
      id: randomUUID(), type: input.type, occurredAt, actorType: 'USER', actorUserId, customerId, contactId,
      subject: input.subject ?? null, body: input.body ?? null, data: {},
    } as never,
    select,
  })) as Row;
  // Security audit in the same unit of work: who logged what kind of entry where. No subject or
  // body (business content, possibly personal data) goes into the audit log (data-model §4.8).
  await recordAudit(db, actorUserId, 'activity.created', { type: 'activity', id: row.id }, { activityType: input.type, customerId, contactId });
  return toActivity(row);
}

/** Newest first by when it happened (then id), keyset-paginated. Removed activities are excluded. */
export async function listActivities(
  db: AppTenantDb,
  query: { customerId?: string; contactId?: string; cursor?: string; limit: number },
): Promise<{ activities: ActivityDto[]; nextCursor: string | null }> {
  const after = decodeCursor(query.cursor, 'activities', ['t', 'i'] as const);
  const where: Record<string, unknown> = { deletedAt: null };
  if (query.customerId) where.customerId = query.customerId;
  if (query.contactId) where.contactId = query.contactId;
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    where.OR = [{ occurredAt: { lt: t } }, { occurredAt: t, id: { lt: after.i } }];
  }
  const rows = (await db.activity.findMany({
    where, select, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    activities: page.map(toActivity),
    nextCursor: rows.length > query.limit && last ? encodeCursor('activities', { t: last.occurredAt.toISOString(), i: last.id }) : null,
  };
}
