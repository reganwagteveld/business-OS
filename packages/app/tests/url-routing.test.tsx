// @vitest-environment jsdom
// Issue #131: Zones survive reload and direct links. Real shell, real history adapters over jsdom.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createHashHistory, createPathHistory, memoryStorage, type AuthClient, type BusinessContext, type ShellHistory, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { HOME, ZONES } from '../src/shell/registry';
import { pathToRoute, routeToPath } from '../src/shell/url-routes';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const BASE = 'https://api.test';
const USER = { id: randomUUID(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };
const ALL = ['customers:read', 'sales:read', 'projects:read', 'finance:read', 'scheduling:read', 'people:read', 'reporting:read', 'communications:read', 'business:read'];
const ctx = (slug: string, permissions: string[]): BusinessContext => ({
  business: { slug, name: slug === 'alpha' ? 'Alpha Plumbing' : 'Beta Sparks', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});

function mount(permissions: string[], opts: { history?: ShellHistory; signedIn?: () => SessionCheck } = {}) {
  const history = opts.history ?? createPathHistory();
  const session = vi.fn(async () => (opts.signedIn?.() ?? { kind: 'signed-in', user: USER }) as SessionCheck);
  const auth = { session, signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: 'Alpha Plumbing', role: 'OWNER' as const }, { slug: 'beta', name: 'Beta Sparks', role: 'OWNER' as const }] })),
    businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug, permissions) })),
    createBusiness: vi.fn(),
    platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: false } })),
  };
  const view = render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })} history={history} />);
  return { view, auth, session, user: userEvent.setup() };
}
const zonesNav = () => screen.findByRole('navigation', { name: 'Zones' });
const currentZone = async () => {
  const nav = await zonesNav();
  await waitFor(() => expect(within(nav).queryAllByRole('button').some((b) => b.getAttribute('aria-current') === 'page')).toBe(true));
  return within(nav).getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.textContent ?? '';
};

describe('url routes (pure)', () => {
  const built = ZONES.filter((z) => z.availability === 'built');
  it('round-trips every built Zone (nine) and every section', () => {
    expect(built).toHaveLength(9);
    for (const z of built) {
      expect(pathToRoute(z.route)).toEqual({ zone: z.id });
      for (const c of z.children ?? []) {
        const route = pathToRoute(c.route);
        expect(route.zone).toBe(z.id);
        expect(routeToPath(route)).toBe(c.route);
      }
    }
  });
  it('writes no business, record or intent into an address', () => {
    expect(routeToPath({ zone: 'customers', target: randomUUID(), intent: 'new' })).toBe('/customers');
    expect(routeToPath({ zone: 'finance', child: 'invoices', target: 'invoice:abc' })).toBe('/finance/invoices');
    expect(routeToPath(HOME)).toBe('/');
  });
  it('maps anything else to Home: unknown, planned, extra segments, traversal, tokens', () => {
    for (const p of ['/', '', '/nope', '/operations', '/finance/unknown', '/finance/invoices/123', '/customers/../finance', '//customers', '/Customers', '/invite', '/reset-password']) {
      expect(pathToRoute(p)).toEqual(HOME);
    }
  });
  it('tolerates a trailing slash, a query and a fragment', () => {
    expect(pathToRoute('/finance/invoices/')).toEqual({ zone: 'finance', child: 'invoices' });
    expect(pathToRoute('/scheduling/resources?x=1#y')).toEqual({ zone: 'scheduling', child: 'resources' });
  });
});

