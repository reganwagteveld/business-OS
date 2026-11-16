import type { ReportingCatalog, ReportingDateConfig, ReportingGranularity, ReportingMetricDefinition, ReportingQueryResult } from '@business-os/contracts';
import { Field, SectionHeader, Select } from '@business-os/ui';
import type { ReportingClient } from '../../api/reporting';
import type { Outcome } from '../../api/tenancy';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { approxDays, autoGranularity, GRANULARITY_LABEL, rangeLabel, ZONE_LABEL } from './format';
import { DateRangeControl, Kpis, pick, runnableMetrics } from './shared';
import { MetricChartWidget, type DashboardLayout, type DashboardWidgetDef } from './widgets';

/**
 * The R2 dashboard: fixed for now (owner decision 2026-11-16), described as data so configurable dashboards
 * can follow without new rendering code. Only R1's registered, available metrics: there is no "revenue"
 * metric (R1 keeps billing, money received and sales outcomes apart), and expenses and projects have no
 * executable metric yet, so they appear under "Not available yet" from the registry instead.
 */
export const DEFAULT_DASHBOARD: DashboardLayout = {
  layoutVersion: 1,
  kpis: ['finance.invoiced_amount', 'finance.payments_received', 'finance.receivables_outstanding', 'finance.receivables_overdue', 'sales.won_value', 'customers.new_customers'],
  sections: [
    {
      id: 'finance', title: ZONE_LABEL.finance!, widgets: [
        { id: 'invoiced', kind: 'metric-chart', metricId: 'finance.invoiced_amount', chart: 'bar' },
        { id: 'received', kind: 'metric-chart', metricId: 'finance.payments_received', chart: 'line' },
        { id: 'invoices-issued', kind: 'metric-chart', metricId: 'finance.invoices_issued', chart: 'bar' },
      ],
    },
    {
      id: 'sales', title: ZONE_LABEL.sales!, widgets: [
        { id: 'won-value', kind: 'metric-chart', metricId: 'sales.won_value', chart: 'bar' },
        { id: 'won-count', kind: 'metric-chart', metricId: 'sales.won_count', chart: 'bar' },
      ],
    },
    { id: 'customers', title: ZONE_LABEL.customers!, widgets: [{ id: 'new-customers', kind: 'metric-chart', metricId: 'customers.new_customers', chart: 'line' }] },
  ],
};

export type DashboardInterval = 'auto' | Exclude<ReportingGranularity, 'none'>;
export interface DashboardSettings { date: ReportingDateConfig; comparison: boolean; interval: DashboardInterval }
export const DASHBOARD_DEFAULTS: DashboardSettings = { date: { kind: 'relative', preset: 'last_3_months' }, comparison: true, interval: 'auto' };

/** The interval actually requested: the person's choice, or a readable one for the range, never beyond the API's bucket limit. */
export function dashboardGranularity(s: DashboardSettings, today: string, maxBuckets: number): Exclude<ReportingGranularity, 'none'> {
  const days = approxDays(s.date, today);
  const wanted = s.interval === 'auto' ? autoGranularity(days) : s.interval;
  if (wanted === 'day' && days > maxBuckets) return days / 7 > maxBuckets ? 'month' : 'week';
  if (wanted === 'week' && days / 7 > maxBuckets) return 'month';
  return wanted;
}

/** Splits metrics into requests of at most `size` (the API's per-query limit). */
const chunk = <T,>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** What the dashboard hands Explore when the person drills down: the same metric, dates, comparison and interval. */
export interface DrillDown { metricId: string; date: ReportingDateConfig; comparison: boolean; granularity: Exclude<ReportingGranularity, 'none'> }

/**
 * The Reporting homepage (R2). Every figure comes from R1's registered metrics through the existing query
 * endpoint; only metrics the API marks `accessible` for this person are requested, so a person without
 * finance:read never asks for (or receives) Finance figures. Two bounded requests per change: headline
 * totals, and the chart series (split only if the API's metric limit requires).
 */
