// @vitest-environment jsdom
// R2 operational dashboard on Home (docs/dashboard-r2.md): every widget from an existing endpoint, through the
// real clients and contracts; role gating, figures, date boundaries, empty and error states, navigation and
// business (tenant) separation.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListActivitiesResponse, ListEventsResponse, ListFinanceDocumentsResponse, SalesSummaryResponse, type Activity, type FinanceDocument, type ProjectSummary, type SchedulingEvent } from '@business-os/contracts';
import { createDashboardClient, createFinanceClient, createReportingClient, type BusinessContext, type ProjectsClient } from '../src';
import { DASHBOARD_LIMITS, DASHBOARD_SOURCES, visibleWidgets } from '../src/shell/dashboard/sources';
import { OperationalDashboard, type CustomerCounts } from '../src/shell/dashboard/operational-dashboard';
import { businessDay, dayLabel, daysOverdue, upcomingWindow } from '../src/shell/dashboard/time';
import { activity, customer } from './support/fake-api';
import { issued } from './support/fake-finance';
import { createFakeReporting } from './support/fake-reporting';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
/** 09:00 on Sunday 15 November 2026 in Perth (the fake Reporting API's "today"). */
const NOW = Date.parse('2026-11-15T01:00:00.000Z');

// The role defaults from apps/api/src/modules/access/server/permissions.ts, for the keys the dashboard reads.
const OWNER = ['reporting:read', 'finance:read', 'sales:read', 'projects:read', 'customers:read', 'activity:read', 'scheduling:read'];
const MANAGER = OWNER;
const MEMBER = ['reporting:read', 'sales:read', 'projects:read', 'customers:read', 'activity:read', 'scheduling:read'];

const ctx = (permissions: string[], slug = 'alpha', timeZone = 'Australia/Perth'): BusinessContext => ({
  business: { slug, name: `${slug} Plumbing`, countryCode: 'AU', timeZone, locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});

const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const listItem = (d: FinanceDocument) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'lines'));

function event(over: Partial<SchedulingEvent> & Pick<SchedulingEvent, 'title' | 'startAt' | 'endAt'>): SchedulingEvent {
  const at = '2026-11-01T00:00:00.000Z';
  const by = randomUUID();
  return {
    id: randomUUID(), calendarId: randomUUID(), description: null, location: null, status: 'SCHEDULED', blocksAvailability: true, customerId: null, customer: null,
    resources: [], cancelledAt: null, cancelledById: null, version: 1, createdById: by, updatedById: by, createdAt: at, updatedAt: at, archivedAt: null, ...over,
  };
}

const ACME = customer({ displayName: 'Acme Pty Ltd' });
const SUMMARY = {
  open: { count: 5, totals: [{ currencyCode: 'AUD', amount: '12500.00', count: 4 }, { currencyCode: 'USD', amount: '900.00', count: 1 }] },
  pipelines: [{
    id: randomUUID(), name: 'Sales pipeline', isDefault: true, count: 5, totals: [{ currencyCode: 'AUD', amount: '12500.00', count: 4 }, { currencyCode: 'USD', amount: '900.00', count: 1 }],
    stages: [
      { id: randomUUID(), name: 'New', position: 1000, archived: false, count: 3, totals: [{ currencyCode: 'AUD', amount: '2500.00', count: 3 }] },
      { id: randomUUID(), name: 'Qualified', position: 2000, archived: false, count: 2, totals: [{ currencyCode: 'AUD', amount: '10000.00', count: 1 }, { currencyCode: 'USD', amount: '900.00', count: 1 }] },
      { id: randomUUID(), name: 'Proposal', position: 3000, archived: false, count: 0, totals: [] },
    ],
  }],
};
const PROJECTS: ProjectSummary = { active: 9, byStatus: { PLANNED: 2, ACTIVE: 4, ON_HOLD: 1, COMPLETED: 1, CANCELLED: 1 } };

interface Data {
  summary?: typeof SUMMARY;
  invoices?: FinanceDocument[];
  invoicesMore?: boolean;
  activities?: Activity[];
  events?: SchedulingEvent[];
  eventsMore?: boolean;
  /** Path fragment → HTTP status to answer instead. */
  fail?: Record<string, number | 'network'>;
}

/**
 * One in-memory API for the dashboard's own reads and Finance's invoice list: every response is parsed with
 * the shared contract before it is sent, and every request is logged with the business slug in its path.
 */
