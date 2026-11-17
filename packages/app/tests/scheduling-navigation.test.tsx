// @vitest-environment jsdom
// S3: Scheduling inside the real application shell: sidebar entry, secondary navigation, section state,
// permission gating, forged routes and the customer deep link.
import type { SchedulingCalendar, SchedulingEvent } from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, createSchedulingClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { canOpen, resolveNavigation, ZONES } from '../src/shell/registry';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const T = '2031-07-01T00:00:00.000Z';
const USER = { id: randomUUID(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };
const SCHED = ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel', 'scheduling:manage_calendars', 'scheduling:manage_resources'];
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cal: SchedulingCalendar = {
  id: randomUUID(), name: 'Main calendar', description: null, colour: null, timeZone: 'Australia/Perth', isDefault: true, version: 1,
  createdById: USER.id, updatedById: USER.id, createdAt: T, updatedAt: T, archivedAt: null,
};
const customerId = randomUUID();

/** A tiny API: one calendar, one event for a customer (this week), no resources. Records every call. */
function fakeScheduling() {
  const calls: string[] = [];
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  const ev: SchedulingEvent = {
    id: randomUUID(), calendarId: cal.id, title: 'Site visit', description: null, location: null, startAt: start.toISOString(), endAt: new Date(start.getTime() + 3600_000).toISOString(),
    status: 'SCHEDULED', blocksAvailability: true, customerId, customer: { id: customerId, displayName: 'Acme Pty Ltd', archived: false }, resources: [], cancelledAt: null, cancelledById: null,
    version: 1, createdById: USER.id, updatedById: USER.id, createdAt: T, updatedAt: T, archivedAt: null,
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v1/b/alpha', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/scheduling/calendars') return json(200, { calendars: [cal], nextCursor: null });
    if (path === '/scheduling/events') return json(200, { events: [ev], nextCursor: null });
    if (path === `/scheduling/events/${ev.id}`) return json(200, { event: ev, conflicts: [] });
    if (path === '/scheduling/resources') return json(200, { resources: [], nextCursor: null });
    if (path.startsWith('/customers')) return json(200, { customers: [], nextCursor: null });
    return json(404, { error: 'not_found' });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function mount(permissions: string[]) {
  const api = fakeScheduling();
  const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: 'Alpha Plumbing', role: 'OWNER' as const }] })),
    businessContext: vi.fn(async () => ({ kind: 'ok' as const, data: ctx(permissions) })),
    createBusiness: vi.fn(),
    platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: true } })),
  };
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })}
    customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} scheduling={createSchedulingClient(BASE, { kind: 'cookie' }, api.fetch)} />);
  return { api, user: userEvent.setup() };
}
const zonesNav = () => screen.findByRole('navigation', { name: 'Zones' });
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

describe('Scheduling registry entry', () => {
  it('sits after Projects and before People, needs only scheduling:read, and has Calendar, Resource schedule and Resources', () => {
    const order = [...ZONES].sort((a, b) => a.order - b.order).map((z) => z.id);
    expect(order.indexOf('scheduling')).toBeGreaterThan(order.indexOf('projects'));
    expect(order.indexOf('scheduling')).toBeLessThan(order.indexOf('people'));
    const z = ZONES.find((x) => x.id === 'scheduling')!;
    expect(z).toMatchObject({ name: 'Scheduling', availability: 'built', requires: ['scheduling:read'], icon: 'calendar' });
    expect(z.children?.map((c) => c.id)).toEqual(['calendar', 'timeline', 'resources']);
    // No Bookings destination: there is no bookings API.
    expect(z.children?.some((c) => /booking/i.test(c.label))).toBe(false);
  });

  it('a forged route to Scheduling is refused without scheduling:read', () => {
    const without = resolveNavigation({ state: 'ready', permissions: ['customers:read'] });
    expect(canOpen({ zone: 'scheduling' }, without)).toBe(false);
    expect(canOpen({ zone: 'scheduling', child: 'resources' }, without)).toBe(false);
    const withKey = resolveNavigation({ state: 'ready', permissions: ['scheduling:read'] });
    expect(canOpen({ zone: 'scheduling', child: 'resources' }, withKey)).toBe(true);
  });
});

