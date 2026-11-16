/**
 * A stand-in for the Reporting API (R1), for client tests only. Every request body is parsed with the
 * shared contract (strict: an unknown field fails the test) and every response is built to the contract
 * types, so the real client parses it as it would the server's. Access follows the permissions given,
 * like the server: a metric needs its source key, a saved view grants nothing.
 */
import {
  CreateSavedViewRequest, ReportingDetailsRequest, ReportingQueryRequest, UpdateSavedViewRequest,
  type ReportingCatalog, type ReportingMetricDefinition, type ReportingMetricResult, type ReportingQueryResult, type SavedView,
} from '@business-os/contracts';
import { randomUUID } from 'node:crypto';

export const TODAY = '2026-11-15';
const NOW = '2026-11-15T01:00:00.000Z';

const base = {
  timeZone: 'Business time zone (from the business settings)', tenantScope: 'business' as const, dimensionRequires: {}, plannedNote: null, minimumGroupSize: null,
  granularities: ['day', 'week', 'month', 'none'] as ReportingMetricDefinition['granularities'], dimensions: [] as ReportingMetricDefinition['dimensions'],
  filters: [] as ReportingMetricDefinition['filters'], hasDetail: true, availability: 'available' as const, version: 1,
};
const def = (over: Partial<ReportingMetricDefinition> & Pick<ReportingMetricDefinition, 'id' | 'name' | 'zone' | 'valueType' | 'requires'>): Omit<ReportingMetricDefinition, 'accessible'> => ({
  ...base, description: `${over.name} in the period.`, unit: over.valueType === 'money' ? 'per currency' : 'records', temporal: 'period',
  semantics: `${over.name}: the owning Zone's own calculation.`, dateField: 'Issue date', statusTreatment: 'Issued only.', defaultChart: 'bar', ...over,
});

export const METRICS = [
  def({ id: 'finance.invoiced_amount', name: 'Amount invoiced', zone: 'finance', valueType: 'money', requires: ['finance:read'] }),
  def({ id: 'finance.payments_received', name: 'Amount received', zone: 'finance', valueType: 'money', requires: ['finance:read'] }),
  def({ id: 'finance.receivables_outstanding', name: 'Outstanding receivables', zone: 'finance', valueType: 'money', requires: ['finance:read'], temporal: 'snapshot', granularities: ['none'], hasDetail: false, defaultChart: 'kpi' }),
  def({ id: 'finance.receivables_overdue', name: 'Overdue receivables', zone: 'finance', valueType: 'money', requires: ['finance:read'], temporal: 'snapshot', granularities: ['none'], hasDetail: false, defaultChart: 'kpi' }),
  def({ id: 'finance.invoices_issued', name: 'Invoices issued', zone: 'finance', valueType: 'count', requires: ['finance:read'] }),
  def({ id: 'sales.won_value', name: 'Won opportunity value', zone: 'sales', valueType: 'money', requires: ['sales:read'] }),
  def({ id: 'sales.won_count', name: 'Opportunities won', zone: 'sales', valueType: 'count', requires: ['sales:read'] }),
  def({ id: 'customers.new_customers', name: 'New customers', zone: 'customers', valueType: 'count', requires: ['customers:read'] }),
  def({ id: 'finance.expenses_recorded', name: 'Expenses recorded', zone: 'finance', valueType: 'money', requires: ['finance:read'], availability: 'planned', plannedNote: 'Waits for Finance expense reporting rules.' }),
  def({ id: 'projects.tasks_completed', name: 'Tasks completed', zone: 'projects', valueType: 'count', requires: ['projects:read'], availability: 'planned', plannedNote: 'Projects has no completion time yet.' }),
  def({ id: 'people.headcount', name: 'Headcount', zone: 'people', valueType: 'count', requires: ['people:read'], availability: 'planned', plannedNote: 'Planned.' }),
];

