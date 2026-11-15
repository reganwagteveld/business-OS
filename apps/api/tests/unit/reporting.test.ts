/**
 * Reporting R1 (docs/reporting-r1.md): the pure parts of the engine. Calendar arithmetic, registry
 * invariants, request validation, access intersection, and how source rows become series. The database
 * paths (tenancy, RLS, Zone read models, saved views) are in tests/integration/reporting.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ReportingQueryRequest, SavedViewConfig } from '@business-os/contracts';
import { ForbiddenError, permissionsFor, type Role } from '@/modules/access';
import { addDays, buckets, checkRange, daysBetween, previousPeriod, resolveDate, todayIn, LIMITS } from '@/modules/reporting/server/periods';
import { METRICS, metricById, type MetricDefinition } from '@/modules/reporting/server/registry';
import { checkAccess, checkShape, resolveMetric, shapeSeries } from '@/modules/reporting/server/engine';
import { DETAIL_SOURCES, PERIOD_SOURCES, SNAPSHOT_SOURCES } from '@/modules/reporting/server/sources';

const as = (role: Role) => ({ role, permissions: new Set(permissionsFor(role)) });
const def = (id: string) => metricById(id)!;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string; name: string }).code ?? (error as Error).name;
  }
  return 'no error';
};

describe('calendar periods', () => {
  it('fills day, ISO-week (Monday) and month buckets, the first one possibly starting before the range', () => {
    expect(buckets({ from: '2026-11-28', to: '2026-12-02' }, 'day')).toEqual(['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    // 2026-11-04 is a Wednesday: its week starts Monday 2 November.
    expect(buckets({ from: '2026-11-04', to: '2026-11-20' }, 'week')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(buckets({ from: '2026-11-15', to: '2027-02-01' }, 'month')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
    expect(buckets({ from: '2026-11-15', to: '2027-02-01' }, 'none')).toEqual(['2026-11-15']);
  });

  it('crosses leap days and year ends', () => {
    expect(buckets({ from: '2028-02-27', to: '2028-03-01' }, 'day')).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
    expect(buckets({ from: '2026-12-28', to: '2027-01-05' }, 'week')).toEqual(['2026-12-28', '2027-01-04']);
  });

  it('resolves presets against today in the business zone, not the server zone', () => {
    // 2026-11-30 23:30 UTC is already 1 December in Perth (UTC+8) and still 30 November in Los Angeles.
    const instant = new Date('2026-11-30T23:30:00Z');
    expect(todayIn('Australia/Perth', instant)).toBe('2026-12-01');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-11-30');
    const today = '2026-11-15';
    expect(resolveDate({ kind: 'relative', preset: 'last_7_days' }, today)).toEqual({ from: '2026-11-09', to: today });
    expect(resolveDate({ kind: 'relative', preset: 'last_30_days' }, today)).toEqual({ from: '2026-10-17', to: today });
    expect(resolveDate({ kind: 'relative', preset: 'this_month' }, today)).toEqual({ from: '2026-11-01', to: today });
    expect(resolveDate({ kind: 'relative', preset: 'last_month' }, today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveDate({ kind: 'relative', preset: 'last_3_months' }, today)).toEqual({ from: '2026-09-01', to: today });
    expect(resolveDate({ kind: 'relative', preset: 'last_12_months' }, today)).toEqual({ from: '2025-12-01', to: today });
    expect(resolveDate({ kind: 'relative', preset: 'year_to_date' }, today)).toEqual({ from: '2026-01-01', to: today });
    expect(resolveDate({ kind: 'relative', preset: 'last_month' }, '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveDate({ kind: 'relative', preset: 'last_month' }, '2027-01-10')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('compares with the immediately preceding period of the same number of days (R-D5)', () => {
    // Partial month: 15 days back, not the same dates of the previous month.
    expect(previousPeriod({ from: '2026-11-01', to: '2026-11-15' })).toEqual({ from: '2026-10-17', to: '2026-10-31' });
    // Whole months of different lengths are compared day for day, never month for month.
    expect(previousPeriod({ from: '2026-11-01', to: '2026-11-30' })).toEqual({ from: '2026-10-02', to: '2026-10-31' }); // 30 days
    expect(previousPeriod({ from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-08-31', to: '2026-09-30' }); // 31 days
    expect(previousPeriod({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-01-29', to: '2026-02-28' }); // across a 28-day February
    expect(previousPeriod({ from: '2028-03-01', to: '2028-03-31' })).toEqual({ from: '2028-01-30', to: '2028-02-29' }); // leap year
    expect(previousPeriod({ from: '2026-02-01', to: '2026-02-28' })).toEqual({ from: '2026-01-04', to: '2026-01-31' }); // 28 days
    // Quarters and year ends: the same rule.
    expect(previousPeriod({ from: '2026-07-01', to: '2026-09-30' })).toEqual({ from: '2026-03-31', to: '2026-06-30' }); // 92 days
    expect(previousPeriod({ from: '2027-01-01', to: '2027-01-07' })).toEqual({ from: '2026-12-25', to: '2026-12-31' });
    expect(previousPeriod({ from: '2026-03-02', to: '2026-03-02' })).toEqual({ from: '2026-03-01', to: '2026-03-01' });
    // Always contiguous and the same length.
    for (const [from, to] of [['2026-01-15', '2026-04-03'], ['2026-11-01', '2026-11-15'], ['2028-02-01', '2028-02-29']] as const) {
      const prev = previousPeriod({ from, to });
      expect(addDays(prev.to, 1)).toBe(from);
      expect(daysBetween(prev.from, prev.to)).toBe(daysBetween(from, to));
    }
  });

  it('aligns comparison buckets by position over the preceding days', () => {
    // 1–15 Nov by week has three Monday weeks (26 Oct, 2 Nov, 9 Nov); 17–31 Oct has three as well.
    const range = { from: '2026-11-01', to: '2026-11-15' };
    expect(buckets(range, 'week')).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    expect(buckets(previousPeriod(range), 'week')).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    // Days compare day n with day n.
    expect(buckets(previousPeriod(range), 'day')).toHaveLength(buckets(range, 'day').length);
  });

  it('bounds ranges and bucket counts with actionable codes', () => {
    expect(code(() => checkRange({ from: '2026-11-02', to: '2026-11-01' }, 'day'))).toBe('invalid_date_range');
    expect(code(() => checkRange({ from: '2020-01-01', to: '2026-12-31' }, 'month'))).toBe('range_too_large');
    expect(code(() => checkRange({ from: '2025-01-01', to: '2026-12-31' }, 'day'))).toBe('too_many_buckets');
    expect(code(() => checkRange({ from: '2025-01-01', to: '2026-12-31' }, 'week'))).toBe('no error');
    expect(code(() => checkRange({ from: '2022-01-01', to: '2026-12-31' }, 'month'))).toBe('no error');
    expect(LIMITS.maxRangeDays).toBeLessThanOrEqual(1827);
  });
});

describe('registry', () => {
  it('has unique, well-formed ids, a compatible current version and a source for every available metric', () => {
    expect(new Set(METRICS.map((m) => m.id)).size).toBe(METRICS.length);
    for (const m of METRICS) {
      expect(m.id).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(m.id.startsWith(`${m.zone}.`)).toBe(true);
      expect(m.compatible).toContain(m.version);
      expect(m.requires.length).toBeGreaterThan(0);
      if (m.availability === 'available') {
        expect(m.source).not.toBeNull();
        const bound = m.temporal === 'snapshot' ? SNAPSHOT_SOURCES[m.source!] : PERIOD_SOURCES[m.source!];
        expect(bound, m.id).toBeTypeOf('function');
        if (m.hasDetail) expect(DETAIL_SOURCES[m.source!], m.id).toBeTypeOf('function');
      } else {
        expect(m.plannedNote).toBeTruthy();
        expect(m.source).toBeNull();
      }
    }
  });

  it('never needs sensitive People data and protects small People groups', () => {
    for (const m of METRICS) expect(m.requires).not.toContain('people:read_sensitive');
    expect(def('people.headcount').minimumGroupSize).toBeGreaterThanOrEqual(5);
  });

  it('keeps invoiced, received and outstanding apart, and never calls invoicing revenue', () => {
    const [invoiced, received, outstanding] = ['finance.invoiced_amount', 'finance.payments_received', 'finance.receivables_outstanding'].map(def);
    expect(new Set([invoiced!.source, received!.source, outstanding!.source]).size).toBe(3);
    expect(invoiced!.semantics).toMatch(/not recognised revenue/);
    for (const m of METRICS) expect(`${m.name} ${m.description}`).not.toMatch(/revenue/i);
    expect(outstanding!.temporal).toBe('snapshot');
  });

  it('requires the source Zone key, and customer names need customers:read', () => {
    expect(def('finance.invoiced_amount').requires).toEqual(['finance:read']);
    expect(def('sales.won_value').requires).toEqual(['sales:read']);
    expect(def('customers.new_customers').requires).toEqual(['customers:read']);
    for (const m of METRICS.filter((x) => x.dimensions.includes('customer'))) expect(m.dimensionRequires.customer).toContain('customers:read');
  });
});

describe('validation', () => {
  it('refuses unknown, retired-version and planned metrics with codes a person can act on', () => {
    expect(code(() => resolveMetric({ id: 'finance.revenue', version: 1 }))).toBe('unknown_metric');
    expect(code(() => resolveMetric({ id: 'finance.invoiced_amount', version: 2 }))).toBe('metric_version_unsupported');
    expect(code(() => resolveMetric({ id: 'people.headcount', version: 1 }))).toBe('metric_unavailable');
    expect(resolveMetric({ id: 'finance.invoiced_amount', version: 1 }).id).toBe('finance.invoiced_amount');
  });

  it('refuses granularities, dimensions and filters a metric does not support', () => {
    const base = { granularity: 'month' as const, groupBy: null, filters: {} };
    expect(code(() => checkShape(def('customers.new_customers'), { ...base, groupBy: 'customer' }))).toBe('unsupported_dimension');
    expect(code(() => checkShape(def('customers.new_customers'), { ...base, filters: { currencyCode: 'AUD' } }))).toBe('unsupported_filter');
    expect(code(() => checkShape(def('finance.receivables_outstanding'), { ...base, groupBy: 'customer' }))).toBe('unsupported_dimension');
    expect(code(() => checkShape(def('finance.invoiced_amount'), { ...base, groupBy: 'customer', filters: { currencyCode: 'AUD' } }))).toBe('no error');
  });

  it('accepts only registered shapes on the wire: no SQL, tables, expressions or unknown fields', () => {
    const ok = { metrics: [{ id: 'finance.invoiced_amount', version: 1 }], date: { kind: 'relative', preset: 'last_30_days' } };
    expect(ReportingQueryRequest.safeParse(ok).success).toBe(true);
    const bad = [
      { ...ok, sql: 'select 1' },
      { ...ok, metrics: [{ id: 'finance_documents; drop table x', version: 1 }] },
      { ...ok, metrics: [{ id: "finance.invoiced_amount' OR '1'='1", version: 1 }] },
      { ...ok, groupBy: 'customer_id' },
      { ...ok, filters: { businessId: '00000000-0000-4000-8000-000000000000' } },
      { ...ok, filters: { customerId: "1' OR 1=1" } },
      { ...ok, filters: { currencyCode: 'aud' } },
      { ...ok, granularity: 'hour' },
      { ...ok, date: { kind: 'fixed', from: '2026-02-30', to: '2026-03-01' } },
      { ...ok, date: { kind: 'fixed', from: '1999-12-31', to: '2026-03-01' } },
      { ...ok, date: { kind: 'relative', preset: 'all_time' } },
      { ...ok, metrics: Array.from({ length: 7 }, () => ok.metrics[0]) },
      { ...ok, metrics: [] },
    ];
    for (const body of bad) expect(ReportingQueryRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it('validates saved configurations strictly too', () => {
    const config = {
      metrics: [{ id: 'finance.invoiced_amount', version: 1 }], date: { kind: 'relative', preset: 'this_month' }, granularity: 'day', groupBy: null,
      filters: {}, comparison: 'previous_period', sort: { by: 'bucket', direction: 'asc' }, visualization: { chart: 'line', showComparison: true },
    };
    expect(SavedViewConfig.safeParse(config).success).toBe(true);
    expect(SavedViewConfig.safeParse({ ...config, results: [] }).success).toBe(false);
    expect(SavedViewConfig.safeParse({ ...config, sort: { by: 'total; drop', direction: 'asc' } }).success).toBe(false);
  });
});

describe('access is the intersection of Reporting, source and dimension keys', () => {
  it('follows the role defaults', () => {
    const finance = def('finance.invoiced_amount');
    expect(code(() => checkAccess(as('OWNER'), finance, 'customer'))).toBe('no error');
    expect(code(() => checkAccess(as('MANAGER'), finance, null))).toBe('no error');
    // MEMBER holds reporting:read but no finance key.
    expect(permissionsFor('MEMBER')).toContain('reporting:read');
    expect(code(() => checkAccess(as('MEMBER'), finance, null))).toBe('ForbiddenError');
    expect(code(() => checkAccess(as('MEMBER'), def('sales.won_count'), null))).toBe('no error');
  });

  it('refuses a dimension whose Zone the caller cannot read, even with the source key', () => {
    const financeOnly = { role: 'MANAGER' as Role, permissions: new Set(['reporting:read', 'finance:read'] as const) };
    expect(code(() => checkAccess(financeOnly as never, def('finance.invoiced_amount'), null))).toBe('no error');
    expect(() => checkAccess(financeOnly as never, def('finance.invoiced_amount'), 'customer')).toThrow(ForbiddenError);
  });

  it('gives sharing to OWNER, ADMIN and MANAGER, and managing others\' views to OWNER and ADMIN only', () => {
    const has = (role: Role, key: string) => permissionsFor(role).includes(key as never);
    expect(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'].map((r) => has(r as Role, 'reporting:save'))).toEqual([true, true, true, true]);
    expect(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'].map((r) => has(r as Role, 'reporting:share'))).toEqual([true, true, true, false]);
    expect(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'].map((r) => has(r as Role, 'reporting:manage'))).toEqual([true, true, false, false]);
  });
});

describe('series shaping', () => {
  const range = { from: '2026-10-01', to: '2026-12-31' };
  const shape = (d: MetricDefinition, opts: Partial<Parameters<typeof shapeSeries>[1]> = {}) =>
    shapeSeries(d, { groupBy: null, granularity: 'month', range, comparisonRange: null, current: [], previous: [], labels: new Map(), ...opts });

  it('never adds money across currencies, and fills empty buckets with zero at the currency decimals', () => {
    const out = shape(def('finance.invoiced_amount'), {
      current: [
        { bucket: '2026-10-01', currencyCode: 'AUD', customerId: null, amount: '100.50', count: 1 },
        { bucket: '2026-12-01', currencyCode: 'AUD', customerId: null, amount: '20.25', count: 2 },
        { bucket: '2026-11-01', currencyCode: 'JPY', customerId: null, amount: '5000', count: 1 },
      ],
    });
    expect(out.buckets).toEqual(['2026-10-01', '2026-11-01', '2026-12-01']);
    const aud = out.series.find((s) => s.currencyCode === 'AUD')!;
    const jpy = out.series.find((s) => s.currencyCode === 'JPY')!;
    expect(aud.points.map((p) => p.value)).toEqual(['100.50', '0.00', '20.25']);
    expect(aud.total).toBe('120.75');
    expect(jpy.points.map((p) => p.value)).toEqual(['0', '5000', '0']);
    expect(out.series).toHaveLength(2);
  });

  it('keeps exact decimals (no floating point)', () => {
    const rows = Array.from({ length: 10 }, () => ({ bucket: '2026-10-01', currencyCode: 'AUD', customerId: null, amount: '0.10', count: 1 }));
    expect(shape(def('finance.invoiced_amount'), { current: rows }).series[0]!.total).toBe('1.00');
  });

  it('shows an empty count as zero, and an empty money metric as no series', () => {
    const count = shape(def('customers.new_customers'));
    expect(count.series).toHaveLength(1);
    expect(count.series[0]!.points.map((p) => p.value)).toEqual(['0', '0', '0']);
    expect(shape(def('finance.invoiced_amount')).series).toEqual([]);
  });

  it('aligns the previous period by position and computes the change', () => {
    const out = shape(def('sales.won_count'), {
      comparisonRange: { from: '2026-07-01', to: '2026-09-30' },
      current: [{ bucket: '2026-10-01', currencyCode: 'AUD', customerId: null, amount: '0', count: 3 }],
      previous: [
        { bucket: '2026-07-01', currencyCode: 'AUD', customerId: null, amount: '0', count: 1 },
        { bucket: '2026-09-01', currencyCode: 'USD', customerId: null, amount: '0', count: 1 },
      ],
    });
    const s = out.series[0]!;
    expect(s.total).toBe('3');
    expect(s.comparisonTotal).toBe('2');
    expect(s.changePercent).toBe('50.0');
    expect(s.comparisonPoints!.map((p) => [p.bucket, p.value])).toEqual([['2026-07-01', '1'], ['2026-08-01', '0'], ['2026-09-01', '1']]);
  });

  it('reports no change from zero rather than infinity', () => {
    const out = shape(def('sales.won_count'), {
      comparisonRange: { from: '2026-07-01', to: '2026-09-30' },
      current: [{ bucket: '2026-10-01', currencyCode: 'AUD', customerId: null, amount: '0', count: 3 }],
    });
    expect(out.series[0]!.changePercent).toBeNull();
  });

  it('labels customers by name, never mixing currencies within a customer', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const out = shape(def('finance.invoiced_amount'), {
      groupBy: 'customer', granularity: 'none',
      current: [
        { bucket: '2026-10-01', currencyCode: 'AUD', customerId: id, amount: '10.00', count: 1 },
        { bucket: '2026-11-01', currencyCode: 'USD', customerId: id, amount: '7.00', count: 1 },
      ],
      labels: new Map([[id, 'Acme']]),
    });
    expect(out.series.map((s) => s.label).sort()).toEqual(['Acme (AUD)', 'Acme (USD)']);
    expect(out.buckets).toEqual(['2026-10-01']);
  });

  it('keeps the largest series and counts the rest, deterministically', () => {
    const rows = Array.from({ length: LIMITS.maxSeries + 3 }, (_, i) => ({
      bucket: '2026-10-01', currencyCode: 'AUD', customerId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, amount: `${i + 1}.00`, count: 1,
    }));
    const out = shape(def('finance.invoiced_amount'), { groupBy: 'customer', current: rows });
    expect(out.series).toHaveLength(LIMITS.maxSeries);
    expect(out.hiddenSeries).toBe(3);
    expect(out.series[0]!.total).toBe(`${LIMITS.maxSeries + 3}.00`);
    expect(shape(def('finance.invoiced_amount'), { groupBy: 'customer', current: [...rows].reverse() }).series.map((s) => s.key)).toEqual(out.series.map((s) => s.key));
  });

  it('suppresses groups and buckets below the minimum group size', () => {
    const sensitive: MetricDefinition = { ...def('customers.new_customers'), minimumGroupSize: 5 };
    const out = shapeSeries(sensitive, {
      groupBy: null, granularity: 'month', range, comparisonRange: null, labels: new Map(), previous: [],
      current: [
        { bucket: '2026-10-01', currencyCode: null, customerId: null, amount: null, count: 7 },
        { bucket: '2026-11-01', currencyCode: null, customerId: null, amount: null, count: 2 },
      ],
    });
    const s = out.series[0]!;
    expect(s.points.map((p) => p.value)).toEqual(['7', null, '0']);
    expect(s.suppressed).toBe(true);
    // 9 − 7 would reveal the hidden 2: the total is suppressed with it.
    expect(s.total).toBeNull();
    const tiny = shapeSeries(sensitive, {
      groupBy: null, granularity: 'none', range, comparisonRange: null, labels: new Map(), previous: [],
      current: [{ bucket: '2026-10-01', currencyCode: null, customerId: null, amount: null, count: 3 }],
    });
    expect(tiny.series[0]!.total).toBeNull();
    expect(tiny.series[0]!.points[0]!.value).toBeNull();
  });
});
