// @vitest-environment jsdom
// WP-C1: the customer page shows the customer's sales opportunities, and authors can edit or remove
// their own timeline entries.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createSalesClient } from '../src';
import { CustomerZone } from '../src/zones/customers/customer-zone';
import { activity, createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';
import { emptySales, opportunity, pipelineWithStages, withSales, type FakeSales } from './support/fake-sales';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const ME = uuid();
const OTHER = uuid();
const ALL = ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write', 'sales:read'];

function mount(opts: { failSalesOnce?: boolean; business?: Partial<FakeBusiness>; sales?: FakeSales; withSalesLink?: boolean; permissions?: string[]; archived?: boolean } = {}) {
  const acme = customer({ displayName: 'Acme', archivedAt: opts.archived ? '2026-11-14T03:00:00.000Z' : null });
  const base = createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme], ...opts.business } });
  const api = withSales(base, { alpha: opts.sales ?? emptySales() });
  const customersClient = createCustomersClient(BASE, { kind: 'cookie' }, api.fetch);
  let failed = !opts.failSalesOnce;
  const salesFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!failed && /opportunities/.test(String(input))) {
      failed = true;
      return new Response('{"error":"internal_error"}', { status: 500 });
    }
    return api.fetch(input, init);
  }) as typeof fetch;
  const salesClient = createSalesClient(BASE, { kind: 'cookie' }, salesFetch);
  const onOpenOpportunity = vi.fn();
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  const user = userEvent.setup();
  render(
    <CustomerZone
      client={customersClient} userLabel="Ada" userId={ME} {...handlers}
      sales={opts.withSalesLink === false ? undefined : { client: salesClient, onOpen: onOpenOpportunity, onViewAll: vi.fn() }}
      context={{
        business: { slug: 'alpha', name: 'Alpha', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
        membership: { id: uuid(), role: 'MANAGER', permissions: opts.permissions ?? ALL },
      }}
    />,
  );
  return { api, user, acme, onOpenOpportunity, handlers };
}
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Acme' }));
  await screen.findByRole('heading', { name: 'Acme', level: 1 });
};
const panel = () => screen.getByRole('region', { name: 'Opportunities' });

