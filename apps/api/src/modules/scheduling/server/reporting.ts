import 'server-only';
// Scheduling's reporting read model (WP-R1, docs/reporting-operational-r1.md). The Scheduling Zone owns what
// "an event scheduled" means; the Reporting module calls these through this module's public API and never
// reads its tables.
//
//   events scheduled = events that are SCHEDULED (not cancelled) and not archived, by `start_at` read in
//                      the business's time zone. Cancelling or archiving an event removes it from every
//                      period, including the one it was due in. It counts events that take place, not
//                      bookings made: when an event was created or moved is not reported.
//
// Calendars are shared by everyone holding scheduling:read (private entries are not built, ADR 0006 §4 is a
// future requirement), so the count and the list reveal nothing the Scheduling Zone does not already show.
// Only the title, start time and linked customer id leave this module: no description, location or resources.
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface EventPeriodQuery { from: string; to: string; unit: 'day' | 'week' | 'month'; timeZone: string; byCustomer: boolean; customerId?: string }
export interface EventPeriodRow { bucket: string; customerId: string | null; count: number }

export async function scheduledEventCounts(db: AppTenantDb, q: EventPeriodQuery): Promise<EventPeriodRow[]> {
  const rows = await db.$queryRaw<{ bucket: string; customer_id: string | null; count: number }[]>`
    SELECT to_char(date_trunc(${q.unit}::text, e.start_at AT TIME ZONE ${q.timeZone}::text), 'YYYY-MM-DD') AS bucket,
           CASE WHEN ${q.byCustomer}::boolean THEN e.customer_id::text END AS customer_id, count(*)::int AS count
      FROM scheduling_events e
     WHERE e.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND e.status = 'SCHEDULED' AND e.archived_at IS NULL
       AND e.start_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND e.start_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR e.customer_id = ${q.customerId ?? null}::uuid)
     GROUP BY 1, 2
     ORDER BY 1, 2`;
  return rows.map((r) => ({ bucket: r.bucket, customerId: r.customer_id, count: Number(r.count) }));
}

export interface ScheduledEventDetail { id: string; title: string; customerId: string | null; startAt: string }

/** The events behind `scheduledEventCounts`, latest start first, keyset-paginated on (start_at, id). */
export async function scheduledEventDetails(db: AppTenantDb, q: { from: string; to: string; timeZone: string; customerId?: string; cursor?: string; limit: number }) {
  const list = 'reporting:scheduling.events';
  const after = decodeCursor(q.cursor, list, ['t', 'i'] as const);
  if (after && (!EXACT.test(after.t) || !UUID.test(after.i))) invalidCursor();
  const rows = await db.$queryRaw<{ id: string; title: string; customer_id: string | null; start_at: Date; at: string }[]>`
    SELECT e.id::text, e.title, e.customer_id::text, e.start_at, to_char(e.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM scheduling_events e
     WHERE e.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND e.status = 'SCHEDULED' AND e.archived_at IS NULL
       AND e.start_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND e.start_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR e.customer_id = ${q.customerId ?? null}::uuid)
       AND (${after?.t ?? null}::timestamptz IS NULL OR (e.start_at, e.id) < (${after?.t ?? null}::timestamptz, ${after?.i ?? null}::uuid))
     ORDER BY e.start_at DESC, e.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): ScheduledEventDetail => ({ id: r.id, title: r.title, customerId: r.customer_id, startAt: r.start_at.toISOString() })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(list, { t: last.at, i: last.id }) : null,
  };
}
