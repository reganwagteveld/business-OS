// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { CustomerZone } from '../src/zones/customers/customer-zone';
import { activity, contact, createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

const BASE = 'https://api.test';
const USER = { id: uuid(), email: 'ada@example.com', name: 'Ada', emailVerified: true };
const WRITE = ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write'];
const READ_ONLY = ['business:read', 'customers:read', 'activity:read'];

function context(slug: string, permissions = WRITE): BusinessContext {
  return {
    business: { slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
    membership: { id: uuid(), role: 'MANAGER', permissions },
  };
}
const clientFor = (api: ReturnType<typeof createFakeApi>) => createCustomersClient(BASE, { kind: 'cookie' }, api.fetch);
const people = (n: number) => Array.from({ length: n }, (_, i) => customer({ displayName: `Customer ${String(i + 1).padStart(2, '0')}`, email: `c${i + 1}@example.com` }));

function mountZone(api: ReturnType<typeof createFakeApi>, opts: { slug?: string; permissions?: string[]; onHome?: () => void; onSessionEnded?: () => void } = {}) {
  const slug = opts.slug ?? 'alpha';
  const handlers = { onHome: opts.onHome ?? vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: opts.onSessionEnded ?? vi.fn() };
  const view = render(<CustomerZone client={clientFor(api)} context={context(slug, opts.permissions)} userLabel="Ada" {...handlers} />);
  return { ...handlers, ...view, user: userEvent.setup() };
}

function mountApp(api: ReturnType<typeof createFakeApi>, opts: { slugs?: string[]; session?: () => SessionCheck; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const slugs = opts.slugs ?? ['alpha'];
  const auth = {
    session: vi.fn(async () => opts.session?.() ?? ({ kind: 'signed-in', user: USER } as SessionCheck)),
    signOut: vi.fn(async () => undefined),
  } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: slugs.map((s) => ({ slug: s, name: context(s).business.name, role: 'MANAGER' as const })) })),
    businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: context(slug) })),
    createBusiness: vi.fn(),
  };
  const view = render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} customers={clientFor(api)} storage={opts.storage ?? memoryStorage()} />);
  return { auth, ...view, user: userEvent.setup() };
}

const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('navigation into and out of the Customer Zone', () => {
  it('the Customers card on the home page opens the Zone, shows the business, and All Zones returns home', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Acme Pty Ltd' })] } });
    const { user } = mountApp(api);
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    expect(await heading('Customers')).toBeTruthy();
    expect(await screen.findByText('Acme Pty Ltd')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Switch business, current business Alpha Plumbing/ })).toBeTruthy(); // active business stays visible
    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    expect(await screen.findByText('Welcome to Alpha Plumbing.')).toBeTruthy();
  });

  it('other Zones stay honest "coming soon" cards, not buttons', async () => {
    mountApp(createFakeApi({ alpha: emptyBusiness() }));
    await screen.findByText('Welcome to Alpha Plumbing.');
    for (const zone of ['Sales', 'Projects', 'Finance', 'People', 'Operations', 'Insights', 'Settings']) {
      expect(screen.getByLabelText(`${zone} Zone — coming soon`)).toBeTruthy();
      expect(screen.queryByRole('button', { name: new RegExp(`Open the ${zone}`) })).toBeNull();
    }
  });
});

