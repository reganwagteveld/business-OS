/**
 * The operational dashboard's widgets and where each one's data comes from (docs/dashboard-r2.md §2).
 * This table is the single source for two things: which widgets a person sees (every key in `requires`
 * must be in the membership's permissions, which the API returns), and the widget-to-data-source matrix
 * in the docs (a test keeps them in step). A widget with no existing endpoint is not listed here, so it
 * cannot be shown. The API checks every request again; hiding a widget is only a courtesy that also
 * avoids a request that would be refused.
 *
 * Figures are never computed from records on the client. KPIs and charts take the totals the API
 * returns; lists show at most one page of rows.
 */
export type DashboardWidgetId =
  | 'kpi.invoiced' | 'kpi.received' | 'kpi.outstanding' | 'kpi.overdue'
  | 'kpi.open-opportunities' | 'kpi.active-projects' | 'kpi.upcoming-events' | 'kpi.customers'
  | 'panel.financial-performance' | 'panel.pipeline' | 'panel.overdue-invoices' | 'panel.schedule' | 'panel.activity';

export interface DashboardWidgetSource {
  id: DashboardWidgetId;
  title: string;
  /** Permission keys, all required. Reporting metrics also need the metric to be `accessible` in the catalog. */
  requires: readonly string[];
  endpoint: string;
  /** The response field the figure or rows come from. */
  field: string;
  /** For Reporting widgets: the registered R1 metric ids (definitions live only in the R1 registry). */
  metrics?: readonly string[];
}

export const DASHBOARD_SOURCES: readonly DashboardWidgetSource[] = [
  { id: 'kpi.invoiced', title: 'Amount invoiced', requires: ['reporting:read', 'finance:read'], endpoint: 'POST /reporting/query', field: 'results[].series[].total', metrics: ['finance.invoiced_amount'] },
  { id: 'kpi.received', title: 'Amount received', requires: ['reporting:read', 'finance:read'], endpoint: 'POST /reporting/query', field: 'results[].series[].total', metrics: ['finance.payments_received'] },
  { id: 'kpi.outstanding', title: 'Outstanding receivables', requires: ['reporting:read', 'finance:read'], endpoint: 'POST /reporting/query', field: 'results[].series[].total', metrics: ['finance.receivables_outstanding'] },
  { id: 'kpi.overdue', title: 'Overdue receivables', requires: ['reporting:read', 'finance:read'], endpoint: 'POST /reporting/query', field: 'results[].series[].total', metrics: ['finance.receivables_overdue'] },
  { id: 'kpi.open-opportunities', title: 'Open opportunities', requires: ['sales:read'], endpoint: 'GET /sales/summary', field: 'summary.open' },
  { id: 'kpi.active-projects', title: 'Active projects', requires: ['projects:read'], endpoint: 'GET /projects/summary', field: 'summary.byStatus.ACTIVE' },
  { id: 'kpi.upcoming-events', title: 'Scheduled, next 7 days', requires: ['scheduling:read'], endpoint: 'GET /scheduling/events', field: 'events.length (+ nextCursor)' },
  { id: 'kpi.customers', title: 'Active customers', requires: ['customers:read'], endpoint: 'GET /customers/summary', field: 'summary.customers.active' },
  { id: 'panel.financial-performance', title: 'Financial performance', requires: ['reporting:read', 'finance:read'], endpoint: 'POST /reporting/query', field: 'results[].buckets, series[].points', metrics: ['finance.invoiced_amount', 'finance.payments_received'] },
  { id: 'panel.pipeline', title: 'Sales pipeline', requires: ['sales:read'], endpoint: 'GET /sales/summary', field: 'summary.pipelines[].stages[]' },
  { id: 'panel.overdue-invoices', title: 'Overdue invoices', requires: ['finance:read'], endpoint: 'GET /finance/invoices?overdue=true&limit=5', field: 'documents[]' },
  { id: 'panel.schedule', title: 'Upcoming schedule', requires: ['scheduling:read'], endpoint: 'GET /scheduling/events', field: 'events[]' },
  { id: 'panel.activity', title: 'Recent activity', requires: ['activity:read'], endpoint: 'GET /activities?limit=8', field: 'activities[]' },
];

/** The widgets this membership may see, in table order. */
export function visibleWidgets(permissions: readonly string[], sources: readonly DashboardWidgetSource[] = DASHBOARD_SOURCES): Set<DashboardWidgetId> {
  const held = new Set(permissions);
  return new Set(sources.filter((s) => s.requires.every((p) => held.has(p))).map((s) => s.id));
}

/** Page sizes: every list on the dashboard is one bounded request. */
export const DASHBOARD_LIMITS = { overdueInvoices: 5, activity: 8, events: 100, scheduleRows: 8, horizonDays: 7 } as const;

/**
 * Who the dashboard was loaded for: the business, the membership and exactly what it may read. Home is
 * mounted under this key, so a business switch, a different membership, or a role or permission change in
 * the same business discards every figure loaded before and starts again with the new access. (Signing out
 * unmounts Home altogether.) The API still checks every request on its own.
 */
export function dashboardIdentity(context: { business: { slug: string }; membership: { id: string; role: string; permissions: readonly string[] } }): string {
  const { business, membership } = context;
  return [business.slug, membership.id, membership.role, [...membership.permissions].sort().join(',')].join('|');
}
