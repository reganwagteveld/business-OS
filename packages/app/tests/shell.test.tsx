// @vitest-environment jsdom
// UI Phase 2: the application shell (registry, navigation, business switching, responsive drawer, theme).
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, createProjectsClient, createSalesClient, memoryStorage, type AuthClient, type BusinessContext, type Outcome, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { AppShell } from '../src/shell/app-shell';
import { resetPreferenceMemory } from '../src/shell/preferences';
import { canOpen, resolveNavigation, ZONES, type ZoneDefinition } from '../src/shell/registry';
import { ZonePage } from '../src/shell/zone-page';
import { createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';
import { emptyProjects, project, withProjects } from './support/fake-projects';
import { emptySales, opportunity, pipelineWithStages, withSales } from './support/fake-sales';
import { homeCrumb, signOutViaMenu, switchBusiness, switcher } from './support/shell';

const BASE = 'https://api.test';
const ALL = ['business:read', 'members:read', 'customers:read', 'customers:write', 'activity:read', 'sales:read', 'sales:write', 'projects:read', 'projects:create', 'projects:update', 'projects:manage_tasks'];
const USER = { id: uuid(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };
const ctx = (slug: string, permissions = ALL): BusinessContext => ({
  business: { slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

// jsdom has no layout: the window width is simulated through matchMedia, which the shell reads.
let width = 1280;
const listeners = new Set<() => void>();
function setWidth(px: number) {
  width = px;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return width >= Number(/min-width:\s*(\d+)px/.exec(query)![1]);
      },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }),
  });
}

beforeEach(() => {
  localStorage.clear();
  resetPreferenceMemory();
  document.documentElement.className = '';
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.restoreAllMocks();
  // @ts-expect-error restoring jsdom's default (no matchMedia)
  delete window.matchMedia;
});

function mountApp(opts: {
  businesses?: Record<string, FakeBusiness>;
  slugs?: string[];
  permissions?: (slug: string) => string[];
  context?: (slug: string) => Promise<Outcome<BusinessContext>>;
  list?: () => Promise<Outcome<{ slug: string; name: string; role: 'MANAGER' }[]>>;
  session?: () => SessionCheck;
} = {}) {
  const slugs = opts.slugs ?? ['alpha', 'beta'];
  const businesses = opts.businesses ?? Object.fromEntries(slugs.map((s) => [s, { ...emptyBusiness(), customers: [customer({ displayName: `${s} customer` })] }]));
  const api = withSales(withProjects(createFakeApi(businesses), Object.fromEntries(slugs.map((s) => [s, { ...emptyProjects(), projects: [project({ name: `${s} project` })] }]))),
    Object.fromEntries(slugs.map((s) => {
      const p = pipelineWithStages();
      return [s, { ...emptySales(), pipelines: [p], opportunities: [opportunity(p, { title: `${s} deal` })] }];
    })));
  const auth = {
    session: vi.fn(async () => opts.session?.() ?? ({ kind: 'signed-in', user: USER } as SessionCheck)),
    signOut: vi.fn(async () => undefined),
  } as unknown as AuthClient;
  const defaultList = async () => ({ kind: 'ok' as const, data: slugs.map((s) => ({ slug: s, name: ctx(s).business.name, role: 'MANAGER' as const })) });
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(opts.list ?? defaultList),
    businessContext: vi.fn(opts.context ?? (async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug, opts.permissions?.(slug)) }))),
    createBusiness: vi.fn(),
  };
  const storage = memoryStorage({ slug: slugs[0] });
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={storage}
    customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} sales={createSalesClient(BASE, { kind: 'cookie' }, api.fetch)}
    projects={createProjectsClient(BASE, { kind: 'cookie' }, api.fetch)} />);
  return { api, auth, tenancy, storage, user: userEvent.setup() };
}

const zonesNav = () => screen.getByRole('navigation', { name: 'Zones' });
const sidebarItem = (name: string | RegExp) => within(zonesNav()).getByRole('button', { name });
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

