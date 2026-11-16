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
import { Dashboard, DASHBOARD_DEFAULTS, type DashboardSettings, type DrillDown } from './dashboard';
import { bucketLabel, bucketRange, changeText, formatTick, formatValue, GRANULARITY_LABEL, rangeLabel, ZONE_LABEL } from './format';
import { ownership, savedActions, SavedReports } from './saved-list';
import { DateRangeControl, Kpis, pick, runnableMetrics } from './shared';

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

export type ReportingSection = 'dashboard' | 'explore' | 'saved';
const SECTIONS: readonly ReportingSection[] = ['dashboard', 'explore', 'saved'];
export const asSection = (s: string | undefined): ReportingSection => (SECTIONS.includes(s as ReportingSection) ? (s as ReportingSection) : 'dashboard');

/**
 * The Reporting Zone. R1 built the trusted metrics, saved views and the report screen (now "Explore");
 * R2 adds the Dashboard homepage and the Saved reports list. Every figure comes from the API's registered
 * metrics, which compute it from the owning Zone's own records; this screen formats and never calculates.
 * Mount with `key={slug}`: switching business discards all state. Controls follow `membership.permissions`
 * for presentation only; the API checks reporting and source permissions on every request.
 *
 * `section` comes from the shell's secondary navigation; without `onSection` (rendered on its own) the Zone
 * keeps the section itself. Settings for each section live here, so moving between tabs keeps them.
 */