export function Dashboard({ client, slug, catalog, layout = DEFAULT_DASHBOARD, settings, onSettings, locale, businessCurrency, onExplore, onSessionEnded }: {
  client: ReportingClient; slug: string; catalog: ReportingCatalog; layout?: DashboardLayout; settings: DashboardSettings; onSettings: (s: DashboardSettings) => void;
  locale?: string; businessCurrency: string; onExplore: (drill: DrillDown) => void; onSessionEnded: () => void;
}) {
  const runnable = runnableMetrics(catalog.metrics);
  const kpis = pick(catalog.metrics, layout.kpis);
  const sections = layout.sections
    .map((s) => ({ ...s, widgets: s.widgets.flatMap((w) => { const m = runnable.find((x) => x.id === w.metricId); return m ? [{ widget: w, metric: m }] : []; }) }))
    .filter((s) => s.widgets.length > 0);
  const granularity = dashboardGranularity(settings, catalog.today, catalog.limits.maxBuckets);
  const planned = catalog.metrics.filter((m) => m.availability === 'planned' && m.accessible);
  const update = (patch: Partial<DashboardSettings>) => onSettings({ ...settings, ...patch });
  const explore = (metricId: string) => onExplore({ metricId, date: settings.date, comparison: settings.comparison, granularity });

  return (
    <div className="space-y-8">
      <section aria-label="Dashboard settings" className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <DateRangeControl date={settings.date} onChange={(date) => update({ date })} today={catalog.today} maxRangeDays={catalog.limits.maxRangeDays} idPrefix="dashboard" />
        <Field label="Interval" hint={settings.interval === 'auto' ? `Showing ${GRANULARITY_LABEL[granularity].toLowerCase()} by ${GRANULARITY_LABEL[granularity].toLowerCase()}.` : undefined}>
          {(c) => (
            <Select {...c} value={settings.interval} onChange={(e) => update({ interval: e.target.value as DashboardInterval })}>
              <option value="auto">Automatic</option>
              {(['day', 'week', 'month'] as const).map((g) => <option key={g} value={g}>{GRANULARITY_LABEL[g]}</option>)}
            </Select>
          )}
        </Field>
        <div className="self-end">
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={settings.comparison} aria-describedby="dashboard-compare-hint"
              onChange={(e) => update({ comparison: e.target.checked })} />
            Compare with previous period
          </label>
          <p id="dashboard-compare-hint" className="text-xs text-muted-foreground">The same number of days immediately before.</p>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
          Dates are calendar days in the business's time zone ({catalog.timeZone}). Amounts stay in their own currency and are never converted or added together.
        </p>
      </section>

      <Kpis client={client} slug={slug} date={settings.date} comparison={settings.comparison} metrics={kpis} locale={locale} onSessionEnded={onSessionEnded}
        columns="xl:grid-cols-3" pickLabel="Explore" onPick={explore} />

      {sections.length > 0 ? (
        <Charts client={client} slug={slug} sections={sections} date={settings.date} comparison={settings.comparison} granularity={granularity}
          maxMetrics={catalog.limits.maxMetrics} locale={locale} businessCurrency={businessCurrency} onExplore={explore} onSessionEnded={onSessionEnded} />
      ) : null}

      {planned.length > 0 ? (
        <section aria-label="Not available yet" className="space-y-3">
          <SectionHeader title="Not available yet" description="These figures are registered but cannot be calculated yet. Nothing is estimated in their place." />
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {planned.map((m) => (
              <li key={m.id} className="rounded-xl border border-dashed p-4 text-sm">
                <p className="font-medium">{m.name} <span className="text-muted-foreground">· {ZONE_LABEL[m.zone] ?? m.zone}</span></p>
                <p className="mt-1 text-muted-foreground">{m.plannedNote ?? m.description}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

type ResolvedSection = { id: string; title: string; widgets: { widget: DashboardWidgetDef; metric: ReportingMetricDefinition }[] };

function Charts({ client, slug, sections, date, comparison, granularity, maxMetrics, locale, businessCurrency, onExplore, onSessionEnded }: {
  client: ReportingClient; slug: string; sections: ResolvedSection[]; date: ReportingDateConfig; comparison: boolean; granularity: Exclude<ReportingGranularity, 'none'>;
  maxMetrics: number; locale?: string; businessCurrency: string; onExplore: (id: string) => void; onSessionEnded: () => void;
}) {
  // Each metric is requested once, even if a layout shows it twice.
  const metrics = [...new Map(sections.flatMap((s) => s.widgets.map((w) => [w.metric.id, w.metric] as const))).values()];
  const requests = chunk(metrics, Math.max(1, maxMetrics)).map((part) => ({
    metrics: part.map((m) => ({ id: m.id, version: m.version })), date, granularity, comparison: comparison ? 'previous_period' : 'none',
  }));
  const load = useLoad(`reporting-dashboard|${slug}|${JSON.stringify(requests)}`, async (signal): Promise<Outcome<ReportingQueryResult>> => {
    const outs = await Promise.all(requests.map((body) => client.query(slug, body, signal)));
    const failed = outs.find((o) => o.kind !== 'ok');
    if (failed) return failed as Outcome<never>;
    const ok = outs as Extract<Outcome<ReportingQueryResult>, { kind: 'ok' }>[];
    return { kind: 'ok', data: { ...ok[0]!.data, results: ok.flatMap((o) => o.data.results) } };
  });
  if (load.state.status === 'done' && load.state.outcome.kind !== 'ok') {
    return <Problem outcome={load.state.outcome} what="Charts" onRetry={load.reload} onSessionEnded={onSessionEnded} />;
  }
  const data = load.state.status === 'done' && load.state.outcome.kind === 'ok' ? load.state.outcome.data : null;
  const per = GRANULARITY_LABEL[granularity].toLowerCase();
  return (
    <div className="space-y-8" aria-live="polite">
      {sections.map((s) => (
        <section key={s.id} aria-label={`${s.title} charts`} className="space-y-3">
          <SectionHeader title={s.title} description={data ? `${rangeLabel(data.range.from, data.range.to, locale)}, ${per} by ${per}` : undefined} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {s.widgets.map(({ widget, metric }) => (
              <MetricChartWidget key={widget.id} widget={widget} metric={metric} result={data ? data.results.find((x) => x.metric.id === metric.id) ?? null : undefined}
                data={data} locale={locale} businessCurrency={businessCurrency} onExplore={() => onExplore(metric.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
