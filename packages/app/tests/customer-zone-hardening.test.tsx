// @vitest-environment jsdom
// PR 14: Zone home counts, business switching across customers/contacts/activity, dialogs, safe
// rendering and the desktop (bearer) transport.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { CustomerZone } from '../src/zones/customers/customer-zone';
import { activity, contact, createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const USER = { id: uuid(), email: 'ada@example.com', name: 'Ada', emailVerified: true };
const ALL = ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write'];
const name = (slug: string) => `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`;
const context = (slug: string, permissions = ALL): BusinessContext => ({
  business: { slug, name: name(slug), countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

function mountApp(api: ReturnType<typeof createFakeApi>, opts: { slugs?: string[]; permissions?: string[] } = {}) {
  const slugs = opts.slugs ?? ['alpha'];
  const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: slugs.map((s) => ({ slug: s, name: name(s), role: 'MANAGER' as const })) })),
    businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: context(slug, opts.permissions) })),
    createBusiness: vi.fn(),
  };
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} storage={memoryStorage({ slug: slugs[0] })} />);
  return userEvent.setup();
}
const card = () => screen.findByRole('button', { name: 'Open the Customers Zone' });
const summaries = (api: ReturnType<typeof createFakeApi>) => api.callsTo(/GET .*customers\/summary$/);

describe('Zone home counts', () => {
  it('shows real active customer and contact counts, described on the card for screen readers', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer(), customer(), customer({ archivedAt: '2026-11-01T00:00:00.000Z' })], contacts: [contact(null), contact(null, { archivedAt: '2026-11-01T00:00:00.000Z' })] } });
    mountApp(api);
    expect(await screen.findByText(/2 active customers/)).toBeTruthy();
    expect(screen.getByText(/1 contact$/)).toBeTruthy();
    expect((await card()).getAttribute('aria-describedby')).toBe('customer-metrics');
    expect(document.getElementById('customer-metrics')!.textContent).toMatch(/2 active customers · 1 contact/);
    expect(summaries(api)).toHaveLength(1);
  });

  it('loading, empty and unavailable states are honest', async () => {
    const api = createFakeApi({ alpha: emptyBusiness() });
    const release = api.holdNext(/customers\/summary$/);
    mountApp(api);
    expect(await screen.findByText('Loading customer counts')).toBeTruthy();
    release();
    expect(await screen.findByText('No customers yet')).toBeTruthy();

    cleanup();
    const failing = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer()] } });
    failing.failNext(/customers\/summary$/, () => new Response('{"error":"internal_error"}', { status: 500 }));
    mountApp(failing);
    expect(await screen.findByText('Counts unavailable right now')).toBeTruthy();
    expect(screen.queryByText(/active customer/)).toBeNull(); // never a made-up number
  });

  it('refreshes after changes in the Zone, with one request per visit to the home page', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer({ displayName: 'Existing' })] } });
    const user = mountApp(api);
    await screen.findByText(/1 active customer/);
    await user.click(await card());
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await user.type(await screen.findByLabelText('Customer name'), 'Brand New');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    await screen.findByRole('heading', { name: 'Brand New', level: 1 });
    expect(summaries(api)).toHaveLength(1); // nothing fetched for the home while inside the Zone
    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    expect(await screen.findByText(/2 active customers/)).toBeTruthy();
    expect(summaries(api)).toHaveLength(2);
  });

  it('a role that cannot read customers sees no numbers and no request is made', async () => {
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [customer()] } });
    mountApp(api, { permissions: ['business:read'] });
    await card();
    expect(document.getElementById('customer-metrics')).toBeNull();
    expect(summaries(api)).toHaveLength(0);
  });
});

describe('switching business refreshes everything', () => {
  const two = (): Record<string, FakeBusiness> => {
    const a = customer({ displayName: 'Alpha Secret Co' });
    const b = customer({ displayName: 'Beta Co' });
    return {
      alpha: { ...emptyBusiness(), customers: [a], contacts: [contact(a.id, { displayName: 'Alpha Contact' })], activities: [activity(a.id, { subject: 'Alpha call', type: 'call' })] },
      beta: { ...emptyBusiness(), customers: [b, customer(), customer()], contacts: [contact(b.id, { displayName: 'Beta Contact' })] },
    };
  };

  it('counts, list, contacts and activity all come from the new business only', async () => {
    const api = createFakeApi(two());
    const user = mountApp(api, { slugs: ['alpha', 'beta'] });
    expect(await screen.findByText(/1 active customer/)).toBeTruthy();
    await user.click(await card());
    await user.click(await screen.findByRole('button', { name: 'Alpha Secret Co' }));
    expect(await screen.findByText('Alpha Contact')).toBeTruthy();
    expect(await screen.findByText('Alpha call')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Switch business/ }));
    api.calls.length = 0;
    await user.click(await screen.findByRole('button', { name: /Beta Plumbing/ }));
    expect(await screen.findByText(/3 active customers/)).toBeTruthy();
    await user.click(await card());
    await user.click(await screen.findByRole('button', { name: 'Beta Co' }));
    expect(await screen.findByText('Beta Contact')).toBeTruthy();
    for (const stale of ['Alpha Secret Co', 'Alpha Contact', 'Alpha call']) expect(screen.queryByText(stale)).toBeNull();
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['beta']));
  });
});

