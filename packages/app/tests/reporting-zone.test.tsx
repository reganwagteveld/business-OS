// @vitest-environment jsdom
// Reporting R1: the Reporting Zone against an in-memory Reporting API. The real client and the shared
// contracts sit in front of it, so every request body is contract-checked (strict) and every response
// parsed. Figures come from the API; the screen only formats them.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedView } from '@business-os/contracts';
import { createReportingClient, type BusinessContext } from '../src';
import { resolveNavigation, ZONES } from '../src/shell/registry';
import { ReportingZone } from '../src/zones/reporting/reporting-zone';
import { createFakeReporting } from './support/fake-reporting';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OWNER = ['reporting:read', 'reporting:save', 'reporting:share', 'reporting:manage', 'finance:read', 'sales:read', 'customers:read'];
const MEMBER = ['reporting:read', 'reporting:save', 'sales:read', 'customers:read'];
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});

function setup(o: Parameters<typeof createFakeReporting>[0]) {
  const api = createFakeReporting(o);
  const client = createReportingClient('https://api.test', { kind: 'cookie' }, api.fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  render(<ReportingZone key="alpha" client={client} context={ctx(o.permissions)} userLabel="Ada" {...handlers} />);
  return { api, handlers, user: userEvent.setup() };
}
const kpis = () => screen.findByRole('region', { name: 'Headline figures' });
const queries = (api: ReturnType<typeof createFakeReporting>) => api.calls.filter((c) => c.path === '/query').map((c) => c.body as { metrics: { id: string }[]; date: unknown; granularity: string; comparison: string });

describe('Reporting in the shell', () => {
  it('is a built Zone opened by reporting:read only', () => {
    expect(ZONES.find((z) => z.id === 'reporting')).toMatchObject({ name: 'Reporting', availability: 'built', requires: ['reporting:read'] });
    expect(resolveNavigation({ state: 'ready', permissions: ['finance:read'] }).available.map((z) => z.id)).not.toContain('reporting');
    expect(resolveNavigation({ state: 'ready', permissions: ['reporting:read'] }).available.map((z) => z.id)).toEqual(['reporting']);
  });
});

describe('Reporting Zone', () => {
  it('shows trusted headline figures per currency with the change against the previous period', async () => {
    const { api } = setup({ permissions: OWNER });
    const region = await kpis();
    await within(region).findByText('$350.50');
    expect(within(region).getByText('USD 75.00')).toBeTruthy(); // never added to the AUD figure
    const invoiced = within(region).getByText('Amount invoiced').closest('section')!;
    // Two currencies: no single change figure (it would mix them).
    expect(within(invoiced).queryByText(/vs previous period/)).toBeNull();
    const won = within(region).getByText('Won opportunity value').closest('section')!;
    expect(within(won).getByText('-20.0% vs previous period')).toBeTruthy();
    expect(within(region).getByText(/As of/)).toBeTruthy(); // receivables are a current balance
    const kpiQuery = queries(api)[0]!;
    expect(kpiQuery.metrics.map((m) => m.id)).toEqual(['finance.invoiced_amount', 'finance.payments_received', 'finance.receivables_outstanding', 'sales.won_value', 'customers.new_customers']);
    expect(kpiQuery).toMatchObject({ granularity: 'none', comparison: 'previous_period', date: { kind: 'relative', preset: 'last_3_months' } });
  });

  it('draws the selected metric as an accessible chart with its data table, one currency at a time', async () => {
    const { user } = setup({ permissions: OWNER });
    const figure = await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    expect(within(figure).getByRole('img', { name: /Amount invoiced in AUD, month by month/ })).toBeTruthy();
    expect(within(figure).getByRole('list', { name: 'Legend' }).textContent).toMatch(/Previous period/);
    // The visible period table and the chart's hidden data table both carry every value.
    expect(screen.getAllByText('$350.50').length).toBeGreaterThan(1);
    await user.click(screen.getByRole('button', { name: 'USD' }));
    expect(await screen.findByRole('figure', { name: 'Amount invoiced (USD)' })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Show as'), 'line');
    expect(await screen.findByRole('figure', { name: 'Amount invoiced (USD)' })).toBeTruthy();
    expect(screen.getByText('Each currency is shown separately; amounts are never converted or added together.')).toBeTruthy();
  });

  it('applies the date range and interval to the API request (presets and custom dates)', async () => {
    const { api, user } = setup({ permissions: OWNER });
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    await user.selectOptions(screen.getByLabelText('Date range'), 'last_month');
    await waitFor(() => expect(queries(api).some((q) => JSON.stringify(q.date) === JSON.stringify({ kind: 'relative', preset: 'last_month' }))).toBe(true));
    await user.selectOptions(screen.getByLabelText('Interval'), 'week');
    await waitFor(() => expect(queries(api).some((q) => q.granularity === 'week')).toBe(true));
    await user.selectOptions(screen.getByLabelText('Date range'), 'custom');
    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-10-05');
    await waitFor(() => expect(queries(api).some((q) => (q.date as { from?: string }).from === '2026-10-05')).toBe(true));
  });

  it('lists the records behind the figure in the API's order', async () => {
    const { user } = setup({ permissions: OWNER });
    const table = await screen.findByRole('table', { name: /records behind amount invoiced/i });
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3
    expect(within(table).getByText('$300.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more records' })).toBeNull();
    void user;
  });

  it('saves the report privately by default, then reopens it through the saved-view endpoint with the same figures', async () => {
    const { api, user } = setup({ permissions: OWNER });
    await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' });
    await user.click(screen.getByRole('button', { name: 'Save report' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Who can see it') as HTMLSelectElement).value).toBe('PRIVATE');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Quarterly invoicing');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved “Quarterly invoicing”.');
    const created = api.calls.find((c) => c.method === 'POST' && c.path === '/views')!.body as { visibility: string; config: Record<string, unknown> };
    expect(created.visibility).toBe('PRIVATE');
    expect(created.config).toEqual({
      metrics: [{ id: 'finance.invoiced_amount', version: 1 }], date: { kind: 'relative', preset: 'last_3_months' }, granularity: 'month', groupBy: null, filters: {},
      comparison: 'previous_period', sort: { by: 'bucket', direction: 'asc' }, visualization: { chart: 'bar', showComparison: true },
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Quarterly invoicing' })).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && /\/views\/.+\/run$/.test(c.path))).toBe(true));
    // Close and reopen from the saved list: same configuration, same figure.
    await user.click(screen.getByRole('button', { name: 'Close report' }));
    await user.selectOptions(screen.getByLabelText('Saved reports'), api.views[0]!.id);
    expect(await screen.findByRole('heading', { level: 1, name: 'Quarterly invoicing' })).toBeTruthy();
    expect(await screen.findByRole('figure', { name: 'Amount invoiced (AUD)' })).toBeTruthy();
    // Changing a setting marks it unsaved; saving sends the new config with the version it was based on.
    await user.selectOptions(screen.getByLabelText('Interval'), 'week');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved “Quarterly invoicing”.');
    const patched = api.calls.find((c) => c.method === 'PATCH')!.body as { version: number; config: { granularity: string } };
    expect(patched).toMatchObject({ version: 1, config: { granularity: 'week' } });
  });

  it('offers sharing only to roles that may share', async () => {
    const { user } = setup({ permissions: MEMBER });
    await screen.findByRole('figure', { name: /Won opportunity value/ });
    await user.click(screen.getByRole('button', { name: 'Save report' }));
    const dialog = await screen.findByRole('dialog');
    const who = within(dialog).getByLabelText('Who can see it') as HTMLSelectElement;
    expect([...who.options].map((o) => o.value)).toEqual(['PRIVATE']);
  });

  it('shows only figures whose source the person may read', async () => {
    const { api } = setup({ permissions: MEMBER });
    const region = await kpis();
    await within(region).findByText('$1,200.00');
    expect(within(region).queryByText('Amount invoiced')).toBeNull();
    expect(queries(api).flatMap((q) => q.metrics.map((m) => m.id)).some((id) => id.startsWith('finance.'))).toBe(false);
    const chart = screen.getByLabelText('Chart') as HTMLSelectElement;
    expect([...chart.options].map((o) => o.textContent)).toEqual(['Won opportunity value', 'New customers']);
  });

  it('explains when no report is available to this role', async () => {
    setup({ permissions: ['reporting:read'] });
    expect(await screen.findByText('No reports are available to you')).toBeTruthy();
  });

  it('shows unauthorised and failed loads with a way forward', async () => {
    setup({ permissions: OWNER, catalogStatus: 403 });
    expect(await screen.findByText('You do not have access')).toBeTruthy();
    cleanup();
    setup({ permissions: OWNER, failQuery: true });
    expect((await screen.findAllByText('Something went wrong')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });

  it('shows an empty period as empty, not as zero money', async () => {
    setup({ permissions: OWNER, empty: ['finance.invoiced_amount'] });
    expect(await screen.findByText('No amount invoiced in this period')).toBeTruthy();
  });

  it('a shared view never grants access: a metric the viewer cannot read shows why, with no figures', async () => {
    const view: SavedView = {
      id: randomUUID(), title: 'Team finance', description: null, reportType: 'metrics', configVersion: 1, visibility: 'BUSINESS', ownerUserId: randomUUID(), isOwner: false,
      version: 3, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
      config: {
        metrics: [{ id: 'finance.invoiced_amount', version: 1 }], date: { kind: 'relative', preset: 'last_month' }, granularity: 'month', groupBy: null, filters: {},
        comparison: 'none', sort: { by: 'bucket', direction: 'asc' }, visualization: { chart: 'bar', showComparison: false },
      },
    };
    const { user } = setup({ permissions: MEMBER, views: [view] });
    await kpis();
    await user.selectOptions(await screen.findByLabelText('Saved reports'), view.id);
    expect(await screen.findByRole('heading', { level: 1, name: 'Team finance' })).toBeTruthy();
    expect(await screen.findByText('You do not have access to this figure')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename or share' })).toBeNull(); // not the owner
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull(); // no reporting:manage
  });
});