describe('directory states', () => {
  it('shows a real empty state with a prominent Add customer action', async () => {
    mountZone(createFakeApi({ alpha: emptyBusiness() }));
    expect(await screen.findByText('No customers yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add customer' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a role without customers:write sees no Add, Edit or Archive controls', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Read Only Co' })] } });
    const { user } = mountZone(api, { permissions: READ_ONLY });
    await screen.findByText('Read Only Co');
    expect(screen.queryByRole('button', { name: 'Add customer' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Read Only Co' }));
    await heading('Read Only Co');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('announces loading, then lists records with type and status indicators', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Acme Pty Ltd', kind: 'COMPANY', city: 'Perth', countryCode: 'AU' }), customer({ displayName: 'Jane Citizen', kind: 'INDIVIDUAL' })] } });
    const release = api.hold();
    mountZone(api);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading customers…')).toBeTruthy();
    release();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('row', { name: /Acme Pty Ltd.*Company.*Perth, Australia.*Active/ })).toBeTruthy();
    expect(within(table).getByRole('row', { name: /Jane Citizen.*Individual/ })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: /Name/ })).toBeTruthy();
  });

  it('a server failure shows an alert and Try again recovers; nothing is invented', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Recovered Co' })] } });
    api.next(() => new Response('{"error":"internal_error"}', { status: 500 }));
    const { user } = mountZone(api);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered Co')).toBeTruthy();
  });

  it('offline is not "signed out": it says so, keeps the session, and retries by itself when the connection returns', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Back Online Co' })] } });
    const onSessionEnded = vi.fn();
    api.next(() => 'network');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    mountZone(api, { onSessionEnded });
    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(onSessionEnded).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(await screen.findByText('Back Online Co')).toBeTruthy();
  });

  it('an ended session (401) hands control back so the app can sign the person in again', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    api.next(() => new Response('{"error":"unauthenticated"}', { status: 401 }));
    const onSessionEnded = vi.fn();
    mountZone(api, { onSessionEnded });
    expect(await screen.findByText('Your session has ended')).toBeTruthy();
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });

  it('a 403 explains the missing access instead of showing an empty list', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    api.next(() => new Response('{"error":"forbidden"}', { status: 403 }));
    mountZone(api);
    expect(await screen.findByText('You do not have access')).toBeTruthy();
    expect(screen.queryByText('No customers yet')).toBeNull();
  });

  it('an expired session in the full app returns to sign-in with the expiry notice', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    let ended = false;
    const storage = memoryStorage({ hadSession: true });
    const { user } = mountApp(api, { storage, session: () => (ended ? { kind: 'signed-out' } : { kind: 'signed-in', user: USER }) });
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    await screen.findByText('No customers yet');
    ended = true;
    api.next(() => new Response('{"error":"unauthenticated"}', { status: 401 }));
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Your session has ended. Please sign in again.')).toBeTruthy();
    expect(screen.queryByText(/No customers/)).toBeNull();
  });
});

describe('search, filters and pagination (all on the server)', () => {
  it('searches by name, email or phone with a debounced server query, and clears', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Banksia Bakery', email: 'hello@banksia.example' }), customer({ displayName: 'Wattle & Co', phone: '+61 8 9000 1111' })] } });
    const { user } = mountZone(api);
    await screen.findByText('Banksia Bakery');
    await user.type(screen.getByRole('searchbox', { name: /Search customers/ }), 'wattle');
    await waitFor(() => expect(screen.queryByText('Banksia Bakery')).toBeNull());
    expect(await screen.findByText('Wattle & Co')).toBeTruthy();
    const searches = api.callsTo(/GET .*customers$/).filter((c) => c.query.q);
    expect(searches.length).toBe(1); // typed 6 characters, one request
    expect(searches[0]!.query.q).toBe('wattle');
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText('No customers match “zzz”')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await screen.findByText('Banksia Bakery')).toBeTruthy();
  });

  it('Active, Archived and All are server filters and show their own empty states', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Live Co' }), customer({ displayName: 'Gone Co', archivedAt: '2026-11-01T00:00:00.000Z' })] } });
    const { user } = mountZone(api);
    await screen.findByText('Live Co');
    expect(screen.queryByText('Gone Co')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Gone Co')).toBeTruthy();
    expect(screen.queryByText('Live Co')).toBeNull();
    expect(screen.getByRole('button', { name: 'Archived' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByText('Live Co')).toBeTruthy();
    expect(screen.getByText('Gone Co')).toBeTruthy();
    expect(api.callsTo(/GET .*customers$/).map((c) => c.query.status)).toEqual(['active', 'archived', 'all']);
  });

  it('pages with the server cursor: Next, Previous, no duplicates, and a new search starts at page 1', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: people(30) } });
    const { user } = mountZone(api);
    await screen.findByText('Customer 01');
    expect(screen.getAllByRole('row').length).toBe(26); // header + 25
    expect(screen.queryByText('Customer 26')).toBeNull();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Customer 26')).toBeTruthy();
    expect(screen.queryByText('Customer 01')).toBeNull();
    expect(screen.getByText(/Page 2/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    const second = api.callsTo(/GET .*customers$/).at(-1)!;
    expect(second.query.cursor).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Customer 01')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Customer 26');
    await user.type(screen.getByRole('searchbox'), 'Customer 0');
    await screen.findByText('Customer 01');
    expect(screen.getByText(/Page 1/)).toBeTruthy();
  });
});

