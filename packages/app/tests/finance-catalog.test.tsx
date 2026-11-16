// @vitest-environment jsdom
// Finance F7-A: the products and services catalog screens, against an in-memory catalog in front of
// the F4 fake Finance API. The real Finance client parses every response with the shared contracts,
// so a shape mismatch fails here.
import type { CatalogItem } from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFinanceClient, type BusinessContext } from '../src';
import { ZONES } from '../src/shell/registry';
import { catalogProblem, formatUnitPrice, taxLabel } from '../src/zones/finance/catalog';
import { FinanceZone, initialView } from '../src/zones/finance/finance-zone';
import { createFakeFinance, financeData } from './support/fake-finance';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const NOW = '2026-11-16T00:00:00.000Z';
const MANAGE = ['finance:read', 'finance:catalog'];
const READER = ['finance:read'];
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function catalogItem(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: randomUUID(), type: 'SERVICE', name: 'Call-out', description: null, code: 'SVC-1', unit: 'job', unitPrice: '95', currencyCode: 'AUD', taxMode: 'NONE',
    taxRateId: null, taxRate: null, status: 'ACTIVE', archivedAt: null, version: 1, createdById: null, updatedById: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function setup(o: { permissions?: string[]; items?: CatalogItem[]; nextCursor?: string | null; section?: string; initialTarget?: string } = {}) {
  const items = o.items ?? [];
  const data = financeData();
  const api = createFakeFinance({ alpha: data });
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /\/finance\/catalog-items(?:\/([^/]+))?(\/.*)?$/.exec(url.pathname);
    if (!m) return api.fetch(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const [, id, tail = ''] = m;
    calls.push({ method, path: `${id ?? ''}${tail}`, query: url.search, body });
    if (!id && method === 'GET') {
      const status = url.searchParams.get('status');
      const q = url.searchParams.get('q')?.toLowerCase();
      const shown = items.filter((x) => (status === 'archived' ? x.archivedAt : status === 'all' ? true : !x.archivedAt) && (!q || x.name.toLowerCase().includes(q)));
      return json(200, { items: shown, nextCursor: url.searchParams.get('cursor') ? null : o.nextCursor ?? null });
    }
    if (!id && method === 'POST') {
      if (items.some((x) => x.code && body.code && x.code.toLowerCase() === body.code.toLowerCase())) return json(409, { error: 'duplicate_code' });
      const created = catalogItem({ ...body, id: randomUUID(), description: body.description || null, code: body.code || null, taxRate: null });
      items.push(created);
      return json(201, { item: created });
    }
    const it = items.find((x) => x.id === id);
    if (!it) return json(404, { error: 'not_found' });
    if (tail === '' && method === 'GET') return json(200, { item: it });
    if (body.version !== it.version) return json(409, { error: 'stale' });
    if (tail === '' && method === 'PATCH') {
      const { version: _v, ...patch } = body;
      void _v;
      Object.assign(it, patch, { version: it.version + 1 });
      return json(200, { item: it });
    }
    if (tail === '/archive') Object.assign(it, { archivedAt: NOW, version: it.version + 1 });
    if (tail === '/restore') Object.assign(it, { archivedAt: null, version: it.version + 1 });
    return json(200, { item: it });
  }) as typeof globalThis.fetch;
  const finance = createFinanceClient(BASE, { kind: 'cookie' }, fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection: vi.fn() };
  render(<FinanceZone key="alpha" client={finance} context={ctx(o.permissions ?? MANAGE)} userLabel="Ada" section={o.section ?? 'catalog'} initialTarget={o.initialTarget} {...handlers} />);
  return { calls, items, data, user: userEvent.setup(), handlers };
}

