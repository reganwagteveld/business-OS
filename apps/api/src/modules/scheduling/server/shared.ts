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

// ---- the lock protocol (docs/scheduling-s1.md §4.3) ------------------------------------------------
//
// Every write that can change what a calendar's time looks like (create, any event edit including a
// move between calendars, cancel, archive; enforced or not) does, in this order, inside its one unit
// of work:
//   1. `lockCalendars`: the calendar rows it touches FOR SHARE, in id order. Archiving or restoring a
//      calendar UPDATEs that row, so it waits for event writes in flight and they wait for it: no event
//      lands on a calendar being archived.
//   2. the per-calendar transaction advisory locks, in the same id order. Two event writes on one
//      calendar run one after the other, so the conflict check of the second sees the first's commit
//      (READ COMMITTED takes a new snapshot per statement, after the lock was granted).
//   3. the event row FOR UPDATE (edits), re-checking its version: a concurrent change is reported as
//      stale, never overwritten.
//   4. the conflict check, then the write. Released together at commit or rollback.
// Every path takes 1 before 2 before 3, and sorts ids within each step, so two writers cannot wait for
// each other in a cycle (deadlock), including two moves in opposite directions between the same pair.

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
