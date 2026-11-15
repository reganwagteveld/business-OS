import 'server-only';
// Activity timeline (data-model §4.7, docs/communications-c1.md): the business-facing history of
// customers and contacts. Not the security audit log. User activities are logged by people; system
// activities are written by the owning module in the same unit of work as the change they describe;
// message entries are written by the communications module when a message is recorded.
//
// This module is the single authority for the timeline. Visibility (restricted notes, message
// entries) is enforced here, in one place (visibleTo), for every read.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Activity as ActivityDto } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { recordAudit } from '@/core/audit';
import { ForbiddenError } from '@/modules/access';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Types a person can log, and the system types this module knows. Unknown types are rejected. */
export const USER_ACTIVITY_TYPES = ['note', 'call', 'meeting', 'email', 'interaction'] as const;
export type UserActivityType = (typeof USER_ACTIVITY_TYPES)[number];
export const SYSTEM_ACTIVITY_TYPES = [
  'customer.created', 'customer.updated', 'customer.archived', 'customer.restored', 'customer.primary_contact_changed',
  'contact.created', 'contact.updated', 'contact.archived', 'contact.restored', 'contact.customer_changed', 'contact.customer_removed',
] as const;
export type SystemActivityType = (typeof SYSTEM_ACTIVITY_TYPES)[number];
/** The timeline entry of one recorded message (written only through recordMessageActivity). */
export const MESSAGE_ACTIVITY_TYPE = 'message.recorded' as const;

// ---- type registry: every type has a zod schema for its `data` payload (implementation plan 1d) ----
const Direction = z.enum(['INBOUND', 'OUTBOUND']);
const SystemData = z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()]));
const DATA_SCHEMAS: Record<string, z.ZodType> = {
  note: z.object({}).strict(),
  meeting: z.object({}).strict(),
  call: z.object({ direction: Direction.optional() }).strict(),
  email: z.object({ direction: Direction.optional() }).strict(),
  interaction: z.object({ channel: z.enum(['SMS', 'CHAT', 'SOCIAL', 'IN_PERSON', 'OTHER']), direction: Direction.optional() }).strict(),
  ...Object.fromEntries(SYSTEM_ACTIVITY_TYPES.map((t) => [t, SystemData])),
  [MESSAGE_ACTIVITY_TYPE]: z.object({
    direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']),
    channel: z.enum(['EMAIL', 'PHONE', 'SMS', 'CHAT', 'SOCIAL', 'IN_PERSON', 'OTHER']),
    source: z.enum(['MANUAL', 'IMPORT']),
  }).strict(),
};
export const KNOWN_ACTIVITY_TYPES: readonly string[] = Object.keys(DATA_SCHEMAS);

/** Validates a payload against its type's schema; an unregistered type or invalid payload is a programming error. */
export function checkActivityData(type: string, data: unknown): Record<string, unknown> {
  const schema = DATA_SCHEMAS[type];
  if (!schema) throw new TypeError(`Unregistered activity type: ${type}`);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new TypeError(`Invalid payload for activity type ${type}`);
  return parsed.data as Record<string, unknown>;
}

const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000; // a meeting can be logged ahead, but not years ahead

/** Who is reading. Built by the route from the verified actor, never from input. */
export interface ActivityViewer {
  userId: string;
  /** activity:read_restricted: may see RESTRICTED notes written by others. */
  canReadRestricted: boolean;
  /** communications:read: may see message entries. */
  canReadMessages: boolean;
}

type Row = {
  id: string; type: string; occurredAt: Date; actorType: 'USER' | 'SYSTEM' | 'AI'; actorUserId: string | null;
  customerId: string | null; contactId: string | null; subject: string | null; body: string | null; data: unknown; createdAt: Date;
  visibility: string; editedAt: Date | null; conversationId: string | null; messageId: string | null; deletedAt: Date | null;
};
const select = {
  id: true, type: true, occurredAt: true, actorType: true, actorUserId: true, customerId: true, contactId: true,
  subject: true, body: true, data: true, createdAt: true, visibility: true, editedAt: true, conversationId: true, messageId: true, deletedAt: true,
} as const;

export function toActivity(r: Row): ActivityDto {
  return {
    id: r.id, type: r.type, occurredAt: r.occurredAt.toISOString(), actorType: r.actorType, actorUserId: r.actorUserId,
    customerId: r.customerId, contactId: r.contactId, subject: r.subject, body: r.body,
    data: (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>, createdAt: r.createdAt.toISOString(),
    visibility: r.visibility === 'RESTRICTED' ? 'RESTRICTED' : 'STANDARD', editedAt: r.editedAt?.toISOString() ?? null,
    conversationId: r.conversationId, messageId: r.messageId,
  };
}

/** The one visibility rule (docs/communications-c1.md §4), as a Prisma filter used by every read. */
function visibleTo(viewer: ActivityViewer): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [{ deletedAt: null }];
  if (!viewer.canReadRestricted) rules.push({ OR: [{ visibility: 'STANDARD' }, { actorUserId: viewer.userId }] });
  if (!viewer.canReadMessages) rules.push({ type: { not: MESSAGE_ACTIVITY_TYPE } });
  return rules;
}