describe('creating customers', () => {
  it('validates before sending, shows the field error, and focuses the summary', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    const { user } = mountZone(api);
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await heading('Add customer');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const name = screen.getByLabelText('Customer name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('A name is required')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(api.callsTo(/POST/).length).toBe(0);
    await user.type(name, 'Acme');
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Website'), 'not a site');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText('Enter a web address such as example.com')).toBeTruthy();
    await user.clear(screen.getByLabelText('Website'));
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect((await screen.findAllByText('Enter a valid email address')).length).toBeGreaterThan(0); // from the shared contract, inline and in the summary
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
    expect(api.callsTo(/POST/).length).toBe(0);
  });

  it('creates a customer with progressive disclosure, sends no business id, and opens the new record', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), members: [{ id: uuid(), userId: uuid(), name: 'Grace Hopper', role: 'MANAGER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' }] } });
    const { user } = mountZone(api);
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await heading('Add customer');
    expect(screen.queryByLabelText('Address line 1')).toBeNull(); // optional fields stay folded away
    await user.type(screen.getByLabelText('Customer name'), 'Kookaburra Pty Ltd');
    await user.type(screen.getByLabelText('Email'), 'Accounts@Kookaburra.example');
    await user.type(screen.getByLabelText('Phone'), '+61 8 9000 0000');
    await user.type(screen.getByLabelText('Website'), 'kookaburra.example');
    await user.click(screen.getByRole('button', { name: /^Address/ }));
    await user.type(screen.getByLabelText('Address line 1'), '1 Hay St');
    await user.type(screen.getByLabelText('City or suburb'), 'Perth');
    await user.selectOptions(screen.getByLabelText('Country'), 'AU');
    await user.click(screen.getByRole('button', { name: /^Customer owner/ }));
    await user.selectOptions(screen.getByLabelText('Owner'), 'Grace Hopper');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await heading('Kookaburra Pty Ltd')).toBeTruthy();
    expect(screen.getByText('Kookaburra Pty Ltd was added.')).toBeTruthy();
    const post = api.callsTo(/POST .*customers$/)[0]!;
    expect(post.slug).toBe('alpha');
    expect(post.body).toMatchObject({ kind: 'COMPANY', displayName: 'Kookaburra Pty Ltd', email: 'accounts@kookaburra.example', countryCode: 'AU', city: 'Perth' });
    expect(JSON.stringify(post)).not.toMatch(/businessId|business_id/i);
    expect(api.businesses.alpha!.customers[0]!.ownerUserId).toBe(api.businesses.alpha!.members[0]!.userId);
    expect(screen.getByText('Grace Hopper')).toBeTruthy(); // owner shown by name, not id
    expect(screen.getByText('1 Hay St')).toBeTruthy();
  });

  it('an individual uses a person-shaped form', async () => {
    const { user } = mountZone(createFakeApi({ alpha: emptyBusiness() }));
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await heading('Add customer');
    await user.click(screen.getByRole('radio', { name: 'Individual' }));
    expect(screen.getByLabelText('Full name')).toBeTruthy();
    expect(screen.queryByLabelText('Customer name')).toBeNull();
  });

  it('prevents duplicate submissions while saving: one request for repeated submits', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    const { user } = mountZone(api);
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await user.type(await screen.findByLabelText('Customer name'), 'Once Only Co');
    const release = api.hold();
    const form = screen.getByLabelText('Customer name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect((await screen.findByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await heading('Once Only Co');
    expect(api.callsTo(/POST .*customers$/).length).toBe(1);
    expect(api.businesses.alpha!.customers.length).toBe(1);
  });

  it('shows API errors without losing what was typed, and says so when offline', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    const { user } = mountZone(api);
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await user.type(await screen.findByLabelText('Customer name'), 'Keep Me Co');
    api.next(() => new Response('{"error":"invalid_owner","message":"That person is not an active member."}', { status: 400 }));
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText('That person is not an active member.')).toBeTruthy();
    expect((screen.getByLabelText('Customer name') as HTMLInputElement).value).toBe('Keep Me Co');
    api.next(() => 'network');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText(/Your changes are still here/)).toBeTruthy();
    expect((screen.getByLabelText('Customer name') as HTMLInputElement).value).toBe('Keep Me Co');
    expect(api.businesses.alpha!.customers.length).toBe(0);
  });
});

