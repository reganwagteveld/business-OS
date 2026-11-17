import 'server-only';
// Projects' reporting read model (WP-R1, docs/reporting-operational-r1.md). The Projects Zone owns what "a
// completed task" means; the Reporting module calls these through this module's public API and never
// reads its tables.
//
//   tasks completed = tasks whose status is DONE, by `completed_at` read in the business's time zone.
//                     A task that is reopened (moved out of DONE) clears `completed_at` (CHECK), so it leaves
//                     every period until it is completed again. Archived tasks are not counted, in any period.
//                     Tasks of an archived project still count: the work happened.
//
// Only the task title, its project's name and the completion time leave this module: no description,
// assignee, notes or comments.
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cursor times keep PostgreSQL's microseconds (a JS Date would drop them and skip rows). */
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface TaskPeriodQuery { from: string; to: string; unit: 'day' | 'week' | 'month'; timeZone: string }
export interface TaskPeriodRow { bucket: string; count: number }

/** Tasks completed per bucket. The range is [from 00:00, to + 1 day 00:00) in the business's zone. */
export async function completedTaskCounts(db: AppTenantDb, q: TaskPeriodQuery): Promise<TaskPeriodRow[]> {
  const rows = await db.$queryRaw<{ bucket: string; count: number }[]>`
    SELECT to_char(date_trunc(${q.unit}::text, t.completed_at AT TIME ZONE ${q.timeZone}::text), 'YYYY-MM-DD') AS bucket, count(*)::int AS count
      FROM project_tasks t
     WHERE t.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND t.status = 'DONE' AND t.completed_at IS NOT NULL AND t.archived_at IS NULL
       AND t.completed_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND t.completed_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
     GROUP BY 1
     ORDER BY 1`;
  return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
}

export interface CompletedTaskDetail { id: string; title: string; projectName: string; completedAt: string }

/** The tasks behind `completedTaskCounts`, newest first, keyset-paginated on (completed_at, id). */
export async function completedTaskDetails(db: AppTenantDb, q: { from: string; to: string; timeZone: string; cursor?: string; limit: number }) {
  const list = 'reporting:projects.tasks';
  const after = decodeCursor(q.cursor, list, ['t', 'i'] as const);
  if (after && (!EXACT.test(after.t) || !UUID.test(after.i))) invalidCursor();
  const rows = await db.$queryRaw<{ id: string; title: string; project_name: string; completed_at: Date; at: string }[]>`
    SELECT t.id::text, t.title, p.name AS project_name, t.completed_at, to_char(t.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM project_tasks t
      JOIN projects p ON p.business_id = t.business_id AND p.id = t.project_id
     WHERE t.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND t.status = 'DONE' AND t.completed_at IS NOT NULL AND t.archived_at IS NULL
       AND t.completed_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND t.completed_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND (${after?.t ?? null}::timestamptz IS NULL OR (t.completed_at, t.id) < (${after?.t ?? null}::timestamptz, ${after?.i ?? null}::uuid))
     ORDER BY t.completed_at DESC, t.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): CompletedTaskDetail => ({ id: r.id, title: r.title, projectName: r.project_name, completedAt: r.completed_at.toISOString() })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(list, { t: last.at, i: last.id }) : null,
  };
}
