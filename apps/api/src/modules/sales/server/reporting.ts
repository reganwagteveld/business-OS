import 'server-only';
// Sales' reporting read model (docs/reporting-r1.md §4). The Sales Zone owns what "won" means; the
// Reporting module calls these through this module's public API and never reads sales tables itself.
//
//   won value = sum of `amount` of opportunities whose CURRENT status is WON, by the time they were won
//               (closed_at, read in the business's time zone). Opportunities without an amount are
//               counted but add nothing. A reopened opportunity is OPEN again and leaves every period
//               until it is won again (then it counts on its new close date). LOST, OPEN and archived
//               opportunities never count. Won value is pipeline outcome, not invoiced or received money.
//   won count = the number of those opportunities.
//
// Amounts stay in their own currency; nothing is converted or added across currencies.
import type { AppTenantDb } from '@/core/db';
import { Decimal } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { formatAmount } from './money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cursor times keep PostgreSQL's microseconds (a JS Date would drop them and skip rows). */
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface SalesPeriodQuery {
  from: string; to: string; unit: 'day' | 'week' | 'month'; timeZone: string; byCustomer: boolean; currencyCode?: string; customerId?: string;
}
/** `amount` sums priced opportunities only; `count` counts every won opportunity in the group. */
export interface SalesPeriodRow { bucket: string; currencyCode: string; customerId: string | null; amount: string; count: number }

export async function wonOpportunityTotals(db: AppTenantDb, q: SalesPeriodQuery): Promise<SalesPeriodRow[]> {
  const rows = await db.$queryRaw<{ bucket: string; currency_code: string; customer_id: string | null; amount: Decimal | null; count: number }[]>`
    SELECT to_char(date_trunc(${q.unit}::text, o.closed_at AT TIME ZONE ${q.timeZone}::text), 'YYYY-MM-DD') AS bucket,
           o.currency_code::text AS currency_code,
           CASE WHEN ${q.byCustomer}::boolean THEN o.customer_id::text END AS customer_id,
           sum(o.amount) AS amount, count(*)::int AS count
      FROM opportunities o
     WHERE o.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND o.status = 'WON' AND o.archived_at IS NULL AND o.closed_at IS NOT NULL
       AND o.closed_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND o.closed_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND (${q.currencyCode ?? null}::text IS NULL OR o.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR o.customer_id = ${q.customerId ?? null}::uuid)
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`;
  return rows.map((r) => ({
    bucket: r.bucket, currencyCode: r.currency_code, customerId: r.customer_id,
    amount: formatAmount(new Decimal(r.amount ?? 0), r.currency_code)!, count: Number(r.count),
  }));
}

export interface WonOpportunityDetail {
  id: string; title: string; customerId: string | null; closedAt: string; amount: string | null; currencyCode: string;
}

/** The opportunities behind `wonOpportunityTotals`, most recently won first, keyset-paginated on (closed_at, id). */
export async function wonOpportunityDetails(db: AppTenantDb, q: {
  from: string; to: string; timeZone: string; currencyCode?: string; customerId?: string; cursor?: string; limit: number;
}) {
  const list = 'reporting:sales.won';
  const after = decodeCursor(q.cursor, list, ['t', 'i'] as const);
  if (after && (!EXACT.test(after.t) || !UUID.test(after.i))) invalidCursor();
  const rows = await db.$queryRaw<{ id: string; title: string; customer_id: string | null; closed_at: Date; at: string; amount: Decimal | null; currency_code: string }[]>`
    SELECT o.id::text, o.title, o.customer_id::text, o.closed_at, to_char(o.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
           o.amount, o.currency_code::text
      FROM opportunities o
     WHERE o.business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND o.status = 'WON' AND o.archived_at IS NULL AND o.closed_at IS NOT NULL
       AND o.closed_at >= (${q.from}::date::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND o.closed_at <  ((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timeZone}::text)
       AND (${q.currencyCode ?? null}::text IS NULL OR o.currency_code = ${q.currencyCode ?? null}::text)
       AND (${q.customerId ?? null}::uuid IS NULL OR o.customer_id = ${q.customerId ?? null}::uuid)
       AND (${after?.t ?? null}::timestamptz IS NULL OR (o.closed_at, o.id) < (${after?.t ?? null}::timestamptz, ${after?.i ?? null}::uuid))
     ORDER BY o.closed_at DESC, o.id DESC
     LIMIT ${q.limit + 1}`;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r): WonOpportunityDetail => ({
      id: r.id, title: r.title, customerId: r.customer_id, closedAt: r.closed_at.toISOString(),
      amount: r.amount === null ? null : formatAmount(new Decimal(r.amount), r.currency_code), currencyCode: r.currency_code,
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor(list, { t: last.at, i: last.id }) : null,
  };
}
