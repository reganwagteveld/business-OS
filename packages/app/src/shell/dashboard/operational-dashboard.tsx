import type { Activity, FinanceDocumentListItem, ProjectSummary, ReportingCatalog, ReportingDateConfig, ReportingQueryResult, SchedulingEvent } from '@business-os/contracts';
import { Badge, Button, Card, EmptyState, KpiCard, SectionHeader, Select, Skeleton } from '@business-os/ui';
import { addDays, startOfDay } from '@business-os/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import type { BoundedPage, DashboardClient, SalesSummary } from '../../api/dashboard';
import type { FinanceClient } from '../../api/finance';
import type { ProjectsClient } from '../../api/projects';
import type { ReportingClient } from '../../api/reporting';
import type { BusinessContext, Outcome } from '../../api/tenancy';
import { ActivityTypeIcon } from '../../zones/activity/activity-badge';
import { messageEntryTitle } from '../../zones/activity/labels';
import { activityTitle } from '../../zones/customers/format';
import { openAmount } from '../../zones/finance/document-list';
import { Problem } from '../../zones/problem';
import { dashboardGranularity } from '../../zones/reporting/dashboard';
import { rangeLabel } from '../../zones/reporting/format';
import { DateRangeControl, Kpis, pick } from '../../zones/reporting/shared';
import { MetricChartWidget } from '../../zones/reporting/widgets';
import { formatDate, formatMoney, formatWhen } from '../../zones/sales/format';
import { useLoad, type Loaded } from '../../zones/use-load';
import type { ShellRoute } from '../registry';
import { DASHBOARD_LIMITS, visibleWidgets, type DashboardWidgetId } from './sources';
import { businessDay, businessToday, dayLabel, daysOverdue, timeIn, upcomingWindow } from './time';

/** Customers counts, loaded once by Home and shared with its Zone card. */
export type CustomerCounts = { state: 'loading' } | { state: 'ready'; customers: number; contacts: number } | { state: 'unavailable' };

export interface DashboardClients {
  reporting: ReportingClient;
  dashboard: DashboardClient;
  projects: ProjectsClient;
  finance: FinanceClient;
}

const FINANCE_KPIS = ['finance.invoiced_amount', 'finance.payments_received', 'finance.receivables_outstanding', 'finance.receivables_overdue'] as const;
const PERFORMANCE_METRICS = ['finance.invoiced_amount', 'finance.payments_received'] as const;
const KPI_WIDGET: Record<(typeof FINANCE_KPIS)[number], DashboardWidgetId> = {
  'finance.invoiced_amount': 'kpi.invoiced', 'finance.payments_received': 'kpi.received',
  'finance.receivables_outstanding': 'kpi.outstanding', 'finance.receivables_overdue': 'kpi.overdue',
};
/** Where each Finance figure is worked on. */
const KPI_ROUTE: Record<string, ShellRoute> = {
  'finance.invoiced_amount': { zone: 'finance', child: 'invoices' },
  'finance.payments_received': { zone: 'finance', child: 'payments' },
  'finance.receivables_outstanding': { zone: 'finance', child: 'receivables' },
  'finance.receivables_overdue': { zone: 'finance', child: 'receivables' },
};
export const DEFAULT_DASHBOARD_DATE: ReportingDateConfig = { kind: 'relative', preset: 'last_30_days' };

const idle = <T,>(): Promise<Outcome<T>> => Promise.resolve({ kind: 'forbidden' });
type Load<T> = { state: Loaded<T>; reload: () => void };
const done = <T,>(l: Load<T>): T | null => (l.state.status === 'done' && l.state.outcome.kind === 'ok' ? l.state.outcome.data : null);
const failed = <T,>(l: Load<T>): Outcome<T> | null => (l.state.status === 'done' && l.state.outcome.kind !== 'ok' ? l.state.outcome : null);

