// @vitest-environment jsdom
// Reporting R2: the Dashboard homepage, drill-down into Explore and records, and the Saved reports list,
// against the in-memory Reporting API (R1 contracts, strict bodies). Figures come from the API only.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportingDetailsRequest, ReportingQueryRequest, type SavedView } from '@business-os/contracts';
import { createReportingClient, type BusinessContext } from '../src';
import { ZONES } from '../src/shell/registry';
import { dashboardGranularity, DEFAULT_DASHBOARD } from '../src/zones/reporting/dashboard';
import { approxDays, autoGranularity, bucketRange, customRangeProblem, formatTick, formatValue } from '../src/zones/reporting/format';
import { ReportingZone } from '../src/zones/reporting/reporting-zone';
import { ownership, savedActions } from '../src/zones/reporting/saved-list';
import { createFakeReporting, TODAY } from './support/fake-reporting';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OWNER = ['reporting:read', 'reporting:save', 'reporting:share', 'reporting:manage', 'finance:read', 'sales:read', 'customers:read', 'projects:read'];
const MANAGER = ['reporting:read', 'reporting:save', 'reporting:share', 'finance:read', 'sales:read', 'customers:read'];
const MEMBER = ['reporting:read', 'reporting:save', 'sales:read', 'customers:read'];
const ctx = (permissions: string[], slug = 'alpha', name = 'Alpha Plumbing'): BusinessContext => ({
  business: { slug, name, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});

type Section = 'dashboard' | 'explore' | 'saved';
function setup(o: Parameters<typeof createFakeReporting>[0] & { section?: Section }) {
  const api = createFakeReporting(o);
  const client = createReportingClient('https://api.test', { kind: 'cookie' }, api.fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  const view = render(<ReportingZone key="alpha" client={client} context={ctx(o.permissions)} userLabel="Ada" section={o.section} {...handlers} />);
  return { api, client, handlers, view, user: userEvent.setup() };
}
type Query = { metrics: { id: string; version: number }[]; date: unknown; granularity: string; comparison: string };
const queries = (api: ReturnType<typeof createFakeReporting>) => api.calls.filter((c) => c.path === '/query').map((c) => c.body as Query);
const details = (api: ReturnType<typeof createFakeReporting>) => api.calls.filter((c) => c.path === '/details').map((c) => c.body as { metric: { id: string }; date: unknown; filters: unknown; cursor?: string });
const kpis = () => screen.findByRole('region', { name: 'Headline figures' });
const panel = (name: string) => screen.getByRole('region', { name });

const view = (over: Partial<SavedView> & Pick<SavedView, 'title'>): SavedView => ({
  id: randomUUID(), description: null, reportType: 'metrics', configVersion: 1, visibility: 'PRIVATE', ownerUserId: randomUUID(), isOwner: true,
  version: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T04:30:00.000Z',
  config: {
    metrics: [{ id: 'sales.won_value', version: 1 }], date: { kind: 'relative', preset: 'last_month' }, granularity: 'month', groupBy: null, filters: {},
    comparison: 'none', sort: { by: 'bucket', direction: 'asc' }, visualization: { chart: 'bar', showComparison: false },
  },
  ...over,
});

describe('navigation', () => {
  it('Reporting has Dashboard, Explore and Saved reports sections; the Zone still opens with reporting:read only', () => {
    const z = ZONES.find((x) => x.id === 'reporting')!;
    expect(z.requires).toEqual(['reporting:read']);
    expect(z.children?.map((c) => [c.id, c.label, c.route])).toEqual([
      ['dashboard', 'Dashboard', '/reporting'], ['explore', 'Explore', '/reporting/explore'], ['saved', 'Saved reports', '/reporting/saved'],
    ]);
  });

  it('the Dashboard is the homepage, and the section follows the shell when it is controlled', async () => {
    const api = createFakeReporting({ permissions: OWNER });
    const client = createReportingClient('https://api.test', { kind: 'cookie' }, api.fetch);
    const onSection = vi.fn();
    const props = { client, context: ctx(OWNER), userLabel: 'Ada', onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection };
    const { rerender } = render(<ReportingZone key="alpha" {...props} />);
    expect(await screen.findByRole('region', { name: 'Dashboard settings' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Saved reports' }));
    expect(onSection).toHaveBeenCalledWith('saved');
    rerender(<ReportingZone key="alpha" {...props} section="saved" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Saved reports' })).toBeTruthy();
    rerender(<ReportingZone key="alpha" {...props} section="nonsense" />);
    expect(await screen.findByRole('region', { name: 'Dashboard settings' })).toBeTruthy(); // unknown section → dashboard
  });
});

describe('Dashboard', () => {
  it('shows the headline figures and one chart per metric, grouped by Zone, from two bounded requests', async () => {
    const { api } = setup({ permissions: OWNER });
    const region = await kpis();
    await within(region).findByText('$350.50');
    expect(within(region).getByText('USD 75.00')).toBeTruthy(); // never added to AUD
    expect(within(region).getByText('Overdue receivables')).toBeTruthy();
    expect(within(region).getAllByText(/Current balance as of .*Not affected by the date range/)).toHaveLength(2);
    for (const name of ['Finance charts', 'Sales charts', 'Customers charts']) expect(panel(name)).toBeTruthy();
    expect(await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' })).toBeTruthy();
    expect(screen.getByRole('figure', { name: 'Amount received (AUD)' })).toBeTruthy();
    expect(screen.getByRole('figure', { name: 'Invoices issued' })).toBeTruthy();
    expect(screen.getByRole('figure', { name: 'Won opportunity value (AUD)' })).toBeTruthy();
    expect(screen.getByRole('figure', { name: 'Opportunities won' })).toBeTruthy();
    expect(screen.getByRole('figure', { name: 'New customers' })).toBeTruthy();
    const qs = queries(api);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ granularity: 'none', comparison: 'previous_period', date: { kind: 'relative', preset: 'last_3_months' } });
    expect(qs[0]!.metrics.map((m) => m.id)).toEqual(DEFAULT_DASHBOARD.kpis);
    // Automatic interval: about three months → weeks. Never more metrics than the API allows per request.
    expect(qs[1]).toMatchObject({ granularity: 'week', comparison: 'previous_period' });
    expect(qs[1]!.metrics.map((m) => m.id)).toEqual(['finance.invoiced_amount', 'finance.payments_received', 'finance.invoices_issued', 'sales.won_value', 'sales.won_count', 'customers.new_customers']);
    for (const q of qs) expect(() => ReportingQueryRequest.parse(q)).not.toThrow();
  });

  it('lists registered but planned figures (expenses, tasks) as not available, with no numbers', async () => {
    setup({ permissions: OWNER });
    const planned = await screen.findByRole('region', { name: 'Not available yet' });
    expect(within(planned).getByText(/Expenses recorded/)).toBeTruthy();
    expect(within(planned).getByText(/Tasks completed/)).toBeTruthy();
    expect(within(planned).queryByText(/\$/)).toBeNull();
  });

  it('never requests or shows Finance figures without finance:read', async () => {
    const { api } = setup({ permissions: MEMBER });
    const region = await kpis();
    await within(region).findByText('$1,200.00');
    expect(within(region).queryByText('Amount invoiced')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Finance charts' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Sales charts' })).toBeTruthy();
    expect(queries(api).flatMap((q) => q.metrics.map((m) => m.id)).some((id) => id.startsWith('finance.'))).toBe(false);
    // Planned Finance and Projects figures are not even named to someone who cannot read those Zones.
    expect(screen.queryByText(/Expenses recorded/)).toBeNull();
    expect(screen.queryByText(/Tasks completed/)).toBeNull();
  });

  it('refuses entry without reporting:read, and explains when no figure is readable', async () => {
    setup({ permissions: ['finance:read'] });
    expect(await screen.findByText('You do not have access')).toBeTruthy();
    cleanup();
    setup({ permissions: ['reporting:read'] });
    expect(await screen.findByText('No reports are available to you')).toBeTruthy();
  });

  it('shows loading placeholders until the figures arrive', async () => {
    const { api } = setup({ permissions: OWNER, holdQueries: true });
    expect(await screen.findByText('Loading Amount invoiced')).toBeTruthy();
    expect(screen.queryByRole('figure', { name: 'Amount invoiced (AUD)' })).toBeNull();
    api.release();
    expect(await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' })).toBeTruthy();
  });

  it('shows failures with a retry, a per-figure problem in its own panel, and an empty period as empty', async () => {
    setup({ permissions: OWNER, failQuery: true });
    expect((await screen.findAllByText('Something went wrong')).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(2);
    cleanup();
    setup({ permissions: OWNER, metricErrors: ['sales.won_count'], empty: ['finance.invoiced_amount'] });
    expect(await screen.findByText('Opportunities won cannot be shown')).toBeTruthy();
    expect(screen.getByText('This figure has changed since the report was set up. Choose it again.')).toBeTruthy();
    expect(screen.getByText('No amount invoiced in this period')).toBeTruthy();
    expect(screen.getByRole('figure', { name: 'Won opportunity value (AUD)' })).toBeTruthy(); // the rest still render
  });

  it('applies presets, the interval and the comparison toggle to every request', async () => {
    const { api, user } = setup({ permissions: OWNER });
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    await user.selectOptions(screen.getByLabelText('Date range'), 'last_12_months');
    await waitFor(() => expect(queries(api).at(-1)).toMatchObject({ date: { kind: 'relative', preset: 'last_12_months' }, granularity: 'month' }));
    await user.selectOptions(screen.getByLabelText('Interval'), 'week');
    await waitFor(() => expect(queries(api).at(-1)!.granularity).toBe('week'));
    await user.click(screen.getByLabelText('Compare with previous period'));
    await waitFor(() => expect(queries(api).slice(-2).every((q) => q.comparison === 'none')).toBe(true));
  });

  it('checks a custom range before sending it, and keeps the last valid range meanwhile', async () => {
    const { api, user } = setup({ permissions: OWNER });
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    await user.selectOptions(screen.getByLabelText('Date range'), 'custom');
    await waitFor(() => expect(queries(api).some((q) => JSON.stringify(q.date) === JSON.stringify({ kind: 'fixed', from: '2026-11-01', to: TODAY }))).toBe(true));
    const sent = queries(api).length;
    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-12-01'); // after the end date
    expect(await screen.findByText('The start date must be on or before the end date.')).toBeTruthy();
    expect(from.getAttribute('aria-invalid')).toBe('true');
    expect(queries(api).slice(sent).some((q) => (q.date as { from?: string }).from === '2026-12-01')).toBe(false);
    await user.clear(from);
    await user.type(from, '2026-10-05');
    await waitFor(() => expect(queries(api).at(-1)).toMatchObject({ date: { kind: 'fixed', from: '2026-10-05', to: TODAY }, granularity: 'week' }));
  });
});

describe('drill-down', () => {
  it('Dashboard → Explore keeps the metric, date range, comparison and interval', async () => {
    const { api, user } = setup({ permissions: OWNER });
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    await user.selectOptions(screen.getByLabelText('Date range'), 'last_month');
    await user.selectOptions(screen.getByLabelText('Interval'), 'week');
    await waitFor(() => expect(queries(api).at(-1)!.granularity).toBe('week'));
    await user.click(screen.getByRole('button', { name: 'Explore Won opportunity value' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Explore' })).toBeTruthy();
    expect((screen.getByLabelText('Chart') as HTMLSelectElement).value).toBe('sales.won_value');
    expect((screen.getByLabelText('Date range') as HTMLSelectElement).value).toBe('last_month');
    expect((screen.getByLabelText('Interval') as HTMLSelectElement).value).toBe('week');
    expect((screen.getByLabelText('Compare with previous period') as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(queries(api).at(-1)).toMatchObject({ metrics: [{ id: 'sales.won_value', version: 1 }], date: { kind: 'relative', preset: 'last_month' }, granularity: 'week', comparison: 'previous_period' }));
    await waitFor(() => expect(details(api).at(-1)).toMatchObject({ metric: { id: 'sales.won_value' }, date: { kind: 'relative', preset: 'last_month' }, filters: {} }));
  });

  it('a custom range survives the drill-down too', async () => {
    const { api, user } = setup({ permissions: OWNER });
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    await user.selectOptions(screen.getByLabelText('Date range'), 'custom');
    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-10-05');
    await waitFor(() => expect(queries(api).at(-1)!.date).toEqual({ kind: 'fixed', from: '2026-10-05', to: TODAY }));
    await user.click(screen.getByRole('button', { name: 'Explore: Amount invoiced' })); // from the KPI card
    expect(await screen.findByRole('heading', { level: 1, name: 'Explore' })).toBeTruthy();
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-10-05');
    await waitFor(() => expect(queries(api).at(-1)).toMatchObject({ metrics: [{ id: 'finance.invoiced_amount' }], date: { kind: 'fixed', from: '2026-10-05', to: TODAY } }));
  });

  it('a period in the table opens the records for just that period, inside the report range, with the same metric and filters', async () => {
    const { api, user } = setup({ permissions: OWNER, section: 'explore' });
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    // Last 3 months by month in the fake: 1 Sep – 15 Nov. November's bucket is clipped to the range end.
    await user.click(await screen.findByRole('button', { name: 'Show records for Nov 2026' }));
    expect(await screen.findByRole('heading', { name: 'Records for Nov 2026' })).toBeTruthy();
    const last = details(api).at(-1)!;
    expect(last).toMatchObject({ metric: { id: 'finance.invoiced_amount' }, date: { kind: 'fixed', from: '2026-11-01', to: TODAY }, filters: {} });
    expect(() => ReportingDetailsRequest.parse(last)).not.toThrow();
    expect(screen.getByRole('button', { name: 'Show records for Nov 2026' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Show all periods' }));
    await waitFor(() => expect(details(api).at(-1)!.date).toEqual({ kind: 'relative', preset: 'last_3_months' }));
    expect(screen.getByRole('heading', { name: 'Records' })).toBeTruthy();
  });

  it('a new range forgets the picked period', async () => {
    const { api, user } = setup({ permissions: OWNER, section: 'explore' });
    await user.click(await screen.findByRole('button', { name: 'Show records for Oct 2026' }));
    await waitFor(() => expect(details(api).at(-1)!.date).toEqual({ kind: 'fixed', from: '2026-10-01', to: '2026-10-31' }));
    await user.selectOptions(screen.getByLabelText('Date range'), 'last_month');
    await waitFor(() => expect(details(api).at(-1)!.date).toEqual({ kind: 'relative', preset: 'last_month' }));
  });
});

describe('Saved reports', () => {
  const mine = view({ title: 'My pipeline' });
  const mineShared = view({ title: 'Team pipeline', visibility: 'BUSINESS' });
  const theirs = view({ title: 'Their pipeline', visibility: 'BUSINESS', isOwner: false });

  it('tells private, shared-by-you and other people\'s reports apart, and filters by scope', async () => {
    const { user } = setup({ permissions: OWNER, section: 'saved', views: [mine, mineShared, theirs] });
    const table = await screen.findByRole('table', { name: /3 saved reports/ });
    const row = (title: string) => within(table).getByRole('button', { name: title }).closest('tr')!;
    expect(within(row('My pipeline')).getByText('Private')).toBeTruthy();
    expect(within(row('Team pipeline')).getByText('Shared by you')).toBeTruthy();
    expect(within(row('Their pipeline')).getByText('Shared with you')).toBeTruthy();
    expect(within(row('My pipeline')).getByText('Won opportunity value')).toBeTruthy(); // metric names from the registry
    await user.click(screen.getByRole('button', { name: 'Shared with me (1)' }));
    expect(screen.getByRole('table', { name: /1 saved report,/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'My pipeline' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Mine (2)' }));
    expect(screen.queryByRole('button', { name: 'Their pipeline' })).toBeNull();
  });

  it('applies R1 permissions to rename, share and delete', async () => {
    expect(savedActions(mine, { save: true, share: false, manage: false })).toEqual({ rename: true, delete: true });
    expect(savedActions(mine, { save: false, share: false, manage: false })).toEqual({ rename: false, delete: false });
    expect(savedActions(theirs, { save: true, share: true, manage: false })).toEqual({ rename: false, delete: false });
    expect(savedActions(theirs, { save: true, share: true, manage: true })).toEqual({ rename: false, delete: true });
    expect(savedActions({ isOwner: false, visibility: 'PRIVATE' }, { save: true, share: true, manage: true })).toEqual({ rename: false, delete: false });
    expect(ownership(theirs).label).toBe('Shared with you');

    setup({ permissions: MANAGER, section: 'saved', views: [mine, theirs] }); // share but no manage
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Rename or share My pipeline' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete My pipeline' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rename .*Their pipeline/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Their pipeline' })).toBeNull();
    cleanup();
    setup({ permissions: OWNER, section: 'saved', views: [mine, theirs] }); // reporting:manage
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Delete Their pipeline' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rename .*Their pipeline/ })).toBeNull();
    cleanup();
    setup({ permissions: MEMBER, section: 'saved', views: [view({ title: 'Member view' })] }); // no reporting:share
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Rename or share Member view' }).textContent).toBe('Rename');
  });

  it('renames with the version it read and deletes after confirming, from the list', async () => {
    const own = view({ title: 'My pipeline', version: 4 });
    const { api, user } = setup({ permissions: OWNER, section: 'saved', views: [own, theirs] });
    await user.click(await screen.findByRole('button', { name: 'Rename or share My pipeline' }));
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Pipeline (renamed)');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved “Pipeline (renamed)”.');
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ version: 4, title: 'Pipeline (renamed)', description: null, visibility: 'PRIVATE' });
    expect(await screen.findByRole('button', { name: 'Pipeline (renamed)' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete Their pipeline' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(/for everyone it is shared with/)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Delete report' }));
    await screen.findByText('Deleted “Their pipeline”. No business records were changed.');
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === `/views/${theirs.id}`)).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Their pipeline' })).toBeNull());
  });

  it('opens a report in Explore through the saved-view endpoint, so the server re-checks it', async () => {
    const { api, user } = setup({ permissions: OWNER, section: 'saved', views: [theirs] });
    await user.click(await screen.findByRole('button', { name: 'Open Their pipeline' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Their pipeline' })).toBeTruthy();
    expect(screen.getByText('Shared with you')).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === `/views/${theirs.id}/run`)).toBe(true));
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull(); // not the owner
  });

  it('shows an empty list with a way to create one, and a multi-page list in full', async () => {
    const { user } = setup({ permissions: OWNER, section: 'saved' });
    expect(await screen.findByText('No saved reports yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create a report' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Explore' })).toBeTruthy();
    cleanup();
    setup({ permissions: OWNER, section: 'saved', views: Array.from({ length: 5 }, (_, i) => view({ title: `R${i}` })), pageSize: 1 });
    // 5 pages exceed nothing here (default bound 50), so the full list shows.
    expect(await screen.findByRole('table', { name: /5 saved reports/ })).toBeTruthy();
  });
});

describe('switching business', () => {
  it('discards every figure and setting of the previous business and asks the new one', async () => {
    const alpha = createFakeReporting({ permissions: OWNER });
    const beta = createFakeReporting({ permissions: OWNER, figures: { 'finance.invoiced_amount': [{ currency: 'EUR', total: '9.99', previous: '1.00', change: null }] } });
    const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
    const { rerender } = render(<ReportingZone key="alpha" client={createReportingClient('https://api.test', { kind: 'cookie' }, alpha.fetch)} context={ctx(OWNER)} userLabel="Ada" {...handlers} />);
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Date range'), 'last_month');
    rerender(<ReportingZone key="beta" client={createReportingClient('https://api.test', { kind: 'cookie' }, beta.fetch)} context={ctx(OWNER, 'beta', 'Beta Bakery')} userLabel="Ada" {...handlers} />);
    expect(await screen.findByRole('figure', { name: 'Amount invoiced (EUR)' })).toBeTruthy();
    expect(screen.queryByText('$350.50')).toBeNull();
    expect((screen.getByLabelText('Date range') as HTMLSelectElement).value).toBe('last_3_months'); // settings reset
    expect(beta.calls.every((c) => c.slug === 'beta')).toBe(true);
    expect(alpha.calls.every((c) => c.slug === 'alpha')).toBe(true);
  });
});

describe('formatting and date helpers', () => {
  it('formats money in its own currency for the business locale, never converting', () => {
    expect(formatValue('350.50', 'money', 'AUD', 'en-AU')).toBe('$350.50');
    expect(formatValue('75', 'money', 'USD', 'en-AU')).toBe('USD\u00a075.00');
    expect(formatValue('350.50', 'money', 'AUD', 'en-US')).toBe('A$350.50');
    expect(formatValue('1234', 'money', 'JPY', 'en-US')).toBe('¥1,234');
    expect(formatValue('1234.5', 'money', 'EUR', 'de-DE')).toBe('1.234,50 €');
    expect(formatValue('1234567.89', 'money', 'AUD', 'en-AU')).toBe('$1,234,567.89');
    expect(formatValue('12345', 'count', null, 'en-AU')).toBe('12,345');
    expect(formatValue(null, 'money', 'AUD', 'en-AU')).toBe('Hidden (small group)');
    // Axis ticks: compact money in the series currency; counts only on whole numbers.
    expect(formatTick(2500, 'money', 'AUD', 'en-AU')).toBe('$2.5K');
    expect(formatTick(0.25, 'count', null, 'en-AU')).toBe('');
    expect(formatTick(2, 'count', null, 'en-AU')).toBe('2');
  });

  it('clips a period to the report range (weeks start Monday, months end on their last day)', () => {
    const range = { from: '2026-09-03', to: '2026-11-15' };
    expect(bucketRange('2026-09-01', 'month', range)).toEqual({ from: '2026-09-03', to: '2026-09-30' });
    expect(bucketRange('2026-11-01', 'month', range)).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(bucketRange('2026-02-01', 'month', { from: '2026-01-01', to: '2026-12-31' })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(bucketRange('2026-08-31', 'week', range)).toEqual({ from: '2026-09-03', to: '2026-09-06' });
    expect(bucketRange('2026-10-05', 'day', range)).toEqual({ from: '2026-10-05', to: '2026-10-05' });
  });

  it('validates custom ranges and keeps automatic intervals inside the bucket limit', () => {
    expect(customRangeProblem('2026-11-01', '2026-11-15', 1827)).toBeNull();
    expect(customRangeProblem('2026-11-16', '2026-11-15', 1827)).toMatch(/on or before/);
    expect(customRangeProblem('2026-02-30', '2026-03-01', 1827)).toMatch(/Enter both dates/);
    expect(customRangeProblem('1999-01-01', '2026-03-01', 1827)).toMatch(/Enter both dates/);
    expect(customRangeProblem('2020-01-01', '2026-03-01', 1827)).toMatch(/at most 1,827 days/);
    expect(autoGranularity(30)).toBe('day');
    expect(autoGranularity(90)).toBe('week');
    expect(autoGranularity(366)).toBe('month');
    expect(approxDays({ kind: 'relative', preset: 'year_to_date' }, '2026-01-10')).toBe(10);
    expect(dashboardGranularity({ date: { kind: 'fixed', from: '2022-01-01', to: '2026-11-15' }, comparison: false, interval: 'day' }, TODAY, 400)).toBe('week');
    expect(dashboardGranularity({ date: { kind: 'fixed', from: '2022-01-01', to: '2026-11-15' }, comparison: false, interval: 'day' }, TODAY, 100)).toBe('month');
    expect(dashboardGranularity({ date: { kind: 'fixed', from: '2026-01-01', to: '2026-11-15' }, comparison: false, interval: 'day' }, TODAY, 400)).toBe('day');
  });
});
