import 'server-only';
// The reporting query engine (docs/reporting-r1.md §5). It validates a request against the registry,
// checks access (reporting:read is checked by the route; here every metric's source keys and every
// dimension's keys), resolves dates in the business's time zone, calls the bound sources and shapes the
// rows into series. It holds no business rules of its own: what counts and how much comes from the
// owning Zone. Everything runs inside the caller's tenant unit of work (bos_app, forced RLS).
import type {
  MetricRef, ReportingDetails, ReportingDetailsRequest, ReportingDimension, ReportingFilters, ReportingGranularity, ReportingMetricResult,
  ReportingQueryRequest, ReportingQueryResult, ReportingRange, ReportingSeries,
} from '@business-os/contracts';
import { Decimal, type AppTenantDb } from '@/core/db';
import { RuleViolationError } from '@/core/http/errors';
import { can, ForbiddenError, type Permission, type Principal } from '@/modules/access';
import { buckets, checkRange, LIMITS, previousPeriod, resolveDate, todayIn } from './periods';
import { metricById, METRICS, type MetricDefinition } from './registry';
import { customerLabels, DETAIL_SOURCES, PERIOD_SOURCES, SNAPSHOT_SOURCES, type SourceRow } from './sources';

export type ParsedQuery = {
  metrics: MetricRef[];
  date: ReportingQueryRequest['date'];
  granularity: ReportingGranularity;
  groupBy: ReportingDimension | null;
  filters: ReportingFilters;
  comparison: 'none' | 'previous_period';
};

const FORBIDDEN_MESSAGE = 'You do not have access to the data this metric uses.';

export async function businessTimeZone(db: AppTenantDb): Promise<string> {
  return (await db.business.findFirstOrThrow({ select: { timeZone: true } })).timeZone;
}

const holdsAll = (actor: Principal, keys: readonly Permission[]) => keys.every((k) => can(actor, k));

/** The registry as the caller sees it: every metric, with whether they may run it. Nothing about data. */
export async function catalog(db: AppTenantDb, actor: Principal) {
  const timeZone = await businessTimeZone(db);
  return {
    timeZone,
    today: todayIn(timeZone),
    limits: { ...LIMITS },
    metrics: METRICS.map((m) => ({
      id: m.id, version: m.version, name: m.name, description: m.description, zone: m.zone, valueType: m.valueType, unit: m.unit, temporal: m.temporal,
      semantics: m.semantics, dateField: m.dateField, timeZone: m.timeZone, statusTreatment: m.statusTreatment, granularities: [...m.granularities],
      dimensions: [...m.dimensions], filters: [...m.filters], requires: [...m.requires],
      dimensionRequires: Object.fromEntries(Object.entries(m.dimensionRequires).map(([k, v]) => [k, [...(v ?? [])]])),
      tenantScope: 'business' as const, availability: m.availability, plannedNote: m.plannedNote, accessible: holdsAll(actor, m.requires),
      hasDetail: m.hasDetail, defaultChart: m.defaultChart, minimumGroupSize: m.minimumGroupSize,
    })),
  };
}

/** The current definition for a stored or requested {id, version}, or an actionable refusal. */
export function resolveMetric(ref: MetricRef): MetricDefinition {
  const def = metricById(ref.id);
  if (!def) throw new RuleViolationError('unknown_metric', `There is no metric called ${ref.id}. Remove it from this report.`);
  if (!def.compatible.includes(ref.version)) {
    throw new RuleViolationError('metric_version_unsupported',
      `${def.name} has changed since this report was saved (version ${ref.version}; now ${def.version}). Edit the report and choose it again.`);
  }
  if (def.availability !== 'available') throw new RuleViolationError('metric_unavailable', `${def.name} is not available yet.`);
  return def;
}

/** Registry checks that do not depend on who asks: granularity, dimension and filters this metric supports. */
export function checkShape(def: MetricDefinition, q: Pick<ParsedQuery, 'granularity' | 'groupBy' | 'filters'>): void {
  if (def.temporal === 'period' && !def.granularities.includes(q.granularity)) {
    throw new RuleViolationError('unsupported_granularity', `${def.name} cannot be shown by ${q.granularity}.`);
  }
  if (q.groupBy && !def.dimensions.includes(q.groupBy)) {
    throw new RuleViolationError('unsupported_dimension', `${def.name} cannot be grouped by ${q.groupBy}. Choose another grouping or remove it.`);
  }
  for (const [key, value] of Object.entries(q.filters)) {
    if (value !== undefined && !def.filters.includes(key as 'currencyCode' | 'customerId')) {
      throw new RuleViolationError('unsupported_filter', `${def.name} cannot be filtered by ${key === 'customerId' ? 'customer' : 'currency'}. Remove that filter.`);
    }
  }
}