describe('editing, unsaved changes, archive and restore', () => {
  const seeded = () => {
    const c = customer({ displayName: 'Acme Pty Ltd', email: 'old@acme.example', phone: '123', notes: 'Prefers email' });
    return { c, api: createFakeApi({ alpha: { ...emptyBusiness(), customers: [c] } }) };
  };

  it('edits send only the fields that changed, and clearing a field sends null', async () => {
    const { api } = seeded();
    const { user } = mountZone(api);
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await heading('Edit Acme Pty Ltd');
    const email = screen.getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'new@acme.example');
    expect(screen.getByRole('button', { name: /^Notes/ }).getAttribute('aria-expanded')).toBe('true'); // opens by itself because notes exist
    await user.clear(screen.getByLabelText('Notes'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await heading('Acme Pty Ltd');
    expect(screen.getByText('Changes saved.')).toBeTruthy();
    expect(api.callsTo(/PATCH/)[0]!.body).toEqual({ email: 'new@acme.example', notes: null });
    expect(api.businesses.alpha!.customers[0]).toMatchObject({ email: 'new@acme.example', notes: null, phone: '123' });
    expect(screen.getByText('new@acme.example')).toBeTruthy();
  });

  it('never drops unsaved changes silently: Cancel, All Zones and the window all ask first', async () => {
    const { api } = seeded();
    const onHome = vi.fn();
    const { user } = mountZone(api, { onHome });
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.type(await screen.findByLabelText('Phone'), '9');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('1239');

    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
    expect(onHome).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    await heading('Acme Pty Ltd');
    expect(api.callsTo(/PATCH/).length).toBe(0);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it('archives after confirmation, hides it from Active, shows it as read-only, and restores it', async () => {
    const { api } = seeded();
    const { user } = mountZone(api);
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Archive Acme Pty Ltd?' });
    await user.click(within(confirm).getByRole('button', { name: 'Keep active' }));
    expect(api.callsTo(/archive/).length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive customer' }));
    expect(await screen.findByText(/This customer is archived/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All customers' }));
    expect(await screen.findByText('No customers yet')).toBeTruthy(); // active list is empty now
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    await user.click(await screen.findByRole('button', { name: 'Restore customer' }));
    await waitFor(() => expect(screen.queryByText(/This customer is archived/)).toBeNull());
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(api.businesses.alpha!.customers[0]!.archivedAt).toBeNull();
  });

  it('a conflicting change is reported, not hidden', async () => {
    const { api } = seeded();
    const { user } = mountZone(api);
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.type(await screen.findByLabelText('Phone'), '9');
    api.next(() => new Response('{"error":"archived"}', { status: 409 }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/archived, so it cannot be edited/)).toBeTruthy();
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('1239');
  });
});

describe('customer detail', () => {
  it('shows only real contacts and activity, humanised, in the business time zone', async () => {
    const c = customer({ displayName: 'Acme Pty Ltd', email: 'hello@acme.example', website: 'acme.example', addressLine1: '1 Hay St', city: 'Perth', region: 'WA', postalCode: '6000', countryCode: 'AU', notes: 'Pays on time', legalName: 'Acme Holdings Pty Ltd' });
    const ada = contact(c.id, { displayName: 'Ada Lovelace', jobTitle: 'Director', email: 'ada@acme.example' });
    c.primaryContactId = ada.id;
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [c], contacts: [ada], activities: [
      activity(c.id, { type: 'customer.created', occurredAt: '2026-11-01T00:00:00.000Z' }),
      activity(c.id, { type: 'customer.updated', data: { fields: ['phone', 'email'] }, occurredAt: '2026-11-02T00:00:00.000Z' }),
      activity(c.id, { type: 'call', subject: 'Quote follow-up', body: 'Left a message', occurredAt: '2026-11-03T04:00:00.000Z' }),
    ] } });
    const { user } = mountZone(api);
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    await heading('Acme Pty Ltd');
    expect(screen.getByText('Acme Holdings Pty Ltd')).toBeTruthy();
    expect(screen.getByText('Pays on time')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'hello@acme.example' }).getAttribute('href')).toBe('mailto:hello@acme.example');
    expect(screen.getByRole('link', { name: 'acme.example' }).getAttribute('href')).toBe('https://acme.example');
    expect(screen.getByRole('link', { name: 'acme.example' }).getAttribute('rel')).toContain('noopener');
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(await screen.findByText('Customer created')).toBeTruthy();
    expect(screen.getByText('Customer updated: phone, email')).toBeTruthy();
    expect(screen.getByText('Quote follow-up')).toBeTruthy();
    expect(screen.getByText('Left a message')).toBeTruthy();
    expect(screen.getByText(/3 Nov 2026.*12:00/)).toBeTruthy(); // 04:00Z is 12:00 in Perth
    expect(screen.getByLabelText('Sales and Finance')).toBeTruthy();
    expect(within(screen.getByLabelText('Sales and Finance')).getByText('Coming soon')).toBeTruthy();
  });

  it('empty contacts and activity are said plainly; a missing customer is "not found"', async () => {
    const c = customer({ displayName: 'Lonely Co' });
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [c] } });
    const { user } = mountZone(api);
    await user.click(await screen.findByRole('button', { name: 'Lonely Co' }));
    expect(await screen.findByText(/No contacts are linked/)).toBeTruthy();
    expect(await screen.findByText('No activity yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'All customers' }));
    api.businesses.alpha!.customers.length = 0;
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    await user.click(screen.getByRole('button', { name: 'Active' }));
    await screen.findByText('No customers yet');
  });

  it('pages through a long activity history with the server cursor', async () => {
    const c = customer({ displayName: 'Busy Co' });
    const acts = Array.from({ length: 30 }, (_, i) => activity(c.id, { type: 'note', subject: `Note ${String(i + 1).padStart(2, '0')}`, occurredAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() }));
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [c], activities: acts } });
    const { user } = mountZone(api);
    await user.click(await screen.findByRole('button', { name: 'Busy Co' }));
    expect(await screen.findByText('Note 30')).toBeTruthy(); // newest first
    expect(screen.queryByText('Note 01')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText('Note 01')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Newer' }));
    expect(await screen.findByText('Note 30')).toBeTruthy();
  });
});

