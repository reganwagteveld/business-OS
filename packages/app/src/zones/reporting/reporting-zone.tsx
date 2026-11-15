import type {
  ReportingDateConfig, ReportingGranularity, ReportingMetricDefinition, ReportingMetricResult, ReportingQueryResult, SavedView, SavedViewConfig, SavedViewListItem,
} from '@business-os/contracts';
import {
  Alert, AlertDescription, AlertTitle, Badge, BarChart, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, Field, Input,
  KpiCard, LineChart, SectionHeader, Select, Skeleton, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Textarea,
} from '@business-os/ui';
import { useMemo, useState, type ReactNode } from 'react';
import type { ReportingClient, ReportingDetails } from '../../api/reporting';
import type { BusinessContext, Outcome } from '../../api/tenancy';
import { ZonePage } from '../../shell/zone-page';
import { formatDate, formatWhen } from '../sales/format';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { bucketLabel, changeText, formatTick, formatValue, GRANULARITY_LABEL, PRESETS, rangeLabel, ZONE_LABEL } from './format';

type MetricResultOk = Extract<ReportingMetricResult, { status: 'ok' }>;

/** The headline figures, in this order, when the person may read their source. */
export const KPI_METRICS = ['finance.invoiced_amount', 'finance.payments_received', 'finance.receivables_outstanding', 'sales.won_value', 'customers.new_customers'] as const;

/** What the screen is showing: the parts of a saved view's configuration a person can change here. */
export interface ReportSettings {
  date: ReportingDateConfig;
  granularity: ReportingGranularity;
  comparison: boolean;
  zone: string;
  metricId: string;
  chart: 'line' | 'bar' | 'table';
  sort: SavedViewConfig['sort'];
}

const DEFAULTS: Omit<ReportSettings, 'metricId'> = {
  date: { kind: 'relative', preset: 'last_3_months' }, granularity: 'month', comparison: true, zone: 'all', chart: 'bar', sort: { by: 'bucket', direction: 'asc' },
};

export function settingsOf(view: SavedView): ReportSettings {
  const c = view.config;
  return {
    date: c.date, granularity: c.granularity, comparison: c.comparison === 'previous_period', zone: 'all', metricId: c.metrics[0]!.id,
    chart: c.visualization.chart, sort: c.sort,
  };
}