describe('dialogs: focus, Escape and the safe choice', () => {
  function mountZone(business: Partial<FakeBusiness> = {}) {
    const acme = customer({ displayName: 'Acme' });
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme], ...business } });
    render(<CustomerZone client={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} context={context('alpha')} userLabel="Ada"
      onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
    return { api, acme, user: userEvent.setup() };
  }

  it('customer archive: opens on the safe button, Escape closes it, and focus returns to Archive', async () => {
    const { user, acme } = mountZone();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    const archive = await screen.findByRole('button', { name: 'Archive' });
    await user.click(archive);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep active' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(archive);
    expect(acme.archivedAt).toBeNull();
  });

  it('contact archive: Escape keeps the contact and returns focus', async () => {
    const acme = customer({ displayName: 'Acme' });
    const zed = contact(acme.id, { displayName: 'Zed' });
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme], contacts: [zed] } });
    render(<CustomerZone client={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} context={context('alpha')} userLabel="Ada"
      onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    const archive = await screen.findByRole('button', { name: 'Archive: Zed' });
    await user.click(archive);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(archive);
    expect(zed.archivedAt).toBeNull();
  });

  it('unsaved changes: the modal keeps focus inside, Escape means Keep editing, and focus returns', async () => {
    const { user } = mountZone();
    await user.click((await screen.findAllByRole('button', { name: 'Add customer' }))[0]!);
    await user.type(await screen.findByLabelText('Customer name'), 'Draft');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancel);
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    const keep = within(dialog).getByRole('button', { name: 'Keep editing' });
    const discard = within(dialog).getByRole('button', { name: 'Discard changes' });
    expect(document.activeElement).toBe(keep);
    await user.tab();
    expect(document.activeElement).toBe(discard);
    await user.tab();
    expect(document.activeElement).toBe(keep); // wrapped, did not leave the dialog
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(discard);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((screen.getByLabelText('Customer name') as HTMLInputElement).value).toBe('Draft');
    expect(document.activeElement).toBe(cancel);
  });
});

describe('user-entered content is shown as text', () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  it('names, notes, contacts and activity render as text; unsafe websites are not links', async () => {
    const acme = customer({ displayName: evil, notes: evil, website: 'javascript:window.__pwned=1' });
    const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme], contacts: [contact(acme.id, { displayName: evil })], activities: [activity(acme.id, { subject: evil, body: evil })] } });
    render(<CustomerZone client={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} context={context('alpha')} userLabel="Ada"
      onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: evil }));
    await screen.findByRole('heading', { name: evil, level: 1 });
    await waitFor(() => expect(screen.getAllByText(evil).length).toBeGreaterThanOrEqual(5));
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.queryByRole('link', { name: /javascript/ })).toBeNull();
    expect([...document.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') ?? ''))).toBe(false);
  });

  it('no shared client code renders raw HTML', () => {
    const root = resolve(__dirname, '../src');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|ts)$/.test(e.name) ? [join(dir, e.name)] : []));
    for (const file of files(root)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  });
});

describe('desktop app transport', () => {
  it('Customer Zone requests carry the bearer token from the OS credential store and no cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ summary: { customers: { active: 1, archived: 0 }, contacts: { active: 0 } } }), { status: 200 }));
    const client = createCustomersClient('http://localhost:3000', { kind: 'bearer', getToken: async () => 'desktop-token' } as never, fetchMock as unknown as typeof fetch);
    expect((await client.summary('alpha')).kind).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/v1/b/alpha/customers/summary');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer desktop-token');
    expect(init.credentials).toBe('omit');
  });

  it('with an empty credential store nothing is sent and the result is "signed out"', async () => {
    const fetchMock = vi.fn();
    const client = createCustomersClient('http://localhost:3000', { kind: 'bearer', getToken: async () => null } as never, fetchMock as unknown as typeof fetch);
    expect((await client.createActivity('alpha', { type: 'note', customerId: uuid(), body: 'x' })).kind).toBe('unauthenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