describe('customer opportunities panel', () => {
  it('lists this customer\'s deals only, open first with the open total, and opens one in Sales', async () => {
    const p = pipelineWithStages();
    const acme = customer({ displayName: 'Acme' });
    const sales: FakeSales = { ...emptySales(), pipelines: [p], opportunities: [
      opportunity(p, { title: 'Website rebuild', customerId: acme.id, amount: '1000.00', status: 'OPEN', expectedCloseDate: '2026-12-01' }),
      opportunity(p, { title: 'Support retainer', customerId: acme.id, amount: '500.50', status: 'OPEN' }),
      opportunity(p, { title: 'Old job', customerId: acme.id, amount: '9999.00', status: 'WON' }),
      opportunity(p, { title: 'Someone else deal', customerId: uuid(), amount: '7.00' }),
    ] };
    const { api, user, onOpenOpportunity } = (() => {
      const m = mount({ sales, business: { customers: [acme] } });
      return m;
    })();
    await open(user);
    const region = await screen.findByRole('region', { name: 'Opportunities' });
    expect(await within(region).findByText('Website rebuild')).toBeTruthy();
    expect(within(region).queryByText('Someone else deal')).toBeNull();
    const titles = within(region).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(titles[0]).toMatch(/Website rebuild|Support retainer/);
    expect(titles[titles.length - 1]).toMatch(/Old job/);
    expect(region.textContent).toMatch(/2 open/);
    expect(region.textContent).toMatch(/1,500\.50/);
    expect(api.callsTo(/GET .*opportunities$/)[0]!.query.customerId).toBe(acme.id);
    await user.click(within(region).getByRole('button', { name: /Website rebuild/ }));
    expect(onOpenOpportunity).toHaveBeenCalledWith(expect.any(String));
  });

  it('says so when the customer has no deals', async () => {
    const { user } = mount();
    await open(user);
    expect(await screen.findByText('No opportunities for this customer.')).toBeTruthy();
  });

  it('shows a retryable error without breaking the rest of the page', async () => {
    const { user } = mount({ failSalesOnce: true });
    await open(user);
    expect(await within(panel()).findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Details' })).toBeTruthy();
    await user.click(within(panel()).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No opportunities for this customer.')).toBeTruthy();
  });

  it('is not shown, and never requested, without sales access', async () => {
    const { api, user } = mount({ withSalesLink: false });
    await open(user);
    expect(screen.queryByRole('region', { name: 'Opportunities' })).toBeNull();
    expect(api.callsTo(/opportunities/).length).toBe(0);
  });
});

describe('customer opportunities beyond one page', () => {
  it('counts every page, so the totals are the customer\'s, and offers an Open Sales hand-off', async () => {
    const p = pipelineWithStages();
    const acme = customer({ displayName: 'Acme' });
    const opportunities = Array.from({ length: 120 }, (_, i) => opportunity(p, { title: `Deal ${i}`, customerId: acme.id, amount: '10.00', status: 'OPEN', updatedAt: new Date(Date.UTC(2026, 10, 14, 3, 0, i)).toISOString() }));
    const { api, user } = mount({ sales: { ...emptySales(), pipelines: [p], opportunities }, business: { customers: [acme] } });
    await open(user);
    const region = await screen.findByRole('region', { name: 'Opportunities' });
    await within(region).findByText(/120 open/);
    expect(region.textContent).toMatch(/1,200\.00/);
    expect(region.textContent).not.toMatch(/Of the first/);
    expect(api.callsTo(/GET .*opportunities$/).length).toBe(3);
    expect(within(region).getByRole('button', { name: 'Open Sales' })).toBeTruthy();
    expect(region.textContent).toMatch(/Showing 10 of 120/);
  });
});

describe('customer opportunities over the page cap', () => {
  it('labels the headline as partial instead of claiming complete totals', async () => {
    const p = pipelineWithStages();
    const acme = customer({ displayName: 'Acme' });
    const opportunities = Array.from({ length: 520 }, (_, i) => opportunity(p, { title: `Deal ${i}`, customerId: acme.id, amount: '1.00', status: 'OPEN' }));
    const { api, user } = mount({ sales: { ...emptySales(), pipelines: [p], opportunities }, business: { customers: [acme] } });
    await open(user);
    const region = await screen.findByRole('region', { name: 'Opportunities' });
    await within(region).findByText(/Of the first 500 deals: 500 open/);
    expect(api.callsTo(/GET .*opportunities$/).length).toBe(10);
    expect(region.textContent).toMatch(/Showing 10 of 500\+/);
  });
});

describe('editing and removing timeline entries', () => {
  const setup = (over: Parameters<typeof mount>[0] = {}) => {
    const acme = customer({ displayName: 'Acme', archivedAt: over.archived ? '2026-11-14T03:00:00.000Z' : null });
    const mine = activity(acme.id, { type: 'note', body: 'My first note', actorUserId: ME });
    const theirs = activity(acme.id, { type: 'note', body: 'A colleague note', actorUserId: OTHER });
    const system = activity(acme.id, { type: 'customer.updated', data: { fields: ['email'] }, actorType: 'SYSTEM', actorUserId: null });
    const call = activity(acme.id, { type: 'call', subject: 'Chased quote', actorUserId: ME });
    return { mine, theirs, system, call, ...mount({ ...over, business: { customers: [acme], activities: [mine, theirs, system, call] } }) };
  };
  const entry = (text: string) => screen.getByText(text).closest('li')!;

  it('offers edit and remove on the author\'s own entries only', async () => {
    const { user } = setup();
    await open(user);
    await screen.findByText('My first note');
    expect(within(entry('My first note')).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(entry('My first note')).getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(within(entry('A colleague note')).queryByRole('button')).toBeNull();
    const callItem = screen.getByText('Chased quote').closest('li')!;
    expect(within(callItem).queryByRole('button', { name: 'Edit' })).toBeNull(); // only notes are editable
    expect(within(callItem).getByRole('button', { name: 'Remove' })).toBeTruthy();
    const systemItem = document.querySelector('li[data-kind="system"]')!;
    expect(within(systemItem as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('edits a note, sends only what changed and shows the edited text from the server', async () => {
    const { api, user, mine } = setup();
    await open(user);
    await screen.findByText('My first note');
    await user.click(within(entry('My first note')).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit note' });
    const box = within(form).getByLabelText('Note');
    await user.clear(box);
    await user.type(box, 'Rewritten note');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Rewritten note')).toBeTruthy();
    const patch = api.callsTo(/PATCH .*activities\//)[0]!;
    expect(patch.path.endsWith(`/activities/${mine.id}`)).toBe(true);
    expect(patch.body).toEqual({ body: 'Rewritten note' });
    expect(screen.queryByRole('form', { name: 'Edit note' })).toBeNull();
    expect(await screen.findByText(/· edited/)).toBeTruthy();
  });

  it('does not call the server when nothing changed, and refuses an empty note', async () => {
    const { api, user } = setup();
    await open(user);
    await screen.findByText('My first note');
    await user.click(within(entry('My first note')).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(api.callsTo(/PATCH/).length).toBe(0);
    await user.click(within(entry('My first note')).getByRole('button', { name: 'Edit' }));
    await user.clear(within(screen.getByRole('form', { name: 'Edit note' })).getByLabelText('Note'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Add a subject or some text/);
    expect(api.callsTo(/PATCH/).length).toBe(0);
  });

  it('keeps the edit open with the text on a refusal, and says the outcome is unknown when offline', async () => {
    const { api, user } = setup();
    await open(user);
    await screen.findByText('My first note');
    await user.click(within(entry('My first note')).getByRole('button', { name: 'Edit' }));
    const note = () => within(screen.getByRole('form', { name: 'Edit note' })).getByLabelText('Note') as HTMLTextAreaElement;
    await user.type(note(), ' more');
    api.next(() => new Response('{"error":"forbidden"}', { status: 403 }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Only the person who wrote this entry/);
    expect(note().value).toBe('My first note more');
    api.next(() => 'network');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/may or may not have been saved/));
    expect(note().value).toBe('My first note more');
  });

  it('removes an entry only after confirming, and Keep it changes nothing', async () => {
    const { api, user, mine } = setup();
    await open(user);
    await screen.findByText('My first note');
    await user.click(within(entry('My first note')).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(api.callsTo(/remove$/).length).toBe(0);
    expect(screen.getByText('My first note')).toBeTruthy();
    await user.click(within(entry('My first note')).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Remove entry' }));
    await waitFor(() => expect(screen.queryByText('My first note')).toBeNull());
    expect(api.callsTo(/POST .*activities\/.*\/remove$/)[0]!.path).toContain(mine.id);
    expect(screen.getByText('A colleague note')).toBeTruthy();
  });

  it('keeps the entry and explains when a removal is refused', async () => {
    const { api, user } = setup();
    await open(user);
    await screen.findByText('My first note');
    await user.click(within(entry('My first note')).getByRole('button', { name: 'Remove' }));
    api.next(() => new Response('{"error":"conflict"}', { status: 409 }));
    await user.click(screen.getByRole('button', { name: 'Remove entry' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/archived, or this entry cannot be changed/);
    expect(screen.getByText('My first note')).toBeTruthy();
  });

  it('offers no controls on an archived customer, or without activity:write', async () => {
    const archived = setup({ archived: true });
    await archived.user.click(await screen.findByRole('button', { name: 'Archived' }));
    await archived.user.click(await screen.findByRole('button', { name: 'Acme' }));
    await screen.findByText('My first note');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    cleanup();
    const readOnly = setup({ permissions: ['business:read', 'customers:read', 'activity:read', 'sales:read'] });
    await open(readOnly.user);
    await screen.findByText('My first note');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