/** Access = reporting:read (route) ∩ the metric's source keys ∩ the grouping dimension's keys. */
export function checkAccess(actor: Principal, def: MetricDefinition, groupBy: ReportingDimension | null): void {
  if (!holdsAll(actor, def.requires)) throw new ForbiddenError(FORBIDDEN_MESSAGE);
  if (groupBy && !holdsAll(actor, def.dimensionRequires[groupBy] ?? [])) throw new ForbiddenError(FORBIDDEN_MESSAGE);
}

const DIGITS = new Map<string, number>();
function scaleOf(currency: string): number {
  let digits = DIGITS.get(currency);
  if (digits === undefined) {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    DIGITS.set(currency, digits);
  }
  return digits;
}

type Acc = { currencyCode: string | null; customerId: string | null; current: Map<string, { v: Decimal; n: number }>; previous: Map<string, { v: Decimal; n: number }> };

function keyOf(def: MetricDefinition, groupBy: ReportingDimension | null, row: SourceRow): { key: string; currencyCode: string | null; customerId: string | null } {
  const customer = row.customerId ?? 'none';
  if (def.valueType === 'money') {
    // Money is never added across currencies: the currency is always part of the series.
    return groupBy === 'customer'
      ? { key: `${customer}|${row.currencyCode}`, currencyCode: row.currencyCode, customerId: row.customerId }
      : { key: String(row.currencyCode), currencyCode: row.currencyCode, customerId: null };
  }
  if (groupBy === 'currency') return { key: String(row.currencyCode), currencyCode: row.currencyCode, customerId: null };
  if (groupBy === 'customer') return { key: customer, currencyCode: null, customerId: row.customerId };
  return { key: 'all', currencyCode: null, customerId: null };
}

