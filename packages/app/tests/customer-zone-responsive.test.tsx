// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, type BusinessContext } from '../src';
import { CustomerZone } from '../src/zones/customers/customer-zone';
import { activity, contact, createFakeApi, customer, emptyBusiness, uuid } from './support/fake-api';

// jsdom has no layout, so the window width is simulated through matchMedia, which is what the app reads.
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
const resize = (px: number) => act(() => {
  width = px;
  listeners.forEach((cb) => cb());
});

afterEach(() => {
  cleanup();
  listeners.clear();
  // @ts-expect-error restoring jsdom's default (no matchMedia)
  delete window.matchMedia;
});

const BASE = 'https://api.test';
const context: BusinessContext = {
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions: ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write'] },
};
const seed = () => [
  customer({ displayName: 'Kookaburra Pty Ltd', kind: 'COMPANY', email: 'accounts@kookaburra.example', phone: '+61 8 9000 0001', city: 'Perth', countryCode: 'AU' }),
  customer({ displayName: 'Mei Tanaka', kind: 'INDIVIDUAL', email: 'mei@example.com', phone: '+81 90 1234 5678', city: 'Osaka', countryCode: 'JP' }),
  customer({ displayName: 'Old Mill Joinery', kind: 'COMPANY', email: 'info@oldmill.example', city: 'Bunbury', countryCode: 'AU', archivedAt: '2026-11-01T00:00:00.000Z' }),
];
function mount(api: ReturnType<typeof createFakeApi>) {
  const view = render(
    <CustomerZone client={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} context={context} userLabel="Ada" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />,
  );
  return { ...view, user: userEvent.setup() };
}
const withCustomers = () => createFakeApi({ alpha: { ...emptyBusiness(), customers: seed() } });

