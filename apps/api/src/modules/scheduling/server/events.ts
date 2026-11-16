import 'server-only';
// Events (docs/scheduling-s1.md §3.2, §4). Runs inside a tenant unit of work: the scoped client adds the
// business id, forced RLS checks it again, and composite foreign keys make a link to another business's
// calendar or customer impossible. Every mutation follows the lock protocol in ./shared.ts, so the conflict
// check and the write are one atomic step per calendar, and every edit is conditional on the version the
// caller saw.
import { randomUUID } from 'node:crypto';
import { resolveWallTime, parseWallTime, type SchedulingConflict, type SchedulingEvent as EventDto, type SchedulingResourceRef } from '@business-os/contracts';
import { ForbiddenError } from '@/modules/access';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import {
  assignableResource, BUMP, changedFields, invalid, lockCalendars, lockResources, MAX_CONFLICTS_PER_RESOURCE, MAX_EVENT_MS, MAX_RANGE_MS, UUID,
  writableCalendar, type Viewer,
} from './shared';

type Status = 'SCHEDULED' | 'CANCELLED';
type Row = {
  id: string; calendarId: string; title: string; description: string | null; location: string | null; startAt: Date; endAt: Date; status: Status;
  blocksAvailability: boolean; customerId: string | null; cancelledAt: Date | null; cancelledById: string | null; version: number;
  createdById: string; updatedById: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null;
  customer?: { id: string; displayName: string; archivedAt: Date | null } | null;
  resources: { resource: { id: string; name: string; resourceType: SchedulingResourceRef['type']; status: SchedulingResourceRef['status'] } }[];
};
const base = {
  id: true, calendarId: true, title: true, description: true, location: true, startAt: true, endAt: true, status: true, blocksAvailability: true,
  customerId: true, cancelledAt: true, cancelledById: true, version: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
  // S2: live assignments only (a removed one is history and no longer part of the event).
  resources: { where: { removedAt: null }, select: { resource: { select: { id: true, name: true, resourceType: true, status: true } } } },
} as const;
const selectFor = (viewer: Viewer) => (viewer.canReadCustomers ? { ...base, customer: { select: { id: true, displayName: true, archivedAt: true } } } : base);

