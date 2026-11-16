import type { ReportingMetricDefinition, ReportingMetricResult, ReportingQueryResult } from '@business-os/contracts';
import { Alert, AlertDescription, AlertTitle, BarChart, Button, Card, EmptyState, LineChart, Skeleton } from '@business-os/ui';
import { useState } from 'react';
import { bucketLabel, changeText, formatTick, formatValue, GRANULARITY_LABEL, rangeLabel } from './format';

type MetricResultOk = Extract<ReportingMetricResult, { status: 'ok' }>;

/**
 * Dashboard building blocks (R2). A dashboard is DATA: a list of KPI metric ids and sections of widgets, each
 * naming a registered metric by id. R2 ships one fixed layout (`DEFAULT_DASHBOARD` in dashboard.tsx); a later
 * phase can store layouts per person or business and render them with the same components, without changing
 * how figures are fetched or permission-checked. A widget never computes a figure: it formats one metric
 * result the API returned.
 */
export interface MetricChartWidgetDef {
  /** Stable within its layout. */
  id: string;
  kind: 'metric-chart';
  /** A registered metric id (R1 registry). Widgets for metrics the person cannot read are left out, not shown disabled. */
  metricId: string;
  chart: 'bar' | 'line';
}
export type DashboardWidgetDef = MetricChartWidgetDef;

export interface DashboardSectionDef {
  id: string;
  /** Heading; usually the Zone that owns the records. */
  title: string;
  widgets: readonly DashboardWidgetDef[];
}

export interface DashboardLayout {
  /** Format version of this description, so stored layouts can be migrated later. */
  layoutVersion: 1;
  kpis: readonly string[];
  sections: readonly DashboardSectionDef[];
}

/** One metric as a chart card. `result` undefined = loading; null = the API returned nothing for it. */
export function MetricChartWidget({ widget, metric, result, data, locale, businessCurrency, onExplore }: {
  widget: MetricChartWidgetDef; metric: ReportingMetricDefinition; result: ReportingMetricResult | null | undefined; data: ReportingQueryResult | null; locale?: string; businessCurrency: string;
  onExplore: () => void;
}) {
  const [currency, setCurrency] = useState<string | null>(null);
  const titleId = `panel-${metric.id.replace('.', '-')}`;
  let body;
  if (result === undefined || !data) {
    body = <div role="status" aria-busy="true"><span className="sr-only">Loading {metric.name}</span><Skeleton className="h-48 w-full" /></div>;
  } else if (result === null || result.status !== 'ok') {
    body = (
      <Alert tone="warning">
        <AlertTitle>{metric.name} cannot be shown</AlertTitle>
        <AlertDescription>{result?.message ?? 'The figure did not come back. Try again.'}</AlertDescription>
      </Alert>
    );
  } else {
    body = <PanelBody chart={widget.chart} result={result} data={data} locale={locale} currency={currency} setCurrency={setCurrency} businessCurrency={businessCurrency} />;
  }
  return (
    <Card aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="text-base font-semibold">{metric.name}</h3>
          <p className="text-xs text-muted-foreground">{metric.dateField}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onExplore} aria-label={`Explore ${metric.name}`}>Explore</Button>
      </div>
      {body}
    </Card>
  );
}

function PanelBody({ chart: kind, result: r, data, locale, currency, setCurrency, businessCurrency }: {
  chart: 'bar' | 'line'; result: MetricResultOk; data: ReportingQueryResult; locale?: string; currency: string | null; setCurrency: (c: string) => void; businessCurrency: string;
}) {
  const currencies = [...new Set(r.series.map((s) => s.currencyCode).filter((c): c is string => c !== null))];
  const shown = r.valueType === 'money' ? (currency && currencies.includes(currency) ? currency : currencies.includes(businessCurrency) ? businessCurrency : currencies[0] ?? null) : null;
  const series = r.valueType === 'money' ? r.series.filter((s) => s.currencyCode === shown) : r.series;
  if (series.length === 0) return <EmptyState title={`No ${r.name.toLowerCase()} in this period`} description={rangeLabel(data.range.from, data.range.to, locale)} />;
  const fmt = (v: string | null) => formatValue(v, r.valueType, shown, locale);
  const one = series[0]!;
  const change = data.comparisonRange ? changeText(one.changePercent) : null;
  const categories = r.buckets.map((b) => bucketLabel(b, r.granularity, locale));
  const withComparison = Boolean(data.comparisonRange && one.comparisonPoints);
  const chart = {
    title: `${r.name}${shown ? ` (${shown})` : ''}`,
    summary: `${r.name}${shown ? ` in ${shown}` : ''}, ${GRANULARITY_LABEL[r.granularity].toLowerCase()} by ${GRANULARITY_LABEL[r.granularity].toLowerCase()}, ${rangeLabel(data.range.from, data.range.to, locale)}`,
    categories,
    series: [
      { key: one.key, label: shown ? `${r.name} (${shown})` : r.name, values: one.points.map((p) => p.value), color: 1 as const },
      ...(withComparison ? [{ key: `${one.key}-prev`, label: `Previous period (${rangeLabel(data.comparisonRange!.from, data.comparisonRange!.to, locale)})`, values: one.comparisonPoints!.map((p) => p.value), variant: 'comparison' as const }] : []),
    ],
    formatValue: (v: string) => fmt(v),
    formatTick: (n: number) => formatTick(n, r.valueType, shown, locale),
    height: 180,
  };
  return (
    <div className="space-y-3">
      {currencies.length > 1 ? (
        <div role="group" aria-label={`${r.name} currency`} className="flex flex-wrap items-center gap-1">
          {currencies.map((c) => <Button key={c} size="sm" variant={c === shown ? 'secondary' : 'ghost'} aria-pressed={c === shown} onClick={() => setCurrency(c)}>{c}</Button>)}
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{fmt(one.total)}</p>
        {change ? <p className="text-xs text-muted-foreground">{change.text}</p> : null}
      </div>
      {r.temporal === 'period' ? (kind === 'bar' ? <BarChart {...chart} /> : <LineChart {...chart} />) : null}
      {currencies.length > 1 ? <p className="text-xs text-muted-foreground">Also in {currencies.filter((c) => c !== shown).join(', ')}. Each currency is shown separately.</p> : null}
    </div>
  );
}