export function ReportingZone({ client, context, userLabel, section, onSection, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: ReportingClient;
  context: BusinessContext; userLabel: string;
  section?: string; onSection?: (section: ReportingSection) => void;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, locale, currency } = context.business;
  const perms = context.membership.permissions;
  const can = { save: perms.includes('reporting:save'), share: perms.includes('reporting:share'), manage: perms.includes('reporting:manage') };
  const catalog = useLoad(`reporting-catalog|${slug}`, (signal) => client.catalog(slug, signal));
  const views = useLoad(`reporting-views|${slug}`, (signal) => client.views(slug, signal));
  const [localSection, setLocalSection] = useState<ReportingSection>(asSection(section));
  const active = onSection ? asSection(section) : localSection;
  const go = (next: ReportingSection) => (onSection ? onSection(next) : setLocalSection(next));
  const [dashboard, setDashboard] = useState<DashboardSettings>(DASHBOARD_DEFAULTS);
  const [settings, setSettings] = useState<ReportSettings | null>(null);
  // Bumped whenever Explore's settings are replaced from outside (a drill-down or an opened report), so its
  // controls start again from the new values.
  const [generation, setGeneration] = useState(0);
  const [open, setOpen] = useState<SavedView | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'save' | 'edit' | 'delete'; view?: SavedView }>(null);
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
  const runnable = runnableMetrics(cat.metrics);
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

  const replaceExplore = (next: ReportSettings | null, view: SavedView | null) => {
    setOpen(view);
    setSettings(next);
    setGeneration((g) => g + 1);
  };
  const openView = async (id: string) => {
    if (!id) {
      setOpen(null);
      return;
    }
    const out = await client.view(slug, id);
    if (out.kind === 'ok') {
      replaceExplore(settingsOf(out.data), out.data);
      setNotice(null);
      go('explore');
    } else setNotice(out.kind === 'not_found' ? 'That report is no longer available to you.' : 'That report could not be opened. Try again.');
  };
  // Dashboard → Explore keeps the metric, the dates, the comparison and the interval the dashboard used.
  const drill = (d: DrillDown) => {
    replaceExplore({ ...DEFAULTS, metricId: d.metricId, date: d.date, comparison: d.comparison, granularity: d.granularity }, null);
    setNotice(null);
    go('explore');
  };
  const dialogs = (
    <>
      {dialog?.kind === 'save' && metric ? (
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
      {dialog?.kind === 'edit' && dialog.view ? (
        <SaveDialog client={client} slug={slug} canShare={can.share} existing={dialog.view} config={null} metricName="" onClose={() => setDialog(null)}
          onSaved={(view) => {
            setDialog(null);
            if (open?.id === view.id) setOpen(view);
            setNotice(`Saved “${view.title}”.`);
            views.reload();
          }} />
      ) : null}
      {dialog?.kind === 'delete' && dialog.view ? (
        <DeleteDialog client={client} slug={slug} view={dialog.view} onClose={() => setDialog(null)}
          onDeleted={() => {
            const gone = dialog.view!;
            setDialog(null);
            if (open?.id === gone.id) replaceExplore(null, null);
            setNotice(`Deleted “${gone.title}”. No business records were changed.`);
            views.reload();
          }} />
      ) : null}
    </>
  );
  const noticeBar = notice ? <Alert tone="info"><AlertDescription>{notice}</AlertDescription></Alert> : null;

  if (active === 'dashboard') {
    return frame(
      <ZonePage title="Reporting" description="Trusted figures from the Zones you work in. Each number is calculated by the Zone that owns the records."
        primaryActions={<Button onClick={() => go('explore')}>Explore figures</Button>}
        secondaryActions={<Button variant="outline" onClick={() => go('saved')}>Saved reports</Button>}>
        {noticeBar}
        <Dashboard client={client} slug={slug} catalog={cat} settings={dashboard} onSettings={setDashboard} locale={locale} businessCurrency={currency}
          onExplore={drill} onSessionEnded={onSessionEnded} />
      </ZonePage>,
    );
  }

  if (active === 'saved') {
    return frame(
      <ZonePage title="Saved reports" eyebrow="Reporting"
        description="Saved reports keep their settings, not their figures: each one recalculates from current records, with the access of whoever opens it."
        primaryActions={can.save ? <Button onClick={() => { replaceExplore(null, null); go('explore'); }}>New report</Button> : undefined}>
        {noticeBar}
        <SavedReports state={views.state} reload={views.reload} catalog={cat.metrics} can={can} timeZone={cat.timeZone} locale={locale} client={client} slug={slug}
          onOpen={(id) => void openView(id)} onNew={can.save ? () => { replaceExplore(null, null); go('explore'); } : undefined}
          onRename={(view) => setDialog({ kind: 'edit', view })} onDelete={(view) => setDialog({ kind: 'delete', view })} onSessionEnded={onSessionEnded} />
        {dialogs}
      </ZonePage>,
    );
  }

  const actions = open ? savedActions(open, can) : null;
  return frame(
    <ZonePage
      title={open ? open.title : 'Explore'}
      eyebrow={open ? 'Saved report' : 'Reporting'}
      description={open?.description ?? 'One figure at a time, with its periods and the records behind it.'}
      primaryActions={can.save && metric?.accessible ? (
        open?.isOwner
          ? <Button onClick={() => setDialog({ kind: 'save' })} disabled={!dirty}>{dirty ? 'Save changes' : 'Saved'}</Button>
          : <Button onClick={() => setDialog({ kind: 'save' })}>Save report</Button>
      ) : undefined}
      secondaryActions={
        <>
          {open && actions?.rename ? <Button variant="outline" onClick={() => setDialog({ kind: 'edit', view: open })}>{can.share ? 'Rename or share' : 'Rename'}</Button> : null}
          {open && actions?.delete ? <Button variant="ghost" onClick={() => setDialog({ kind: 'delete', view: open })}>Delete</Button> : null}
          {open ? <Button variant="ghost" onClick={() => replaceExplore(null, null)}>Close report</Button> : null}
        </>
      }
    >
      {noticeBar}
      {views.state.status === 'done' && views.state.outcome.kind !== 'ok' && views.state.outcome.kind !== 'unauthenticated' ? (
        <Alert tone="warning" className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <AlertTitle>Saved reports could not all be listed</AlertTitle>
            <AlertDescription>{views.state.outcome.kind === 'incomplete' ? views.state.outcome.message : 'The list of saved reports did not load. Figures below are not affected.'}</AlertDescription>
          </div>
          <Button variant="outline" size="sm" onClick={views.reload}>Try again</Button>
        </Alert>
      ) : null}
      <Toolbar key={generation}
        settings={current} update={update} zones={zones} metrics={runnable.filter(inZone)} saved={savedList} openId={open?.id ?? ''} onOpen={(id) => void openView(id)}
        today={cat.today} maxRangeDays={cat.limits.maxRangeDays} metric={metric}
      />
      {open ? (
        <p className="text-xs text-muted-foreground">
          <Badge tone={ownership(open).tone}>{ownership(open).label}</Badge> {open.visibility === 'BUSINESS' ? `Shared with everyone in ${name} who can read its data. Each person sees only what their own role allows.` : ownership(open).help}
        </p>
      ) : null}
      <Kpis client={client} slug={slug} date={current.date} comparison={current.comparison} metrics={pick(cat.metrics, KPI_METRICS).filter(inZone)} locale={locale}
        onSessionEnded={onSessionEnded} onPick={(id) => update({ metricId: id })} />
      {metric ? (
        <MetricSection key={metric.id} client={client} slug={slug} metric={metric} settings={current} locale={locale} timeZone={cat.timeZone}
          businessCurrency={currency} viewId={open && !dirty ? open.id : null} update={update} onSessionEnded={onSessionEnded} />
      ) : null}
      {dialogs}
    </ZonePage>,
  );
}

function Toolbar({ settings, update, zones, metrics, saved, openId, onOpen, today, maxRangeDays, metric }: {
  settings: ReportSettings; update: (p: Partial<ReportSettings>) => void; zones: string[]; metrics: ReportingMetricDefinition[]; saved: SavedViewListItem[];
  openId: string; onOpen: (id: string) => void; today: string; maxRangeDays: number; metric: ReportingMetricDefinition | null;
}) {
  const snapshot = metric?.temporal === 'snapshot';
  return (
    <section aria-label="Report settings" className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Saved reports">
        {(c) => (
          <Select {...c} value={openId} onChange={(e) => onOpen(e.target.value)}>
            <option value="">{saved.length ? 'Choose a saved report' : 'No saved reports yet'}</option>
            {saved.map((v) => <option key={v.id} value={v.id}>{v.title} ({ownership(v).label.toLowerCase()}){v.issues.length ? ' — needs attention' : ''}</option>)}
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
      <DateRangeControl date={settings.date} onChange={(date) => update({ date })} today={today} maxRangeDays={maxRangeDays} />
      <Field label="Interval" hint={snapshot ? 'Not used: this figure is a current balance.' : undefined}>
        {(c) => (
          <Select {...c} value={settings.granularity} disabled={snapshot} onChange={(e) => update({ granularity: e.target.value as ReportingGranularity })}>
            {(['day', 'week', 'month', 'none'] as const).map((g) => <option key={g} value={g}>{GRANULARITY_LABEL[g]}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Chart" hint="A saved report keeps this one figure; the headline figures are always shown.">
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
      <div className="self-end">
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={settings.comparison} aria-describedby="reporting-compare-hint"
            onChange={(e) => update({ comparison: e.target.checked })} />
          Compare with previous period
        </label>
        <p id="reporting-compare-hint" className="text-xs text-muted-foreground">The same number of days immediately before.</p>
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
  // A period picked in the table narrows the records to that period; it belongs to this exact configuration.
  const configKey = JSON.stringify(config);
  const [picked, setPicked] = useState<{ key: string; label: string; from: string; to: string } | null>(null);
  const period = picked?.key === configKey ? picked : null;

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
        onSort={(sort) => update({ sort })} canDrill={metric.hasDetail} picked={period?.from ?? null}
        onPeriod={(label, range) => setPicked({ key: configKey, label, ...range })} />;
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
      {metric.accessible && metric.hasDetail ? (
        <Records key={JSON.stringify([config.date, period])} client={client} slug={slug} metric={metric}
          date={period ? { kind: 'fixed', from: period.from, to: period.to } : config.date} filters={config.filters}
          period={period?.label ?? null} onAllPeriods={() => setPicked(null)} locale={locale} timeZone={timeZone} onSessionEnded={onSessionEnded} />
      ) : null}
    </section>
  );
}

function ResultView({ result: r, data, settings, locale, currency, setCurrency, businessCurrency, onSort, canDrill, picked, onPeriod }: {
  result: MetricResultOk; data: ReportingQueryResult; settings: ReportSettings; locale?: string; currency: string | null; setCurrency: (c: string) => void;
  businessCurrency: string; onSort: (sort: ReportSettings['sort']) => void;
  /** Whether the metric has records behind it; each period row then offers them. */
  canDrill: boolean; picked: string | null; onPeriod: (label: string, range: { from: string; to: string }) => void;
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
            {r.series.map((s) => <KpiCard key={s.key} label={`${r.name} (${s.currencyCode})`} values={[{ key: s.key, text: fmt(s.total, s.currencyCode) }]} note={`Current balance as of ${formatDate(r.asOf, locale)}. Past balances are not available.`} />)}
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
            {canDrill ? <TableHead><span className="sr-only">Records</span></TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <TableRow key={row.bucket}>
              <TableCell>{row.label}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(row.value, one.currencyCode)}</TableCell>
              {data.comparisonRange ? <TableCell className="text-right tabular-nums text-muted-foreground">{row.previous ? fmt(row.previous.value, one.currencyCode) : '—'}</TableCell> : null}
              {canDrill ? (
                <TableCell className="text-right">
                  {(() => {
                    const range = bucketRange(row.bucket, r.granularity, data.range);
                    const current = picked === range.from;
                    return (
                      <Button size="sm" variant={current ? 'secondary' : 'ghost'} aria-pressed={current} aria-label={`Show records for ${row.label}`}
                        onClick={() => onPeriod(row.label, range)}>Records</Button>
                    );
                  })()}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The records behind the figure, newest first, page by page (the API's stable order). */
function Records({ client, slug, metric, date, filters, period, onAllPeriods, locale, timeZone, onSessionEnded }: {
  client: ReportingClient; slug: string; metric: ReportingMetricDefinition; date: ReportingDateConfig; filters: SavedViewConfig['filters'];
  /** The period picked in the table (its label), or null for the whole range. */
  period: string | null; onAllPeriods: () => void;
  locale?: string; timeZone: string; onSessionEnded: () => void;
}) {
  const [pages, setPages] = useState<ReportingDetails[]>([]);
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const request = { metric: { id: metric.id, version: metric.version }, date, filters, limit: 25 };
  const firstPage = useLoad(`reporting-details|${slug}|${JSON.stringify(request)}`, (signal) => client.details(slug, request, signal));
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
    const out = await client.details(slug, { ...request, cursor: next });
    if (out.kind === 'ok') {
      setPages((p) => [...p, out.data]);
      setMore({ busy: false, error: null });
    } else setMore({ busy: false, error: 'More records could not be loaded. Try again.' });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{period ? `Records for ${period}` : 'Records'}</h3>
        {period ? <Button size="sm" variant="outline" onClick={onAllPeriods}>Show all periods</Button> : null}
      </div>
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