function rangeOf(date: { kind: 'fixed'; from: string; to: string } | { kind: 'relative'; preset: string }) {
  if (date.kind === 'fixed') return { from: date.from, to: date.to };
  if (date.preset === 'last_month') return { from: '2026-10-01', to: '2026-10-31' };
  if (date.preset === 'this_month') return { from: '2026-11-01', to: TODAY };
  return { from: '2026-09-01', to: TODAY };
}
function bucketsOf(range: { from: string; to: string }, granularity: string): string[] {
  if (granularity === 'none') return [range.from];
  const out: string[] = [];
  const d = new Date(`${range.from}T00:00:00Z`);
  if (granularity === 'month') d.setUTCDate(1);
  if (granularity === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  while (d.toISOString().slice(0, 10) <= range.to && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    if (granularity === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + (granularity === 'week' ? 7 : 1));
  }
  return out;
}

/** Per metric: totals by currency (or count), spread over buckets by the fixture's rule (all in the second bucket). */
export const FIGURES: Record<string, { currency: string | null; total: string; previous: string; change: string | null }[]> = {
  'finance.invoiced_amount': [{ currency: 'AUD', total: '350.50', previous: '200.00', change: '75.3' }, { currency: 'USD', total: '75.00', previous: '0.00', change: null }],
  'finance.payments_received': [{ currency: 'AUD', total: '85.50', previous: '85.50', change: '0.0' }],
  'finance.receivables_overdue': [{ currency: 'AUD', total: '40.00', previous: '0', change: null }],
  'finance.invoices_issued': [{ currency: null, total: '4', previous: '2', change: '100.0' }],
  'sales.won_count': [{ currency: null, total: '2', previous: '2', change: '0.0' }],
  'finance.receivables_outstanding': [{ currency: 'AUD', total: '265.00', previous: '0', change: null }],
  'sales.won_value': [{ currency: 'AUD', total: '1200.00', previous: '1500.00', change: '-20.0' }],
  'customers.new_customers': [{ currency: null, total: '3', previous: '1', change: '200.0' }],
};

export interface ReportingCall { method: string; path: string; body: unknown; slug: string }

export function createFakeReporting(o: {
  permissions: string[]; empty?: string[]; failQuery?: boolean; catalogStatus?: number; views?: SavedView[]; pageSize?: number;
  /** Metrics that answer with a per-metric error (as the engine does for a retired version). */
  metricErrors?: string[];
  /** Holds every /query response until `release()` is called (to observe loading states). */
  holdQueries?: boolean;
  /** Figures to return instead of FIGURES (for example a second business's own numbers). */
  figures?: Record<string, { currency: string | null; total: string; previous: string; change: string | null }[]>;
}) {
  const held = new Set(o.permissions);
  const calls: ReportingCall[] = [];
  const views: SavedView[] = [...(o.views ?? [])];
  const metricOf = (id: string) => METRICS.find((m) => m.id === id);
  let release: () => void = () => {};
  const held$ = o.holdQueries ? new Promise<void>((resolve) => { release = resolve; }) : null;
  const can = (id: string) => (metricOf(id)?.requires ?? ['x']).every((k) => held.has(k));

  function result(q: { metrics: { id: string; version: number }[]; date: Parameters<typeof rangeOf>[0]; granularity: string; comparison: string }, lenient: boolean) {
    const range = rangeOf(q.date);
    const comparisonRange = q.comparison === 'previous_period' ? { from: '2026-06-01', to: '2026-08-15' } : null;
    const results: ReportingMetricResult[] = [];
    for (const ref of q.metrics) {
      const m = metricOf(ref.id);
      if (!m || !can(ref.id)) {
        if (!lenient) return null;
        results.push({ status: 'error', metric: ref, name: m?.name ?? null, code: 'forbidden_source', message: 'You do not have access to the data this metric uses.' });
        continue;
      }
      if (o.metricErrors?.includes(m.id)) {
        results.push({ status: 'error', metric: ref, name: m.name, code: 'metric_version_unsupported', message: 'This figure has changed since the report was set up. Choose it again.' });
        continue;
      }
      const buckets = m.temporal === 'snapshot' ? [] : bucketsOf(range, q.granularity);
      const figures = o.empty?.includes(m.id) ? [] : (o.figures ?? FIGURES)[m.id] ?? [];
      const zero = (c: string | null) => (c === 'USD' || c === 'AUD' ? '0.00' : '0');
      results.push({
        status: 'ok', metric: { id: m.id, version: m.version }, name: m.name, valueType: m.valueType, unit: m.unit, temporal: m.temporal,
        granularity: m.temporal === 'snapshot' ? 'none' : (q.granularity as never), groupBy: null, buckets, hiddenSeries: 0,
        asOf: m.temporal === 'snapshot' ? TODAY : null, notes: figures.length > 1 ? ['Each currency is shown separately; amounts are never converted or added together.'] : [],
        series: figures.map((f) => ({
          key: f.currency ?? 'all', label: f.currency ?? m.name, currencyCode: f.currency, customerId: null, total: f.total, suppressed: false,
          comparisonTotal: comparisonRange ? f.previous : null, changePercent: comparisonRange ? f.change : null,
          points: buckets.map((b, i) => ({ bucket: b, value: i === Math.min(1, buckets.length - 1) ? f.total : zero(f.currency) })),
          comparisonPoints: comparisonRange ? buckets.map((b, i) => ({ bucket: b, value: i === 0 ? f.previous : zero(f.currency) })) : null,
        })),
      });
    }
    return { timeZone: 'Australia/Perth', range, comparisonRange, results } satisfies ReportingQueryResult;
  }

  const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const slug = /^\/api\/v1\/b\/([^/]+)\//.exec(url.pathname)?.[1] ?? '';
    const path = url.pathname.replace(/^\/api\/v1\/b\/[^/]+\/reporting/, '');
    calls.push({ method, path, body, slug });
    if (!held.has('reporting:read')) return json(403, { error: 'forbidden' });
    if (method === 'GET' && path === '/metrics') {
      if (o.catalogStatus) return json(o.catalogStatus, { error: 'x' });
      const catalog: ReportingCatalog = {
        timeZone: 'Australia/Perth', today: TODAY, limits: { maxMetrics: 6, maxRangeDays: 1827, maxBuckets: 400, maxSeries: 12, maxDetailRows: 100 },
        metrics: METRICS.map((m) => ({ ...m, accessible: can(m.id) })),
      };
      return json(200, catalog);
    }
    if (method === 'POST' && path === '/query') {
      const q = ReportingQueryRequest.parse(body);
      if (held$) await held$;
      if (o.failQuery) return json(500, { error: 'internal_error' });
      const r = result(q, false);
      return r ? json(200, r) : json(403, { error: 'forbidden' });
    }
    if (method === 'POST' && path === '/details') {
      const d = ReportingDetailsRequest.parse(body);
      if (!can(d.metric.id)) return json(403, { error: 'forbidden' });
      const all = Array.from({ length: 3 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}`, currencyCode: 'AUD', cells: { number: `INV-000${3 - i}`, issueDate: '2026-11-0' + (3 - i), total: `${(3 - i) * 100}.00` } }));
      const start = d.cursor ? Number(d.cursor) : 0;
      const rows = all.slice(start, start + (d.limit ?? 25));
      return json(200, {
        metric: d.metric, range: rangeOf(d.date), columns: [{ key: 'number', label: 'Invoice', type: 'text' }, { key: 'issueDate', label: 'Issued', type: 'date' }, { key: 'total', label: 'Total', type: 'money' }],
        rows, nextCursor: start + rows.length < all.length ? String(start + rows.length) : null,
      });
    }
    if (method === 'GET' && path === '/views') {
      const all = views.map(({ config, ...v }) => ({ ...v, metrics: config.metrics, issues: config.metrics.every((m) => can(m.id)) ? [] : ['You do not have access to the data Amount invoiced uses.'] }));
      // Pages of `pageSize` (default: everything), so the client's cursor loop is exercised.
      const size = o.pageSize ?? 100;
      const start = Number(url.searchParams.get('cursor') ?? 0);
      return json(200, { views: all.slice(start, start + size), nextCursor: start + size < all.length ? String(start + size) : null });
    }
    if (method === 'POST' && path === '/views') {
      const input = CreateSavedViewRequest.parse(body);
      if (input.visibility === 'BUSINESS' && !held.has('reporting:share')) return json(403, { error: 'forbidden' });
      const view: SavedView = {
        id: randomUUID(), title: input.title, description: input.description ?? null, reportType: 'metrics', config: input.config, configVersion: 1, visibility: input.visibility,
        ownerUserId: '00000000-0000-4000-8000-0000000000aa', isOwner: true, version: 1, createdAt: NOW, updatedAt: NOW,
      };
      views.unshift(view);
      return json(201, { view });
    }
    const one = /^\/views\/([^/]+)(\/run)?$/.exec(path);
    const view = one ? views.find((v) => v.id === one[1]) : undefined;
    if (one && !view) return json(404, { error: 'not_found' });
    if (view && one?.[2] && method === 'POST') return json(200, { view, result: result(view.config, true) });
    if (view && method === 'GET') return json(200, { view });
    if (view && method === 'PATCH') {
      const patch = UpdateSavedViewRequest.parse(body);
      if (patch.version !== view.version) return json(409, { error: 'stale' });
      Object.assign(view, { ...patch, version: view.version + 1, updatedAt: NOW });
      return json(200, { view });
    }
    if (view && method === 'DELETE') {
      views.splice(views.indexOf(view), 1);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not_found' });
  }
  return { fetch: fetchImpl as typeof fetch, calls, views, release: () => release() };
}
