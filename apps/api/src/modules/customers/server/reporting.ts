import 'server-only';
// Customers' reporting read model (docs/reporting-r1.md §4). The Customers Zone owns what "a new customer"
// means; the Reporting module calls these through this module's public API and never reads its tables.
//
//   new customers = customers created in the period (created_at read in the business's time zone),
//                   excluding customers that are archived now. Archiving removes a customer from every
//                   period, including the one it was created in.
//
// Only identity fields leave this module (id, display name, created and archived times): no contact
// details, notes, tax numbers or addresses.
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cursor times keep PostgreSQL's microseconds (a JS Date would drop them and skip rows). */
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface CustomerPeriodQuery { from: string; to: string; unit: 'day' | 'week' | 'month'; timeZone: string }
export interface CustomerPeriodRow { bucket: string; count: number }

/** Active customers created per bucket. The range is [from 00:00, to + 1 day 00:00) in the business's zone. */
export async function newCustomerCounts(db: AppTenantDb, q: CustomerPeriodQuery): Promise<CustomerPeriodRow[]> {
  const rows = await db.$queryRaw<{ bucket: string; count: number }[]>`
    SELECT to_char(date_trunc(${q.unit}::text, c.created_at AT TIME ZONE ${q.timeZone}::text), 'YYYY-MM-DD') AS bucket, count(*)::int AS count
      FROM customers c
     WHERE c.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND c.archived_at IS NULL
       AND c.created_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND c.created_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
     GROUP BY 1
     ORDER BY 1`;
  return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
}

export interface NewCustomerDetail { id: string; displayName: string; createdAt: string }

/** The customers behind `newCustomerCounts`, newest first, keyset-paginated on (created_at, id). */
export async function newCustomerDetails(db: AppTenantDb, q: { from: string; to: string; timeZone: string; cursor?: string; limit: number }) {
  const list = 'reporting:customers.new';
  const after = decodeCursor(q.cursor, list, ['t', 'i'] as const);
  if (after && (!EXACT.test(after.t) || !UUID.test(after.i))) invalidCursor();
  const rows = await db.$queryRaw<{ id: string; display_name: string; created_at: Date; at: string }[]>`
    SELECT c.id::text, c.display_name, c.created_at, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM customers c
     WHERE c.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND c.archived_at IS NULL
       AND c.created_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND c.created_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND (${after?.t ?? null}::timestamptz IS NULL OR (c.created_at, c.id) < (${after?.t ?? null}::timestamptz, ${after?.i ?? null}::uuid))
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): NewCustomerDetail => ({ id: r.id, displayName: r.display_name, createdAt: r.created_at.toISOString() })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(list, { t: last.at, i: last.id }) : null,
  };
}

/** Display names for customer ids of this business (archived included), for report labels. Unknown ids are left out. */
export async function customerLabels(db: AppTenantDb, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (unique.length === 0) return new Map();
  const rows = await db.customer.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } });
  return new Map(rows.map((r) => [r.id, r.displayName]));
}