const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('catalog words and formatting', () => {
  it('shows unit prices exactly (never rounded to cents), tax in words, and plain conflict messages', () => {
    expect(formatUnitPrice('0.012345', 'AUD', 'en-AU')).toBe('$0.012345');
    expect(formatUnitPrice('95', 'AUD', 'en-AU')).toBe('$95.00');
    expect(formatUnitPrice('1500', 'JPY', 'en-AU')).toMatch(/^JPY\s1,500$/);
    expect(formatUnitPrice(null, 'AUD')).toBe('No default price');
    expect(taxLabel({ taxMode: 'NONE', taxRate: null })).toBe('No tax');
    expect(taxLabel({ taxMode: 'RATE', taxRate: { id: randomUUID(), name: 'GST', ratePercent: '10', archived: true } })).toBe('GST (10%), archived');
    expect(catalogProblem('duplicate_code')).toMatch(/already uses that code/);
    expect(catalogProblem('stale')).toMatch(/Someone else changed/);
  });

  it('is a Finance section in the navigation registry', () => {
    const finance = ZONES.find((z) => z.id === 'finance')!;
    expect(finance.children?.map((c) => c.id)).toContain('catalog');
    expect(finance.children?.find((c) => c.id === 'catalog')?.label).toBe('Products & services');
  });
});

