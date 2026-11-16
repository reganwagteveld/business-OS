import type { ReportingDateConfig, ReportingMetricDefinition, ReportingQueryResult } from '@business-os/contracts';
import { Button, Field, Input, KpiCard, SectionHeader, Select } from '@business-os/ui';
import { useState } from 'react';
import type { ReportingClient } from '../../api/reporting';
import type { Outcome } from '../../api/tenancy';
import { formatDate } from '../sales/format';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { changeText, customRangeProblem, formatValue, PRESETS, rangeLabel } from './format';

/** Only metrics the API says this person may run (`accessible`) and that exist (`available`). Nothing else is ever requested. */
export const runnableMetrics = (catalog: readonly ReportingMetricDefinition[]) => catalog.filter((m) => m.availability === 'available' && m.accessible);

/** Picks registered, runnable metrics in the given order; unknown or inaccessible ids are dropped. */
export function pick(catalog: readonly ReportingMetricDefinition[], ids: readonly string[]): ReportingMetricDefinition[] {
  const runnable = runnableMetrics(catalog);
  return ids.map((id) => runnable.find((m) => m.id === id)).filter((m): m is ReportingMetricDefinition => Boolean(m));
}

/**
 * Date range: the API's presets (resolved on the server against today in the business's time zone) or a
 * custom inclusive range. A custom range is only applied once it is valid; until then the reason is shown
 * next to the dates and the last valid range stays in use.
 */
export function DateRangeControl({ date, onChange, today, maxRangeDays, idPrefix = 'reporting' }: {
  date: ReportingDateConfig; onChange: (date: ReportingDateConfig) => void; today: string; maxRangeDays: number; idPrefix?: string;
}) {
  const custom = date.kind === 'fixed';
  const [from, setFrom] = useState(date.kind === 'fixed' ? date.from : today.slice(0, 8) + '01');
  const [to, setTo] = useState(date.kind === 'fixed' ? date.to : today);
  const problem = custom ? customRangeProblem(from, to, maxRangeDays) : null;
  const apply = (f: string, t: string) => {
    if (!customRangeProblem(f, t, maxRangeDays)) onChange({ kind: 'fixed', from: f, to: t });
  };
  return (
    <>
      <Field label="Date range">
        {(c) => (
          <Select {...c} value={custom ? 'custom' : date.kind === 'relative' ? date.preset : ''}
            onChange={(e) => {
              if (e.target.value !== 'custom') return onChange({ kind: 'relative', preset: e.target.value as never });
              // Start from the dates last entered when they are valid, otherwise from this month so far.
              if (!customRangeProblem(from, to, maxRangeDays)) return onChange({ kind: 'fixed', from, to });
              const start = today.slice(0, 8) + '01';
              setFrom(start);
              setTo(today);
              onChange({ kind: 'fixed', from: start, to: today });
            }}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="custom">Custom range</option>
          </Select>
        )}
      </Field>
      {custom ? (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2" id={`${idPrefix}-custom-range`}>
          <Field label="From" error={problem ?? undefined}>
            {(c) => <Input {...c} type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); apply(e.target.value, to); }} />}
          </Field>
          <Field label="To">
            {(c) => <Input {...c} type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); apply(from, e.target.value); }} />}
          </Field>
        </div>
      ) : null}
    </>
  );
}

/**
 * One request for every headline figure the person may read: totals only, with the previous period when
 * asked. Money is one line per currency (never added across currencies). Snapshot figures say they are
 * current balances and ignore the range.
 */
export function Kpis({ client, slug, date, comparison, metrics, locale, onSessionEnded, onPick, pickLabel = 'Show in chart', title = 'Headline figures', columns = 'xl:grid-cols-5' }: {
  client: ReportingClient; slug: string; date: ReportingDateConfig; comparison: boolean; metrics: ReportingMetricDefinition[]; locale?: string;
  onSessionEnded: () => void; onPick?: (id: string) => void; pickLabel?: string; title?: string; columns?: string;
}) {
  const body = { metrics: metrics.map((m) => ({ id: m.id, version: m.version })), date, granularity: 'none', comparison: comparison ? 'previous_period' : 'none' };
  const load = useLoad(`reporting-kpis|${slug}|${JSON.stringify(body)}`, (signal) =>
    metrics.length ? client.query(slug, body, signal) : Promise.resolve({ kind: 'ok', data: null } as Outcome<ReportingQueryResult | null>));
  if (metrics.length === 0) return null;
  if (load.state.status === 'done' && load.state.outcome.kind !== 'ok') {
    return <Problem outcome={load.state.outcome} what={title} onRetry={load.reload} onSessionEnded={onSessionEnded} />;
  }
  const data = load.state.status === 'done' && load.state.outcome.kind === 'ok' ? load.state.outcome.data : null;
  return (
    <section aria-label={title} aria-live="polite" className="space-y-3">
      <SectionHeader title={title} description={data ? rangeLabel(data.range.from, data.range.to, locale) : undefined} />
      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${columns}`}>
        {metrics.map((m) => {
          const r = data?.results.find((x) => x.metric.id === m.id);
          if (!data || !r) return <KpiCard key={m.id} label={m.name} state="loading" />;
          if (r.status !== 'ok') return <KpiCard key={m.id} label={m.name} state="unavailable" unavailableText={r.message} />;
          const single = r.series.length === 1 ? r.series[0]! : null;
          const change = single ? changeText(single.changePercent) : null;
          return (
            <KpiCard key={m.id} label={m.name}
              values={r.series.map((s) => {
                const text = formatValue(s.total, r.valueType, s.currencyCode, locale);
                // Name the currency once: only when the locale's format does not already show its code.
                return { key: s.key, text, caption: r.valueType === 'money' && s.currencyCode && !text.includes(s.currencyCode) ? s.currencyCode : undefined };
              })}
              change={change?.text} trend={change?.trend}
              note={r.temporal === 'snapshot' ? `Current balance as of ${formatDate(r.asOf, locale)}. Not affected by the date range.` : m.dateField}
              action={onPick ? <Button size="sm" variant="ghost" onClick={() => onPick(m.id)} aria-label={`${pickLabel}: ${m.name}`}>{pickLabel}</Button> : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}
