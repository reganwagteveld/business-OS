import 'server-only';
// Resources (docs/scheduling-s2.md §2–4): people, rooms, equipment and anything else an event can occupy.
// Runs inside a tenant unit of work: the scoped client adds the business id, forced RLS checks it again.
// Lifecycle changes UPDATE the resource row, which waits for bookings in flight (they hold it FOR SHARE,
// lock protocol step 3 in ./shared.ts) and makes later bookings read the new status under their lock.
// Assignments are never written here: only event writes (./events.ts) assign or remove resources.
import { randomUUID } from 'node:crypto';
import type { SchedulingConflict, SchedulingResource as ResourceDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { findConflicts, findResourceConflicts } from './events';
import { BUMP, changedFields, invalid, MAX_EVENT_MS, UUID } from './shared';

type Type = ResourceDto['type'];
type Status = ResourceDto['status'];
type Row = {
  id: string; name: string; description: string | null; resourceType: Type; status: Status; colour: string | null; version: number;
  createdById: string; updatedById: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null;
};
const select = {
  id: true, name: true, description: true, resourceType: true, status: true, colour: true, version: true,
  createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;

const toDto = (r: Row): ResourceDto => ({
  id: r.id, name: r.name, description: r.description, type: r.resourceType, status: r.status, colour: r.colour, version: r.version,
  createdById: r.createdById, updatedById: r.updatedById, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});

async function load(db: AppTenantDb, id: string): Promise<Row> {
  const row = (await db.schedulingResource.findFirst({ where: { id }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** Scheduled, blocking, active events that still hold the resource and have not ended yet. */
async function upcomingBookings(db: AppTenantDb, resourceId: string): Promise<number> {
  return db.schedulingEventResource.count({
    where: { resourceId, removedAt: null, event: { status: 'SCHEDULED', archivedAt: null, blocksAvailability: true, endAt: { gt: new Date() } } },
  } as never);
}

async function respond(db: AppTenantDb, id: string) {
  return { resource: toDto(await load(db, id)), upcomingBookings: await upcomingBookings(db, id) };
}

export type ResourceInput = { name?: string; description?: string | null; colour?: string | null; type?: Type };

/** A new resource is ACTIVE. Names need not be unique (two sites may each have a "Room 1"). */
export async function createResource(db: AppTenantDb, actorUserId: string, input: ResourceInput & { name: string; type: Type }) {
  const id = randomUUID();
  await db.schedulingResource.create({
    data: {
      id, name: input.name, description: input.description ?? null, colour: input.colour ?? null, resourceType: input.type,
      createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  // Names and descriptions stay out of the audit log.
  await recordAudit(db, actorUserId, 'scheduling.resource.created', { type: 'scheduling_resource', id }, { resourceType: input.type });
  return respond(db, id);
}

export async function getResource(db: AppTenantDb, id: string) {
  return respond(db, id);
}

/**
 * Edits details and the type, or switches ACTIVE ⇄ INACTIVE. Existing bookings keep the resource either
 * way (history is never rewritten); an INACTIVE resource only stops receiving new assignments. Archived
 * resources are read-only: restore first.
 */
export async function updateResource(db: AppTenantDb, actorUserId: string, id: string, patch: ResourceInput & { status?: 'ACTIVE' | 'INACTIVE'; version: number }) {
  const before = await load(db, id);
  if (before.status === 'ARCHIVED') throw new StateConflictError('archived');
  if (before.version !== patch.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'colour', 'status'] as const) if (patch[key] !== undefined) data[key] = patch[key];
  if (patch.type !== undefined) data.resourceType = patch.type;
  const fields = changedFields(before as unknown as Record<string, unknown>, data);
  if (fields.length === 0) return respond(db, id);
  const result = await db.schedulingResource.updateMany({
    where: { id, version: patch.version, status: { not: 'ARCHIVED' } }, data: { ...data, ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError((await load(db, id)).status === 'ARCHIVED' ? 'archived' : 'stale');
  const details = fields.filter((f) => f !== 'status').map((f) => (f === 'resourceType' ? 'type' : f));
  if (details.length > 0) await recordAudit(db, actorUserId, 'scheduling.resource.updated', { type: 'scheduling_resource', id }, { fields: details });
  if (fields.includes('status')) {
    await recordAudit(db, actorUserId, 'scheduling.resource.status_changed', { type: 'scheduling_resource', id }, { from: before.status, to: patch.status! });
  }
  return respond(db, id);
}

/**
 * Retires a resource: hidden from the picker and the directory's default list, read-only, and it can no
 * longer be newly assigned. Events already holding it keep it (and it keeps occupying their time); the
 * response says how many upcoming ones there are, so they can be moved. Never deleted.
 */
export async function archiveResource(db: AppTenantDb, actorUserId: string, id: string, version: number) {
  const before = await load(db, id);
  if (before.status === 'ARCHIVED') throw new StateConflictError('archived');
  const result = await db.schedulingResource.updateMany({
    where: { id, version, status: { not: 'ARCHIVED' } }, data: { status: 'ARCHIVED', archivedAt: new Date(), ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError((await load(db, id)).status === 'ARCHIVED' ? 'archived' : 'stale');
  await recordAudit(db, actorUserId, 'scheduling.resource.archived', { type: 'scheduling_resource', id }, { from: before.status });
  return respond(db, id);
}

/** Back to ACTIVE (the same convention as calendars: restore makes it usable again). */
export async function restoreResource(db: AppTenantDb, actorUserId: string, id: string, version: number) {
  const before = await load(db, id);
  if (before.status !== 'ARCHIVED') throw new StateConflictError('not_archived');
  const result = await db.schedulingResource.updateMany({
    where: { id, version, status: 'ARCHIVED' }, data: { status: 'ACTIVE', archivedAt: null, ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError((await load(db, id)).status === 'ARCHIVED' ? 'stale' : 'not_archived');
  await recordAudit(db, actorUserId, 'scheduling.resource.restored', { type: 'scheduling_resource', id });
  return respond(db, id);
}

const STATUS_FILTER: Record<string, Status[] | undefined> = {
  current: ['ACTIVE', 'INACTIVE'], active: ['ACTIVE'], inactive: ['INACTIVE'], archived: ['ARCHIVED'], all: undefined,
};

export type ResourceQuery = { q?: string; type?: Type; status: 'current' | 'active' | 'inactive' | 'archived' | 'all'; cursor?: string; limit: number };

/** Keyset-paginated by name then id, with an opaque cursor bound to this exact filter. */
export async function listResources(db: AppTenantDb, query: ResourceQuery) {
  const where: Record<string, unknown>[] = [];
  const statuses = STATUS_FILTER[query.status];
  if (statuses) where.push({ status: { in: statuses } });
  if (query.type) where.push({ resourceType: query.type });
  if (query.q) where.push({ name: { contains: query.q, mode: 'insensitive' } });
  const list = `scheduling-resources:${query.status}:${query.type ?? '*'}:${query.q ?? ''}`;
  const after = decodeCursor(query.cursor, list, ['n', 'i'] as const);
  if (after) {
    if (!UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ name: { gt: after.n } }, { name: after.n, id: { gt: after.i } }] });
  }
  const rows = (await db.schedulingResource.findMany({
    where: { AND: where }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  } as never)) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { resources: page.map(toDto), nextCursor: rows.length > query.limit && last ? encodeCursor(list, { n: last.name, i: last.id }) : null };
}

export type AvailabilityQuery = {
  start: string; end: string; resourceIds?: string[]; type?: Type; calendarId?: string; excludeEventId?: string; cursor?: string; limit: number;
};

/**
 * Advisory availability of resources for [start, end) (docs/scheduling-s2.md §4.2). Takes no lock: the
 * booking transaction re-checks under the lock protocol. Every answer comes from the events and their live
 * assignments, never from a stored ledger. Bounded: at most 50 named resources or one page of 100, an
 * interval of at most 31 days, and at most 20 listed conflicts per resource.
 */
export async function resourceAvailability(db: AppTenantDb, query: AvailabilityQuery) {
  const start = new Date(query.start);
  const end = new Date(query.end);
  if (end.getTime() <= start.getTime()) invalid('invalid_interval', 'The end must be after the start.');
  if (end.getTime() - start.getTime() > MAX_EVENT_MS) invalid('duration_too_long', 'Ask about at most 31 days at a time.');

  let rows: Row[];
  let nextCursor: string | null = null;
  if (query.resourceIds) {
    rows = (await db.schedulingResource.findMany({ where: { id: { in: query.resourceIds } }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }] } as never)) as Row[];
    if (rows.length !== query.resourceIds.length) throw new RecordNotFoundError();
  } else {
    const page = await listResources(db, { status: 'current', type: query.type, cursor: query.cursor, limit: query.limit });
    nextCursor = page.nextCursor;
    rows = (await db.schedulingResource.findMany({ where: { id: { in: page.resources.map((r) => r.id) } }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }] } as never)) as Row[];
  }

  let calendar: { calendarId: string; available: boolean; conflicts: SchedulingConflict[] } | null = null;
  if (query.calendarId) {
    if (!(await db.schedulingCalendar.findFirst({ where: { id: query.calendarId }, select: { id: true } }))) throw new RecordNotFoundError();
    const conflicts = await findConflicts(db, query.calendarId, start, end, query.excludeEventId);
    calendar = { calendarId: query.calendarId, available: conflicts.length === 0, conflicts };
  }

  // One query for every resource on the page (no per-resource round trip).
  const conflicts = await findResourceConflicts(db, rows.map((r) => r.id), start, end, { excludeEventId: query.excludeEventId });
  const byResource = new Map<string, SchedulingConflict[]>();
  for (const c of conflicts) byResource.set(c.resource!.id, [...(byResource.get(c.resource!.id) ?? []), c]);
  return {
    resources: rows.map((r) => {
      const own = byResource.get(r.id) ?? [];
      const state = r.status !== 'ACTIVE' ? 'unavailable' as const : own.length > 0 ? 'occupied' as const : 'available' as const;
      return { resource: { id: r.id, name: r.name, type: r.resourceType, status: r.status }, state, conflicts: own };
    }),
    calendar,
    nextCursor,
  };
}