describe('directory at different window widths', () => {
  it('wide: every column is shown', async () => {
    setWidth(1280);
    mount(withCustomers());
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent?.replace(/\s*↑/, ''))).toEqual(['Name', 'Type', 'Email', 'Phone', 'Location', 'Status']);
  });

  it('medium: fewer columns; type and location move under the name instead of disappearing', async () => {
    setWidth(800);
    mount(withCustomers());
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent?.replace(/\s*↑/, ''))).toEqual(['Customer', 'Email', 'Phone', 'Status']);
    const name = within(table).getByRole('rowheader', { name: /Kookaburra Pty Ltd/ });
    expect(within(name).getByText('Company')).toBeTruthy();
    expect(within(name).getByText('Perth, Australia')).toBeTruthy();
    expect(within(table).getByRole('rowheader', { name: /Mei Tanaka/ }).textContent).toContain('Individual');
  });

  it('narrow: a compact record list replaces the table, names first, search, filters and Add stay usable', async () => {
    setWidth(400);
    mount(withCustomers());
    const list = await screen.findByRole('list', { name: /Customers, sorted by name A to Z/ });
    expect(screen.queryByRole('table')).toBeNull();
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(first.textContent).toMatch(/^Kookaburra Pty Ltd/); // the name leads
    for (const text of ['Company', 'Perth, Australia', 'accounts@kookaburra.example', '+61 8 9000 0001']) expect(first.textContent).toContain(text);
    expect(screen.getByRole('searchbox', { name: /Search customers/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Show customers' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add customer' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy();
  });

  it.each([1280, 800, 400])('at %ipx every fact about every customer is still on the page', async (px) => {
    setWidth(px);
    const api = withCustomers();
    const { user } = mount(api);
    await screen.findByText('Kookaburra Pty Ltd');
    const text = document.body.textContent ?? '';
    for (const fact of ['Kookaburra Pty Ltd', 'accounts@kookaburra.example', '+61 8 9000 0001', 'Perth, Australia', 'Company', 'Mei Tanaka', 'mei@example.com', '+81 90 1234 5678', 'Osaka, Japan', 'Individual']) {
      expect(text, `${fact} at ${px}px`).toContain(fact);
    }
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    await screen.findByText('Old Mill Joinery');
    expect(document.body.textContent).toContain('Bunbury, Australia');
    expect(document.body.textContent).toContain('Archived'); // status is visible for archived records at every width
    expect(document.body.textContent).toContain('info@oldmill.example');
  });

  it('resizing the window re-lays-out live without reloading or losing the list', async () => {
    setWidth(1280);
    const api = withCustomers();
    mount(api);
    await screen.findByRole('table');
    const requests = api.callsTo(/GET .*customers$/).length;
    await resize(400);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Mei Tanaka')).toBeTruthy();
    await resize(800);
    expect(within(screen.getByRole('table')).getAllByRole('columnheader').length).toBe(4);
    await resize(1400);
    expect(within(screen.getByRole('table')).getAllByRole('columnheader').length).toBe(6);
    expect(api.callsTo(/GET .*customers$/).length).toBe(requests);
  });

  it('the narrow list works from the keyboard: Tab to a record, Enter opens it', async () => {
    setWidth(400);
    const { user } = mount(withCustomers());
    await screen.findByRole('list', { name: /Customers/ });
    const first = within(screen.getByRole('list', { name: /Customers/ })).getAllByRole('button')[0]!;
    first.focus();
    expect(document.activeElement).toBe(first);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Kookaburra Pty Ltd', level: 1 })).toBeTruthy();
  });

  it('the customer page keeps Edit and Archive reachable at a narrow width', async () => {
    setWidth(400);
    const { user } = mount(withCustomers());
    await user.click((await screen.findAllByRole('button', { name: /Kookaburra Pty Ltd/ }))[0]!);
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });
});

describe('activity timeline', () => {
  const c = customer({ displayName: 'Timeline Co' });
  const build = () => createFakeApi({ alpha: { ...emptyBusiness(), customers: [c], activities: [
    activity(c.id, { type: 'customer.created', occurredAt: '2026-11-01T01:00:00.000Z' }),
    activity(c.id, { type: 'call', subject: 'Quote follow-up', body: 'Left a message', occurredAt: '2026-11-02T01:00:00.000Z' }),
    activity(c.id, { type: 'customer.updated', data: { fields: ['phone'] }, occurredAt: '2026-11-03T01:00:00.000Z' }),
    activity(c.id, { type: 'meeting', subject: 'Site visit', occurredAt: '2026-11-04T01:00:00.000Z' }),
    activity(c.id, { type: 'email', subject: 'Sent the quote', occurredAt: '2026-11-05T01:00:00.000Z' }),
    activity(c.id, { type: 'note', subject: 'Prefers mornings', occurredAt: '2026-11-06T01:00:00.000Z' }),
  ] } });

  it('people-logged activities carry a labelled icon; automated events are quieter and have none', async () => {
    setWidth(1280);
    const { user } = mount(build());
    await user.click(await screen.findByRole('button', { name: 'Timeline Co' }));
    const panel = await screen.findByLabelText('Activity');
    await within(panel).findByText('Site visit');
    expect(within(panel).getAllByRole('img').map((i) => i.getAttribute('aria-label')).sort()).toEqual(['Call', 'Email', 'Meeting', 'Note']);
    const items = within(panel).getAllByRole('listitem');
    expect(items.filter((i) => i.dataset.kind === 'user').length).toBe(4);
    const system = items.filter((i) => i.dataset.kind === 'system');
    expect(system.length).toBe(2);
    for (const item of system) {
      expect(within(item).queryByRole('img')).toBeNull();
      expect(item.querySelector('p')!.className).toContain('text-xs'); // smaller than the 'text-sm' of people's entries
    }
    expect(items.find((i) => i.dataset.kind === 'user')!.querySelector('p')!.className).toContain('text-sm');
  });

  it('stays newest first, and every entry keeps its actor and timestamp', async () => {
    setWidth(1280);
    const { user } = mount(build());
    await user.click(await screen.findByRole('button', { name: 'Timeline Co' }));
    const panel = await screen.findByLabelText('Activity');
    await within(panel).findByText('Site visit');
    const titles = within(panel).getAllByRole('listitem').map((i) => i.querySelector('p')!.textContent);
    expect(titles).toEqual(['Prefers mornings', 'Sent the quote', 'Site visit', 'Customer updated: phone', 'Quote follow-up', 'Customer created']);
    const times = panel.querySelectorAll('time');
    expect(times.length).toBe(6);
    for (const t of times) expect(t.getAttribute('datetime')).toMatch(/^2026-11-0\d/);
    expect(within(panel).getAllByText(/System|team member|·/).length).toBeGreaterThan(0);
  });
});

describe('customer profile hierarchy', () => {
  const build = () => {
    const c = customer({ displayName: 'Acme Pty Ltd', email: 'hello@acme.example', phone: '+61 8 9000 0001', website: 'acme.example', notes: 'Pays on time' });
    const zed = contact(c.id, { displayName: 'Zed Primary', jobTitle: 'Director', email: 'zed@acme.example', phone: '+61 400 000 000' });
    const amy = contact(c.id, { displayName: 'Amy Accounts', email: 'amy@acme.example' });
    c.primaryContactId = zed.id;
    return createFakeApi({ alpha: { ...emptyBusiness(), customers: [c], contacts: [amy, zed] } });
  };

  it('contact details are links, the primary contact leads and is labelled, and Sales and Finance stays quiet', async () => {
    setWidth(1280);
    const { user } = mount(build());
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    expect(await screen.findByRole('link', { name: 'hello@acme.example' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '+61 8 9000 0001' }).getAttribute('href')).toBe('tel:+61890000001');
    const contacts = await screen.findByLabelText('Contacts');
    await within(contacts).findByText('Zed Primary');
    const names = within(contacts).getAllByRole('listitem').map((li) => li.querySelector('p')!.textContent);
    expect(names[0]).toContain('Zed Primary'); // primary first although Amy sorts earlier
    expect(within(contacts).getByLabelText('Primary contact')).toBeTruthy();
    expect(within(contacts).getByRole('link', { name: 'zed@acme.example' })).toBeTruthy();
    const sales = screen.getByLabelText('Sales and Finance');
    expect(within(sales).getByText('Coming soon')).toBeTruthy();
    expect(sales.className).toContain('border-dashed'); // present, but not a heavy card
    for (const label of ['Details', 'Notes', 'Contacts', 'Activity']) expect(screen.getByLabelText(label)).toBeTruthy();
    // On a small window the sections stack in this order, so contacts come before the long timeline.
    const order = ['Details', 'Contacts', 'Notes', 'Activity', 'Sales and Finance'].map((l) => screen.getByLabelText(l));
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('light and dark themes', () => {
  // The Zone uses only the shared design tokens (CSS variables with light and dark values), never fixed colours.
  const root = resolve(__dirname, '../src/zones');
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.match(/\.(tsx|ts)$/) ? [join(dir, e.name)] : []));
  it('no hard-coded colours or gradients in any Zone source', () => {
    for (const file of files(root)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|green|emerald|teal|blue|indigo|violet|purple|pink|rose)(?:-\d+)?\b/);
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|gradient/);
    }
  });
});
