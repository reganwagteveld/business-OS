// @vitest-environment jsdom
// GS2-A (GS1 §10.6): a shell route target opens one opportunity's detail in the Sales Zone.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createSalesClient, type BusinessContext } from '../src';
import { SalesZone } from '../src/zones/sales/sales-zone';
import { createFakeApi, emptyBusiness, uuid } from './support/fake-api';
import { emptySales, opportunity, pipelineWithStages, withSales, type FakeSales } from './support/fake-sales';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const ALL = ['business:read', 'members:read', 'customers:read', 'customers:write', 'sales:read', 'sales:write'];
const READ_ONLY = ['business:read', 'members:read', 'customers:read', 'sales:read'];
const ctx = (slug: string, permissions = ALL): BusinessContext => ({
  business: { slug, name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

function setup(opts: { sales: Record<string, FakeSales>; initialOpportunityId?: string; initialAction?: 'new'; permissions?: string[] }) {
  const businesses = Object.fromEntries(Object.keys(opts.sales).map((slug) => [slug, emptyBusiness()]));
  const api = withSales(createFakeApi(businesses), opts.sales);
  render(
    <SalesZone
      sales={createSalesClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
      context={ctx('alpha', opts.permissions)} userLabel="Ada" initialOpportunityId={opts.initialOpportunityId} initialAction={opts.initialAction}
      onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()}
    />,
  );
  return { api, user: userEvent.setup() };
}

describe('opening an opportunity from a route target', () => {
  it('opens the detail directly, and Back returns to the list', async () => {
    const p = pipelineWithStages();
    const target = opportunity(p, { title: 'Office fit-out' });
    const other = opportunity(p, { title: 'Warehouse roof' });
    const { api, user } = setup({ sales: { alpha: { ...emptySales(), pipelines: [p], opportunities: [target, other] } }, initialOpportunityId: target.id });
    expect(await screen.findByRole('heading', { name: 'Office fit-out', level: 1 })).toBeTruthy();
    expect(screen.queryByText('Warehouse roof')).toBeNull();
    expect(api.callsTo(new RegExp(`^GET .*/opportunities/${target.id}$`)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /All opportunities/ }));
    expect(await screen.findByText('Warehouse roof')).toBeTruthy();
    expect(screen.getByText('Office fit-out')).toBeTruthy();
  });

  it('a read-only member can open it too, without mutation controls', async () => {
    const p = pipelineWithStages();
    const target = opportunity(p, { title: 'Read only deal' });
    setup({ sales: { alpha: { ...emptySales(), pipelines: [p], opportunities: [target] } }, initialOpportunityId: target.id, permissions: READ_ONLY });
    expect(await screen.findByRole('heading', { name: 'Read only deal', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('an id from another business is loaded only in this business and shows the not-found state', async () => {
    const pa = pipelineWithStages();
    const pb = pipelineWithStages();
    const foreign = opportunity(pb, { title: 'Beta secret deal' });
    const { api } = setup({
      sales: { alpha: { ...emptySales(), pipelines: [pa] }, beta: { ...emptySales(), pipelines: [pb], opportunities: [foreign] } },
      initialOpportunityId: foreign.id,
    });
    expect(await screen.findByText('This opportunity could not be found in this business. It may have been removed.')).toBeTruthy();
    expect(screen.queryByText('Beta secret deal')).toBeNull();
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['alpha']));
  });

  it('a target wins over the add intent: no form opens', async () => {
    const p = pipelineWithStages();
    const target = opportunity(p, { title: 'Targeted deal' });
    setup({ sales: { alpha: { ...emptySales(), pipelines: [p], opportunities: [target] } }, initialOpportunityId: target.id, initialAction: 'new' });
    expect(await screen.findByRole('heading', { name: 'Targeted deal', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Add opportunity' })).toBeNull();
  });
});