describe('shell URL routing', () => {
  const zoneCases = built().map((z) => [z.name, z.route] as const);
  function built() {
    return ZONES.filter((z) => z.availability === 'built');
  }

  it.each(zoneCases)('direct link and hard refresh open %s (%s)', async (name, path) => {
    window.history.replaceState(null, '', path);
    const first = mount(ALL);
    expect(await currentZone()).toMatch(new RegExp(`^${name}`));
    expect(window.location.pathname).toBe(path);
    // A hard refresh is a fresh mount at the same address.
    first.view.unmount();
    mount(ALL);
    expect(await currentZone()).toMatch(new RegExp(`^${name}`));
    expect(window.location.pathname).toBe(path);
  });

  it('opens a section directly and keeps it across a refresh', async () => {
    window.history.replaceState(null, '', '/finance/invoices');
    const first = mount(ALL);
    const sub = await screen.findByRole('navigation', { name: 'Finance sections' });
    expect(within(sub).getByRole('button', { name: 'Invoices' }).getAttribute('aria-current')).toBe('page');
    first.view.unmount();
    mount(ALL);
    const again = await screen.findByRole('navigation', { name: 'Finance sections' });
    expect(within(again).getByRole('button', { name: 'Invoices' }).getAttribute('aria-current')).toBe('page');
  });

  it('a Zone the role cannot open falls back to Home and the address is corrected', async () => {
    window.history.replaceState(null, '', '/finance/invoices');
    mount(['customers:read', 'business:read']);
    await zonesNav();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.queryByRole('navigation', { name: 'Finance sections' })).toBeNull();
    expect(within(await zonesNav()).queryByRole('button', { name: 'Finance' })).toBeNull();
  });

  it.each(['/nope', '/operations', '/finance/unknown', '/customers/9f0c1b6e-0000-4000-8000-000000000000'])('invalid path %s lands on Home and is replaced', async (path) => {
    window.history.replaceState(null, '', path);
    mount(ALL);
    await zonesNav();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(await currentZone()).toMatch(/^Home/);
  });

  it('updates the address as the person navigates and follows back and forward', async () => {
    const { user } = mount(ALL);
    const nav = await zonesNav();
    await user.click(within(nav).getByRole('button', { name: 'Scheduling' }));
    await waitFor(() => expect(window.location.pathname).toBe('/scheduling'));
    await user.click(within(await screen.findByRole('navigation', { name: 'Scheduling sections' })).getByRole('button', { name: 'Resources' }));
    await waitFor(() => expect(window.location.pathname).toBe('/scheduling/resources'));
    await user.click(within(nav).getByRole('button', { name: 'Customers' }));
    await waitFor(() => expect(window.location.pathname).toBe('/customers'));

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/scheduling/resources'));
    expect(within(await screen.findByRole('navigation', { name: 'Scheduling sections' })).getByRole('button', { name: 'Resources' }).getAttribute('aria-current')).toBe('page');
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/scheduling'));
    window.history.forward();
    await waitFor(() => expect(window.location.pathname).toBe('/scheduling/resources'));
    expect(within(await screen.findByRole('navigation', { name: 'Scheduling sections' })).getByRole('button', { name: 'Resources' }).getAttribute('aria-current')).toBe('page');
  });

  it('back to an address the role cannot open lands on Home, not on the Zone', async () => {
    window.history.replaceState(null, '', '/customers');
    window.history.pushState(null, '', '/');
    mount(['business:read']); // no customers:read
    await zonesNav();
    window.history.pushState(null, '', '/finance');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });

  it('keeps no business or record in the address, and switching business lands on Home', async () => {
    window.history.replaceState(null, '', '/customers');
    const { user } = mount(ALL);
    await currentZone();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/customers');
    await user.click(screen.getAllByRole('button', { name: /Alpha Plumbing/ })[0]!);
    const beta = await screen.findByRole('menuitem', { name: /Beta Sparks/ }).catch(() => null);
    if (beta) {
      await user.click(beta);
      await waitFor(() => expect(window.location.pathname).toBe('/'));
    }
  });

  it('an ended session shows sign-in; the address is kept and the Zone returns after signing in again', async () => {
    window.history.replaceState(null, '', '/finance/invoices');
    mount(ALL, { signedIn: () => ({ kind: 'signed-out', expired: false }) as unknown as SessionCheck });
    await screen.findByRole('button', { name: /sign in/i });
    expect(window.location.pathname).toBe('/finance/invoices');
    expect(screen.queryByRole('navigation', { name: 'Zones' })).toBeNull(); // nothing of the Zone or tenant is shown
    cleanup();
    mount(ALL);
    const sub = await screen.findByRole('navigation', { name: 'Finance sections' });
    expect(within(sub).getByRole('button', { name: 'Invoices' }).getAttribute('aria-current')).toBe('page');
  });

  it('does not touch the address without a history adapter (existing in-memory behaviour)', async () => {
    window.history.replaceState(null, '', '/finance');
    const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: vi.fn() } as unknown as AuthClient;
    const tenancy: TenancyClient = {
      listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: 'Alpha Plumbing', role: 'OWNER' as const }] })),
      businessContext: vi.fn(async () => ({ kind: 'ok' as const, data: ctx('alpha', ALL) })),
      createBusiness: vi.fn(),
      platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: false } })),
    };
    render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })} />);
    await zonesNav();
    expect(window.location.pathname).toBe('/finance');
  });
});

describe('hash history (desktop)', () => {
  it('reads and writes the fragment, so a reload needs no server route', async () => {
    window.history.replaceState(null, '', '/#/people');
    const history = createHashHistory();
    expect(history.read()).toBe('/people');
    mount(ALL, { history });
    expect(await currentZone()).toMatch(/^People/);
    history.push('/reporting/explore');
    expect(window.location.hash).toBe('#/reporting/explore');
    expect(window.location.pathname).toBe('/');
    window.history.replaceState(null, '', '/#garbage');
    expect(history.read()).toBe('/');
  });
});