export function configOf(s: ReportSettings, metric: ReportingMetricDefinition): SavedViewConfig {
  return {
    metrics: [{ id: metric.id, version: metric.version }], date: s.date, granularity: metric.temporal === 'snapshot' ? 'none' : s.granularity, groupBy: null, filters: {},
    comparison: s.comparison && metric.temporal === 'period' ? 'previous_period' : 'none', sort: s.sort,
    visualization: { chart: s.chart, showComparison: s.comparison },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The Reporting Zone (R1): headline figures, one chart with its data table and records, a date range,
 * a Zone filter, and saved reports. Every figure comes from the API's registered metrics, which compute it
 * from the owning Zone's own records; this screen formats and never calculates. Mount with `key={slug}`:
 * switching business discards all state. Controls follow `membership.permissions` for presentation only;
 * the API checks reporting and source permissions on every request.
 */
export function ReportingZone({ client, context, userLabel, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: ReportingClient;
  context: BusinessContext; userLabel: string;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, locale, currency } = context.business;
  const perms = context.membership.permissions;
  const can = { save: perms.includes('reporting:save'), share: perms.includes('reporting:share'), manage: perms.includes('reporting:manage') };
  const catalog = useLoad(`reporting-catalog|${slug}`, (signal) => client.catalog(slug, signal));
  const views = useLoad(`reporting-views|${slug}`, (signal) => client.views(slug, signal));
  const [settings, setSettings] = useState<ReportSettings | null>(null);
  const [open, setOpen] = useState<SavedView | null>(null);
  const [dialog, setDialog] = useState<null | 'save' | 'edit' | 'delete'>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const frame = (children: ReactNode) => (
    <ZoneFrame zone="Reporting" business={name} user={userLabel} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>{children}</ZoneFrame>
  );

  if (catalog.state.status === 'loading') return frame(<ZonePage title="Reporting" state={{ kind: 'loading', label: 'Loading reports' }} />);
  if (catalog.state.outcome.kind !== 'ok') {
    return frame(
      <ZonePage title="Reporting">
        <Problem outcome={catalog.state.outcome} what="Reports" onRetry={catalog.reload} onSessionEnded={onSessionEnded} />
      </ZonePage>,
    );
  }
  const cat = catalog.state.outcome.data;
  const runnable = cat.metrics.filter((m) => m.availability === 'available' && m.accessible);
  if (runnable.length === 0) {
    return frame(
      <ZonePage title="Reporting" description="Trusted figures from the Zones you work in."
        state={{ kind: 'empty', title: 'No reports are available to you', description: 'Every report uses data from another Zone, such as Finance or Sales. Your role in this business does not include any of them. Ask an owner or admin if you need access.' }} />,
    );
  }
  const current: ReportSettings = settings ?? { ...DEFAULTS, metricId: runnable.find((m) => m.temporal === 'period')?.id ?? runnable[0]!.id };
  const update = (patch: Partial<ReportSettings>) => setSettings({ ...current, ...patch });
  const metric = runnable.find((m) => m.id === current.metricId) ?? cat.metrics.find((m) => m.id === current.metricId) ?? null;
  const zones = [...new Set(runnable.map((m) => m.zone))];
  const inZone = (m: ReportingMetricDefinition) => current.zone === 'all' || m.zone === current.zone;
  const savedConfig = open ? open.config : null;
  const dirty = Boolean(open && metric && !same(configOf(current, metric), savedConfig));
  const savedList = views.state.status === 'done' && views.state.outcome.kind === 'ok' ? views.state.outcome.data : [];

  const openView = async (id: string) => {
    if (!id) {
      setOpen(null);
      return;
    }
    const out = await client.view(slug, id);
    if (out.kind === 'ok') {
      setOpen(out.data);
      setSettings(settingsOf(out.data));
      setNotice(null);
    } else setNotice(out.kind === 'not_found' ? 'That report is no longer available to you.' : 'That report could not be opened. Try again.');
  };

  return frame(
    <ZonePage
      title={open ? open.title : 'Reporting'}
      eyebrow={open ? 'Saved report' : undefined}
      description={open?.description ?? 'Trusted figures from the Zones you work in. Each number is calculated by the Zone that owns the records.'}
      primaryActions={can.save && metric?.accessible ? (
        open?.isOwner
          ? <Button onClick={() => setDialog('save')} disabled={!dirty}>{dirty ? 'Save changes' : 'Saved'}</Button>
          : <Button onClick={() => setDialog('save')}>Save report</Button>
      ) : undefined}
      secondaryActions={
        <>
          {open?.isOwner ? <Button variant="outline" onClick={() => setDialog('edit')}>Rename or share</Button> : null}
          {open && (open.isOwner || (open.visibility === 'BUSINESS' && can.manage)) ? <Button variant="ghost" onClick={() => setDialog('delete')}>Delete</Button> : null}
          {open ? <Button variant="ghost" onClick={() => { setOpen(null); setSettings(null); }}>Close report</Button> : null}
        </>
      }
    >
      {notice ? <Alert tone="info"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      <Toolbar
        settings={current} update={update} zones={zones} metrics={runnable.filter(inZone)} saved={savedList} openId={open?.id ?? ''} onOpen={openView}
        today={cat.today} metric={metric}
      />
      {open?.visibility === 'BUSINESS' ? (
        <p className="text-xs text-muted-foreground">
          <Badge tone="info">Shared</Badge> Shared with everyone in {name} who can read its data. Each person sees only what their own role allows.
        </p>
      ) : null}
      <Kpis client={client} slug={slug} settings={current} catalog={cat.metrics} locale={locale} onSessionEnded={onSessionEnded} onPick={(id) => update({ metricId: id })} />
      {metric ? (
        <MetricSection key={metric.id} client={client} slug={slug} metric={metric} settings={current} locale={locale} timeZone={cat.timeZone}
          businessCurrency={currency} viewId={open && !dirty ? open.id : null} update={update} onSessionEnded={onSessionEnded} />
      ) : null}
      {dialog === 'save' && metric ? (
        <SaveDialog
          client={client} slug={slug} canShare={can.share} existing={open?.isOwner ? open : null} config={configOf(current, metric)} metricName={metric.name}
          onClose={() => setDialog(null)}
          onSaved={(view) => {
            setDialog(null);
            setOpen(view);
            setSettings(settingsOf(view));
            setNotice(`Saved “${view.title}”.`);
            views.reload();
          }}
        />
      ) : null}
      {dialog === 'edit' && open ? (
        <SaveDialog client={client} slug={slug} canShare={can.share} existing={open} config={null} metricName={metric?.name ?? ''} onClose={() => setDialog(null)}
          onSaved={(view) => {
            setDialog(null);
            setOpen(view);
            setNotice(`Saved “${view.title}”.`);
            views.reload();
          }} />
      ) : null}
      {dialog === 'delete' && open ? (
        <DeleteDialog client={client} slug={slug} view={open} onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            setOpen(null);
            setSettings(null);
            setNotice(`Deleted “${open.title}”. No business records were changed.`);
            views.reload();
          }} />
      ) : null}
    </ZonePage>,
  );
}

function Toolbar({ settings, update, zones, metrics, saved, openId, onOpen, today, metric }: {
  settings: ReportSettings; update: (p: Partial<ReportSettings>) => void; zones: string[]; metrics: ReportingMetricDefinition[]; saved: SavedViewListItem[];
  openId: string; onOpen: (id: string) => void; today: string; metric: ReportingMetricDefinition | null;
}) {
  const custom = settings.date.kind === 'fixed';
  const [from, setFrom] = useState(settings.date.kind === 'fixed' ? settings.date.from : today.slice(0, 8) + '01');
  const [to, setTo] = useState(settings.date.kind === 'fixed' ? settings.date.to : today);
  const applyCustom = (f: string, t: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t) && f <= t) update({ date: { kind: 'fixed', from: f, to: t } });
  };
  const snapshot = metric?.temporal === 'snapshot';
  return (
    <section aria-label="Report settings" className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Saved reports">
        {(c) => (
          <Select {...c} value={openId} onChange={(e) => onOpen(e.target.value)}>
            <option value="">{saved.length ? 'Choose a saved report' : 'No saved reports yet'}</option>
            {saved.map((v) => <option key={v.id} value={v.id}>{v.title}{v.visibility === 'BUSINESS' ? ' (shared)' : ''}{v.issues.length ? ' — needs attention' : ''}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Zone">
        {(c) => (
          <Select {...c} value={settings.zone} onChange={(e) => update({ zone: e.target.value })}>
            <option value="all">All Zones</option>
            {zones.map((z) => <option key={z} value={z}>{ZONE_LABEL[z] ?? z}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Date range">
        {(c) => (
          <Select {...c} value={custom ? 'custom' : settings.date.kind === 'relative' ? settings.date.preset : ''}
            onChange={(e) => update({ date: e.target.value === 'custom' ? { kind: 'fixed', from, to } : { kind: 'relative', preset: e.target.value as never } })}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="custom">Custom range</option>
          </Select>
        )}
      </Field>
      <Field label="Interval" hint={snapshot ? 'Not used: this figure is a current balance.' : undefined}>
        {(c) => (
          <Select {...c} value={settings.granularity} disabled={snapshot} onChange={(e) => update({ granularity: e.target.value as ReportingGranularity })}>
            {(['day', 'week', 'month', 'none'] as const).map((g) => <option key={g} value={g}>{GRANULARITY_LABEL[g]}</option>)}
          </Select>
        )}
      </Field>
      {custom ? (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          <Field label="From">{(c) => <Input {...c} type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); applyCustom(e.target.value, to); }} />}</Field>
          <Field label="To">{(c) => <Input {...c} type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); applyCustom(from, e.target.value); }} />}</Field>
        </div>
      ) : null}
      <Field label="Chart">
        {(c) => (
          <Select {...c} value={metrics.some((m) => m.id === settings.metricId) ? settings.metricId : ''} onChange={(e) => update({ metricId: e.target.value })}>
            {metrics.some((m) => m.id === settings.metricId) ? null : <option value="">Choose a figure</option>}
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Show as">
        {(c) => (
          <Select {...c} value={settings.chart} onChange={(e) => update({ chart: e.target.value as ReportSettings['chart'] })}>
            <option value="bar">Bar chart</option>
            <option value="line">Line chart</option>
            <option value="table">Table only</option>
          </Select>
        )}
      </Field>
      <label className="flex min-h-10 items-center gap-2 self-end text-sm">
        <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={settings.comparison} onChange={(e) => update({ comparison: e.target.checked })} />
        Compare with previous period
      </label>
    </section>
  );
}

/** One request for every headline figure the person may read, totals only, with the previous period. */
function Kpis({ client, slug, settings, catalog, locale, onSessionEnded, onPick }: {
  client: ReportingClient; slug: string; settings: ReportSettings; catalog: ReportingMetricDefinition[]; locale?: string; onSessionEnded: () => void;
  onPick: (id: string) => void;
}) {
  const defs = KPI_METRICS.map((id) => catalog.find((m) => m.id === id)).filter((m): m is ReportingMetricDefinition =>
    Boolean(m && m.accessible && m.availability === 'available' && (settings.zone === 'all' || m.zone === settings.zone)));
  const body = { metrics: defs.map((m) => ({ id: m.id, version: m.version })), date: settings.date, granularity: 'none', comparison: settings.comparison ? 'previous_period' : 'none' };
  const load = useLoad(`reporting-kpis|${slug}|${JSON.stringify(body)}`, (signal) =>
    defs.length ? client.query(slug, body, signal) : Promise.resolve({ kind: 'ok', data: null } as Outcome<ReportingQueryResult | null>));
  if (defs.length === 0) return null;
  if (load.state.status === 'done' && load.state.outcome.kind !== 'ok') {
    return <Problem outcome={load.state.outcome} what="Headline figures" onRetry={load.reload} onSessionEnded={onSessionEnded} />;
  }
  const data = load.state.status === 'done' && load.state.outcome.kind === 'ok' ? load.state.outcome.data : null;
  return (
    <section aria-label="Headline figures" aria-live="polite" className="space-y-3">
      <SectionHeader title="Headline figures" description={data ? rangeLabel(data.range.from, data.range.to, locale) : undefined} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {defs.map((m) => {
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
              note={r.temporal === 'snapshot' ? `As of ${formatDate(r.asOf, locale)}` : m.dateField}
              action={<Button size="sm" variant="ghost" onClick={() => onPick(m.id)} aria-label={`Show ${m.name} in the chart`}>Show in chart</Button>}
            />
          );
        })}
      </div>
    </section>
  );
}

function MetricSection({ client, slug, metric, settings, locale, timeZone, businessCurrency, viewId, update, onSessionEnded }: {
  client: ReportingClient; slug: string; metric: ReportingMetricDefinition; settings: ReportSettings; locale?: string; timeZone: string; businessCurrency: string;
  viewId: string | null; update: (p: Partial<ReportSettings>) => void; onSessionEnded: () => void;
}) {
  const config = configOf(settings, metric);
  // A saved report that is shown as saved runs through the saved-view endpoint, so the API validates the
  // stored configuration against the current registry and the viewer's own access every time it opens.
  const load = useLoad(`reporting-metric|${slug}|${viewId ?? ''}|${JSON.stringify(config)}`, async (signal): Promise<Outcome<ReportingQueryResult>> => {
    if (viewId) {
      const out = await client.runView(slug, viewId, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.result } : out;
    }
    return client.query(slug, { metrics: config.metrics, date: config.date, granularity: config.granularity, comparison: config.comparison }, signal);
  });
  const [currency, setCurrency] = useState<string | null>(null);

  let body: ReactNode;
  if (!metric.accessible) {
    body = <EmptyState title="You do not have access to this figure" description={`It uses ${ZONE_LABEL[metric.zone] ?? metric.zone} data, which your role does not include.`} />;
  } else if (load.state.status === 'loading') {
    body = <div role="status" aria-busy="true"><span className="sr-only">Loading {metric.name}</span><Skeleton className="h-64 w-full" /></div>;
  } else if (load.state.outcome.kind !== 'ok') {
    body = <Problem outcome={load.state.outcome} what={metric.name} onRetry={load.reload} onSessionEnded={onSessionEnded} />;
  } else {
    const data = load.state.outcome.data;
    const r = data.results[0];
    if (!r) body = null;
    else if (r.status !== 'ok') {
      body = (
        <Alert tone="warning">
          <AlertTitle>{r.name ?? 'This figure'} cannot be shown</AlertTitle>
          <AlertDescription>{r.message}</AlertDescription>
        </Alert>
      );
    } else {
      body = <ResultView result={r} data={data} settings={settings} locale={locale} currency={currency} setCurrency={setCurrency} businessCurrency={businessCurrency}
        onSort={(sort) => update({ sort })} />;
    }
  }
  return (
    <section aria-label={metric.name} className="space-y-4">
      <SectionHeader title={metric.name} description={metric.description} />
      <details className="rounded-lg border bg-card px-4 py-2 text-sm">
        <summary className="cursor-pointer py-1 font-medium">How this is calculated</summary>
        <dl className="mt-2 grid gap-2 pb-2 text-muted-foreground sm:grid-cols-[10rem_1fr]">
          <dt className="font-medium text-foreground">Calculation</dt><dd>{metric.semantics}</dd>
          <dt className="font-medium text-foreground">Date</dt><dd>{metric.dateField}. {metric.timeZone}: {timeZone}.</dd>
          <dt className="font-medium text-foreground">Included</dt><dd>{metric.statusTreatment}</dd>
          <dt className="font-medium text-foreground">Source</dt><dd>{ZONE_LABEL[metric.zone] ?? metric.zone} Zone (metric {metric.id}, version {metric.version})</dd>
        </dl>
      </details>
      <div aria-live="polite">{body}</div>
      {metric.accessible && metric.hasDetail ? <Records key={JSON.stringify(config.date)} client={client} slug={slug} metric={metric} date={config.date} locale={locale} timeZone={timeZone} onSessionEnded={onSessionEnded} /> : null}
    </section>
  );
}

function ResultView({ result: r, data, settings, locale, currency, setCurrency, businessCurrency, onSort }: {
  result: MetricResultOk; data: ReportingQueryResult; settings: ReportSettings; locale?: string; currency: string | null; setCurrency: (c: string) => void;
  businessCurrency: string; onSort: (sort: ReportSettings['sort']) => void;
}) {
  const currencies = [...new Set(r.series.map((s) => s.currencyCode).filter((c): c is string => c !== null))];
  const shownCurrency = r.valueType === 'money' ? (currency && currencies.includes(currency) ? currency : currencies.includes(businessCurrency) ? businessCurrency : currencies[0] ?? null) : null;
  const series = r.valueType === 'money' ? r.series.filter((s) => s.currencyCode === shownCurrency) : r.series;
  const fmt = (v: string | null, c: string | null = shownCurrency) => formatValue(v, r.valueType, c, locale);
  const notes = r.notes.filter((n) => !/never converted/.test(n) || currencies.length > 1);

  if (r.temporal === 'snapshot') {
    return (
      <div className="space-y-2">
        {r.series.length === 0 ? <EmptyState title="Nothing outstanding" description={`As of ${formatDate(r.asOf, locale)}.`} /> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {r.series.map((s) => <KpiCard key={s.key} label={`${r.name} (${s.currencyCode})`} values={[{ key: s.key, text: fmt(s.total, s.currencyCode) }]} note={`As of ${formatDate(r.asOf, locale)}`} />)}
          </div>
        )}
        {notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
      </div>
    );
  }
  if (series.length === 0) {
    return <EmptyState title={`No ${r.name.toLowerCase()} in this period`} description={rangeLabel(data.range.from, data.range.to, locale)} />;
  }
  const categories = r.buckets.map((b) => bucketLabel(b, r.granularity, locale));
  const showComparison = Boolean(data.comparisonRange) && series.length === 1;
  const chartSeries = series.slice(0, 5).flatMap((s, i) => [
    { key: s.key, label: r.valueType === 'money' ? `${s.label === s.currencyCode ? r.name : s.label} (${s.currencyCode})` : s.label, values: s.points.map((p) => p.value), color: ((i % 5) + 1) as 1 },
    ...(showComparison && s.comparisonPoints ? [{ key: `${s.key}-prev`, label: `Previous period (${rangeLabel(data.comparisonRange!.from, data.comparisonRange!.to, locale)})`, values: s.comparisonPoints.map((p) => p.value), variant: 'comparison' as const }] : []),
  ]);
  const summary = `${r.name}${shownCurrency ? ` in ${shownCurrency}` : ''}, ${GRANULARITY_LABEL[r.granularity].toLowerCase()} by ${GRANULARITY_LABEL[r.granularity].toLowerCase()}, ${rangeLabel(data.range.from, data.range.to, locale)}`;
  const chartProps = { title: `${r.name}${shownCurrency ? ` (${shownCurrency})` : ''}`, summary, categories, series: chartSeries, formatValue: (v: string) => fmt(v), formatTick: (n: number) => formatTick(n, r.valueType, shownCurrency, locale) };
  const one = series[0]!;
  // `previous` is undefined where the previous period has no matching bucket (it can be shorter).
  const rows = r.buckets.map((b, i) => ({ bucket: b, label: categories[i]!, value: one.points[i]?.value ?? null, previous: one.comparisonPoints?.[i] }));
  const sorted = [...rows].sort((a, b) => {
    const d = settings.sort.by === 'bucket' ? a.bucket.localeCompare(b.bucket) : Number(a.value ?? 0) - Number(b.value ?? 0);
    return settings.sort.direction === 'asc' ? d : -d;
  });
  const toggle = (by: 'bucket' | 'value') => onSort({ by, direction: settings.sort.by === by && settings.sort.direction === 'asc' ? 'desc' : 'asc' });
  const arrow = (by: 'bucket' | 'value') => (settings.sort.by === by ? (settings.sort.direction === 'asc' ? ' ↑' : ' ↓') : '');
  const ariaSort = (by: 'bucket' | 'value') => (settings.sort.by === by ? (settings.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  const change = changeText(one.changePercent);

  return (
    <div className="space-y-4">
      {currencies.length > 1 ? (
        <div role="group" aria-label="Currency" className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Currency:</span>
          {currencies.map((c) => <Button key={c} size="sm" variant={c === shownCurrency ? 'secondary' : 'ghost'} aria-pressed={c === shownCurrency} onClick={() => setCurrency(c)}>{c}</Button>)}
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{fmt(one.total, one.currencyCode)}</p>
        {series.length === 1 && data.comparisonRange ? <p className="text-sm text-muted-foreground">Previous period {fmt(one.comparisonTotal, one.currencyCode)}{change ? ` · ${change.text}` : ''}</p> : null}
      </div>
      {settings.chart === 'line' ? <LineChart {...chartProps} /> : settings.chart === 'bar' ? <BarChart {...chartProps} /> : null}
      {notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
      {r.hiddenSeries > 0 ? <p className="text-xs text-muted-foreground">{r.hiddenSeries} smaller groups are not shown.</p> : null}
      <Table>
        <TableCaption>{r.name}{shownCurrency ? ` in ${shownCurrency}` : ''} by period. {series.length > 1 ? `Showing ${one.label}.` : ''}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead aria-sort={ariaSort('bucket')}><button type="button" className="uppercase" onClick={() => toggle('bucket')}>Period{arrow('bucket')}</button></TableHead>
            <TableHead aria-sort={ariaSort('value')} className="text-right"><button type="button" className="uppercase" onClick={() => toggle('value')}>{r.valueType === 'money' ? `Amount (${shownCurrency})` : 'Count'}{arrow('value')}</button></TableHead>
            {data.comparisonRange ? <TableHead className="text-right">Previous period</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <TableRow key={row.bucket}>
              <TableCell>{row.label}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(row.value, one.currencyCode)}</TableCell>
              {data.comparisonRange ? <TableCell className="text-right tabular-nums text-muted-foreground">{row.previous ? fmt(row.previous.value, one.currencyCode) : '—'}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The records behind the figure, newest first, page by page (the API's stable order). */
function Records({ client, slug, metric, date, locale, timeZone, onSessionEnded }: {
  client: ReportingClient; slug: string; metric: ReportingMetricDefinition; date: ReportingDateConfig; locale?: string; timeZone: string; onSessionEnded: () => void;
}) {
  const [pages, setPages] = useState<ReportingDetails[]>([]);
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const firstPage = useLoad(`reporting-details|${slug}|${metric.id}|${JSON.stringify(date)}`, (signal) => client.details(slug, { metric: { id: metric.id, version: metric.version }, date, limit: 25 }, signal));
  const all = useMemo(() => (firstPage.state.status === 'done' && firstPage.state.outcome.kind === 'ok' ? [firstPage.state.outcome.data, ...pages] : []), [firstPage.state, pages]);
  if (firstPage.state.status === 'loading') return <div role="status" aria-busy="true"><span className="sr-only">Loading records</span><Skeleton className="h-32 w-full" /></div>;
  if (firstPage.state.outcome.kind !== 'ok') return <Problem outcome={firstPage.state.outcome} what="Records" onRetry={firstPage.reload} onSessionEnded={onSessionEnded} />;
  const columns = all[0]!.columns;
  const rows = all.flatMap((p) => p.rows);
  const next = all[all.length - 1]!.nextCursor;
  const cell = (type: string, value: string | null, currencyCode: string | null) => {
    if (value === null) return '—';
    if (type === 'money') return currencyCode ? formatValue(value, 'money', currencyCode, locale) : value;
    if (type === 'date') return formatDate(value, locale);
    if (type === 'datetime') return formatWhen(value, timeZone, locale);
    if (type === 'status') return value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');
    return value;
  };
  const loadMore = async () => {
    if (!next) return;
    setMore({ busy: true, error: null });
    const out = await client.details(slug, { metric: { id: metric.id, version: metric.version }, date, limit: 25, cursor: next });
    if (out.kind === 'ok') {
      setPages((p) => [...p, out.data]);
      setMore({ busy: false, error: null });
    } else setMore({ busy: false, error: 'More records could not be loaded. Try again.' });
  };
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold">Records</h3>
      {rows.length === 0 ? <EmptyState title="No records in this period" /> : (
        <Table>
          <TableCaption>{rows.length} record{rows.length === 1 ? '' : 's'} behind {metric.name.toLowerCase()}, {rangeLabel(all[0]!.range.from, all[0]!.range.to, locale)}, newest first.</TableCaption>
          <TableHeader>
            <TableRow>{columns.map((c) => <TableHead key={c.key} className={c.type === 'money' ? 'text-right' : undefined}>{c.label}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {columns.map((c) => <TableCell key={c.key} className={c.type === 'money' ? 'text-right tabular-nums' : undefined}>{cell(c.type, row.cells[c.key] ?? null, row.currencyCode)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {more.error ? <p role="alert" className="text-sm text-destructive">{more.error}</p> : null}
      {next ? <Button variant="outline" size="sm" loading={more.busy} onClick={() => void loadMore()}>Show more records</Button> : null}
    </div>
  );
}

function SaveDialog({ client, slug, canShare, existing, config, metricName, onClose, onSaved }: {
  client: ReportingClient; slug: string; canShare: boolean; existing: SavedView | null; config: SavedViewConfig | null; metricName: string;
  onClose: () => void; onSaved: (view: SavedView) => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? metricName);
  const [description, setDescription] = useState(existing?.description ?? '');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'BUSINESS'>(existing?.visibility ?? 'PRIVATE');
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const submit = async () => {
    if (!title.trim()) {
      setState({ busy: false, error: 'A title is required.' });
      return;
    }
    setState({ busy: true, error: null });
    const out = existing
      ? await client.updateView(slug, existing.id, { version: existing.version, title, description, visibility, ...(config ? { config } : {}) })
      : await client.createView(slug, { title, description, visibility, config });
    if (out.kind === 'ok') return onSaved(out.data);
    setState({
      busy: false,
      error: out.kind === 'conflict' && out.code === 'stale' ? 'This report was changed somewhere else. Close it and open it again.'
        : out.kind === 'forbidden' ? 'Your role does not allow saving this report that way.'
        : out.kind === 'invalid_input' ? out.message
        : 'The report could not be saved. Try again.',
    });
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">{existing ? (config ? 'Save changes' : 'Rename or share') : 'Save report'}</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          Saves the settings, not the figures: the report recalculates from current records each time it is opened.
        </DialogDescription>
        <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Title">{(c) => <Input {...c} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
          <Field label="Description" hint="Optional">{(c) => <Textarea {...c} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Field label="Who can see it" hint={visibility === 'BUSINESS' ? 'People who open it see only the data their own role allows.' : 'Only you.'}>
            {(c) => (
              <Select {...c} value={visibility} onChange={(e) => setVisibility(e.target.value as 'PRIVATE' | 'BUSINESS')} disabled={!canShare && visibility === 'PRIVATE'}>
                <option value="PRIVATE">Only me</option>
                {canShare || visibility === 'BUSINESS' ? <option value="BUSINESS">Everyone in this business</option> : null}
              </Select>
            )}
          </Field>
          {state.error ? <p role="alert" className="text-sm font-medium text-destructive">{state.error}</p> : null}
          <DialogFooter className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={state.busy}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ client, slug, view, onClose, onDeleted }: { client: ReportingClient; slug: string; view: SavedView; onClose: () => void; onDeleted: () => void }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const remove = async () => {
    setState({ busy: true, error: null });
    const out = await client.deleteView(slug, view.id);
    if (out.kind === 'ok') return onDeleted();
    setState({ busy: false, error: out.kind === 'forbidden' ? 'Your role does not allow deleting this report.' : 'The report could not be deleted. Try again.' });
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">Delete “{view.title}”?</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          This removes the saved settings{view.visibility === 'BUSINESS' ? ' for everyone it is shared with' : ''}. No business records are changed.
        </DialogDescription>
        {state.error ? <p role="alert" className="mt-3 text-sm font-medium text-destructive">{state.error}</p> : null}
        <DialogFooter className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" loading={state.busy} onClick={() => void remove()}>Delete report</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