describe('Zone registry', () => {
  it('declares a stable id, name, icon, route, order and existing permission keys for every Zone', () => {
    const ids = new Set(ZONES.map((z) => z.id));
    expect(ids.size).toBe(ZONES.length);
    for (const zone of ZONES) {
      expect(zone.route).toMatch(/^\/[a-z-]+$/);
      expect(zone.icon).toBeTruthy();
      // Built Zones are gated on real API keys (`<zone>:<action>`); planned ones cannot be opened at all.
      if (zone.availability === 'built') expect(zone.requires.length).toBeGreaterThan(0);
      for (const key of zone.requires) expect(key).toMatch(/^[a-z]+:[a-z_]+$/);
    }
    expect(ZONES.find((z) => z.id === 'finance')!.availability).toBe('planned'); // Finance F1 is not merged
  });

  it('filters by the server\'s permissions: unauthorised Zones are omitted, planned ones never openable, nothing listed while loading or failed', () => {
    const nav = resolveNavigation({ state: 'ready', permissions: ['customers:read', 'projects:read'] });
    expect(nav.available.map((z) => z.id)).toEqual(['customers', 'projects']);
    expect(nav.planned.map((z) => z.id)).toEqual(['finance', 'people', 'operations', 'insights', 'settings']);
    expect(canOpen({ zone: 'sales' }, nav)).toBe(false);
    expect(canOpen({ zone: 'finance' }, nav)).toBe(false);
    expect(canOpen({ zone: 'customers' }, nav)).toBe(true);
    expect(resolveNavigation({ state: 'loading' })).toEqual({ state: 'loading', available: [], planned: [] });
    expect(resolveNavigation({ state: 'failed' })).toEqual({ state: 'failed', available: [], planned: [] });
    // A Zone's name is never a permission: "sales" access without sales:read is not access.
    expect(resolveNavigation({ state: 'ready', permissions: ['sales', 'sales:write'] }).available).toEqual([]);
  });

  it('a new Zone (with child navigation) needs only a registry entry: sidebar, breadcrumbs and secondary navigation follow', async () => {
    // Reuses a planned Zone's id (ids are a closed union) as a stand-in for a future built Zone.
    const zones: ZoneDefinition[] = [
      ...ZONES.filter((z) => z.id !== 'operations'),
      { id: 'operations', name: 'Field', description: 'x', icon: 'operations', route: '/field', order: 5, requires: ['field:read'], availability: 'built',
        status: { label: 'Beta', tone: 'info' }, children: [{ id: 'jobs', label: 'Jobs', route: '/field/jobs' }, { id: 'crews', label: 'Crews', route: '/field/crews' }] },
    ];
    const onNavigate = vi.fn();
    const props = {
      business: { slug: 'alpha', name: 'Alpha Plumbing' }, businesses: [], user: { name: 'Ada', email: 'ada@example.com' },
      navigation: resolveNavigation({ state: 'ready', permissions: ['field:read', 'customers:read'] }, zones),
      onNavigate, onChooseBusiness: vi.fn(), onSignOut: vi.fn(),
    };
    const { rerender } = render(<AppShell {...props} route={{ zone: 'home' }}><p>content</p></AppShell>);
    const items = within(zonesNav()).getAllByRole('button').map((b) => b.textContent);
    expect(items).toEqual(['Home', 'FieldBeta', 'Customers']); // ordered by `order`
    await userEvent.setup().click(sidebarItem(/Field/));
    expect(onNavigate).toHaveBeenCalledWith({ zone: 'operations' });
    rerender(<AppShell {...props} route={{ zone: 'operations', child: 'crews' }}><p>content</p></AppShell>);
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('button', { name: 'Field' })).toBeTruthy();
    expect(crumbs.getByText('Crews').getAttribute('aria-current')).toBe('page');
    const sections = within(screen.getByRole('navigation', { name: 'Field sections' }));
    expect(sections.getByRole('button', { name: 'Crews' }).getAttribute('aria-current')).toBe('page');
    expect(sections.getByRole('button', { name: 'Jobs' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('navigation in the app', () => {
  it('the sidebar opens Customers, Sales and Projects; the active item and breadcrumbs follow; Home returns', async () => {
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    expect(sidebarItem('Home').getAttribute('aria-current')).toBe('page');
    expect(within(zonesNav()).queryByRole('button', { name: 'Finance' })).toBeNull(); // planned Zones are not navigation
    for (const [zone, heading, record] of [['Customers', 'Customers', 'alpha customer'], ['Sales', 'Sales', 'alpha deal'], ['Projects', 'Projects', 'alpha project']] as const) {
      await user.click(sidebarItem(zone));
      await h1(heading);
      expect(await screen.findByText(record)).toBeTruthy();
      expect(sidebarItem(zone).getAttribute('aria-current')).toBe('page');
      expect(sidebarItem('Home').getAttribute('aria-current')).toBeNull();
      const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
      expect(crumbs.getByText(zone).getAttribute('aria-current')).toBe('page');
      expect(document.title).toBe(`${zone} · Alpha Plumbing · Business OS`);
    }
    await user.click(homeCrumb());
    await h1('Welcome to Alpha Plumbing.');
  });

  it('a role without a Zone\'s permission never sees it in the sidebar or on Home', async () => {
    mountApp({ permissions: () => ['business:read', 'customers:read'] });
    await h1('Welcome to Alpha Plumbing.');
    expect(within(zonesNav()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Home', 'Customers']);
    expect(screen.queryByRole('button', { name: 'Open the Sales Zone' })).toBeNull();
    expect(screen.queryByText(/Sales Zone — coming soon/)).toBeNull();
  });

  it('a role with no Zones gets a plain explanation instead of an empty sidebar', async () => {
    mountApp({ permissions: () => ['business:read'] });
    await h1('Welcome to Alpha Plumbing.');
    expect(within(zonesNav()).getByText('No Zones are open to your role in this business.')).toBeTruthy();
  });

  it('Home shortcuts open the right create form', async () => {
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    await h1(/Add (a )?customer/i);
    await user.click(homeCrumb());
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    await h1(/New project/i);
  });

  it('leaving unsaved work through the sidebar asks first, and Keep editing keeps it', async () => {
    const { user } = mountApp();
    await user.click(await screen.findByRole('button', { name: 'Open the Projects Zone' }));
    await user.click((await screen.findAllByRole('button', { name: 'New project' }))[0]!);
    await user.type(await screen.findByLabelText('Name'), 'Half typed');
    await user.click(sidebarItem('Customers'));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Half typed');
    await user.click(sidebarItem('Customers'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    await h1('Customers');
  });

  it('signing out from the account menu asks the server and returns to sign-in', async () => {
    let signedIn = true;
    const { user, auth } = mountApp({ session: () => (signedIn ? { kind: 'signed-in', user: USER } : { kind: 'signed-out' }) as SessionCheck });
    await h1('Welcome to Alpha Plumbing.');
    signedIn = false;
    await signOutViaMenu(user);
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: /Sign in/ })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Zones' })).toBeNull();
  });

  it('an unauthenticated visitor never sees the shell', async () => {
    mountApp({ session: () => ({ kind: 'signed-out' }) as SessionCheck });
    expect(await screen.findByRole('button', { name: /Sign in/ })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Zones' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Switch business/ })).toBeNull();
  });
});

describe('business switching', () => {
  it('lists exactly the server\'s businesses, marks the active one, and switches without leaving data behind', async () => {
    const { user, api, storage } = mountApp();
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    expect(await screen.findByText('alpha customer')).toBeTruthy();
    await user.click(switcher());
    const menu = within(screen.getByRole('menu', { name: 'Businesses' }));
    const options = menu.getAllByRole('menuitemradio');
    expect(options.map((o) => o.textContent)).toEqual(['Alpha PlumbingManager', 'Beta PlumbingManager']);
    expect(options[0]!.getAttribute('aria-checked')).toBe('true');
    api.calls.length = 0;
    await user.click(options[1]!);
    await h1('Welcome to Beta Plumbing.'); // the route resets to Home: no Alpha screen carries over
    expect(screen.queryByText('alpha customer')).toBeNull();
    expect(switcher().getAttribute('aria-label')).toBe('Switch business, current business Beta Plumbing');
    expect(storage.getSlug()).toBe('beta');
    await user.click(sidebarItem('Customers'));
    expect(await screen.findByText('beta customer')).toBeTruthy();
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['beta']));
  });

  it('while a business opens, the shell shows that instead of the previous business\'s screens, and a late answer for the old one is ignored', async () => {
    let releaseBeta!: () => void;
    const { user } = mountApp({
      context: (slug) => slug === 'beta'
        ? new Promise((resolve) => { releaseBeta = () => resolve({ kind: 'ok', data: ctx('beta') }); })
        : Promise.resolve({ kind: 'ok', data: ctx(slug) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Open the Sales Zone' }));
    expect(await screen.findByText('alpha deal')).toBeTruthy();
    await switchBusiness(user, /Beta Plumbing/);
    expect(await screen.findByText('Opening Beta Plumbing…')).toBeTruthy();
    expect(screen.queryByText('alpha deal')).toBeNull();
    expect(within(zonesNav()).getByRole('status', { name: 'Loading your Zones' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Switch business/ })).toBeNull(); // no second switch mid-flight
    await act(async () => releaseBeta());
    await h1('Welcome to Beta Plumbing.');
  });

  it('if the server cannot be reached, you stay in the current business and are told', async () => {
    const { user, storage } = mountApp({ context: async (slug) => (slug === 'beta' ? { kind: 'unreachable' } : { kind: 'ok', data: ctx(slug) }) });
    await h1('Welcome to Alpha Plumbing.');
    await switchBusiness(user, /Beta Plumbing/);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't open Beta Plumbing");
    expect(alert.textContent).toContain("You're still in Alpha Plumbing");
    expect(switcher().getAttribute('aria-label')).toContain('Alpha Plumbing');
    expect(storage.getSlug()).toBe('alpha');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('if the membership was revoked meanwhile, the switch does not happen and says why', async () => {
    let revoked = false;
    const { user } = mountApp({
      list: async () => ({ kind: 'ok', data: (revoked ? ['alpha'] : ['alpha', 'beta']).map((s) => ({ slug: s, name: ctx(s).business.name, role: 'MANAGER' as const })) }),
    });
    await h1('Welcome to Alpha Plumbing.');
    revoked = true;
    await switchBusiness(user, /Beta Plumbing/);
    expect((await screen.findByRole('alert')).textContent).toContain('You no longer have access to Beta Plumbing');
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome to Alpha Plumbing.' })).toBeTruthy();
    await user.click(switcher());
    expect(within(screen.getByRole('menu')).queryByRole('menuitemradio', { name: /Beta/ })).toBeNull();
  });

  it('a switch that finds the session ended goes to sign-in, showing nothing from either business', async () => {
    let ended = false;
    const { user } = mountApp({ session: () => (ended ? { kind: 'signed-out' } : { kind: 'signed-in', user: USER }) as SessionCheck });
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    await screen.findByText('alpha customer');
    ended = true;
    await switchBusiness(user, /Beta Plumbing/);
    expect(await screen.findByText(/Your session has ended/)).toBeTruthy();
    expect(screen.queryByText('alpha customer')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Zones' })).toBeNull();
  });

  it('"All businesses…" opens the full chooser, with a way back', async () => {
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    await user.click(switcher());
    await user.click(screen.getByRole('menuitem', { name: 'All businesses…' }));
    await h1('Choose your workspace');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await h1('Welcome to Alpha Plumbing.');
  });
});

describe('menus and keyboard', () => {
  it('the switcher opens with the keyboard, arrows move, Escape closes and returns focus', async () => {
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    switcher().focus();
    await user.keyboard('{ArrowDown}');
    const menu = screen.getByRole('menu', { name: 'Businesses' });
    expect(document.activeElement?.textContent).toContain('Alpha Plumbing'); // lands on the checked choice
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Beta Plumbing');
    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toContain('Create another business');
    await user.keyboard('{Escape}');
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(switcher());
  });

  it('search and notifications are visibly unavailable, with nothing fabricated', async () => {
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    for (const name of ['Search (not available yet)', 'Notifications (not available yet)']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      await user.click(button);
    }
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a skip link leads to the content area', async () => {
    mountApp();
    await h1('Welcome to Alpha Plumbing.');
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip.getAttribute('href')).toBe('#bos-content');
    expect(document.getElementById('bos-content')?.tagName).toBe('MAIN');
  });
});

describe('theme', () => {
  it('System, Light and Dark use the design system classes and are remembered on this device', async () => {
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    const choose = async (name: string) => {
      await user.click(screen.getByRole('button', { name: /Account menu/ }));
      await user.click(screen.getByRole('menuitemradio', { name }));
    };
    expect(document.documentElement.className).toBe('');
    await choose('Dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('bos.theme')).toBe('dark');
    await choose('Light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    expect(screen.getByRole('menuitemradio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(document.documentElement.className).toBe('');
  });
});

describe('responsive', () => {
  it('desktop: the sidebar collapses to icons (names kept for assistive tech) and the choice is remembered', async () => {
    setWidth(1280);
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem('bos.sidebar')).toBe('compact');
    expect(sidebarItem('Customers').getAttribute('title')).toBe('Customers');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    cleanup();
    resetPreferenceMemory();
    mountApp();
    await h1('Welcome to Alpha Plumbing.');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('tablet: a compact rail with every Zone reachable and no collapse toggle', async () => {
    setWidth(800);
    mountApp();
    await h1('Welcome to Alpha Plumbing.');
    expect(sidebarItem('Projects').getAttribute('title')).toBe('Projects');
    expect(screen.queryByRole('button', { name: /Collapse sidebar|Expand sidebar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
  });

  it('mobile: navigation is a modal drawer: focus moves in and stays, Escape and the backdrop close it, focus returns, the page does not scroll', async () => {
    setWidth(390);
    const { user } = mountApp();
    await h1('Welcome to Alpha Plumbing.');
    expect(screen.queryByRole('navigation', { name: 'Zones' })).toBeNull();
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    await user.click(opener);
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: 'Close navigation' }));
    expect(document.body.style.overflow).toBe('hidden');
    // Tab stays inside the drawer.
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');

    await user.click(opener);
    await user.click(screen.getByTestId('drawer-backdrop'));
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();

    await user.click(opener);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sales' }));
    await h1('Sales');
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });

  it('mobile: the active business stays visible in the top bar', async () => {
    setWidth(390);
    mountApp();
    await h1('Welcome to Alpha Plumbing.');
    expect(switcher().textContent).toContain('Alpha Plumbing');
  });
});

describe('Zone page layout contract', () => {
  it('heading, description, actions, tabs and the loading, error and empty states', async () => {
    const onRetry = vi.fn();
    const onTab = vi.fn();
    const { rerender } = render(<ZonePage title="Invoices" description="All invoices" primaryActions={<button type="button">New invoice</button>} secondaryActions={<button type="button">Export</button>}
      tabs={[{ id: 'open', label: 'Open' }, { id: 'paid', label: 'Paid' }]} currentTab="paid" onTab={onTab}><p>rows</p></ZonePage>);
    expect(screen.getByRole('heading', { level: 1, name: 'Invoices' })).toBeTruthy();
    expect(screen.getByText('All invoices')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New invoice' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paid' }).getAttribute('aria-current')).toBe('page');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    expect(onTab).toHaveBeenCalledWith('open');
    expect(screen.getByText('rows')).toBeTruthy();

    rerender(<ZonePage title="Invoices" state={{ kind: 'loading', label: 'Loading invoices' }}><p>rows</p></ZonePage>);
    expect(screen.getByRole('status').textContent).toContain('Loading invoices');
    expect(screen.queryByText('rows')).toBeNull();

    rerender(<ZonePage title="Invoices" state={{ kind: 'error', title: 'Invoices could not be loaded', onRetry }} />);
    expect(screen.getByRole('alert').textContent).toContain('Invoices could not be loaded');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();

    rerender(<ZonePage title="Invoices" state={{ kind: 'empty', title: 'No invoices yet' }} />);
    expect(screen.getByText('No invoices yet')).toBeTruthy();
  });
});

describe('module discovery states', () => {
  it('a failed discovery is said plainly, and nothing restricted is listed', () => {
    render(<AppShell business={{ slug: 'alpha', name: 'Alpha' }} businesses={[]} user={{ name: null, email: 'a@example.com' }} route={{ zone: 'home' }}
      navigation={resolveNavigation({ state: 'failed' })} onNavigate={vi.fn()} onChooseBusiness={vi.fn()} onSignOut={vi.fn()}><p>x</p></AppShell>);
    expect(within(zonesNav()).getByRole('alert').textContent).toBe('Your Zones could not be loaded.');
    expect(within(zonesNav()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Home']);
  });

  it('keeps every request for the new business only after a switch (no cross-tenant requests)', async () => {
    const { user, api } = mountApp();
    await user.click(await screen.findByRole('button', { name: 'Open the Projects Zone' }));
    await screen.findByText('alpha project');
    api.calls.length = 0;
    await switchBusiness(user, /Beta Plumbing/);
    await h1('Welcome to Beta Plumbing.');
    await user.click(sidebarItem('Projects'));
    await screen.findByText('beta project');
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(0));
    expect(api.calls.every((c) => c.slug === 'beta')).toBe(true);
    expect(screen.queryByText('alpha project')).toBeNull();
  });
});