function fakeApi(byBusiness: Record<string, Data>) {
  const calls: { slug: string; path: string; query: Record<string, string> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const m = /^\/api\/v1\/b\/([^/]+)(\/.*)$/.exec(url.pathname)!;
    const [, slug, path] = m as unknown as [string, string, string];
    calls.push({ slug, path, query: Object.fromEntries(url.searchParams) });
    const d = byBusiness[slug];
    if (!d) return json(404, { error: 'not_found' });
    const failure = Object.entries(d.fail ?? {}).find(([k]) => path.includes(k))?.[1];
    if (failure === 'network') throw new TypeError('Failed to fetch');
    if (failure) return json(failure, { error: 'x' });
    if (path === '/sales/summary') return json(200, SalesSummaryResponse.parse({ summary: d.summary ?? { open: { count: 0, totals: [] }, pipelines: [] } }));
    if (path === '/activities') return json(200, ListActivitiesResponse.parse({ activities: (d.activities ?? []).slice(0, Number(url.searchParams.get('limit'))), nextCursor: null }));
    if (path === '/scheduling/events') return json(200, ListEventsResponse.parse({ events: d.events ?? [], nextCursor: d.eventsMore ? 'next' : null }));
    if (path === '/finance/invoices') return json(200, ListFinanceDocumentsResponse.parse({ documents: (d.invoices ?? []).map(listItem), nextCursor: d.invoicesMore ? 'next' : null }));
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function setup(o: { permissions: string[]; data?: Data; slug?: string; timeZone?: string; reporting?: Partial<Parameters<typeof createFakeReporting>[0]>; projects?: ProjectsClient; customers?: CustomerCounts }) {
  const slug = o.slug ?? 'alpha';
  const api = fakeApi({ [slug]: o.data ?? {} });
  const rep = createFakeReporting({ permissions: o.permissions, ...o.reporting });
  const projects = o.projects ?? ({ summary: vi.fn(async () => ({ kind: 'ok' as const, data: PROJECTS })) } as unknown as ProjectsClient);
  const clients = {
    reporting: createReportingClient(BASE, { kind: 'cookie' }, rep.fetch),
    dashboard: createDashboardClient(BASE, { kind: 'cookie' }, api.fetch),
    finance: createFinanceClient(BASE, { kind: 'cookie' }, api.fetch),
    projects,
  };
  const onOpen = vi.fn();
  const onSessionEnded = vi.fn();
  const context = ctx(o.permissions, slug, o.timeZone);
  const view = render(<OperationalDashboard key={slug} context={context} clients={clients} customers={o.customers} onOpen={onOpen} onSessionEnded={onSessionEnded} now={NOW} />);
  return { api, rep, clients, onOpen, onSessionEnded, view, context, user: userEvent.setup() };
}

const panel = (name: string) => screen.findByRole('region', { name });
const OWNER_DATA: Data = {
  summary: SUMMARY,
  invoices: [
    issued('INVOICE', ACME, 'INV-0007', { amount: '500.00', allocatedTotal: '120.00', creditAppliedTotal: '30.00', dueDate: '2026-11-05', settlementState: 'PARTIALLY_PAID' }),
    issued('INVOICE', ACME, 'INV-0009', { amount: '80.00', dueDate: '2026-11-14' }),
  ],
  activities: [activity(ACME.id, { type: 'note', subject: 'Called about the quote', occurredAt: '2026-11-14T23:00:00.000Z' })],
  events: [
    event({ title: 'Site visit', startAt: '2026-11-15T02:00:00.000Z', endAt: '2026-11-15T03:00:00.000Z', customer: { id: ACME.id, displayName: 'Acme Pty Ltd', archived: false }, customerId: ACME.id }),
    // 23:30 UTC on the 15th is 07:30 on the 16th in Perth: listed under Tomorrow, not today.
    event({ title: 'Early start', startAt: '2026-11-15T23:30:00.000Z', endAt: '2026-11-16T01:00:00.000Z' }),
  ],
};

describe('widget sources and role gating', () => {
  it('every widget names an existing endpoint and real permission keys; Reporting widgets name registered R1 metrics', () => {
    const keys = /^[a-z]+:[a-z_]+$/;
    for (const s of DASHBOARD_SOURCES) {
      expect(s.endpoint).toMatch(/^(GET|POST) \//);
      expect(s.requires.length).toBeGreaterThan(0);
      for (const k of s.requires) expect(k).toMatch(keys);
      if (s.endpoint.includes('/reporting/')) expect(s.metrics?.length).toBeGreaterThan(0);
    }
    expect(new Set(DASHBOARD_SOURCES.map((s) => s.id)).size).toBe(DASHBOARD_SOURCES.length);
  });

  it('Member sees no Finance widget; Owner and Manager see everything; nothing without a permission', () => {
    const member = visibleWidgets(MEMBER);
    for (const id of ['kpi.invoiced', 'kpi.received', 'kpi.outstanding', 'kpi.overdue', 'panel.financial-performance', 'panel.overdue-invoices'] as const) expect(member.has(id), id).toBe(false);
    for (const id of ['kpi.open-opportunities', 'kpi.active-projects', 'panel.pipeline', 'panel.activity', 'panel.schedule'] as const) expect(member.has(id), id).toBe(true);
    expect(visibleWidgets(OWNER).size).toBe(DASHBOARD_SOURCES.length);
    expect(visibleWidgets(MANAGER).size).toBe(DASHBOARD_SOURCES.length);
    expect(visibleWidgets([]).size).toBe(0);
    // finance:read alone is not enough for Reporting figures; reporting:read alone grants no source data.
    expect(visibleWidgets(['finance:read']).has('kpi.invoiced')).toBe(false);
    expect(visibleWidgets(['reporting:read']).has('kpi.invoiced')).toBe(false);
  });
});

describe('rendering real figures', () => {
  it('Owner: KPIs, pipeline, overdue invoices, schedule and activity from one bounded request each', async () => {
    const { api, rep } = setup({ permissions: OWNER, data: OWNER_DATA, customers: { state: 'ready', customers: 12, contacts: 30 } });
    // Finance KPIs (R1 metrics through the R1 query).
    const money = await panel('Financial figures');
    await waitFor(() => expect(within(money).getByText('Outstanding receivables')).toBeTruthy());
    await waitFor(() => expect(within(money).getByText(/265\.00/)).toBeTruthy());
    // Operations.
    const ops = screen.getByRole('region', { name: 'Operations' });
    await waitFor(() => expect(within(ops).getByText(/Open value: \$12,500\.00 · USD 900\.00/)).toBeTruthy());
    expect(within(ops).getByText('5')).toBeTruthy();
    expect(within(ops).getByText('4')).toBeTruthy(); // ACTIVE projects only, not the 9 unarchived
    expect(within(ops).getByText(/Also 2 planned, 1 on hold/)).toBeTruthy();
    expect(within(ops).getByText('12')).toBeTruthy();
    // Pipeline: stage rows with counts and per-currency values, never added across currencies.
    const pipeline = await panel('Sales pipeline');
    const rows = within(pipeline).getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/\s/g, ' '));
    expect(rows).toEqual(['New3$2,500.00', 'Qualified2$10,000.00USD 900.00', 'Proposal0—']);
    // Overdue invoices: open amount = total − payments − credit; days overdue in business days.
    const overdue = await panel('Overdue invoices');
    await waitFor(() => expect(within(overdue).getByText('INV-0007')).toBeTruthy());
    expect(within(overdue).getByText('$350.00')).toBeTruthy();
    expect(within(overdue).getByText('10 days overdue')).toBeTruthy();
    expect(within(overdue).getByText('1 day overdue')).toBeTruthy();
    // Schedule grouped by business day.
    const schedule = await panel('Upcoming schedule');
    await waitFor(() => expect(within(schedule).getByRole('region', { name: 'Today' })).toBeTruthy());
    expect(within(within(schedule).getByRole('region', { name: 'Today' })).getByText('Site visit')).toBeTruthy();
    expect(within(within(schedule).getByRole('region', { name: 'Tomorrow' })).getByText('Early start')).toBeTruthy();
    // Activity.
    const act = await panel('Recent activity');
    await waitFor(() => expect(within(act).getByText('Called about the quote')).toBeTruthy());
    // Request budget: each source once; Reporting = catalog + KPI query + performance query.
    await waitFor(() => expect(rep.calls.filter((c) => c.path === '/query')).toHaveLength(2));
    expect(rep.calls.filter((c) => c.path === '/metrics')).toHaveLength(1);
    expect(api.calls.map((c) => c.path).sort()).toEqual(['/activities', '/finance/invoices', '/sales/summary', '/scheduling/events']);
    const inv = api.calls.find((c) => c.path === '/finance/invoices')!;
    expect(inv.query).toMatchObject({ overdue: 'true', limit: String(DASHBOARD_LIMITS.overdueInvoices) });
    expect(api.calls.find((c) => c.path === '/activities')!.query).toEqual({ limit: String(DASHBOARD_LIMITS.activity) });
    // At most 6 metrics per query (the R1 limit), only accessible ones.
    for (const q of rep.calls.filter((c) => c.path === '/query')) expect((q.body as { metrics: unknown[] }).metrics.length).toBeLessThanOrEqual(6);
  });

  it('Member: no Finance request is ever sent and no Finance figure is shown', async () => {
    const { api, rep } = setup({ permissions: MEMBER, data: OWNER_DATA });
    await panel('Sales pipeline');
    await waitFor(() => expect(api.calls.length).toBe(3));
    expect(rep.calls).toHaveLength(0);
    expect(api.calls.some((c) => c.path.startsWith('/finance'))).toBe(false);
    expect(screen.queryByRole('region', { name: 'Financial figures' })).toBeNull();
    expect(screen.queryByText(/Overdue invoices|Financial performance|receivables|invoiced/i)).toBeNull();
  });

  it('only the widgets a role can read are requested (projects:read missing: no project request, no card)', async () => {
    const projects = { summary: vi.fn() } as unknown as ProjectsClient;
    setup({ permissions: ['sales:read'], data: OWNER_DATA, projects });
    await panel('Sales pipeline');
    expect(projects.summary).not.toHaveBeenCalled();
    expect(screen.queryByText('Active projects')).toBeNull();
    expect(screen.queryByText('Upcoming schedule')).toBeNull();
  });

  it('a role with none of the sources gets an honest empty dashboard and no requests', () => {
    const { api, rep } = setup({ permissions: ['business:read'] });
    expect(screen.getByText("Nothing to show on your dashboard yet")).toBeTruthy();
    expect(api.calls).toHaveLength(0);
    expect(rep.calls).toHaveLength(0);
  });
});

describe('date range and time zones', () => {
  it('the range re-runs only the two Reporting queries; balances, pipeline and lists are not re-fetched', async () => {
    const { api, rep, user } = setup({ permissions: OWNER, data: OWNER_DATA });
    await waitFor(() => expect(rep.calls.filter((c) => c.path === '/query')).toHaveLength(2));
    const before = api.calls.length;
    await user.selectOptions(screen.getByLabelText('Date range'), 'last_month');
    await waitFor(() => expect(rep.calls.filter((c) => c.path === '/query')).toHaveLength(4));
    const last = rep.calls.filter((c) => c.path === '/query').slice(-2).map((c) => c.body as { date: unknown; granularity: string });
    for (const q of last) expect(q.date).toEqual({ kind: 'relative', preset: 'last_month' });
    expect(last.map((q) => q.granularity).sort()).toEqual(['day', 'none']);
    expect(api.calls.length).toBe(before);
  });

  it('the schedule window runs from now to the end of the 7th business day, in the business zone', () => {
    // Perth (UTC+8, no DST): 15 Nov 09:00 local → end of 21 Nov local = 21 Nov 16:00 UTC.
    expect(upcomingWindow('Australia/Perth', 7, NOW)).toEqual({ from: '2026-11-15T01:00:00.000Z', to: '2026-11-21T16:00:00.000Z', lastDay: '2026-11-21' });
    // Sydney across the start of daylight saving (4 Oct 2026, 02:00 → 03:00): the window is 7 days less one hour.
    const syd = upcomingWindow('Australia/Sydney', 7, Date.parse('2026-09-30T14:00:00.000Z')); // 1 Oct 00:00 AEST
    expect(syd).toEqual({ from: '2026-09-30T14:00:00.000Z', to: '2026-10-07T13:00:00.000Z', lastDay: '2026-10-07' });
    expect(Date.parse(syd.to) - Date.parse(syd.from)).toBe(7 * 86_400_000 - 3_600_000);
    // New York: the same instant is still the 14th there.
    expect(upcomingWindow('America/New_York', 7, NOW).lastDay).toBe('2026-11-20');
  });

  it('the events request uses that window and only scheduled events', async () => {
    const { api } = setup({ permissions: OWNER, data: OWNER_DATA });
    await waitFor(() => expect(api.calls.some((c) => c.path === '/scheduling/events')).toBe(true));
    expect(api.calls.find((c) => c.path === '/scheduling/events')!.query).toEqual({ from: '2026-11-15T01:00:00.000Z', to: '2026-11-21T16:00:00.000Z', status: 'scheduled', limit: String(DASHBOARD_LIMITS.events) });
  });

  it('days overdue and day labels use business calendar dates', () => {
    expect(daysOverdue('2026-11-14', '2026-11-15')).toBe(1);
    expect(daysOverdue('2026-11-15', '2026-11-15')).toBe(0);
    expect(daysOverdue('2026-11-20', '2026-11-15')).toBe(0);
    expect(daysOverdue('2026-02-28', '2026-03-01')).toBe(1);
    expect(dayLabel('2026-11-15', '2026-11-15')).toBe('Today');
    expect(dayLabel('2026-11-16', '2026-11-15')).toBe('Tomorrow');
    expect(dayLabel('2026-11-17', '2026-11-15', 'en-AU')).toMatch(/Tuesday.*17 Nov/);
    // 23:30 UTC is already the next day in Perth and still the same day in London.
    expect(businessDay('2026-11-15T23:30:00.000Z', 'Australia/Perth')).toBe('2026-11-16');
    expect(businessDay('2026-11-15T23:30:00.000Z', 'Europe/London')).toBe('2026-11-15');
  });

  it('more events than one page says so instead of a false count', async () => {
    const many = Array.from({ length: 3 }, (_, i) => event({ title: `Job ${i}`, startAt: '2026-11-15T02:00:00.000Z', endAt: '2026-11-15T03:00:00.000Z' }));
    setup({ permissions: MEMBER, data: { events: many, eventsMore: true } });
    const ops = await panel('Operations');
    await waitFor(() => expect(within(ops).getByText('3+')).toBeTruthy());
  });
});

describe('empty data and errors', () => {
  it('empty business: every panel says so plainly, with no made-up figures', async () => {
    setup({ permissions: OWNER, data: {}, reporting: { empty: ['finance.invoiced_amount', 'finance.payments_received', 'finance.receivables_outstanding', 'finance.receivables_overdue'] } });
    expect(await screen.findByText('No open opportunities')).toBeTruthy();
    expect(await screen.findByText('No overdue invoices')).toBeTruthy();
    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();
    expect(await screen.findByText('No activity yet')).toBeTruthy();
    const money = await panel('Financial figures');
    await waitFor(() => expect(within(money).getAllByText('No data')).toHaveLength(4));
  });

  it('one failing source shows its own error with a retry; the others still render', async () => {
    const { api, user } = setup({ permissions: OWNER, data: { ...OWNER_DATA, fail: { '/sales/summary': 500 } } });
    const pipeline = await panel('Sales pipeline');
    await waitFor(() => expect(within(pipeline).getByRole('alert').textContent).toMatch(/could not be loaded/));
    expect(within(await panel('Overdue invoices')).queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Could not load the pipeline/)).toBeTruthy();
    const before = api.calls.filter((c) => c.path === '/sales/summary').length;
    await user.click(within(pipeline).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/sales/summary').length).toBe(before + 1));
  });

  it('offline and a refused catalog are told apart from an ended session', async () => {
    setup({ permissions: OWNER, data: { ...OWNER_DATA, fail: { '/activities': 'network' } }, reporting: { catalogStatus: 500 } });
    const act = await panel('Recent activity');
    await waitFor(() => expect(within(act).getByRole('alert').textContent).toMatch(/Can't reach Business OS/));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Money' }).textContent).toMatch(/Something went wrong/));
  });

  it('an ended session (401) sends the person to sign in once', async () => {
    const { onSessionEnded } = setup({ permissions: OWNER, data: { ...OWNER_DATA, fail: { '/sales/summary': 401, '/activities': 401 } } });
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });

  it('a response that does not match the contract is an error, never shown', async () => {
    const api = fakeApi({});
    const bad = (async () => json(200, { summary: { open: { count: -1, totals: [] }, pipelines: [] } })) as typeof fetch;
    void api;
    const client = createDashboardClient(BASE, { kind: 'cookie' }, bad);
    expect(await client.salesSummary('alpha')).toEqual({ kind: 'invalid' });
  });
});