describe('Scheduling inside the shell', () => {
  it('is hidden without scheduling:read', async () => {
    mount(['customers:read']);
    const nav = await zonesNav();
    await within(nav).findByRole('button', { name: 'Customers' });
    expect(within(nav).queryByRole('button', { name: 'Scheduling' })).toBeNull();
  });

  it('appears between Projects and People, opens the Calendar and marks it current', async () => {
    const { user } = mount(['customers:read', 'projects:read', 'people:read', ...SCHED]);
    const nav = await zonesNav();
    const names = within(nav).getAllByRole('button').map((b) => b.textContent ?? '');
    const at = (n: string) => names.findIndex((t) => t.startsWith(n));
    expect(at('Scheduling')).toBeGreaterThan(at('Projects'));
    expect(at('Scheduling')).toBeLessThan(at('People'));
    await user.click(within(nav).getByRole('button', { name: 'Scheduling' }));
    expect(await h1('Scheduling')).toBeTruthy();
    expect(await screen.findByText('Site visit')).toBeTruthy();
    const sub = screen.getByRole('navigation', { name: 'Scheduling sections' });
    expect(within(sub).getByRole('button', { name: 'Calendar' }).getAttribute('aria-current')).toBe('page');
    // The Zone's own tab strip is replaced by the shell's secondary navigation.
    expect(screen.queryByRole('tablist', { name: /sections/i })).toBeNull();
  });

  it('moves between Calendar, Resource schedule and Resources from the keyboard without remounting the Zone', async () => {
    const { api, user } = mount(['customers:read', ...SCHED]);
    await user.click(within(await zonesNav()).getByRole('button', { name: 'Scheduling' }));
    await h1('Scheduling');
    await screen.findByText('Site visit');
    const calendarLoads = () => api.calls.filter((c) => c === 'GET /scheduling/calendars').length;
    const before = calendarLoads();
    const sub = screen.getByRole('navigation', { name: 'Scheduling sections' });
    const resources = within(sub).getByRole('button', { name: 'Resources' });
    resources.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/No resources yet/)).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Scheduling sections' })).getByRole('button', { name: 'Resources' }).getAttribute('aria-current')).toBe('page');
    await user.click(within(screen.getByRole('navigation', { name: 'Scheduling sections' })).getByRole('button', { name: 'Calendar' }));
    expect(await screen.findByText('Site visit')).toBeTruthy();
    expect(calendarLoads()).toBe(before); // same mounted Zone: calendars were not reloaded
  });

  it('opens the linked customer from an event only when the viewer may read customers', async () => {
    const withCustomers = mount(['customers:read', ...SCHED]);
    await withCustomers.user.click(within(await zonesNav()).getByRole('button', { name: 'Scheduling' }));
    await withCustomers.user.click(await screen.findByText('Site visit'));
    const link = await screen.findByRole('button', { name: 'Acme Pty Ltd' });
    await withCustomers.user.click(link);
    await waitFor(() => expect(withCustomers.api.calls.some((c) => c.includes(`/customers`))).toBe(true));
    expect(screen.queryByRole('heading', { level: 1, name: 'Scheduling' })).toBeNull();
  });

  it('shows the customer name as plain text without customers:read', async () => {
    const { user } = mount(SCHED);
    await user.click(within(await zonesNav()).getByRole('button', { name: 'Scheduling' }));
    await user.click(await screen.findByText('Site visit'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Acme Pty Ltd')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Acme Pty Ltd' })).toBeNull();
  });

  it('shows a permission-denied state when the API refuses the calendars', async () => {
    const api = fakeScheduling();
    const denied = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('/scheduling/calendars') ? json(403, { error: 'forbidden' }) : api.fetch(input, init))) as typeof globalThis.fetch;
    const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
    const tenancy: TenancyClient = {
      listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: 'Alpha Plumbing', role: 'OWNER' as const }] })),
      businessContext: vi.fn(async () => ({ kind: 'ok' as const, data: ctx(SCHED) })),
      createBusiness: vi.fn(),
      platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: false } })),
    };
    const user = userEvent.setup();
    render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })} scheduling={createSchedulingClient(BASE, { kind: 'cookie' }, denied)} />);
    await user.click(within(await zonesNav()).getByRole('button', { name: 'Scheduling' }));
    expect(await screen.findByText(/not allowed|permission|access/i)).toBeTruthy();
  });
});