describe('catalog item target (GS2-A)', () => {
  const can = { write: false, issue: false, payments: false, expenses: false, manage: false, billing: false, catalog: false, readCustomers: false };

  it('maps catalog:<id> to that item, whatever the section, and leaves the other targets alone', () => {
    const id = randomUUID();
    expect(initialView('catalog', `catalog:${id}`, undefined, can)).toEqual({ name: 'catalog-item', id });
    expect(initialView(undefined, `catalog:${id}`, undefined, can)).toEqual({ name: 'catalog-item', id });
    expect(initialView('catalog', undefined, undefined, can)).toEqual({ name: 'catalog' });
    expect(initialView(undefined, id, undefined, can)).toEqual({ name: 'expense', id }); // F3 bare id is still an expense
  });

  it('opens the item for a reader, read-only, through the item endpoint', async () => {
    const item = catalogItem({ name: 'Blocked drain', description: 'Up to one hour' });
    const { calls } = setup({ permissions: READER, items: [item], initialTarget: `catalog:${item.id}` });
    await heading('Blocked drain');
    expect(screen.getByText('Up to one hour')).toBeTruthy();
    for (const name of ['Save changes', 'Archive', 'Mark inactive', 'Restore']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(calls).toEqual([{ method: 'GET', path: item.id, query: '', body: undefined }]);
  });

  it('opens an archived item read-only for a manager', async () => {
    const item = catalogItem({ name: 'Old service', archivedAt: NOW });
    setup({ items: [item], initialTarget: `catalog:${item.id}` });
    await heading('Old service');
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('shows the not-found state for an item that no longer exists, without listing the catalog', async () => {
    const { calls } = setup({ permissions: READER, items: [], initialTarget: `catalog:${randomUUID()}` });
    expect(await screen.findByText(/This item/)).toBeTruthy();
    expect(calls.every((c) => c.path !== '')).toBe(true);
  });
});

describe('catalog screens', () => {
  it('a reader sees the list and an item, with no way to add or change anything', async () => {
    const item = catalogItem({ name: 'Blocked drain', description: 'Up to one hour', unitPrice: '180.5' });
    const { user } = setup({ permissions: READER, items: [item] });
    await heading('Products & services');
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    const table = await screen.findByRole('table', { name: 'Products and services' });
    expect(within(table).getByText('$180.50')).toBeTruthy();
    expect(within(table).getByText('SVC-1')).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: 'Blocked drain' }));
    await heading('Blocked drain');
    expect(screen.getByText('Up to one hour')).toBeTruthy();
    for (const name of ['Save changes', 'Archive', 'Mark inactive', 'Restore']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByText(/keep their own copy of every line/)).toBeTruthy();
  });

  it('adds an item with its price, unit and tax, sending exact strings and no business id', async () => {
    const { user, calls, data } = setup({ items: [] });
    await heading('Products & services');
    expect(await screen.findByText('No products or services yet')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'New item' })[0]!);
    await heading('New product or service');
    await user.selectOptions(screen.getByLabelText('Type'), 'PRODUCT');
    await user.type(screen.getByLabelText('Name'), 'Copper pipe');
    await user.type(screen.getByLabelText(/^Code/), 'CU-15');
    await user.selectOptions(screen.getByLabelText('Unit'), 'm');
    await user.type(screen.getByLabelText(/^Default price/), '12.345');
    await user.selectOptions(screen.getByLabelText(/^Tax$/), 'RATE');
    await user.selectOptions(screen.getByLabelText('Tax rate'), data.rates[0]!.id);
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    await heading('Copper pipe');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      type: 'PRODUCT', name: 'Copper pipe', code: 'CU-15', description: null, unit: 'm', unitPrice: '12.345', currencyCode: 'AUD', taxMode: 'RATE',
      taxRateId: data.rates[0]!.id,
    });
    expect(JSON.stringify(post.body)).not.toContain('business');
    expect(screen.getByText('Copper pipe was added.')).toBeTruthy();
  });

  it('shows the server\'s duplicate-code refusal plainly and keeps the form', async () => {
    const { user } = setup({ items: [catalogItem({ code: 'DUP-1' })] });
    await heading('Products & services');
    await user.click(screen.getAllByRole('button', { name: 'New item' })[0]!);
    await heading('New product or service');
    await user.type(screen.getByLabelText('Name'), 'Another');
    await user.type(screen.getByLabelText(/^Code/), 'dup-1');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already uses that code/);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Another');
  });

  it('edits with the version it read; a stale edit says someone else changed it', async () => {
    const item = catalogItem({ name: 'Inspection', version: 4 });
    const { user, calls, items } = setup({ items: [item] });
    await user.click(await screen.findByRole('button', { name: 'Inspection' }));
    await heading('Inspection');
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Full inspection');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ version: 4, name: 'Full inspection' });
    // Someone else saves in between: the next edit is refused, never silently overwrites.
    items[0]!.version = 9;
    const again = await screen.findByLabelText('Name');
    await user.type(again, '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Someone else changed this item/);
  });

  it('marks inactive, archives (read-only) and restores, each with the current version', async () => {
    const item = catalogItem({ name: 'Old service', version: 2 });
    const { user, calls } = setup({ items: [item] });
    await user.click(await screen.findByRole('button', { name: 'Old service' }));
    await heading('Old service');
    await user.click(screen.getByRole('button', { name: 'Mark inactive' }));
    await screen.findByText(/Marked inactive/);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ version: 2, status: 'INACTIVE' });
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await screen.findByText(/Archived. Restore it at any time/);
    expect(calls.find((c) => c.path.endsWith('/archive'))!.body).toEqual({ version: 3 });
    // Archived: read-only, no edit form.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    expect(screen.getByText(/read-only until it is restored/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByText('Restored.');
    expect(calls.find((c) => c.path.endsWith('/restore'))!.body).toEqual({ version: 4 });
    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeTruthy();
  });

  it('filters by status and searches on the server, and pages with the cursor', async () => {
    const items = [catalogItem({ name: 'Alpha' }), catalogItem({ name: 'Beta', archivedAt: NOW })];
    const { user, calls } = setup({ items, nextCursor: 'next-page' });
    await screen.findByRole('button', { name: 'Alpha' });
    expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Status'), 'archived');
    await screen.findByRole('button', { name: 'Beta' });
    expect(calls.some((c) => c.method === 'GET' && c.query.includes('status=archived'))).toBe(true);
    await user.selectOptions(screen.getByLabelText('Status'), 'current');
    await user.type(screen.getByLabelText('Search'), 'alp');
    await waitFor(() => expect(calls.some((c) => c.query.includes('q=alp'))).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(calls.some((c) => c.query.includes('cursor=next-page'))).toBe(true));
    // A cursor belongs to its filters: changing a filter goes back to the first page without it.
    const before = calls.length;
    await user.selectOptions(screen.getByLabelText('Type'), 'SERVICE');
    await waitFor(() => expect(calls.slice(before).some((c) => c.query.includes('type=SERVICE'))).toBe(true));
    expect(calls.slice(before).filter((c) => c.query.includes('type=SERVICE')).every((c) => !c.query.includes('cursor='))).toBe(true);
  });
});
