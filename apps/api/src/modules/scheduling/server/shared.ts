import 'server-only';
// Shared by the scheduling services (docs/scheduling-s1.md).
import type { AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { can, type Principal } from '@/modules/access';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every change bumps the version, so an edit based on an older version can be detected. */
export const BUMP = { version: { increment: 1 } };
/** The longest event (also a CHECK in the migration). It bounds every range scan by start time. */
export const MAX_EVENT_MS = 31 * 86_400_000;
/** The widest range one list request may cover (a six-week month view fits easily). */
export const MAX_RANGE_MS = 62 * 86_400_000;
/** Conflicts listed per resource in a write's response or an availability answer (the check itself sees all). */
export const MAX_CONFLICTS_PER_RESOURCE = 20;

/** What the caller may see besides the schedule itself. Decided by the route from the verified role. */
export interface Viewer {
  /** Customer names come from the Customer Zone, so they are shown only to people who may read customers. */
  canReadCustomers: boolean;
}
export const viewerOf = (principal: Principal): Viewer => ({ canReadCustomers: can(principal, 'customers:read') });

/** Field names whose value differs between a row and the update about to be written (sorted). */
export const changedFields = (before: Record<string, unknown>, data: Record<string, unknown>) =>
  Object.keys(data).filter((k) => {
    const a = before[k];
    const b = data[k];
    if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime() !== (b as Date | null)?.getTime();
    return a !== b;
  }).sort();

export async function businessTimeZone(db: AppTenantDb): Promise<string> {
  return (await db.business.findFirstOrThrow({ select: { timeZone: true } })).timeZone;
}

// ---- the lock protocol (docs/scheduling-s1.md §4.3, extended by docs/scheduling-s2.md §5) ----------
//
// Every write that can change what a calendar's or a resource's time looks like (create, any event edit
// including a move between calendars and any change of its resources, cancel, archive; enforced or not)
// does, in this order, inside its one unit of work:
//   1. `lockCalendars`: the calendar rows it touches FOR SHARE, in id order. Archiving or restoring a
//      calendar UPDATEs that row, so it waits for event writes in flight and they wait for it: no event
//      lands on a calendar being archived.
//   2. the per-calendar transaction advisory locks, in the same id order. Two event writes on one
//      calendar run one after the other, so the conflict check of the second sees the first's commit
//      (READ COMMITTED takes a new snapshot per statement, after the lock was granted).
//   3. `lockResources` (S2): the resource rows it touches (assigned before and after the write) FOR SHARE,
//      in id order, reading each status under the lock. A resource status change or archive UPDATEs that
//      row, so it waits for bookings in flight and they wait for it.
//   4. the per-resource transaction advisory locks, in the same id order: two bookings of one resource
//      run one after the other, even when they are on different calendars.
//   5. the event row FOR UPDATE (edits), re-checking its version: a concurrent change is reported as
//      stale, never overwritten. Assignments change only through event writes that bump the version, so
//      a matching version also proves the event's resources read before step 1 are still current.
//   6. the conflict checks (calendar, then resources), then the writes. Released together at commit or
//      rollback.
// Every path takes the steps in this order and sorts ids within each step, and the lifecycle paths
// (calendar or resource UPDATE, default-calendar lock) hold one lock each before their single row, so two
// writers cannot wait for each other in a cycle (deadlock): not for two moves in opposite directions
// between two calendars, nor for two events exchanging resources.

/** Steps 1 and 2. Returns each calendar's archived state; a calendar of another business is never found (RLS). */
export async function lockCalendars(db: AppTenantDb, calendarIds: string[]): Promise<Map<string, { archived: boolean }>> {
  const ids = [...new Set(calendarIds)].sort();
  const rows = await db.$queryRaw<{ id: string; archived: boolean }[]>`
    SELECT id::text, archived_at IS NOT NULL AS archived FROM scheduling_calendars
    WHERE id = ANY(${ids}::uuid[]) AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ORDER BY id FOR SHARE`;
  const found = new Map(rows.map((r) => [r.id, { archived: r.archived }]));
  for (const id of ids) {
    if (!found.has(id)) throw new RecordNotFoundError();
    // One statement per key keeps the acquisition order explicit (no reliance on target-list evaluation order).
    await db.$queryRaw<{ locked: number }[]>`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended('scheduling.calendar:' || ${id}::text, 0))) AS l`;
  }
  return found;
}

export type LockedResource = { status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' };

/**
 * Steps 3 and 4 (S2). Returns each resource's status as read under the lock. A resource of another
 * business is never found (RLS), and an unknown id is a 404, the same as an unknown calendar.
 */
export async function lockResources(db: AppTenantDb, resourceIds: string[]): Promise<Map<string, LockedResource>> {
  const ids = [...new Set(resourceIds.map((i) => i.toLowerCase()))].sort();
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<{ id: string; status: LockedResource['status'] }[]>`
    SELECT id::text, status::text AS status FROM scheduling_resources
    WHERE id = ANY(${ids}::uuid[]) AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ORDER BY id FOR SHARE`;
  const found = new Map(rows.map((r) => [r.id, { status: r.status }]));
  for (const id of ids) {
    if (!found.has(id)) throw new RecordNotFoundError();
    await db.$queryRaw<{ locked: number }[]>`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended('scheduling.resource:' || ${id}::text, 0))) AS l`;
  }
  return found;
}

/** A resource being newly assigned must be ACTIVE (docs/scheduling-s2.md §3). Kept assignments may be in any state. */
export function assignableResource(locked: Map<string, LockedResource>, id: string) {
  const status = locked.get(id)?.status;
  if (status === 'ARCHIVED') throw new StateConflictError('archived_reference');
  if (status === 'INACTIVE') throw new StateConflictError('resource_inactive');
}

/** Serialises choosing the default calendar in this business (initialise, create-as-default, make default). */
export async function lockDefaultChoice(db: AppTenantDb) {
  await db.$queryRaw<{ locked: number }[]>`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(
      'scheduling.default:' || current_setting('app.business_id', true), 0))) AS l`;
}

export function writableCalendar(locked: Map<string, { archived: boolean }>, id: string) {
  if (locked.get(id)?.archived) throw new StateConflictError('archived_reference');
}

export function invalid(code: string, detail: string): never {
  throw new RuleViolationError(code, detail);
}
