// @vitest-environment jsdom
// PR 16: the Sales Zone interface against a stand-in for the PR 15 API (real clients and contracts).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, createSalesClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { SalesZone } from '../src/zones/sales/sales-zone';
import { contact, createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';
import { emptySales, opportunity, pipelineWithStages, withSales, type FakeSales } from './support/fake-sales';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const ALL = ['business:read', 'members:read', 'customers:read', 'customers:write', 'sales:read', 'sales:write'];
const READ_ONLY = ['business:read', 'members:read', 'customers:read', 'sales:read'];
const ADA = uuid();
const ctx = (slug: string, permissions = ALL): BusinessContext => ({
  business: { slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

function setup(opts: { business?: Partial<FakeBusiness>; sales?: Partial<FakeSales>; permissions?: string[] } = {}) {
  const biz: FakeBusiness = { ...emptyBusiness(), members: [{ id: uuid(), userId: ADA, name: 'Ada Lovelace', role: 'OWNER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' }], ...opts.business };
  const api = withSales(createFakeApi({ alpha: biz }), { alpha: { ...emptySales(), ...opts.sales } });
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  render(<SalesZone sales={createSalesClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
    context={ctx('alpha', opts.permissions)} userLabel="Ada" {...handlers} />);
  return { api, biz, handlers, user: userEvent.setup() };
}
const salesCalls = (api: ReturnType<typeof setup>['api'], re: RegExp) => api.callsTo(re).filter((c) => c.path.includes('/sales/'));

describe('setting up Sales', () => {
  it('viewing never creates a pipeline; "Set up Sales" does it explicitly, once', async () => {
    const { api, user } = setup();
    expect(await screen.findByText("Sales isn't set up yet")).toBeTruthy();
    expect(salesCalls(api, /^POST/)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Set up Sales' }));
    expect(await screen.findByText('No open opportunities yet')).toBeTruthy();
    expect(salesCalls(api, /^POST .*pipelines\/default$/)).toHaveLength(1);
    expect(api.sales.alpha!.pipelines).toHaveLength(1);
  });

  it('"Add opportunity" before set-up sets up first (an explicit action), then opens the form', async () => {
    const { api, user } = setup();
    await screen.findByText("Sales isn't set up yet");
    await user.click(screen.getByRole('button', { name: 'Add opportunity' }));
    expect(await screen.findByRole('heading', { name: 'Add opportunity', level: 1 })).toBeTruthy();
    expect(salesCalls(api, /^POST .*pipelines\/default$/)).toHaveLength(1);
    expect((screen.getByLabelText('Stage') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('New');
  });

  it('someone who can only read sees an explanation, and no set-up or add buttons', async () => {
    setup({ permissions: READ_ONLY });
    expect(await screen.findByText(/needs to set it up first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up Sales' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add opportunity' })).toBeNull();
  });
});

describe('opportunities list', () => {
  const seeded = () => {
    const p = pipelineWithStages();
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const ana = contact(acme.id, { displayName: 'Ana Ruiz' });
    const rows = [
      opportunity(p, { title: 'Office fit-out', customerId: acme.id, contactId: ana.id, stageId: p.stages[2]!.id, amount: '1250.50', ownerUserId: ADA, expectedCloseDate: '2026-12-31', createdAt: '2026-11-10T00:00:00.000Z' }),
      opportunity(p, { title: 'Tokyo branch', amount: '150000', currencyCode: 'JPY', createdAt: '2026-11-09T00:00:00.000Z' }),
      opportunity(p, { title: 'Lost one', status: 'LOST', closedAt: '2026-11-05T00:00:00.000Z', createdAt: '2026-11-08T00:00:00.000Z' }),
      opportunity(p, { title: 'Archived one', archivedAt: '2026-11-05T00:00:00.000Z', createdAt: '2026-11-07T00:00:00.000Z' }),
    ];
    return { p, acme, ana, rows };
  };

  it('shows real records: customer, contact, stage, exact money in its own currency, owner, close date and status', async () => {
    const { p, acme, ana, rows } = seeded();
    setup({ business: { customers: [acme], contacts: [ana] }, sales: { pipelines: [p], opportunities: rows } });
    const table = await screen.findByRole('table', { name: /Opportunities/ });
    const fitout = await within(table).findByRole('row', { name: /Office fit-out/ });
    await waitFor(() => expect(fitout.textContent).toContain('Acme Pty Ltd'));
    await waitFor(() => expect(fitout.textContent).toContain('Ana Ruiz'));
    for (const text of ['Ana Ruiz', 'Proposal', '$1,250.50', 'Ada Lovelace', '31 Dec 2026', 'Open']) expect(fitout.textContent).toContain(text);
    expect(within(table).getByRole('row', { name: /Tokyo branch/ }).textContent).toMatch(/(¥|JPY)\s?150,000(?!\.)/); // no decimals for yen
    expect(within(table).queryByText('Lost one')).toBeNull(); // Open is the default filter
    expect(within(table).queryByText('Archived one')).toBeNull();
  });

  it('filters on the server by status, stage, archived state and title search', async () => {
    const { p, rows } = seeded();
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: rows } });
    await screen.findByText('Office fit-out');
    await user.click(screen.getByRole('button', { name: 'Lost' }));
    expect(await screen.findByText('Lost one')).toBeTruthy();
    expect(screen.queryByText('Office fit-out')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.selectOptions(screen.getByLabelText('Records'), 'archived');
    expect(await screen.findByText('Archived one')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Records'), 'active');
    await user.selectOptions(screen.getByLabelText('Stage'), 'Proposal');
    await waitFor(() => expect(screen.queryByText('Tokyo branch')).toBeNull());
    expect(screen.getByText('Office fit-out')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Stage'), '');
    await user.type(screen.getByRole('searchbox', { name: /Search opportunities/ }), 'tokyo');
    await waitFor(() => expect(screen.queryByText('Office fit-out')).toBeNull());
    expect(await screen.findByText('Tokyo branch')).toBeTruthy();
    const queries = salesCalls(api, /^GET .*opportunities$/).map((c) => c.query);
    expect(queries.some((q) => q.status === 'lost')).toBe(true);
    expect(queries.some((q) => q.archived === 'archived')).toBe(true);
    expect(queries.some((q) => q.stageId === p.stages[2]!.id)).toBe(true);
    expect(queries.some((q) => q.q === 'tokyo')).toBe(true);
  });

  it('pages with the server cursor and starts again at page 1 when filters change', async () => {
    const p = pipelineWithStages();
    const many = Array.from({ length: 30 }, (_, i) => opportunity(p, { title: `Deal ${String(i).padStart(2, '0')}`, createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() }));
    const { user } = setup({ sales: { pipelines: [p], opportunities: many } });
    expect(await screen.findByText('Deal 29')).toBeTruthy();
    expect(screen.queryByText('Deal 04')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Deal 04')).toBeTruthy();
    expect(screen.getByText(/Page 2/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Deal 29')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Deal 04');
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByText(/Page 1/)).toBeTruthy();
  });

  it('a failed load shows an error with Try again; an ended session hands back to the app', async () => {
    const p = pipelineWithStages();
    const { api, user, handlers } = setup({ sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Recovered' })] } });
    await screen.findByText('Recovered');
    api.salesNext((path) => (path.endsWith('/opportunities') ? new Response('{"error":"internal_error"}', { status: 500 }) : undefined));
    await user.click(screen.getByRole('button', { name: 'All' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Something went wrong')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered')).toBeTruthy();
    api.salesNext(() => new Response('{"error":"unauthenticated"}', { status: 401 }));
    await user.click(screen.getByRole('button', { name: 'Won' }));
    await waitFor(() => expect(handlers.onSessionEnded).toHaveBeenCalled());
  });
});

describe('creating an opportunity', () => {
  it('validates before sending; amounts are decimal strings; the business currency is the default', async () => {
    const p = pipelineWithStages();
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const other = customer({ displayName: 'Other Co' });
    const ana = contact(acme.id, { displayName: 'Ana Ruiz' });
    const bob = contact(other.id, { displayName: 'Bob Other' });
    const { api, user } = setup({ business: { customers: [acme, other], contacts: [ana, bob] }, sales: { pipelines: [p] } });
    await user.click(await screen.findByRole('button', { name: 'Add opportunity' }));
    await screen.findByRole('heading', { name: 'Add opportunity', level: 1 });
    expect((screen.getByLabelText('Currency') as HTMLSelectElement).value).toBe('AUD');
    await user.click(screen.getByRole('button', { name: 'Add opportunity' }));
    expect(screen.getByText('A title is required')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    await user.type(screen.getByLabelText('Title'), 'Office fit-out');
    await user.type(screen.getByLabelText('Amount'), '1,250.50');
    await user.type(screen.getByLabelText('Probability (%)'), '150');
    await user.click(screen.getByRole('button', { name: 'Add opportunity' }));
    expect(screen.getByLabelText('Amount').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Probability (%)').getAttribute('aria-invalid')).toBe('true');
    expect(salesCalls(api, /^POST .*opportunities$/)).toHaveLength(0);

    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '1250.5');
    await user.clear(screen.getByLabelText('Probability (%)'));
    await user.type(screen.getByLabelText('Probability (%)'), '60');
    // Customer from the Customers Zone, and only that customer's contacts.
    expect((screen.getByLabelText('Contact') as HTMLSelectElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Customer'), 'acme');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd/ }));
    await waitFor(() => expect((screen.getByLabelText('Contact') as HTMLSelectElement).disabled).toBe(false));
    const options = [...(screen.getByLabelText('Contact') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['No contact', 'Ana Ruiz']);
    await user.selectOptions(screen.getByLabelText('Contact'), 'Ana Ruiz');
    await user.selectOptions(screen.getByLabelText('Stage'), 'Qualified');
    await user.selectOptions(screen.getByLabelText('Owner'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Expected close date'), '2027-01-31');
    await user.click(screen.getByRole('button', { name: 'Add opportunity' }));
    expect(await screen.findByRole('heading', { name: 'Office fit-out', level: 1 })).toBeTruthy();
    expect(screen.getByText('Office fit-out was added.')).toBeTruthy();
    const body = salesCalls(api, /^POST .*opportunities$/)[0]!.body as Record<string, unknown>;
    expect(body).toEqual({
      title: 'Office fit-out', customerId: acme.id, contactId: ana.id, pipelineId: p.pipeline.id, stageId: p.stages[1]!.id,
      amount: '1250.5', currencyCode: 'AUD', probability: 60, expectedCloseDate: '2027-01-31', ownerUserId: ADA,
    });
    expect(typeof body.amount).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/business/i);
    expect(screen.getByText('Acme Pty Ltd')).toBeTruthy();
    expect(screen.getAllByText('$1,250.50').length).toBeGreaterThan(0);
  });

  it('server rules come back as clear messages and nothing is lost', async () => {
    const p = pipelineWithStages();
    const { api, user } = setup({ sales: { pipelines: [p] } });
    await user.click(await screen.findByRole('button', { name: 'Add opportunity' }));
    await user.type(await screen.findByLabelText('Title'), 'Yen deal');
    await user.selectOptions(screen.getByLabelText('Currency'), 'JPY');
    await user.type(screen.getByLabelText('Amount'), '1000.5');
    await user.click(screen.getByRole('button', { name: 'Add opportunity' }));
    expect(await screen.findByText('JPY amounts have at most 0 decimal places.')).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Yen deal');
    api.salesNext(() => 'network');
    await user.clear(screen.getByLabelText('Amount'));
    await user.click(screen.getByRole('button', { name: 'Add opportunity' }));
    expect(await screen.findByText(/may or may not have been added/)).toBeTruthy();
  });
});

describe('editing and concurrent changes', () => {
  it('sends only the changed fields with the version; a stale save keeps the person’s edits and asks them to review', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Shared deal', amount: '100.00', probability: 20 });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await user.click(await screen.findByRole('button', { name: 'Shared deal' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('heading', { name: 'Edit Shared deal', level: 1 });
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '150');
    // Meanwhile someone else changes the probability (version 1 → 2).
    Object.assign(api.sales.alpha!.opportunities[0]!, { probability: 80, version: 2 });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Someone else changed this opportunity/);
    expect(alert.textContent).toMatch(/They changed: probability/);
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('150'); // their work is kept
    expect((screen.getByLabelText('Probability (%)') as HTMLInputElement).value).toBe('80'); // the other person's change is shown
    expect(salesCalls(api, /^PATCH/)[0]!.body).toEqual({ amount: '150', version: 1 });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeTruthy();
    expect(salesCalls(api, /^PATCH/)[1]!.body).toEqual({ amount: '150', version: 2 }); // never a stale copy of the probability
    expect(api.sales.alpha!.opportunities[0]).toMatchObject({ amount: '150.00', probability: 80, version: 3 });
  });

  it('moves stage from the detail page with the version; a stale move explains and reloads', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Mover' });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await user.click(await screen.findByRole('button', { name: 'Mover' }));
    const panel = await screen.findByLabelText('Move to another stage');
    await user.selectOptions(within(panel).getByLabelText('Stage'), 'Proposal');
    await user.click(within(panel).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Moved to Proposal.')).toBeTruthy();
    expect(salesCalls(api, /^PATCH/)[0]!.body).toEqual({ version: 1, stageId: p.stages[2]!.id });
    api.sales.alpha!.opportunities[0]!.version = 9;
    await user.selectOptions(within(screen.getByLabelText('Move to another stage')).getByLabelText('Stage'), 'Negotiation');
    await user.click(within(screen.getByLabelText('Move to another stage')).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText(/Someone else changed this opportunity a moment ago/)).toBeTruthy();
    expect(api.sales.alpha!.opportunities[0]!.stageId).toBe(p.stages[2]!.id);
  });

  it('leaving an edited form asks first', async () => {
    const p = pipelineWithStages();
    const { handlers, user } = setup({ sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Draft' })] } });
    await user.click(await screen.findByRole('button', { name: 'Draft' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.type(await screen.findByLabelText('Title'), ' changed');
    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Keep editing' }));
    expect(handlers.onHome).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Draft changed');
  });
});

describe('win, lose, reopen, archive, restore and history', () => {
  it('uses the lifecycle endpoints with confirmations, and the history keeps the loss reason through reopening', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Lifecycle', amount: '500.00' });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await user.click(await screen.findByRole('button', { name: 'Lifecycle' }));
    await user.click(await screen.findByRole('button', { name: 'Mark lost' }));
    const lose = screen.getByRole('alertdialog', { name: 'Mark “Lifecycle” as lost?' });
    expect(document.activeElement).toBe(within(lose).getByLabelText('Reason (optional)'));
    await user.type(within(lose).getByLabelText('Reason (optional)'), 'Chose a cheaper supplier');
    await user.click(within(lose).getByRole('button', { name: 'Mark lost' }));
    expect(await screen.findByText('Marked as lost.')).toBeTruthy();
    expect(salesCalls(api, /^POST .*\/lose$/)[0]!.body).toEqual({ lossReason: 'Chose a cheaper supplier' });
    const history = screen.getByLabelText('Outcome history');
    expect(await within(history).findByText('“Chose a cheaper supplier”')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    const reopen = screen.getByRole('alertdialog', { name: 'Reopen “Lifecycle”?' });
    await user.selectOptions(within(reopen).getByLabelText('Reopen in stage'), 'Proposal');
    await user.click(within(reopen).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('Opportunity reopened.')).toBeTruthy();
    expect(salesCalls(api, /^POST .*\/reopen$/)[0]!.body).toEqual({ stageId: p.stages[2]!.id });
    await waitFor(() => expect(within(screen.getByLabelText('Outcome history')).getByText(/reopened/)).toBeTruthy());
    expect(within(screen.getByLabelText('Outcome history')).getByText('“Chose a cheaper supplier”')).toBeTruthy(); // still there

    await user.click(screen.getByRole('button', { name: 'Mark won' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Mark won' }));
    expect(await screen.findByText('Marked as won.')).toBeTruthy();
    expect(salesCalls(api, /^PATCH/)).toHaveLength(0); // status never changes through PATCH

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/This opportunity is archived/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Opportunity restored.')).toBeTruthy();
    expect(api.sales.alpha!.opportunities[0]).toMatchObject({ status: 'WON', archivedAt: null });
  });

  it('a closed-elsewhere conflict is explained and the latest version is shown', async () => {
    const p = pipelineWithStages();
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Race' })] } });
    await user.click(await screen.findByRole('button', { name: 'Race' }));
    await user.click(await screen.findByRole('button', { name: 'Mark won' }));
    Object.assign(api.sales.alpha!.opportunities[0]!, { status: 'LOST', closedAt: '2026-11-14T05:00:00.000Z', version: 2 });
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Mark won' }));
    expect(await screen.findByText(/already won or lost/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy());
  });

  it('dialogs: Escape closes, focus returns to the button; a typed loss reason is protected', async () => {
    const p = pipelineWithStages();
    const { handlers, user } = setup({ sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Keys' })] } });
    await user.click(await screen.findByRole('button', { name: 'Keys' }));
    const archive = await screen.findByRole('button', { name: 'Archive' });
    await user.click(archive);
    expect(document.activeElement).toBe(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(archive);
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Half typed');
    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
    expect(handlers.onHome).not.toHaveBeenCalled();
  });
});

describe('development mode', () => {
  it('customer and contact names still resolve under React StrictMode (effects mounted twice)', async () => {
    const p = pipelineWithStages();
    const acme = customer({ displayName: 'Strict Co' });
    const k = contact(acme.id, { displayName: 'Strict Contact' });
    const api = withSales(createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme], contacts: [k] } }), { alpha: { ...emptySales(), pipelines: [p], opportunities: [opportunity(p, { title: 'Strict deal', customerId: acme.id, contactId: k.id })] } });
    render(
      <StrictMode>
        <SalesZone sales={createSalesClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
          context={ctx('alpha')} userLabel="Ada" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByText('Strict Co')).toBeTruthy();
    expect(await screen.findByText('Strict Contact')).toBeTruthy();
  });
});

describe('permissions', () => {
  it('a read-only role sees everything but no mutation controls', async () => {
    const p = pipelineWithStages();
    setup({ permissions: READ_ONLY, sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Look only', status: 'LOST', closedAt: '2026-11-01T00:00:00.000Z' })] } });
    await screen.findByText(/No open opportunities/);
    expect(screen.queryByRole('button', { name: 'Add opportunity' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'All' }));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Look only' }));
    await screen.findByRole('heading', { name: 'Look only', level: 1 });
    for (const name of ['Edit', 'Mark won', 'Mark lost', 'Reopen', 'Archive', 'Restore']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByLabelText('Move to another stage')).toBeNull();
    expect(screen.getByLabelText('Outcome history')).toBeTruthy();
  });
});

describe('Zone navigation, business switching and desktop transport', () => {
  function mountApp(businesses: Record<string, FakeBusiness>, sales: Record<string, FakeSales>, slugs: string[]) {
    const api = withSales(createFakeApi(businesses), sales);
    const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: { id: ADA, email: 'ada@example.com', name: 'Ada', emailVerified: true } }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
    const tenancy: TenancyClient = {
      listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: slugs.map((s) => ({ slug: s, name: ctx(s).business.name, role: 'MANAGER' as const })) })),
      businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug) })),
      createBusiness: vi.fn(),
    };
    render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
      sales={createSalesClient(BASE, { kind: 'cookie' }, api.fetch)} storage={memoryStorage({ slug: slugs[0] })} />);
    return { api, user: userEvent.setup() };
  }

  it('the Sales card opens the Zone; switching business shows only the new business’s opportunities', async () => {
    const pa = pipelineWithStages();
    const pb = pipelineWithStages();
    const { api, user } = mountApp(
      { alpha: emptyBusiness(), beta: emptyBusiness() },
      { alpha: { ...emptySales(), pipelines: [pa], opportunities: [opportunity(pa, { title: 'Alpha secret deal' })] }, beta: { ...emptySales(), pipelines: [pb], opportunities: [opportunity(pb, { title: 'Beta deal' })] } },
      ['alpha', 'beta'],
    );
    await user.click(await screen.findByRole('button', { name: 'Open the Sales Zone' }));
    expect(await screen.findByText('Alpha secret deal')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Switch business/ }));
    expect(screen.queryByText('Alpha secret deal')).toBeNull();
    api.calls.length = 0;
    await user.click(await screen.findByRole('button', { name: /Beta Plumbing/ }));
    await user.click(await screen.findByRole('button', { name: 'Open the Sales Zone' }));
    expect(await screen.findByText('Beta deal')).toBeTruthy();
    expect(screen.queryByText('Alpha secret deal')).toBeNull();
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['beta']));
    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    expect(await screen.findByText('Welcome to Beta Plumbing.')).toBeTruthy();
  });

  it('keyboard: Add opportunity opens the form and focus lands on its heading', async () => {
    const p = pipelineWithStages();
    setup({ sales: { pipelines: [p] } });
    const add = await screen.findByRole('button', { name: 'Add opportunity' });
    add.focus();
    await userEvent.setup().keyboard('{Enter}');
    const heading = await screen.findByRole('heading', { name: 'Add opportunity', level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('desktop: Sales requests carry the bearer token from the OS credential store and no cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ pipelines: [] }), { status: 200 }));
    const client = createSalesClient('http://localhost:3000', { kind: 'bearer', getToken: async () => 'desktop-token' } as never, fetchMock as unknown as typeof fetch);
    expect((await client.pipelines('alpha')).kind).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/v1/b/alpha/sales/pipelines');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer desktop-token');
    expect(init.credentials).toBe('omit');
    // A float amount never leaves the client.
    expect((await client.create('alpha', { title: 'x', amount: 12.5 })).kind).toBe('invalid_input');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