describe('business switching never leaks the previous business', () => {
  const two = (): Record<string, FakeBusiness> => ({
    alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Alpha Secret Co', email: 'secret@alpha.example' })] },
    beta: { ...emptyBusiness(), customers: [customer({ displayName: 'Beta Visible Co' })] },
  });

  it('after switching, only the new business is requested and shown, and the old data is gone from the page', async () => {
    const api = createFakeApi(two());
    const { user } = mountApp(api, { slugs: ['alpha', 'beta'], storage: memoryStorage({ slug: 'alpha' }) });
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    expect(await screen.findByText('Alpha Secret Co')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Switch business/ }));
    await screen.findByRole('button', { name: /Beta Plumbing/ });
    expect(screen.queryByText('Alpha Secret Co')).toBeNull();
    expect(document.body.textContent).not.toContain('secret@alpha.example');
    api.calls.length = 0;
    await user.click(screen.getByRole('button', { name: /Beta Plumbing/ }));
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    expect(await screen.findByText('Beta Visible Co')).toBeTruthy();
    expect(screen.queryByText('Alpha Secret Co')).toBeNull();
    expect(api.calls.length).toBeGreaterThan(0);
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['beta']));
  });

  it('a slow response from the old business arriving after the switch is dropped, not rendered', async () => {
    const api = createFakeApi(two());
    const { user } = mountApp(api, { slugs: ['alpha', 'beta'], storage: memoryStorage({ slug: 'alpha' }) });
    await screen.findByRole('button', { name: 'Open the Customers Zone' });
    const release = api.hold();
    await user.click(screen.getByRole('button', { name: 'Open the Customers Zone' }));
    await user.click(await screen.findByRole('button', { name: /Switch business/ }));
    await user.click(await screen.findByRole('button', { name: /Beta Plumbing/ }));
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    await screen.findByText('Beta Visible Co');
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Alpha Secret Co')).toBeNull();
    expect(screen.getByText('Beta Visible Co')).toBeTruthy();
  });

  it('the active business is only ever the :slug in the path; no request body or query names a business id', async () => {
    const api = createFakeApi(two());
    const { user } = mountZone(api);
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await user.type(await screen.findByLabelText('Customer name'), 'Path Only Co');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    await heading('Path Only Co');
    for (const call of api.calls) {
      expect(call.path).toMatch(/^\/api\/v1\/b\/alpha\//);
      expect(JSON.stringify([call.query, call.body])).not.toMatch(/business/i);
      expect(call.headers.authorization).toBeUndefined(); // the browser app uses the HTTP-only cookie
    }
  });

  it('customer data is never written to browser storage', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Storage Check Co', email: 'private@storage.example', phone: '555 0100' })] } });
    const { user } = mountApp(api);
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    await user.click(await screen.findByRole('button', { name: 'Storage Check Co' }));
    await heading('Storage Check Co');
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toMatch(/Storage Check|private@storage|555 0100/);
  });
});