/**
 * The customer/contact an entry is filed under, by the rules of data-model §4.7: both must exist in
 * this business (scoped lookup, RLS and composite FKs agree) and not be archived; a contact that
 * belongs to a customer files the entry under that customer (at the time of writing), and a
 * different customer supplied with it is rejected. Shared with the communications module.
 */
export async function resolveSubject(
  db: AppTenantDb,
  link: { customerId?: string | null; contactId?: string | null },
): Promise<{ customerId: string | null; contactId: string | null }> {
  let customerId = link.customerId ?? null;
  const contactId = link.contactId ?? null;
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
  return { customerId, contactId };
}

/** Refuses a change to an entry whose customer or contact is archived (archived records are read-only). */
async function assertSubjectsActive(db: AppTenantDb, row: { customerId: string | null; contactId: string | null }) {
  if (row.customerId) {
    const c = await db.customer.findFirst({ where: { id: row.customerId }, select: { archivedAt: true } });
    if (c?.archivedAt) throw new StateConflictError('archived_reference');
  }
  if (row.contactId) {
    const c = await db.contact.findFirst({ where: { id: row.contactId }, select: { archivedAt: true } });
    if (c?.archivedAt) throw new StateConflictError('archived_reference');
  }
}

/**
 * System activity attributed to the person whose action caused it. Called by the owning module
 * inside its unit of work, so the activity and the change commit or roll back together. Only
 * registered system types are accepted; clients can never write these.
 */
export async function recordSystemActivity(
  db: AppTenantDb,
  actorUserId: string,
  type: SystemActivityType,
  link: { customerId?: string | null; contactId?: string | null },
  data: Record<string, string | string[] | null> = {},
): Promise<void> {
  if (!(SYSTEM_ACTIVITY_TYPES as readonly string[]).includes(type)) throw new TypeError(`Unregistered system activity type: ${type}`);
  await db.activity.create({
    data: {
      id: randomUUID(), type, occurredAt: new Date(), actorType: 'USER', actorUserId,
      customerId: link.customerId ?? null, contactId: link.contactId ?? null, data: checkActivityData(type, data),
    } as never,
  });
}

/**
 * The timeline entry of one recorded message, for the communications module only. Written in the
 * same unit of work as the message. It carries no copy of the message content: the timeline shows
 * the message through the composite FK (conversation_id, message_id).
 */
export async function recordMessageActivity(
  db: AppTenantDb,
  actorUserId: string,
  entry: {
    conversationId: string; messageId: string; customerId: string | null; contactId: string | null; occurredAt: Date;
    direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL'; channel: string; source: 'MANUAL' | 'IMPORT';
  },
): Promise<void> {
  await db.activity.create({
    data: {
      id: randomUUID(), type: MESSAGE_ACTIVITY_TYPE, occurredAt: entry.occurredAt, actorType: 'USER', actorUserId,
      customerId: entry.customerId, contactId: entry.contactId, conversationId: entry.conversationId, messageId: entry.messageId,
      data: checkActivityData(MESSAGE_ACTIVITY_TYPE, { direction: entry.direction, channel: entry.channel, source: entry.source }),
    } as never,
  });
}

/**
 * A person logs a note, call, meeting, email or other interaction against a customer and/or contact.
 * Logging records that something happened; it never sends anything and never claims Business OS did.
 */
export async function createActivity(
  db: AppTenantDb,
  actorUserId: string,
  input: {
    type: UserActivityType; occurredAt?: string; customerId?: string; contactId?: string; subject?: string | null; body?: string | null;
    visibility?: 'STANDARD' | 'RESTRICTED'; direction?: 'INBOUND' | 'OUTBOUND'; channel?: 'SMS' | 'CHAT' | 'SOCIAL' | 'IN_PERSON' | 'OTHER';
  },
): Promise<ActivityDto> {
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (occurredAt.getTime() > Date.now() + MAX_FUTURE_MS) throw new RuleViolationError('invalid_date', 'The date is too far in the future.');
  const visibility = input.visibility ?? 'STANDARD';
  if (visibility === 'RESTRICTED' && input.type !== 'note') throw new RuleViolationError('invalid_visibility', 'Only notes can be restricted.');
  const { customerId, contactId } = await resolveSubject(db, input);
  const payload: Record<string, unknown> = {};
  if (input.direction) payload.direction = input.direction;
  if (input.channel) payload.channel = input.channel;
  let data: Record<string, unknown>;
  try {
    data = checkActivityData(input.type, payload);
  } catch {
    throw new RuleViolationError('invalid_input', 'These details do not fit this kind of activity.');
  }

  const row = (await db.activity.create({
    data: {
      id: randomUUID(), type: input.type, occurredAt, actorType: 'USER', actorUserId, customerId, contactId,
      subject: input.subject ?? null, body: input.body ?? null, data, visibility,
    } as never,
    select,
  })) as Row;
  // Security audit in the same unit of work: who logged what kind of entry where. No subject or
  // body (business content, possibly personal data) goes into the audit log (data-model §4.8).
  await recordAudit(db, actorUserId, 'activity.created', { type: 'activity', id: row.id }, {
    activityType: input.type, customerId, contactId, ...(visibility === 'RESTRICTED' ? { visibility } : {}),
  });
  return toActivity(row);
}