/**
 * The operational dashboard on Home (R2, docs/dashboard-r2.md): the business's figures and the work that
 * needs attention, each widget from an existing, permission-checked endpoint (see `sources.ts`). Widgets the
 * person's role cannot read are left out and never requested. At most eight requests on first load, all in
 * parallel and each bounded; changing the date range re-runs only the two Reporting queries.
 */
export function OperationalDashboard({ context, clients, customers, onOpen, onSessionEnded, now: nowOverride }: {
  context: BusinessContext;
  clients: DashboardClients;
  /** From Home's own customer-summary request; omitted when the person cannot read customers. */
  customers?: CustomerCounts;
  onOpen: (route: ShellRoute) => void;
  onSessionEnded: () => void;
  /** Tests only: a fixed "now" (no midnight roll-over). */
  now?: number;
}) {
  const { slug, timeZone, locale, currency } = context.business;
  const permissions = context.membership.permissions;
  const visible = visibleWidgets(permissions);
  const has = (id: DashboardWidgetId) => visible.has(id);
  const can = (p: string) => permissions.includes(p);
  // Fixed per visit (so request keys are stable) until the business's day changes: at its midnight every
  // date-dependent figure is fetched again for the new day. Coming back to Home mounts a fresh one.
  const [now, setNow] = useState(() => nowOverride ?? Date.now());
  const [date, setDate] = useState<ReportingDateConfig>(DEFAULT_DASHBOARD_DATE);
  const window = upcomingWindow(timeZone, DASHBOARD_LIMITS.horizonDays, now);
  const today = businessToday(timeZone, now);
  useEffect(() => {
    if (nowOverride !== undefined) return; // a fixed clock (tests) never rolls over
    const ms = startOfDay(addDays(today, 1), timeZone) - Date.now();
    const timer = setTimeout(() => setNow(Math.max(Date.now(), startOfDay(addDays(today, 1), timeZone))), Math.min(Math.max(ms, 0), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [today, timeZone, nowOverride]);

  const wantsReporting = has('kpi.invoiced') || has('panel.financial-performance');
  const catalog = useLoad<ReportingCatalog>(`dash-catalog|${slug}|${wantsReporting}|${today}`, (s) => (wantsReporting ? clients.reporting.catalog(slug, s) : idle()));
  const sales = useLoad<SalesSummary>(`dash-sales|${slug}|${has('panel.pipeline')}`, (s) => (has('panel.pipeline') ? clients.dashboard.salesSummary(slug, s) : idle()));
  const projects = useLoad<ProjectSummary>(`dash-projects|${slug}|${has('kpi.active-projects')}`, (s) => (has('kpi.active-projects') ? clients.projects.summary(slug, s) : idle()));
  const events = useLoad<BoundedPage<SchedulingEvent>>(`dash-events|${slug}|${has('panel.schedule')}|${window.from}`, (s) =>
    has('panel.schedule') ? clients.dashboard.upcomingEvents(slug, { from: window.from, to: window.to, limit: DASHBOARD_LIMITS.events }, s) : idle());
  const overdue = useLoad<{ documents: FinanceDocumentListItem[]; nextCursor: string | null }>(`dash-overdue|${slug}|${has('panel.overdue-invoices')}|${today}`, (s) =>
    has('panel.overdue-invoices') ? clients.finance.documents(slug, 'invoices', { status: 'all', overdue: true, limit: DASHBOARD_LIMITS.overdueInvoices }, s) : idle());
  const activity = useLoad<BoundedPage<Activity>>(`dash-activity|${slug}|${has('panel.activity')}`, (s) =>
    has('panel.activity') ? clients.dashboard.recentActivity(slug, DASHBOARD_LIMITS.activity, s) : idle());

  // An ended session anywhere sends the person to sign in (once).
  const ended = ([catalog, sales, projects, events, overdue, activity] as Load<unknown>[]).some((l) => failed(l)?.kind === 'unauthenticated');
  useEffect(() => {
    if (ended) onSessionEnded();
  }, [ended, onSessionEnded]);

  const cat = done(catalog);
  const financeKpis = cat ? pick(cat.metrics, FINANCE_KPIS.filter((id) => has(KPI_WIDGET[id]))) : [];
  const performance = cat ? pick(cat.metrics, PERFORMANCE_METRICS.filter(() => has('panel.financial-performance'))) : [];
  const opsCards = (['kpi.open-opportunities', 'kpi.active-projects', 'kpi.upcoming-events', 'kpi.customers'] as const).filter((id) => has(id) && (id !== 'kpi.customers' || customers));
  const panels = (['panel.financial-performance', 'panel.overdue-invoices', 'panel.pipeline', 'panel.schedule', 'panel.activity'] as const).filter(has);

  if (!wantsReporting && opsCards.length === 0 && panels.length === 0) {
    return (
      <Card className="p-0">
        <EmptyState className="border-0" title="Nothing to show on your dashboard yet" description="Your role in this business does not include any of the dashboard's figures. The Zones you can open are listed below." />
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {wantsReporting ? (
        <section aria-label="Money" className="space-y-4">
          <SectionHeader title="Money" description={`Invoiced and received are for the chosen dates; balances are as of today. Calendar days in ${timeZone}.`}
            actions={cat && financeKpis.length > 0 ? (
              <div aria-label="Dashboard dates" role="group" className="grid w-full gap-3 sm:w-72">
                <DateRangeControl date={date} onChange={setDate} today={cat.today} maxRangeDays={cat.limits.maxRangeDays} idPrefix="home-dashboard" />
              </div>
            ) : undefined} />
          {failed(catalog) ? (
            <Problem outcome={failed(catalog)!} what="Your financial figures" onRetry={catalog.reload} onSessionEnded={onSessionEnded} />
          ) : !cat ? (
            <div role="status" aria-busy="true" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><span className="sr-only">Loading financial figures</span>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div>
          ) : financeKpis.length === 0 ? (
            <Card className="p-0"><EmptyState className="border-0" title="Financial figures are not available to you" description="Reporting did not grant any of these figures for your role." /></Card>
          ) : (
            <>
              <Kpis key={cat.today} client={clients.reporting} slug={slug} date={date} comparison metrics={financeKpis} locale={locale} onSessionEnded={onSessionEnded}
                title="Financial figures" columns="xl:grid-cols-4" pickLabel="Open in Finance"
                onPick={can('finance:read') ? (id) => { const r = KPI_ROUTE[id]; if (r) onOpen(r); } : undefined} />
            </>
          )}
        </section>
      ) : null}

      {opsCards.length > 0 ? (
        <section aria-label="Operations" className="space-y-4">
          <SectionHeader title="Operations" description="Where things stand right now." />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {opsCards.map((id) => {
              switch (id) {
                case 'kpi.open-opportunities': return <OpenOpportunitiesCard key={id} load={sales} locale={locale} onOpen={() => onOpen({ zone: 'sales' })} />;
                case 'kpi.active-projects': return <ActiveProjectsCard key={id} load={projects} onOpen={() => onOpen({ zone: 'projects' })} />;
                case 'kpi.upcoming-events': return <UpcomingEventsCard key={id} load={events} lastDay={window.lastDay} locale={locale} />;
                case 'kpi.customers': return <CustomersCard key={id} counts={customers!} onOpen={() => onOpen({ zone: 'customers' })} />;
              }
            })}
          </div>
        </section>
      ) : null}

      {panels.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {panels.map((id) => {
            switch (id) {
              case 'panel.financial-performance':
                return cat && performance.length > 0 ? (
                  <Performance key={`${id}|${cat.today}`} client={clients.reporting} slug={slug} catalog={cat} metrics={performance} date={date} locale={locale} currency={currency}
                    onExplore={() => onOpen({ zone: 'reporting', child: 'explore' })} onSessionEnded={onSessionEnded} />
                ) : null;
              case 'panel.overdue-invoices':
                return <OverdueInvoices key={id} load={overdue} today={today} locale={locale} onOpen={(docId) => onOpen({ zone: 'finance', child: 'invoices', target: `invoice:${docId}` })}
                  onAll={() => onOpen({ zone: 'finance', child: 'invoices' })} onSessionEnded={onSessionEnded} />;
              case 'panel.pipeline':
                return <Pipeline key={id} load={sales} locale={locale} currency={currency} onOpen={() => onOpen({ zone: 'sales' })} onSessionEnded={onSessionEnded} />;
              case 'panel.schedule':
                return <Schedule key={id} load={events} today={today} lastDay={window.lastDay} timeZone={timeZone} locale={locale} onAll={() => onOpen({ zone: 'scheduling' })} onSessionEnded={onSessionEnded} />;
              case 'panel.activity':
                return <RecentActivity key={id} load={activity} timeZone={timeZone} locale={locale}
                  onOpenCustomer={can('customers:read') ? (cid) => onOpen({ zone: 'customers', target: cid }) : undefined} onSessionEnded={onSessionEnded} />;
            }
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---- KPI cards (Operations) ---------------------------------------------------------------------

function cardState<T>(l: Load<T>): 'loading' | 'unavailable' | 'ready' {
  return l.state.status === 'loading' ? 'loading' : l.state.outcome.kind === 'ok' ? 'ready' : 'unavailable';
}
const openButton = (label: string, onClick: () => void) => <Button size="sm" variant="ghost" onClick={onClick}>{label}</Button>;
const count = (n: number, locale?: string) => new Intl.NumberFormat(locale).format(n);

function OpenOpportunitiesCard({ load, locale, onOpen }: { load: Load<SalesSummary>; locale?: string; onOpen: () => void }) {
  const s = done(load);
  return (
    <KpiCard label="Open opportunities" state={cardState(load)} unavailableText="Could not load the pipeline."
      values={s ? [{ key: 'count', text: count(s.open.count, locale) }] : undefined}
      note={s ? (s.open.totals.length ? `Open value: ${s.open.totals.map((t) => formatMoney(t.amount, t.currencyCode, locale)).join(' · ')}` : 'No open value recorded.') : 'Open, not archived. Won and lost are not included.'}
      action={openButton('Open Sales', onOpen)} />
  );
}

function ActiveProjectsCard({ load, onOpen }: { load: Load<ProjectSummary>; onOpen: () => void }) {
  const s = done(load);
  return (
    <KpiCard label="Active projects" state={cardState(load)} unavailableText="Could not load project counts."
      values={s ? [{ key: 'active', text: count(s.byStatus.ACTIVE) }] : undefined}
      note={s ? `Status Active, not archived. Also ${s.byStatus.PLANNED} planned, ${s.byStatus.ON_HOLD} on hold.` : undefined}
      action={openButton('Open Projects', onOpen)} />
  );
}

function UpcomingEventsCard({ load, lastDay, locale }: { load: Load<BoundedPage<SchedulingEvent>>; lastDay: string; locale?: string }) {
  const p = done(load);
  return (
    <KpiCard label="Scheduled, next 7 days" state={cardState(load)} unavailableText="Could not load the schedule."
      values={p ? [{ key: 'n', text: `${count(p.items.length, locale)}${p.more ? '+' : ''}` }] : undefined}
      note={p?.more
        ? `At least ${count(p.items.length, locale)}: only the first ${count(p.items.length, locale)} scheduled events up to the end of ${formatDate(lastDay, locale)} were counted.`
        : `Scheduled events from now to the end of ${formatDate(lastDay, locale)}. Cancelled events are not counted.`} />
  );
}

function CustomersCard({ counts, onOpen }: { counts: CustomerCounts; onOpen: () => void }) {
  return (
    <KpiCard label="Active customers" state={counts.state === 'ready' ? 'ready' : counts.state} unavailableText="Counts unavailable right now."
      values={counts.state === 'ready' ? [{ key: 'n', text: count(counts.customers) }] : undefined}
      note={counts.state === 'ready' ? `${count(counts.contacts)} active contacts. Archived customers are not counted.` : undefined}
      action={openButton('Open Customers', onOpen)} />
  );
}

// ---- panels -------------------------------------------------------------------------------------

function Panel({ id, title, description, actions, wide, children }: { id: string; title: string; description?: ReactNode; actions?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <Card id={id} aria-label={title} className={`flex min-w-0 flex-col gap-4 p-5${wide ? ' xl:col-span-2' : ''}`}>
      <SectionHeader as="h2" title={title} description={description} actions={actions} />
      {children}
    </Card>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}

/** Invoiced and received over the chosen dates: the R1 metrics through the R1 query, drawn with the R2 chart widget. */
function Performance({ client, slug, catalog, metrics, date, locale, currency, onExplore, onSessionEnded }: {
  client: ReportingClient; slug: string; catalog: ReportingCatalog; metrics: ReturnType<typeof pick>; date: ReportingDateConfig; locale: string; currency: string;
  onExplore: () => void; onSessionEnded: () => void;
}) {
  const granularity = dashboardGranularity({ date, comparison: false, interval: 'auto' }, catalog.today, catalog.limits.maxBuckets);
  const body = { metrics: metrics.map((m) => ({ id: m.id, version: m.version })), date, granularity, comparison: 'previous_period' };
  const load = useLoad<ReportingQueryResult>(`dash-performance|${slug}|${JSON.stringify(body)}`, (s) => client.query(slug, body, s));
  const data = done(load);
  const problem = failed(load);
  return (
    <Panel id="dash-performance" title="Financial performance" wide
      description={data ? `${rangeLabel(data.range.from, data.range.to, locale)}, compared with the previous period` : 'Invoiced and received for the chosen dates'}
      actions={<Button size="sm" variant="outline" onClick={onExplore}>Explore in Reporting</Button>}>
      {problem ? <Problem outcome={problem} what="Financial performance" onRetry={load.reload} onSessionEnded={onSessionEnded} /> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {metrics.map((m) => (
            <MetricChartWidget key={m.id} widget={{ id: m.id, kind: 'metric-chart', metricId: m.id, chart: m.id === 'finance.payments_received' ? 'line' : 'bar' }} metric={m}
              result={data ? data.results.find((r) => r.metric.id === m.id) ?? null : undefined} data={data} locale={locale} businessCurrency={currency} onExplore={onExplore} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function OverdueInvoices({ load, today, locale, onOpen, onAll, onSessionEnded }: {
  load: Load<{ documents: FinanceDocumentListItem[]; nextCursor: string | null }>; today: string; locale: string; onOpen: (id: string) => void; onAll: () => void; onSessionEnded: () => void;
}) {
  const data = done(load);
  const problem = failed(load);
  return (
    <Panel id="dash-overdue" title="Overdue invoices" description={`Issued, not fully paid, due before today (${formatDate(today, locale)}). Newest invoices first.`}
      actions={<Button size="sm" variant="outline" onClick={onAll}>All invoices</Button>}>
      {problem ? <Problem outcome={problem} what="Overdue invoices" onRetry={load.reload} onSessionEnded={onSessionEnded} />
        : !data ? <PanelLoading label="Loading overdue invoices" />
        : data.documents.length === 0 ? <EmptyState title="No overdue invoices" description="Every issued invoice is paid or not yet due." />
        : (
          <>
            <ul className="divide-y" aria-label="Overdue invoices">
              {data.documents.map((d) => {
                const days = d.dueDate ? daysOverdue(d.dueDate, today) : 0;
                return (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
                    <div className="min-w-0">
                      <button type="button" className="text-left text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onOpen(d.id)}>
                        {d.number ?? 'Invoice'}<span className="sr-only">, open invoice</span>
                      </button>
                      <p className="truncate text-xs text-muted-foreground">{d.billToSnapshot?.name ?? 'Customer'} · Due {formatDate(d.dueDate, locale)}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge tone="danger">{days === 1 ? '1 day overdue' : `${days} days overdue`}</Badge>
                      <span className="text-sm font-semibold tabular-nums">{formatMoney(openAmount(d), d.currencyCode, locale)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {data.nextCursor ? <p className="text-xs text-muted-foreground">Showing the {DASHBOARD_LIMITS.overdueInvoices} most recently created, not the oldest due. More are in Finance.</p> : null}
          </>
        )}
    </Panel>
  );
}

/** The open pipeline by stage, from the Sales summary (counts and per-currency value; no conversion). */
function Pipeline({ load, locale, currency, onOpen, onSessionEnded }: { load: Load<SalesSummary>; locale: string; currency: string; onOpen: () => void; onSessionEnded: () => void }) {
  const data = done(load);
  const problem = failed(load);
  const [chosen, setChosen] = useState<string | null>(null);
  const pipelines = data?.pipelines ?? [];
  const pipeline = pipelines.find((p) => p.id === chosen) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const max = pipeline ? Math.max(1, ...pipeline.stages.map((s) => s.count)) : 1;
  const shown = (totals: SalesSummary['open']['totals']) => totals.find((t) => t.currencyCode === currency) ?? totals[0];
  return (
    <Panel id="dash-pipeline" title="Sales pipeline" description="Open opportunities by stage, as of now."
      actions={<Button size="sm" variant="outline" onClick={onOpen}>Open Sales</Button>}>
      {problem ? <Problem outcome={problem} what="The sales pipeline" onRetry={load.reload} onSessionEnded={onSessionEnded} />
        : !data ? <PanelLoading label="Loading the sales pipeline" />
        : !pipeline || data.open.count === 0 ? <EmptyState title="No open opportunities" description="Opportunities you add in Sales appear here by stage." />
        : (
          <div className="space-y-3">
            {pipelines.length > 1 ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Pipeline</span>
                <Select value={pipeline.id} onChange={(e) => setChosen(e.target.value)} className="w-auto">
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.count})</option>)}
                </Select>
              </label>
            ) : null}
            <table className="w-full text-sm">
              <caption className="sr-only">{pipeline.name}: open opportunities and their value by stage</caption>
              <thead className="text-xs text-muted-foreground">
                <tr><th scope="col" className="py-1 text-left font-medium">Stage</th><th scope="col" className="py-1 text-right font-medium">Open</th><th scope="col" className="py-1 text-right font-medium">Value</th></tr>
              </thead>
              <tbody>
                {pipeline.stages.map((s) => {
                  const main = shown(s.totals);
                  const others = s.totals.filter((t) => t !== main);
                  return (
                    <tr key={s.id} className="border-t align-top">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <span>{s.name}{s.archived ? ' (archived stage)' : ''}</span>
                        <span aria-hidden="true" className="mt-1 block h-1.5 rounded-full bg-muted">
                          <span className="block h-1.5 rounded-full bg-primary" style={{ width: `${(s.count / max) * 100}%` }} />
                        </span>
                      </th>
                      <td className="py-2 text-right tabular-nums">{count(s.count, locale)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums">
                        {main ? formatMoney(main.amount, main.currencyCode, locale) : '—'}
                        {others.map((t) => <span key={t.currencyCode} className="block text-xs text-muted-foreground">{formatMoney(t.amount, t.currencyCode, locale)}</span>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">Value sums opportunities with an amount, per currency; currencies are never converted or added together.</p>
          </div>
        )}
    </Panel>
  );
}

/** Scheduled events from now to the end of the horizon, grouped by business day. Read-only here; "Open Scheduling" opens the Zone. */
function Schedule({ load, today, lastDay, timeZone, locale, onAll, onSessionEnded }: {
  load: Load<BoundedPage<SchedulingEvent>>; today: string; lastDay: string; timeZone: string; locale: string; onAll: () => void; onSessionEnded: () => void;
}) {
  const data = done(load);
  const problem = failed(load);
  const rows = data ? data.items.slice(0, DASHBOARD_LIMITS.scheduleRows) : [];
  const hidden = data ? data.items.length - rows.length : 0;
  // An event already under way is listed under today.
  const dayOf = (e: SchedulingEvent) => maxDay(businessDay(e.startAt, timeZone), today);
  const days = [...new Set(rows.map(dayOf))];
  return (
    <Panel id="dash-schedule" title="Upcoming schedule" description={`From now to the end of ${formatDate(lastDay, locale)}, in ${timeZone}.`}
      actions={<Button size="sm" variant="outline" onClick={onAll}>Open Scheduling</Button>}>
      {problem ? <Problem outcome={problem} what="The schedule" onRetry={load.reload} onSessionEnded={onSessionEnded} />
        : !data ? <PanelLoading label="Loading the schedule" />
        : rows.length === 0 ? <EmptyState title="Nothing scheduled" description="No scheduled events in the next 7 days." />
        : (
          <div className="space-y-4">
            {days.map((day) => (
              <section key={day} aria-label={dayLabel(day, today, locale)}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{dayLabel(day, today, locale)}</h3>
                <ul className="mt-1 divide-y">
                  {rows.filter((e) => dayOf(e) === day).map((e) => {
                    const startedBefore = businessDay(e.startAt, timeZone) < today;
                    return (
                      <li key={e.id} className="flex gap-3 py-2">
                        <span className="w-36 shrink-0 text-xs tabular-nums text-muted-foreground">
                          {startedBefore ? `Since ${formatDate(businessDay(e.startAt, timeZone), locale)}` : `${timeIn(e.startAt, timeZone, locale)} – ${timeIn(e.endAt, timeZone, locale)}`}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{e.title}</span>
                          {e.customer || e.location ? <span className="block truncate text-xs text-muted-foreground">{[e.customer?.displayName, e.location].filter(Boolean).join(' · ')}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {hidden > 0 || data.more ? <p className="text-xs text-muted-foreground">{data.more ? `And more than ${hidden} others.` : `And ${hidden} more.`}</p> : null}
          </div>
        )}
    </Panel>
  );
}
const maxDay = (a: string, b: string) => (a > b ? a : b);

function RecentActivity({ load, timeZone, locale, onOpenCustomer, onSessionEnded }: {
  load: Load<BoundedPage<Activity>>; timeZone: string; locale: string; onOpenCustomer?: (id: string) => void; onSessionEnded: () => void;
}) {
  const data = done(load);
  const problem = failed(load);
  return (
    <Panel id="dash-activity" title="Recent activity" description="The newest entries on your customers' timelines that you can see.">
      {problem ? <Problem outcome={problem} what="Recent activity" onRetry={load.reload} onSessionEnded={onSessionEnded} />
        : !data ? <PanelLoading label="Loading recent activity" />
        : data.items.length === 0 ? <EmptyState title="No activity yet" description="Notes, calls, meetings and customer changes will appear here." />
        : (
          <ul className="space-y-3" aria-label="Recent activity">
            {data.items.map((a) => (
              <li key={a.id} className="flex gap-3">
                <ActivityTypeIcon activity={a} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.type === 'message.recorded' ? messageEntryTitle(a) : activityTitle(a)}</p>
                  <p className="text-xs text-muted-foreground"><time dateTime={a.occurredAt}>{formatWhen(a.occurredAt, timeZone, locale)}</time></p>
                </div>
                {a.customerId && onOpenCustomer ? <Button size="sm" variant="ghost" onClick={() => onOpenCustomer(a.customerId!)} aria-label={`Open the customer for: ${a.type === 'message.recorded' ? messageEntryTitle(a) : activityTitle(a)}`}>Open</Button> : null}
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}
