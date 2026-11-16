import 'server-only';
// The open pipeline as totals (R2 operational dashboard, docs/dashboard-r2.md §3). The Sales Zone owns what
// "open" means, exactly as on its board and list:
//
//   open = status OPEN and not archived. Won and lost opportunities are outcomes, not pipeline.
//   value = sum of `amount` of open opportunities, per currency (never converted or added across
//           currencies). Opportunities without an amount are counted but add nothing.
//
// One grouped query, bounded by stages x currencies; no opportunity rows leave the database. Runs in a
// tenant unit of work. Every table read (opportunities, stages, pipelines) is filtered to the business in the
// URL explicitly, and forced RLS on all three is the backstop; joins also match on business_id.
import type { PipelineCurrencyTotal, SalesSummary } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { Decimal } from '@/core/db';
import { formatAmount } from './money';

type Row = {
  pipeline_id: string; pipeline_name: string; is_default: boolean;
  stage_id: string; stage_name: string; stage_position: number; stage_archived: boolean;
  currency_code: string | null; amount: Decimal | null; count: number | null;
};

/** Adds per-currency totals exactly (Decimal), keeping currencies apart, sorted by code. */
class Totals {
  private readonly map = new Map<string, { amount: Decimal; count: number }>();
  add(currency: string, amount: Decimal, count: number) {
    const t = this.map.get(currency) ?? { amount: new Decimal(0), count: 0 };
    this.map.set(currency, { amount: t.amount.plus(amount), count: t.count + count });
  }
  get count() { return [...this.map.values()].reduce((n, t) => n + t.count, 0); }
  list(): PipelineCurrencyTotal[] {
    return [...this.map.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, t]) => ({ currencyCode, amount: formatAmount(t.amount, currencyCode)!, count: t.count }));
  }
}

export async function salesSummary(db: AppTenantDb): Promise<{ summary: SalesSummary }> {
  const rows = await db.$queryRaw<Row[]>`
    WITH tenant AS (SELECT nullif(current_setting('app.business_id', true), '')::uuid AS id),
    open AS (
      SELECT o.pipeline_id, o.stage_id, o.currency_code::text AS currency_code, sum(o.amount) AS amount, count(*)::int AS count
        FROM opportunities o
       WHERE o.business_id = (SELECT id FROM tenant)
         AND o.status = 'OPEN' AND o.archived_at IS NULL
       GROUP BY 1, 2, 3
    )
    SELECT p.id::text AS pipeline_id, p.name AS pipeline_name, (p.default_slot IS NOT NULL) AS is_default,
           s.id::text AS stage_id, s.name AS stage_name, s.position AS stage_position, (s.archived_at IS NOT NULL) AS stage_archived,
           o.currency_code, o.amount, o.count
      FROM sales_stages s
      JOIN sales_pipelines p ON p.business_id = s.business_id AND p.id = s.pipeline_id
      LEFT JOIN open o ON o.pipeline_id = s.pipeline_id AND o.stage_id = s.id
     WHERE s.business_id = (SELECT id FROM tenant)
       AND p.business_id = (SELECT id FROM tenant)
       AND ((s.archived_at IS NULL AND p.archived_at IS NULL) OR o.count IS NOT NULL)
     ORDER BY p.position, p.id, s.position, s.id, o.currency_code`;

  const overall = new Totals();
  const pipelines = new Map<string, { id: string; name: string; isDefault: boolean; totals: Totals; stages: Map<string, { id: string; name: string; position: number; archived: boolean; totals: Totals }> }>();
  for (const r of rows) {
    let p = pipelines.get(r.pipeline_id);
    if (!p) pipelines.set(r.pipeline_id, (p = { id: r.pipeline_id, name: r.pipeline_name, isDefault: r.is_default, totals: new Totals(), stages: new Map() }));
    let s = p.stages.get(r.stage_id);
    if (!s) p.stages.set(r.stage_id, (s = { id: r.stage_id, name: r.stage_name, position: Number(r.stage_position), archived: r.stage_archived, totals: new Totals() }));
    if (r.currency_code === null || r.count === null) continue;
    const amount = new Decimal(r.amount ?? 0);
    const count = Number(r.count);
    for (const t of [overall, p.totals, s.totals]) t.add(r.currency_code, amount, count);
  }
  return {
    summary: {
      open: { count: overall.count, totals: overall.list() },
      pipelines: [...pipelines.values()].map((p) => ({
        id: p.id, name: p.name, isDefault: p.isDefault, count: p.totals.count, totals: p.totals.list(),
        stages: [...p.stages.values()].map((s) => ({ id: s.id, name: s.name, position: s.position, archived: s.archived, count: s.totals.count, totals: s.totals.list() })),
      })),
    },
  };
}