function percentChange(current: Decimal, previous: Decimal): string | null {
  if (previous.isZero()) return null;
  return current.sub(previous).div(previous.abs()).mul(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
}

/**
 * Shapes source rows into series: buckets filled with zeros, totals, comparison aligned by position,
 * small groups suppressed, the largest `maxSeries` kept. Exported for unit tests (no database).
 */
export function shapeSeries(def: MetricDefinition, args: {
  groupBy: ReportingDimension | null; granularity: ReportingGranularity; range: ReportingRange; comparisonRange: ReportingRange | null;
  current: SourceRow[]; previous: SourceRow[]; labels: Map<string, string>;
}): { buckets: string[]; series: ReportingSeries[]; hiddenSeries: number } {
  const currentBuckets = buckets(args.range, args.granularity);
  const previousBuckets = args.comparisonRange ? buckets(args.comparisonRange, args.granularity) : [];
  const groups = new Map<string, Acc>();
  const add = (row: SourceRow, side: 'current' | 'previous') => {
    const k = keyOf(def, args.groupBy, row);
    let acc = groups.get(k.key);
    if (!acc) groups.set(k.key, (acc = { currencyCode: k.currencyCode, customerId: k.customerId, current: new Map(), previous: new Map() }));
    const bucket = args.granularity === 'none' ? (side === 'current' ? currentBuckets[0]! : previousBuckets[0]!) : row.bucket;
    const value = def.value === 'amount' ? new Decimal(row.amount ?? 0) : new Decimal(row.count);
    const cell = acc[side].get(bucket) ?? { v: new Decimal(0), n: 0 };
    acc[side].set(bucket, { v: cell.v.add(value), n: cell.n + row.count });
  };
  for (const row of args.current) add(row, 'current');
  for (const row of args.previous) add(row, 'previous');
  // A count with no grouping always has its one series, so an empty period reads as zero, not "no data".
  if (def.valueType === 'count' && !args.groupBy && !groups.has('all')) groups.set('all', { currencyCode: null, customerId: null, current: new Map(), previous: new Map() });

  const k = def.minimumGroupSize;
  const fmt = (v: Decimal, currency: string | null) => (def.valueType === 'money' && currency ? v.toFixed(scaleOf(currency)) : v.toFixed(0));
  const built = [...groups.entries()].map(([key, acc]) => {
    const sum = (m: Map<string, { v: Decimal; n: number }>) => [...m.values()].reduce((s, c) => ({ v: s.v.add(c.v), n: s.n + c.n }), { v: new Decimal(0), n: 0 });
    const total = sum(acc.current);
    const previous = sum(acc.previous);
    const hide = (n: number) => k !== null && n > 0 && n < k;
    // Any suppressed bucket also hides the totals, or the hidden value could be recovered by subtraction.
    const suppressed = hide(total.n) || [...acc.current.values()].some((c) => hide(c.n));
    const previousSuppressed = hide(previous.n) || [...acc.previous.values()].some((c) => hide(c.n));
    const point = (m: Map<string, { v: Decimal; n: number }>) => (bucket: string) => {
      const c = m.get(bucket);
      return { bucket, value: c && hide(c.n) ? null : fmt(c?.v ?? new Decimal(0), acc.currencyCode) };
    };
    let label = def.name;
    if (key !== 'all') {
      const customerLabel = acc.customerId ? args.labels.get(acc.customerId) ?? 'Unknown customer' : 'No customer';
      label = args.groupBy === 'customer'
        ? def.valueType === 'money' ? `${customerLabel} (${acc.currencyCode})` : customerLabel
        : String(acc.currencyCode);
    }
    return {
      sortValue: total.v,
      series: {
        key, label, currencyCode: acc.currencyCode, customerId: acc.customerId,
        total: suppressed ? null : fmt(total.v, acc.currencyCode),
        comparisonTotal: args.comparisonRange ? (previousSuppressed ? null : fmt(previous.v, acc.currencyCode)) : null,
        changePercent: args.comparisonRange && !suppressed && !previousSuppressed ? percentChange(total.v, previous.v) : null,
        points: currentBuckets.map(point(acc.current)),
        comparisonPoints: args.comparisonRange ? previousBuckets.slice(0, currentBuckets.length).map(point(acc.previous)) : null,
        suppressed,
      } satisfies ReportingSeries,
    };
  });
  // Deterministic: largest first, then by key. Currencies are never compared for value, only ordered.
  built.sort((a, b) => b.sortValue.comparedTo(a.sortValue) || (a.series.key < b.series.key ? -1 : a.series.key > b.series.key ? 1 : 0));
  return { buckets: currentBuckets, series: built.slice(0, LIMITS.maxSeries).map((b) => b.series), hiddenSeries: Math.max(0, built.length - LIMITS.maxSeries) };
}

async function runOne(db: AppTenantDb, actor: Principal, ref: MetricRef, q: ParsedQuery, ctx: {
  timeZone: string; range: ReportingRange; comparisonRange: ReportingRange | null;
}): Promise<ReportingMetricResult> {
  const def = resolveMetric(ref);
  checkShape(def, q);
  checkAccess(actor, def, q.groupBy);
  const notes: string[] = [];
  if (def.temporal === 'snapshot') {
    const source = SNAPSHOT_SOURCES[def.source!]!;
    const snap = await source(db);
    if (q.granularity !== 'none') notes.push('A current balance: the date range and interval do not apply.');
    if (ctx.comparisonRange) notes.push('No comparison: past balances are not available in this release.');
    const rows = snap.rows.filter((r) => !q.filters.currencyCode || r.currencyCode === q.filters.currencyCode);
    const series: ReportingSeries[] = rows.map((r) => ({
      key: r.currencyCode, label: r.currencyCode, currencyCode: r.currencyCode, customerId: null, total: r.amount, comparisonTotal: null,
      changePercent: null, points: [], comparisonPoints: null, suppressed: false,
    }));
    return {
      status: 'ok', metric: { id: def.id, version: def.version }, name: def.name, valueType: def.valueType, unit: def.unit, temporal: 'snapshot',
      granularity: 'none', groupBy: q.groupBy, buckets: [], series, hiddenSeries: 0, asOf: snap.asOf, notes,
    };
  }
  const source = PERIOD_SOURCES[def.source!]!;
  const unit = q.granularity === 'none' ? 'month' : q.granularity;
  const byCustomer = q.groupBy === 'customer';
  const [current, previous] = await Promise.all([
    source(db, { range: ctx.range, unit, byCustomer, filters: q.filters, timeZone: ctx.timeZone }),
    ctx.comparisonRange ? source(db, { range: ctx.comparisonRange, unit, byCustomer, filters: q.filters, timeZone: ctx.timeZone }) : Promise.resolve([]),
  ]);
  const ids = byCustomer ? [...current, ...previous].map((r) => r.customerId).filter((id): id is string => id !== null) : [];
  const labels = ids.length ? await customerLabels(db, ids) : new Map<string, string>();
  const shaped = shapeSeries(def, { groupBy: q.groupBy, granularity: q.granularity, range: ctx.range, comparisonRange: ctx.comparisonRange, current, previous, labels });
  if (def.valueType === 'money' && shaped.series.length > 1 && q.groupBy !== 'customer') notes.push('Each currency is shown separately; amounts are never converted or added together.');
  return {
    status: 'ok', metric: { id: def.id, version: def.version }, name: def.name, valueType: def.valueType, unit: def.unit, temporal: 'period',
    granularity: q.granularity, groupBy: q.groupBy, ...shaped, asOf: null, notes,
  };
}

/**
 * Runs a query. `strict` (ad-hoc queries): any registry or access problem fails the whole request
 * (400 with an actionable code, or 403). `lenient` (saved views): each failing metric becomes an error
 * entry naming the problem, and the others still run; no data of a failing metric is returned.
 */
export async function runQuery(db: AppTenantDb, actor: Principal, q: ParsedQuery, mode: 'strict' | 'lenient'): Promise<ReportingQueryResult> {
  if (q.metrics.length > LIMITS.maxMetrics) throw new RuleViolationError('too_many_metrics', `At most ${LIMITS.maxMetrics} metrics per report.`);
  const timeZone = await businessTimeZone(db);
  const range = resolveDate(q.date, todayIn(timeZone));
  checkRange(range, q.granularity);
  const comparisonRange = q.comparison === 'previous_period' ? previousPeriod(range) : null;
  const results: ReportingMetricResult[] = [];
  for (const ref of q.metrics) {
    try {
      results.push(await runOne(db, actor, ref, q, { timeZone, range, comparisonRange }));
    } catch (error) {
      if (mode === 'strict') throw error;
      const name = metricById(ref.id)?.name ?? null;
      if (error instanceof ForbiddenError) results.push({ status: 'error', metric: ref, name, code: 'forbidden_source', message: FORBIDDEN_MESSAGE });
      else if (error instanceof RuleViolationError) results.push({ status: 'error', metric: ref, name, code: error.code, message: error.detail });
      else throw error;
    }
  }
  return { timeZone, range, comparisonRange, results };
}

/** One page of the records behind a metric, with exactly the filters of the aggregate. */
export async function runDetails(db: AppTenantDb, actor: Principal, req: Required<Omit<ReportingDetailsRequest, 'cursor'>> & { cursor?: string }): Promise<ReportingDetails> {
  const def = resolveMetric(req.metric);
  checkShape(def, { granularity: 'none', groupBy: null, filters: req.filters });
  checkAccess(actor, def, null);
  const source = def.hasDetail && def.source ? DETAIL_SOURCES[def.source] : undefined;
  if (!source) throw new RuleViolationError('no_detail', `${def.name} has no record list. Open the ${def.zone} Zone for details.`);
  const timeZone = await businessTimeZone(db);
  const range = resolveDate(req.date as ParsedQuery['date'], todayIn(timeZone));
  checkRange(range, 'none');
  const page = await source(db, { range, filters: req.filters as ReportingFilters, timeZone, cursor: req.cursor, limit: Math.min(req.limit, LIMITS.maxDetailRows) });
  // Customer names belong to the Customers Zone: shown only to callers who may read customers.
  const showCustomer = can(actor, 'customers:read') && page.rows.some((r) => r.customerId !== null);
  const labels = showCustomer ? await customerLabels(db, page.rows.map((r) => r.customerId).filter((id): id is string => id !== null)) : new Map<string, string>();
  return {
    metric: { id: def.id, version: def.version },
    range,
    columns: showCustomer ? [page.columns[0]!, { key: 'customer', label: 'Customer', type: 'text' }, ...page.columns.slice(1)] : page.columns,
    rows: page.rows.map((r) => ({
      id: r.id, currencyCode: r.currencyCode,
      cells: showCustomer ? { ...r.cells, customer: r.customerId ? labels.get(r.customerId) ?? null : null } : r.cells,
    })),
    nextCursor: page.nextCursor,
  };
}