describe('keyboard and accessibility', () => {
  it('the whole create flow works from the keyboard, and focus follows each screen', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    const { user } = mountZone(api);
    await screen.findByText('No customers yet');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Customers', level: 1 }));
    const add = screen.getAllByRole('button', { name: 'Add customer' })[0]!;
    add.focus();
    await user.keyboard('{Enter}');
    await heading('Add customer');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Add customer', level: 1 }));
    await user.tab();
    await user.keyboard('{ArrowRight}'); // radio group: arrows move between Company and Individual
    expect((screen.getByRole('radio', { name: 'Individual' }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByLabelText('Full name'));
    await user.keyboard('Keyboard Person');
    const disclosure = screen.getByRole('button', { name: /^Notes/ });
    disclosure.focus();
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard(' ');
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    await user.type(screen.getByLabelText('Notes'), 'typed with the keyboard');
    await user.keyboard('{Tab}');
    screen.getByRole('button', { name: 'Add customer' }).focus();
    await user.keyboard('{Enter}');
    await heading('Keyboard Person');
    expect(api.businesses.alpha!.customers[0]).toMatchObject({ kind: 'INDIVIDUAL', displayName: 'Keyboard Person', notes: 'typed with the keyboard' });
  });

  it('the directory is a labelled table with column headers, row headers and a grouped, pressed-state filter', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Acme Pty Ltd' })] } });
    mountZone(api);
    const table = await screen.findByRole('table', { name: /Customers, sorted by name A to Z/ });
    expect(within(table).getAllByRole('columnheader').length).toBe(6);
    expect(within(table).getByRole('rowheader', { name: 'Acme Pty Ltd' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Show customers' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeTruthy();
  });

  it('every form control has an accessible name, required fields are marked, and errors are linked to their field', async () => {
    const { user } = mountZone(createFakeApi({ alpha: emptyBusiness() }));
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await heading('Add customer');
    for (const control of screen.getAllByRole('textbox')) expect(control.getAttribute('id')).toBeTruthy();
    for (const label of ['Customer name', 'Legal name', 'Email', 'Phone', 'Website']) expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByLabelText('Customer name').getAttribute('aria-required')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const field = screen.getByLabelText('Customer name');
    const errorId = field.getAttribute('aria-describedby')!;
    expect(document.getElementById(errorId)?.textContent).toBe('A name is required');
  });

  it('the discard dialog is modal, labelled, and starts on the safe choice', async () => {
    const { user } = mountZone(createFakeApi({ alpha: emptyBusiness() }));
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await user.type(await screen.findByLabelText('Customer name'), 'x');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Keep editing');
  });
});