describe('navigation into Zones', () => {
  it('links open the right Zone and record', async () => {
    const { onOpen, user } = setup({ permissions: OWNER, data: OWNER_DATA, customers: { state: 'ready', customers: 1, contacts: 0 } });
    const overdue = await panel('Overdue invoices');
    await user.click(await within(overdue).findByRole('button', { name: /INV-0007/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'finance', child: 'invoices', target: `invoice:${OWNER_DATA.invoices![0]!.id}` });
    await user.click(within(overdue).getByRole('button', { name: 'All invoices' }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'finance', child: 'invoices' });
    await user.click(within(await panel('Sales pipeline')).getByRole('button', { name: 'Open Sales' }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'sales' });
    await user.click(screen.getByRole('button', { name: 'Open Projects' }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'projects' });
    await user.click(screen.getByRole('button', { name: 'Open Customers' }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'customers' });
    await user.click(await within(await panel('Recent activity')).findByRole('button', { name: /Open the customer for: Called about the quote/ }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'customers', target: ACME.id });
    await user.click(await screen.findByRole('button', { name: 'Open in Finance: Outstanding receivables' }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'finance', child: 'receivables' });
    await user.click(within(await panel('Financial performance')).getByRole('button', { name: 'Explore in Reporting' }));
    expect(onOpen).toHaveBeenLastCalledWith({ zone: 'reporting', child: 'explore' });
  });

  it('without customers:read, activity rows have no customer link', async () => {
    setup({ permissions: ['activity:read'], data: OWNER_DATA });
    const act = await panel('Recent activity');
    await waitFor(() => expect(within(act).getByText('Called about the quote')).toBeTruthy());
    expect(within(act).queryByRole('button')).toBeNull();
  });
});

describe('tenant separation', () => {
  it("every request is under the active business's slug, and another business's figures never appear", async () => {
    const other = { ...SUMMARY, open: { count: 77, totals: [{ currencyCode: 'AUD', amount: '777.00', count: 77 }] }, pipelines: [] };
    const api = fakeApi({ alpha: OWNER_DATA, beta: { summary: other } });
    const projects = { summary: vi.fn(async () => ({ kind: 'ok' as const, data: PROJECTS })) } as unknown as ProjectsClient;
    const rep = createFakeReporting({ permissions: MEMBER });
    const clients = { reporting: createReportingClient(BASE, { kind: 'cookie' }, rep.fetch), dashboard: createDashboardClient(BASE, { kind: 'cookie' }, api.fetch), finance: createFinanceClient(BASE, { kind: 'cookie' }, api.fetch), projects };
    const { rerender } = render(<OperationalDashboard key="alpha" context={ctx(MEMBER, 'alpha')} clients={clients} onOpen={vi.fn()} onSessionEnded={vi.fn()} now={NOW} />);
    await waitFor(() => expect(screen.getByText(/Open value: \$12,500\.00/)).toBeTruthy());
    rerender(<OperationalDashboard key="beta" context={ctx(MEMBER, 'beta')} clients={clients} onOpen={vi.fn()} onSessionEnded={vi.fn()} now={NOW} />);
    await waitFor(() => expect(screen.getByText(/Open value: \$777\.00/)).toBeTruthy());
    expect(screen.queryByText(/12,500/)).toBeNull();
    expect(screen.queryByText('Called about the quote')).toBeNull();
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['alpha', 'beta']));
    expect(vi.mocked(projects.summary).mock.calls.map((c) => c[0])).toEqual(['alpha', 'beta']);
  });

  it('the dashboard client only ever builds paths under /api/v1/b/:slug and parses with the contracts', async () => {
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).pathname);
      return json(403, { error: 'forbidden' });
    }) as typeof fetch;
    const c = createDashboardClient(BASE, { kind: 'cookie' }, f);
    expect(await c.salesSummary('gamma')).toEqual({ kind: 'forbidden' });
    expect(await c.recentActivity('gamma', 8)).toEqual({ kind: 'forbidden' });
    expect(await c.upcomingEvents('gamma', { from: '2026-11-15T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z', limit: 10 })).toEqual({ kind: 'forbidden' });
    expect(seen).toEqual(['/api/v1/b/gamma/sales/summary', '/api/v1/b/gamma/activities', '/api/v1/b/gamma/scheduling/events']);
  });
});
