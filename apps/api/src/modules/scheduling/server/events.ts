import 'server-only';
// Events (docs/scheduling-s1.md §3.2, §4). Runs inside a tenant unit of work: the scoped client adds the
// business id, forced RLS checks it again, and composite foreign keys make a link to another business's
// calendar or customer impossible. Every mutation follows the lock protocol in ./shared.ts, so the conflict
// check and the write are one atomic step per calendar, and every edit is conditional on the version the
// caller saw.
import { randomUUID } from 'node:crypto';
import { resolveWallTime, parseWallTime, type SchedulingConflict, type SchedulingEvent as EventDto } from '@business-os/contracts';
import { ForbiddenError } from '@/modules/access';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { BUMP, changedFields, invalid, lockCalendars, MAX_EVENT_MS, MAX_RANGE_MS, UUID, writableCalendar, type Viewer } from './shared';

type Status = 'SCHEDULED' | 'CANCELLED';
type Row = {
  id: string; calendarId: string; title: string; description: string | null; location: string | null; startAt: Date; endAt: Date; status: Status;
  blocksAvailability: boolean; customerId: string | null; cancelledAt: Date | null; cancelledById: string | null; version: number;
  createdById: string; updatedById: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null;
  customer?: { id: string; displayName: string; archivedAt: Date | null } | null;
};
const base = {
  id: true, calendarId: true, title: true, description: true, location: true, startAt: true, endAt: true, status: true, blocksAvailability: true,
  customerId: true, cancelledAt: true, cancelledById: true, version: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;
const selectFor = (viewer: Viewer) => (viewer.canReadCustomers ? { ...base, customer: { select: { id: true, displayName: true, archivedAt: true } } } : base);

const toDto = (r: Row): EventDto => ({
  id: r.id, calendarId: r.calendarId, title: r.title, description: r.description, location: r.location,
  startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), status: r.status, blocksAvailability: r.blocksAvailability,
  customerId: r.customerId, customer: r.customer ? { id: r.customer.id, displayName: r.customer.displayName, archived: r.customer.archivedAt !== null } : null,
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
export async function findConflicts(db: AppTenantDb, calendarId: string, start: Date, end: Date, excludeEventId?: string): Promise<SchedulingConflict[]> {
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
  return rows.map((r) => ({ eventId: r.id, calendarId: r.calendarId, title: r.title, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString() }));
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
};

export async function createEvent(db: AppTenantDb, viewer: Viewer, actorUserId: string, input: EventInput & { calendarId: string; title: string; start: TimeInput; end: TimeInput }): Promise<WriteResult> {
  const startAt = resolveTime(input.start, 'start');
  const endAt = resolveTime(input.end, 'end');
  checkInterval(startAt, endAt);
  if (input.customerId) await checkCustomer(db, viewer, input.customerId);
  const blocks = input.blocksAvailability ?? true;

  writableCalendar(await lockCalendars(db, [input.calendarId]), input.calendarId);
  const conflicts = blocks ? await findConflicts(db, input.calendarId, startAt, endAt) : [];
  if (conflicts.length > 0 && input.enforceConflicts) return { kind: 'conflict', conflicts };

  const id = randomUUID();
  await db.schedulingEvent.create({
    data: {
      id, calendarId: input.calendarId, title: input.title, description: input.description ?? null, location: input.location ?? null,
      startAt, endAt, blocksAvailability: blocks, customerId: input.customerId ?? null, createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  // Structured facts only: no title, description or location (they may hold customer details).
  await recordAudit(db, actorUserId, 'scheduling.event.created', { type: 'scheduling_event', id }, {
    calendarId: input.calendarId, customerId: input.customerId ?? null, blocksAvailability: String(blocks),
    enforced: String(input.enforceConflicts), overlaps: String(conflicts.length),
  });
  return { kind: 'written', event: toDto(await load(db, viewer, id)), conflicts };
}

export async function getEvent(db: AppTenantDb, viewer: Viewer, id: string) {
  const row = await load(db, viewer, id);
  const active = row.status === 'SCHEDULED' && row.archivedAt === null && row.blocksAvailability;
  return { event: toDto(row), conflicts: active ? await findConflicts(db, row.calendarId, row.startAt, row.endAt, row.id) : [] };
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
  const { customer: _customer, ...comparable } = before;
  void _customer;
  const fields = changedFields(comparable as unknown as Record<string, unknown>, data);
  if (fields.length === 0) return { kind: 'written', ...(await getEvent(db, viewer, id)) };

  const calendarId = (data.calendarId as string | undefined) ?? before.calendarId;
  const locked = await lockCalendars(db, [before.calendarId, calendarId]);
  writableCalendar(locked, before.calendarId);
  writableCalendar(locked, calendarId);
  await lockEvent(db, id, patch.version, before.calendarId);

  const blocks = (data.blocksAvailability as boolean | undefined) ?? before.blocksAvailability;
  const affectsAvailability = blocks && fields.some((f) => AVAILABILITY_FIELDS.includes(f));
  const conflicts = affectsAvailability ? await findConflicts(db, calendarId, startAt, endAt, id) : [];
  if (conflicts.length > 0 && patch.enforceConflicts) return { kind: 'conflict', conflicts };

  const result = await db.schedulingEvent.updateMany({
    where: { id, version: patch.version, status: 'SCHEDULED', archivedAt: null }, data: { ...data, ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'scheduling.event.updated', { type: 'scheduling_event', id }, {
    fields, enforced: String(patch.enforceConflicts), overlaps: String(conflicts.length),
  });
  if (fields.includes('calendarId')) {
    await recordAudit(db, actorUserId, 'scheduling.event.moved', { type: 'scheduling_event', id }, { from: before.calendarId, to: calendarId });
  }
  return { kind: 'written', event: toDto(await load(db, viewer, id)), conflicts };
}

/**
 * Cancels a scheduled event. The row is kept (status CANCELLED, who and when); it stops blocking time at
 * once, under the calendar lock, so a booking waiting for that slot sees it free when it runs.
 */
export async function cancelEvent(db: AppTenantDb, viewer: Viewer, actorUserId: string, id: string, version: number) {
  const before = await load(db, viewer, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.status !== 'SCHEDULED') throw new StateConflictError('not_scheduled');
  writableCalendar(await lockCalendars(db, [before.calendarId]), before.calendarId);
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
  await lockEvent(db, id, version, before.calendarId);
  const result = await db.schedulingEvent.updateMany({ where: { id, version, archivedAt: null }, data: { archivedAt: new Date(), ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'scheduling.event.archived', { type: 'scheduling_event', id }, { calendarId: before.calendarId, status: before.status });
  return { event: toDto(await load(db, viewer, id)), conflicts: [] };
}

export type EventQuery = { from: string; to: string; calendarId?: string; status: 'scheduled' | 'cancelled' | 'all'; cursor?: string; limit: number };

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
  if (query.status !== 'all') where.push({ status: query.status === 'scheduled' ? 'SCHEDULED' : 'CANCELLED' });
  const list = `scheduling-events:${query.from}:${query.to}:${query.calendarId ?? '*'}:${query.status}`;
  const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ startAt: { gt: t } }, { startAt: t, id: { gt: after.i } }] });
  }
  const rows = (await db.schedulingEvent.findMany({
    where: { AND: where }, select: selectFor(viewer), orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  } as never)) as Row[];
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
