import 'server-only';
// Calendars (docs/scheduling-s1.md §3.1). Runs inside a tenant unit of work: the scoped client adds the
// business id, forced RLS checks it again. Exactly one active default per business, kept by the Sales
// default-record pattern (default_slot + unique index + ON CONFLICT DO NOTHING) and a per-business lock
// on every change of which calendar is the default.
import { randomUUID } from 'node:crypto';
import type { SchedulingCalendar as CalendarDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { BUMP, businessTimeZone, changedFields, lockDefaultChoice, UUID } from './shared';

type Row = {
  id: string; name: string; description: string | null; colour: string | null; timeZone: string; defaultSlot: string | null; version: number;
  createdById: string; updatedById: string; createdAt: Date; updatedAt: Date; archivedAt: Date | null;
};
const select = {
  id: true, name: true, description: true, colour: true, timeZone: true, defaultSlot: true, version: true,
  createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;

export const DEFAULT_CALENDAR_NAME = 'Calendar';

const toDto = (r: Row): CalendarDto => ({
  id: r.id, name: r.name, description: r.description, colour: r.colour, timeZone: r.timeZone, isDefault: r.defaultSlot !== null,
  version: r.version, createdById: r.createdById, updatedById: r.updatedById,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null,
});

async function load(db: AppTenantDb, id: string): Promise<Row> {
  const row = (await db.schedulingCalendar.findFirst({ where: { id }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/**
 * The business's default calendar, created in the business's time zone if there is none. Called only from
 * explicit write requests, never from a GET. Safe under concurrency twice over: the per-business lock
 * serialises it with every other default change, and the insert is ON CONFLICT DO NOTHING on (business_id,
 * default_slot), so even a writer that skipped the lock could not create a second default. Only the request
 * that created it reports `created` and writes the audit entry.
 */
export async function ensureDefaultCalendar(db: AppTenantDb, actorUserId: string): Promise<{ calendar: CalendarDto; created: boolean }> {
  const existing = (await db.schedulingCalendar.findFirst({ where: { defaultSlot: 'default' }, select })) as Row | null;
  if (existing) return { calendar: toDto(existing), created: false };
  await lockDefaultChoice(db);
  const id = randomUUID();
  const inserted = await db.schedulingCalendar.createMany({
    data: [{ id, name: DEFAULT_CALENDAR_NAME, timeZone: await businessTimeZone(db), defaultSlot: 'default', createdById: actorUserId, updatedById: actorUserId }] as never,
    skipDuplicates: true,
  });
  if (inserted.count === 1) await recordAudit(db, actorUserId, 'scheduling.calendar.initialized', { type: 'scheduling_calendar', id });
  const calendar = (await db.schedulingCalendar.findFirstOrThrow({ where: { defaultSlot: 'default' }, select })) as Row;
  return { calendar: toDto(calendar), created: inserted.count === 1 };
}

/**
 * Makes `id` the default. The caller must already hold the per-business default lock (`lockDefaultChoice`),
 * taken before it touched any calendar row: every default change takes that lock first and the rows after,
 * so a detail edit and a default change cannot wait for each other in a cycle (S1-02). The old default is
 * cleared, then the new one set; `expectedVersion` (when given) makes a stale request fail instead of
 * silently winning over a concurrent edit.
 */
async function makeDefault(db: AppTenantDb, actorUserId: string, id: string, expectedVersion?: number) {
  const previous = await db.schedulingCalendar.findFirst({ where: { defaultSlot: 'default' }, select: { id: true } });
  if (previous?.id === id) return;
  if (previous) {
    await db.schedulingCalendar.updateMany({ where: { id: previous.id }, data: { defaultSlot: null, ...BUMP, updatedById: actorUserId } as never });
  }
  const set = await db.schedulingCalendar.updateMany({
    where: { id, archivedAt: null, ...(expectedVersion !== undefined ? { version: expectedVersion } : {}) },
    data: { defaultSlot: 'default', ...BUMP, updatedById: actorUserId } as never,
  });
  // Archived or changed meanwhile: throwing rolls the whole unit of work back, so the old default is kept.
  if (set.count === 0) throw new StateConflictError((await load(db, id)).archivedAt ? 'archived' : 'stale');
  await recordAudit(db, actorUserId, 'scheduling.calendar.default_changed', { type: 'scheduling_calendar', id }, { from: previous?.id ?? null });
}

export type CalendarInput = { name?: string; description?: string | null; colour?: string | null; timeZone?: string; isDefault?: true };

/**
 * Creates a calendar. The first active calendar of a business is always its default (S1-01): under the
 * per-business default lock, a business with no active default gets this calendar inserted directly into
 * the default slot, in the same statement that creates it, so no request order (including racing
 * `ensureDefaultCalendar` or other creates) can leave active calendars without a default. The unique
 * (business_id, default_slot) index still backs this up. `isDefault: true` moves the default here.
 */
export async function createCalendar(db: AppTenantDb, actorUserId: string, input: CalendarInput & { name: string }) {
  const id = randomUUID();
  await lockDefaultChoice(db);
  const hasDefault = (await db.schedulingCalendar.count({ where: { defaultSlot: 'default' } })) > 0;
  await db.schedulingCalendar.create({
    data: {
      id, name: input.name, description: input.description ?? null, colour: input.colour ?? null,
      timeZone: input.timeZone ?? (await businessTimeZone(db)), defaultSlot: hasDefault ? null : 'default',
      createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  // Names and descriptions stay out of the audit log.
  await recordAudit(db, actorUserId, 'scheduling.calendar.created', { type: 'scheduling_calendar', id }, hasDefault ? undefined : { default: 'first_calendar' });
  if (input.isDefault && hasDefault) await makeDefault(db, actorUserId, id);
  return toDto(await load(db, id));
}

export async function getCalendar(db: AppTenantDb, id: string) {
  return toDto(await load(db, id));
}

/** Edits details and the display zone, or makes the calendar the default. Archived calendars are read-only. */
export async function updateCalendar(db: AppTenantDb, actorUserId: string, id: string, patch: CalendarInput & { version: number }) {
  // Default lock before any row lock (S1-02): the same order as every other default change.
  if (patch.isDefault) await lockDefaultChoice(db);
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== patch.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'colour', 'timeZone'] as const) if (patch[key] !== undefined) data[key] = patch[key];
  const fields = changedFields(before as unknown as Record<string, unknown>, data);
  if (fields.length > 0) {
    const result = await db.schedulingCalendar.updateMany({ where: { id, archivedAt: null, version: patch.version }, data: { ...data, ...BUMP, updatedById: actorUserId } as never });
    if (result.count === 0) throw new StateConflictError((await load(db, id)).archivedAt ? 'archived' : 'stale');
    await recordAudit(db, actorUserId, 'scheduling.calendar.updated', { type: 'scheduling_calendar', id }, { fields });
  }
  if (patch.isDefault && before.defaultSlot === null) await makeDefault(db, actorUserId, id, fields.length > 0 ? patch.version + 1 : patch.version);
  return toDto(await load(db, id));
}

/**
 * Archiving hides the calendar from ordinary views and makes it and its events read-only. Its events are
 * kept untouched (still readable by id and in that calendar's own view). The default cannot be archived:
 * make another calendar the default first (409 default_calendar), so a business never loses its default.
 * The UPDATE waits for event writes holding the calendar FOR SHARE (lock protocol step 1).
 */
export async function archiveCalendar(db: AppTenantDb, actorUserId: string, id: string, version: number) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.defaultSlot !== null) throw new StateConflictError('default_calendar');
  const result = await db.schedulingCalendar.updateMany({
    where: { id, archivedAt: null, defaultSlot: null, version }, data: { archivedAt: new Date(), ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) {
    const now = await load(db, id);
    throw new StateConflictError(now.archivedAt ? 'archived' : now.defaultSlot !== null ? 'default_calendar' : 'stale');
  }
  await recordAudit(db, actorUserId, 'scheduling.calendar.archived', { type: 'scheduling_calendar', id });
  return toDto(await load(db, id));
}

export async function restoreCalendar(db: AppTenantDb, actorUserId: string, id: string, version: number) {
  const before = await load(db, id);
  if (!before.archivedAt) throw new StateConflictError('not_archived');
  const result = await db.schedulingCalendar.updateMany({ where: { id, archivedAt: { not: null }, version }, data: { archivedAt: null, ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError((await load(db, id)).archivedAt ? 'stale' : 'not_archived');
  await recordAudit(db, actorUserId, 'scheduling.calendar.restored', { type: 'scheduling_calendar', id });
  return toDto(await load(db, id));
}

/** Keyset-paginated by name then id, with an opaque cursor bound to this list. */
export async function listCalendars(db: AppTenantDb, query: { archived: 'active' | 'archived' | 'all'; cursor?: string; limit: number }) {
  const where: Record<string, unknown>[] = [];
  if (query.archived === 'active') where.push({ archivedAt: null });
  if (query.archived === 'archived') where.push({ archivedAt: { not: null } });
  const list = `scheduling-calendars:${query.archived}`;
  const after = decodeCursor(query.cursor, list, ['n', 'i'] as const);
  if (after) {
    if (!UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ name: { gt: after.n } }, { name: after.n, id: { gt: after.i } }] });
  }
  const rows = (await db.schedulingCalendar.findMany({
    where: { AND: where }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  } as never)) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { calendars: page.map(toDto), nextCursor: rows.length > query.limit && last ? encodeCursor(list, { n: last.name, i: last.id }) : null };
}