/** One entry the viewer may see; anything else (another business, removed, restricted, message without access) is 404. */
async function visibleRow(db: AppTenantDb, viewer: ActivityViewer, id: string): Promise<Row> {
  const row = (await db.activity.findFirst({ where: { id, AND: visibleTo(viewer) }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export async function getActivity(db: AppTenantDb, viewer: ActivityViewer, id: string): Promise<ActivityDto> {
  return toActivity(await visibleRow(db, viewer, id));
}

/**
 * The author edits a note's subject or text. Only notes, only the author, only while the note is
 * live and its customer/contact is not archived. edited_at is stamped by the database; type, links,
 * visibility and authorship cannot change (column grants and the activities_guard_update trigger).
 */
export async function updateNote(
  db: AppTenantDb,
  viewer: ActivityViewer,
  id: string,
  patch: { subject?: string | null; body?: string | null },
): Promise<ActivityDto> {
  const row = await visibleRow(db, viewer, id);
  if (row.type !== 'note' || row.actorType !== 'USER') throw new StateConflictError('immutable');
  if (row.actorUserId !== viewer.userId) throw new ForbiddenError();
  await assertSubjectsActive(db, row);
  const subject = patch.subject !== undefined ? patch.subject : row.subject;
  const body = patch.body !== undefined ? patch.body : row.body;
  if (!subject && !body) throw new RuleViolationError('invalid_input', 'Add a subject or some text');
  const fields = (['subject', 'body'] as const).filter((k) => patch[k] !== undefined && patch[k] !== row[k]);
  if (fields.length === 0) return toActivity(row);
  await db.activity.updateMany({ where: { id, deletedAt: null }, data: { subject, body } });
  const updated = (await db.activity.findFirst({ where: { id }, select })) as Row;
  await recordAudit(db, viewer.userId, 'activity.updated', { type: 'activity', id }, { activityType: row.type, fields: [...fields] });
  return toActivity(updated);
}

/**
 * The author removes their own user-entered activity (soft delete; it leaves every timeline). System
 * and message entries cannot be removed (409 immutable; the database refuses too, CM003).
 */
export async function removeActivity(db: AppTenantDb, viewer: ActivityViewer, id: string): Promise<ActivityDto> {
  const row = await visibleRow(db, viewer, id);
  if (!(USER_ACTIVITY_TYPES as readonly string[]).includes(row.type) || row.actorType !== 'USER') throw new StateConflictError('immutable');
  if (row.actorUserId !== viewer.userId) throw new ForbiddenError();
  await assertSubjectsActive(db, row);
  await db.activity.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
  const updated = (await db.activity.findFirst({ where: { id }, select })) as Row;
  await recordAudit(db, viewer.userId, 'activity.removed', { type: 'activity', id }, { activityType: row.type });
  return toActivity(updated);
}

/**
 * The unified timeline, newest first by when it happened (then id), keyset-paginated. Without a
 * customer or contact it is the whole business's timeline. Removed entries, restricted notes the
 * viewer may not see, and message entries without communications:read are excluded.
 */
export async function listActivities(
  db: AppTenantDb,
  viewer: ActivityViewer,
  query: { customerId?: string; contactId?: string; types?: string[]; visibility?: 'all' | 'standard' | 'restricted'; cursor?: string; limit: number },
): Promise<{ activities: ActivityDto[]; nextCursor: string | null }> {
  const after = decodeCursor(query.cursor, 'activities', ['t', 'i'] as const);
  const and: Record<string, unknown>[] = visibleTo(viewer);
  if (query.customerId) and.push({ customerId: query.customerId });
  if (query.contactId) and.push({ contactId: query.contactId });
  if (query.types) {
    const unknown = query.types.filter((t) => !KNOWN_ACTIVITY_TYPES.includes(t));
    if (unknown.length > 0) throw new RuleViolationError('invalid_type', 'One of the activity types is not known.');
    and.push({ type: { in: [...new Set(query.types)] } });
  }
  if (query.visibility === 'standard') and.push({ visibility: 'STANDARD' });
  if (query.visibility === 'restricted') and.push({ visibility: 'RESTRICTED' });
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    and.push({ OR: [{ occurredAt: { lt: t } }, { occurredAt: t, id: { lt: after.i } }] });
  }
  const rows = (await db.activity.findMany({
    where: { AND: and }, select, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    activities: page.map(toActivity),
    nextCursor: rows.length > query.limit && last ? encodeCursor('activities', { t: last.occurredAt.toISOString(), i: last.id }) : null,
  };
}