const resourceRefs = (r: Row): SchedulingResourceRef[] =>
  r.resources
    .map(({ resource: x }) => ({ id: x.id, name: x.name, type: x.resourceType, status: x.status }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
const resourceIdsOf = (r: Row) => r.resources.map((x) => x.resource.id);

const toDto = (r: Row): EventDto => ({
  id: r.id, calendarId: r.calendarId, title: r.title, description: r.description, location: r.location,
  startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), status: r.status, blocksAvailability: r.blocksAvailability,
  customerId: r.customerId, customer: r.customer ? { id: r.customer.id, displayName: r.customer.displayName, archived: r.customer.archivedAt !== null } : null,
  resources: resourceRefs(r),
  cancelledAt: r.cancelledAt?.toISOString() ?? null, cancelledById: r.cancelledById, version: r.version,
  createdById: r.createdById, updatedById: r.updatedById, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});

async function load(db: AppTenantDb, viewer: Viewer, id: string): Promise<Row> {
  const row = (await db.schedulingEvent.findFirst({ where: { id }, select: selectFor(viewer) })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

// ---- time input --------------------------------------------------------------------------------

export type TimeInput = { at: string } | { local: string; timeZone: string; disambiguation?: 'earlier' | 'later' };

/** One unambiguous instant, or a 400 that says why not. Never shifts a local time silently. */
export function resolveTime(input: TimeInput, which: 'start' | 'end'): Date {
  if ('at' in input) return new Date(input.at);
  const wall = parseWallTime(input.local);
  if (!wall) invalid('invalid_input', `The ${which} time is not a real date and time.`);
  const resolved = resolveWallTime(wall, input.timeZone, input.disambiguation);
  if (resolved.ok) return new Date(resolved.instant);
  if (resolved.reason === 'nonexistent') {
    invalid('nonexistent_local_time', `The ${which} time does not exist in ${input.timeZone}: the clocks skip it. Choose another time.`);
  }
  invalid('ambiguous_local_time', `The ${which} time happens twice in ${input.timeZone} (the clocks go back). Say whether you mean the earlier or the later one.`);
}

function checkInterval(start: Date, end: Date) {
  if (end.getTime() <= start.getTime()) invalid('invalid_interval', 'The end must be after the start.');
  if (end.getTime() - start.getTime() > MAX_EVENT_MS) invalid('duration_too_long', 'An event can last at most 31 days.');
}

// ---- conflicts ---------------------------------------------------------------------------------

/**
 * Blocking events on `calendarId` overlapping [start, end): active (not archived), SCHEDULED, and
 * blocks_availability, with existing.start_at < end AND existing.end_at > start (half-open: touching
 * intervals do not overlap). The start bound uses the 31-day maximum so the scan stays on the
 * (business_id, calendar_id, start_at) index.
 */
export async function findConflicts(db: AppTenantDb, calendarId: string, start: Date, end: Date, excludeEventId?: string, blocking = false): Promise<SchedulingConflict[]> {
  const rows = (await db.schedulingEvent.findMany({
    where: {
      calendarId, archivedAt: null, status: 'SCHEDULED', blocksAvailability: true,
      startAt: { lt: end, gt: new Date(start.getTime() - MAX_EVENT_MS - 1) }, endAt: { gt: start },
      ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
    },
    select: { id: true, calendarId: true, title: true, startAt: true, endAt: true },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    take: 50,
  } as never)) as { id: string; calendarId: string; title: string; startAt: Date; endAt: Date }[];
  return rows.map((r) => ({
    kind: 'calendar' as const, eventId: r.id, calendarId: r.calendarId, title: r.title, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(),
    resource: null, blocking,
  }));
}

/**
 * S2 (docs/scheduling-s2.md §4): occupying events that hold any of `resourceIds` and overlap [start, end).
 * Occupying = SCHEDULED, not archived, blocks_availability, and a live (not removed) assignment of the
 * resource. Same half-open rule as calendars. One entry per (resource, event), at most `perResource` per
 * resource (earliest first); `occupied` lists every resource with at least one, however many are cut.
 * Computed from the events and assignments themselves: there is no availability ledger. The start bound
 * uses the 31-day maximum so the event side stays index-bounded.
 */
export async function findResourceConflicts(
  db: AppTenantDb, resourceIds: string[], start: Date, end: Date, opts: { excludeEventId?: string; blocking?: boolean; perResource?: number } = {},
): Promise<SchedulingConflict[]> {
  const ids = [...new Set(resourceIds.map((i) => i.toLowerCase()))];
  if (ids.length === 0) return [];
  const exclude = opts.excludeEventId ?? null;
  const rows = await db.$queryRaw<{ resource_id: string; resource_name: string; event_id: string; calendar_id: string; title: string; start_at: Date; end_at: Date }[]>`
    SELECT resource_id, resource_name, event_id, calendar_id, title, start_at, end_at FROM (
      SELECT a.resource_id::text AS resource_id, r.name AS resource_name, e.id::text AS event_id, e.calendar_id::text AS calendar_id,
             e.title, e.start_at, e.end_at,
             row_number() OVER (PARTITION BY a.resource_id ORDER BY e.start_at, e.id) AS n
      FROM scheduling_event_resources a
      JOIN scheduling_events e ON e.business_id = a.business_id AND e.id = a.event_id
      JOIN scheduling_resources r ON r.business_id = a.business_id AND r.id = a.resource_id
      WHERE a.business_id = nullif(current_setting('app.business_id', true), '')::uuid
        AND a.removed_at IS NULL AND a.resource_id = ANY(${ids}::uuid[])
        AND e.status = 'SCHEDULED' AND e.archived_at IS NULL AND e.blocks_availability
        AND e.start_at < ${end} AND e.start_at > ${new Date(start.getTime() - MAX_EVENT_MS - 1)} AND e.end_at > ${start}
        AND (${exclude}::uuid IS NULL OR e.id <> ${exclude}::uuid)
    ) x
    WHERE n <= ${opts.perResource ?? MAX_CONFLICTS_PER_RESOURCE}
    ORDER BY resource_name, resource_id, start_at, event_id`;
  return rows.map((r) => ({
    kind: 'resource' as const, eventId: r.event_id, calendarId: r.calendar_id, title: r.title,
    startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString(),
    resource: { id: r.resource_id, name: r.resource_name }, blocking: opts.blocking ?? false,
  }));
}

const uniqueIds = (ids: string[] | undefined) => [...new Set((ids ?? []).map((i) => i.toLowerCase()))];
const withBlocking = (conflicts: SchedulingConflict[], blocking: boolean) => conflicts.map((c) => ({ ...c, blocking }));

/** Audit for an overlap kept on purpose (enforceConflicts false): ids and counts only, never text. */
async function auditAcceptedOverlap(db: AppTenantDb, actorUserId: string, id: string, conflicts: SchedulingConflict[]) {
  if (conflicts.length === 0) return;
  const calendar = conflicts.filter((c) => c.kind === 'calendar');
  const resource = conflicts.filter((c) => c.kind === 'resource');
  await recordAudit(db, actorUserId, 'scheduling.event.overlap_accepted', { type: 'scheduling_event', id }, {
    calendarOverlaps: String(calendar.length), resourceOverlaps: String(resource.length),
    eventIds: [...new Set(conflicts.map((c) => c.eventId))].sort(), resourceIds: [...new Set(resource.map((c) => c.resource!.id))].sort(),
  });
}

/** The outcome of a write: written (with any overlaps it was allowed to make), or refused with nothing written. */
export type WriteResult = { kind: 'written'; event: EventDto; conflicts: SchedulingConflict[] } | { kind: 'conflict'; conflicts: SchedulingConflict[] };

async function checkCustomer(db: AppTenantDb, viewer: Viewer, customerId: string) {
  if (!viewer.canReadCustomers) throw new ForbiddenError();
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
  if (!customer) throw new RecordNotFoundError();
  if (customer.archivedAt) throw new StateConflictError('archived_reference');
}

export type EventInput = {
  calendarId?: string; title?: string; description?: string | null; location?: string | null; start?: TimeInput; end?: TimeInput;
  blocksAvailability?: boolean; customerId?: string | null; enforceConflicts: boolean;
  /** S2: the event's resources (create: initial set; edit: complete new set, undefined keeps the current one). */
  resourceIds?: string[];
};

export async function createEvent(db: AppTenantDb, viewer: Viewer, actorUserId: string, input: EventInput & { calendarId: string; title: string; start: TimeInput; end: TimeInput }): Promise<WriteResult> {
  const startAt = resolveTime(input.start, 'start');
  const endAt = resolveTime(input.end, 'end');
  checkInterval(startAt, endAt);
  if (input.customerId) await checkCustomer(db, viewer, input.customerId);
  const blocks = input.blocksAvailability ?? true;

  const resourceIds = uniqueIds(input.resourceIds);

  // Lock protocol (shared.ts): calendar, then resources, then the checks and the writes.
  writableCalendar(await lockCalendars(db, [input.calendarId]), input.calendarId);
  const resources = await lockResources(db, resourceIds);
  for (const r of resourceIds) assignableResource(resources, r);
  const conflicts = blocks
    ? [...(await findConflicts(db, input.calendarId, startAt, endAt)), ...(await findResourceConflicts(db, resourceIds, startAt, endAt))]
    : [];
  // One override for both kinds (D-S2-4): an enforced write refuses any overlap, and nothing is written.
  if (conflicts.length > 0 && input.enforceConflicts) return { kind: 'conflict', conflicts: withBlocking(conflicts, true) };

  const id = randomUUID();
  await db.schedulingEvent.create({
    data: {
      id, calendarId: input.calendarId, title: input.title, description: input.description ?? null, location: input.location ?? null,
      startAt, endAt, blocksAvailability: blocks, customerId: input.customerId ?? null, createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  if (resourceIds.length > 0) {
    await db.schedulingEventResource.createMany({
      data: resourceIds.map((resourceId) => ({ id: randomUUID(), eventId: id, resourceId, createdById: actorUserId })) as never,
    });
  }
  // Structured facts only: no title, description or location (they may hold customer details).
  await recordAudit(db, actorUserId, 'scheduling.event.created', { type: 'scheduling_event', id }, {
    calendarId: input.calendarId, customerId: input.customerId ?? null, blocksAvailability: String(blocks),
    enforced: String(input.enforceConflicts), overlaps: String(conflicts.length), resources: String(resourceIds.length),
  });
  if (resourceIds.length > 0) {
    await recordAudit(db, actorUserId, 'scheduling.event.resources_changed', { type: 'scheduling_event', id }, { added: [...resourceIds].sort(), removed: [] });
  }
  await auditAcceptedOverlap(db, actorUserId, id, conflicts);
  return { kind: 'written', event: toDto(await load(db, viewer, id)), conflicts: withBlocking(conflicts, false) };
}

export async function getEvent(db: AppTenantDb, viewer: Viewer, id: string) {
  const row = await load(db, viewer, id);
  const active = row.status === 'SCHEDULED' && row.archivedAt === null && row.blocksAvailability;
  if (!active) return { event: toDto(row), conflicts: [] };
  return {
    event: toDto(row),
    conflicts: [
      ...(await findConflicts(db, row.calendarId, row.startAt, row.endAt, row.id)),
      ...(await findResourceConflicts(db, resourceIdsOf(row), row.startAt, row.endAt, { excludeEventId: row.id })),
    ],
  };
}

/** Lock protocol step 3: the event row, after the calendar locks, at the version the caller saw. */
async function lockEvent(db: AppTenantDb, id: string, version: number, calendarId: string) {
  const rows = await db.$queryRaw<{ version: number; calendar_id: string }[]>`
    SELECT version, calendar_id::text FROM scheduling_events
    WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new RecordNotFoundError();
  // Moved or changed since it was read (before the locks): the caller must reload.
  if (row.version !== version || row.calendar_id !== calendarId) throw new StateConflictError('stale');
}

/** The fields whose change can create a conflict. Only these trigger the check on an edit. */
const AVAILABILITY_FIELDS = ['calendarId', 'startAt', 'endAt', 'blocksAvailability'];
/** The fields whose change re-checks every resource the event keeps (S2). */
const RESOURCE_TIME_FIELDS = ['startAt', 'endAt', 'blocksAvailability'];

/**
 * Edits a scheduled event: details, times, blocking, customer link, or a move to another active calendar.
 * Cancelled and archived events, and events on an archived calendar, are read-only. The conflict check runs
 * when the change affects availability (time, calendar, or blocking switched on) and the result blocks.
 */
export async function updateEvent(db: AppTenantDb, viewer: Viewer, actorUserId: string, id: string, patch: EventInput & { version: number }): Promise<WriteResult> {
  const before = await load(db, viewer, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.status !== 'SCHEDULED') throw new StateConflictError('not_scheduled');
  if (before.version !== patch.version) throw new StateConflictError('stale');

  const data: Record<string, unknown> = {};
  for (const key of ['title', 'description', 'location', 'blocksAvailability', 'calendarId'] as const) if (patch[key] !== undefined) data[key] = patch[key];
  if (patch.start) data.startAt = resolveTime(patch.start, 'start');
  if (patch.end) data.endAt = resolveTime(patch.end, 'end');
  const startAt = (data.startAt as Date | undefined) ?? before.startAt;
  const endAt = (data.endAt as Date | undefined) ?? before.endAt;
  checkInterval(startAt, endAt);
  if (patch.customerId !== undefined && patch.customerId !== before.customerId) {
    if (patch.customerId) await checkCustomer(db, viewer, patch.customerId);
    else if (!viewer.canReadCustomers) throw new ForbiddenError(); // unlinking is a customer decision too
    data.customerId = patch.customerId;
  }
  const { customer: _customer, resources: _resources, ...comparable } = before;
  void _customer;
  void _resources;
  const fields = changedFields(comparable as unknown as Record<string, unknown>, data);

  // S2: the resource set. `resourceIds` is the complete new set; undefined keeps the current one.
  const beforeIds = resourceIdsOf(before);
  const afterIds = patch.resourceIds === undefined ? beforeIds : uniqueIds(patch.resourceIds);
  const added = afterIds.filter((r) => !beforeIds.includes(r));
  const removed = beforeIds.filter((r) => !afterIds.includes(r));
  if (added.length > 0 || removed.length > 0) fields.push('resourceIds');
  fields.sort();
  if (fields.length === 0) return { kind: 'written', ...(await getEvent(db, viewer, id)) };

  const calendarId = (data.calendarId as string | undefined) ?? before.calendarId;
  const locked = await lockCalendars(db, [before.calendarId, calendarId]);
  writableCalendar(locked, before.calendarId);
  writableCalendar(locked, calendarId);
  // Every resource the write touches: kept, added and removed (removing frees time, so it serialises too).
  const resources = await lockResources(db, [...beforeIds, ...afterIds]);
  for (const r of added) assignableResource(resources, r);
  // Also proves the assignment set read above is unchanged (assignments change only with a version bump).
  await lockEvent(db, id, patch.version, before.calendarId);

  const blocks = (data.blocksAvailability as boolean | undefined) ?? before.blocksAvailability;
  const affectsAvailability = blocks && fields.some((f) => AVAILABILITY_FIELDS.includes(f));
  // Resources are business-wide: a calendar move alone does not change their occupancy. A new time or
  // switching blocking on re-checks every resource; otherwise only the newly added ones are checked.
  const retimed = fields.some((f) => RESOURCE_TIME_FIELDS.includes(f));
  const resourcesToCheck = blocks ? (retimed ? afterIds : added) : [];
  const conflicts = [
    ...(affectsAvailability ? await findConflicts(db, calendarId, startAt, endAt, id) : []),
    ...(await findResourceConflicts(db, resourcesToCheck, startAt, endAt, { excludeEventId: id })),
  ];
  if (conflicts.length > 0 && patch.enforceConflicts) return { kind: 'conflict', conflicts: withBlocking(conflicts, true) };

  // The version bumps on every change, a resource-only change included.
  const result = await db.schedulingEvent.updateMany({
    where: { id, version: patch.version, status: 'SCHEDULED', archivedAt: null }, data: { ...data, ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  if (removed.length > 0) {
    await db.schedulingEventResource.updateMany({
      where: { eventId: id, resourceId: { in: removed }, removedAt: null }, data: { removedAt: new Date(), removedById: actorUserId } as never,
    });
  }
  if (added.length > 0) {
    await db.schedulingEventResource.createMany({
      data: added.map((resourceId) => ({ id: randomUUID(), eventId: id, resourceId, createdById: actorUserId })) as never,
    });
  }
  await recordAudit(db, actorUserId, 'scheduling.event.updated', { type: 'scheduling_event', id }, {
    fields, enforced: String(patch.enforceConflicts), overlaps: String(conflicts.length),
  });
  if (fields.includes('calendarId')) {
    await recordAudit(db, actorUserId, 'scheduling.event.moved', { type: 'scheduling_event', id }, { from: before.calendarId, to: calendarId });
  }
  if (added.length > 0 || removed.length > 0) {
    await recordAudit(db, actorUserId, 'scheduling.event.resources_changed', { type: 'scheduling_event', id }, { added: [...added].sort(), removed: [...removed].sort() });
  }
  await auditAcceptedOverlap(db, actorUserId, id, conflicts);
  return { kind: 'written', event: toDto(await load(db, viewer, id)), conflicts: withBlocking(conflicts, false) };
}

/**
 * Cancels a scheduled event. The row is kept (status CANCELLED, who and when), and so are its resource
 * assignments (history); it stops occupying the calendar and its resources at once, under their locks, so a booking waiting for that slot sees it free when it runs.
 */
export async function cancelEvent(db: AppTenantDb, viewer: Viewer, actorUserId: string, id: string, version: number) {
  const before = await load(db, viewer, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.status !== 'SCHEDULED') throw new StateConflictError('not_scheduled');
  writableCalendar(await lockCalendars(db, [before.calendarId]), before.calendarId);
  await lockResources(db, resourceIdsOf(before)); // frees their time: serialised like any booking of them
  await lockEvent(db, id, version, before.calendarId);
  const result = await db.schedulingEvent.updateMany({
    where: { id, version, status: 'SCHEDULED', archivedAt: null },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actorUserId, ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'scheduling.event.cancelled', { type: 'scheduling_event', id }, { calendarId: before.calendarId });
  return { event: toDto(await load(db, viewer, id)), conflicts: [] };
}

/** Archives a scheduled or cancelled event: hidden from ordinary views, kept as history, read-only. */
export async function archiveEvent(db: AppTenantDb, viewer: Viewer, actorUserId: string, id: string, version: number) {
  const before = await load(db, viewer, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  writableCalendar(await lockCalendars(db, [before.calendarId]), before.calendarId);
  await lockResources(db, resourceIdsOf(before));
  await lockEvent(db, id, version, before.calendarId);
  const result = await db.schedulingEvent.updateMany({ where: { id, version, archivedAt: null }, data: { archivedAt: new Date(), ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'scheduling.event.archived', { type: 'scheduling_event', id }, { calendarId: before.calendarId, status: before.status });
  return { event: toDto(await load(db, viewer, id)), conflicts: [] };
}

export type EventQuery = { from: string; to: string; calendarId?: string; resourceId?: string; status: 'scheduled' | 'cancelled' | 'all'; cursor?: string; limit: number };

/**
 * Events overlapping [from, to), at most 62 days, ordered by start then id, keyset-paginated. Archived
 * events never appear. Without a calendar, events on archived calendars are left out too; naming an
 * archived calendar shows its (read-only) events.
 */
export async function listEvents(db: AppTenantDb, viewer: Viewer, query: EventQuery) {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (to.getTime() <= from.getTime()) invalid('invalid_range', 'The end of the range must be after its start.');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) invalid('range_too_long', 'Ask for at most 62 days at a time.');
  const where: Record<string, unknown>[] = [
    { archivedAt: null }, { startAt: { lt: to, gt: new Date(from.getTime() - MAX_EVENT_MS - 1) } }, { endAt: { gt: from } },
  ];
  if (query.calendarId) {
    if (!(await db.schedulingCalendar.findFirst({ where: { id: query.calendarId }, select: { id: true } }))) throw new RecordNotFoundError();
    where.push({ calendarId: query.calendarId });
  } else {
    where.push({ calendar: { archivedAt: null } });
  }
  if (query.resourceId) {
    if (!(await db.schedulingResource.findFirst({ where: { id: query.resourceId }, select: { id: true } }))) throw new RecordNotFoundError();
    where.push({ resources: { some: { resourceId: query.resourceId, removedAt: null } } });
  }
  if (query.status !== 'all') where.push({ status: query.status === 'scheduled' ? 'SCHEDULED' : 'CANCELLED' });
  // S1's list key is unchanged when no resource is named, so cursors issued before S2 stay valid.
  const list = `scheduling-events:${query.from}:${query.to}:${query.calendarId ?? '*'}:${query.status}${query.resourceId ? `:r:${query.resourceId}` : ''}`;
  const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ startAt: { gt: t } }, { startAt: t, id: { gt: after.i } }] });
  }
  const rows = (await db.schedulingEvent.findMany({
    where: { AND: where }, select: selectFor(viewer), orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  } as never)) as unknown as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { events: page.map(toDto), nextCursor: rows.length > query.limit && last ? encodeCursor(list, { t: last.startAt.toISOString(), i: last.id }) : null };
}

/** Advisory availability for a proposed interval on one calendar (no lock: an enforced write is the guarantee). */
export async function checkAvailability(db: AppTenantDb, query: { calendarId: string; start: string; end: string; excludeEventId?: string }) {
  const start = new Date(query.start);
  const end = new Date(query.end);
  checkInterval(start, end);
  if (!(await db.schedulingCalendar.findFirst({ where: { id: query.calendarId }, select: { id: true } }))) throw new RecordNotFoundError();
  const conflicts = await findConflicts(db, query.calendarId, start, end, query.excludeEventId);
  return { available: conflicts.length === 0, conflicts };
}
