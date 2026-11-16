// @vitest-environment jsdom
// Finance F7-B (docs/finance-catalog-f7b.md): adding catalog products and services to draft quote and
// invoice lines, against the in-memory Finance API (every request body is contract-checked, strict).
import type { CatalogItem, Customer } from '@business-os/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createFinanceClient, type BusinessContext } from '../src';
import { catalogLineStart, catalogPriceNote } from '../src/zones/finance/catalog-picker';
import { FinanceZone } from '../src/zones/finance/finance-zone';
import { financeMessage } from '../src/zones/finance/shared';
import { customer } from './support/fake-api';
import { createFakeFinance, doc, financeData, NOW, type FinanceData } from './support/fake-finance';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const WRITER = ['finance:read', 'finance:write', 'finance:issue', 'customers:read'];
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

function catalogItem(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: randomUUID(), type: 'SERVICE', name: 'Call-out', description: null, code: 'SVC-1', unit: 'job', unitPrice: '95', currencyCode: 'AUD', taxMode: 'NONE',
    taxRateId: null, taxRate: null, status: 'ACTIVE', archivedAt: null, version: 1, createdById: null, updatedById: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function setup(o: { data: FinanceData; permissions?: string[]; section?: string; target?: string; intent?: 'new' }) {
  const api = createFakeFinance({ alpha: o.data });
  const finance = createFinanceClient(BASE, { kind: 'cookie' }, api.fetch);
  const customers = createCustomersClient(BASE, { kind: 'cookie' }, api.fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection: vi.fn(), onOpenCustomer: vi.fn() };
  const permissions = o.permissions ?? WRITER;
  render(
    <FinanceZone key="alpha" client={finance} customers={permissions.includes('customers:read') ? customers : undefined} context={ctx(permissions)} userLabel="Ada"
      section={o.section} initialTarget={o.target} initialAction={o.intent} {...handlers} />,
  );
  return { api, user: userEvent.setup() };
}

async function pickCustomer(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByLabelText('Customer'), name.slice(0, 4));
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
}

describe('line start values (mirror of the server defaults)', () => {
  const live = (id: string) => id !== 'archived-rate';
  it('copies name and description, the price only in the same currency, and the item tax', () => {
    const item = catalogItem({ name: 'Install', description: 'Per unit', unitPrice: '80', taxMode: 'RATE', taxRateId: 'gst' });
    expect(catalogLineStart(item, 'AUD', 'default', live)).toEqual({ description: 'Install\nPer unit', unitPrice: '80', taxRateId: 'gst', taxNote: null });
    expect(catalogLineStart(item, 'USD', 'default', live).unitPrice).toBe('');
    expect(catalogLineStart({ ...item, taxMode: 'BUSINESS_DEFAULT', taxRateId: null }, 'AUD', 'default', live).taxRateId).toBe('default');
    expect(catalogLineStart({ ...item, taxMode: 'NONE', taxRateId: null }, 'AUD', 'default', live).taxRateId).toBe('');
    expect(catalogLineStart({ ...item, taxRateId: 'archived-rate' }, 'AUD', 'default', live)).toMatchObject({ taxRateId: '', taxNote: expect.stringMatching(/archived/) });
    expect(catalogLineStart({ ...item, name: 'n'.repeat(200), description: 'd'.repeat(2000) }, 'AUD', '', live).description).toHaveLength(1000);
  });
  it('explains a missing price; error codes have words', () => {
    expect(catalogPriceNote({ unitPrice: null, currencyCode: 'AUD' }, 'AUD')).toMatch(/no default price/);
    expect(catalogPriceNote({ unitPrice: '5', currencyCode: 'USD' }, 'AUD')).toMatch(/in USD.*never converted/);
    expect(catalogPriceNote({ unitPrice: '5', currencyCode: 'AUD' }, 'AUD')).toBeNull();
    expect(financeMessage('catalog_item_inactive')).toMatch(/inactive/);
    expect(financeMessage('archived_reference')).toMatch(/product or service/);
  });
});

describe('adding catalog items to drafts', () => {
  it('searches active items only, adds one as an editable line next to a manual line, and sends catalogItemId with the values shown', async () => {
    const acme: Customer = customer({ displayName: 'Acme Pty Ltd' });
    const data = financeData({ customers: [acme] });
    const gst = data.rates[0]!.id;
    const drain = catalogItem({ name: 'Blocked drain', code: 'DRN-1', description: 'Up to one hour', unitPrice: '180.5', taxMode: 'RATE', taxRateId: gst });
    data.catalog = [drain, catalogItem({ name: 'Drain camera', status: 'INACTIVE' }), catalogItem({ name: 'Drain old', archivedAt: NOW })];
    const { api, user } = setup({ data, section: 'quotes', intent: 'new' });
    await heading('New quote');
    await pickCustomer(user, 'Acme Pty Ltd');
    await user.type(screen.getByLabelText('Description'), 'Manual line');
    await user.type(screen.getByLabelText('Unit price (AUD)'), '10');

    await user.click(screen.getByRole('button', { name: 'Add from catalog' }));
    const picker = screen.getByRole('region', { name: 'Add a product or service' });
    await user.type(within(picker).getByLabelText('Search the catalog'), 'drain');
    const results = await within(picker).findByRole('list', { name: 'Matching products and services' });
    expect(within(results).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringContaining('Blocked drain')]);
    await user.click(within(results).getByRole('button', { name: /Blocked drain/ }));
    expect(screen.queryByRole('region', { name: 'Add a product or service' })).toBeNull();
    expect(screen.getByText('Added Blocked drain as line 2.')).toBeTruthy();

    const line2 = screen.getByRole('group', { name: 'Line 2' });
    expect(within(line2).getByText('From catalog: Blocked drain (DRN-1)')).toBeTruthy();
    expect((within(line2).getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Blocked drain\nUp to one hour');
    expect((within(line2).getByLabelText('Unit price (AUD)') as HTMLInputElement).value).toBe('180.5');
    expect((within(line2).getByLabelText('Tax') as HTMLSelectElement).value).toBe(gst);
    await user.clear(within(line2).getByLabelText('Quantity'));
    await user.type(within(line2).getByLabelText('Quantity'), '2');

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await heading('Draft quote')).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/finance/quotes')!;
    expect((post.body as { lines: unknown[] }).lines).toEqual([
      { description: 'Manual line', quantity: '1', unitPrice: '10', taxRateId: null },
      { catalogItemId: drain.id, description: 'Blocked drain\nUp to one hour', quantity: '2', unitPrice: '180.5', taxRateId: gst },
    ]);
  });

  it('never converts: an item priced in another currency leaves the price empty and says why; switching currency follows the item', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const data = financeData({ customers: [acme] });
    data.catalog = [catalogItem({ name: 'US licence', unitPrice: '99', currencyCode: 'USD' })];
    const { user } = setup({ data, section: 'invoices', intent: 'new' });
    await heading('New invoice');
    await user.click(screen.getByRole('button', { name: 'Remove line 1' }));
    await user.click(screen.getByRole('button', { name: 'Add from catalog' }));
    expect(await screen.findByText(/price in USD/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /US licence/ }));
    const line = screen.getByRole('group', { name: 'Line 1' });
    expect((within(line).getByLabelText('Unit price (AUD)') as HTMLInputElement).value).toBe('');
    expect(within(line).getByText(/This item's price is in USD\. Enter a price in AUD/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    expect((within(line).getByLabelText('Unit price (USD)') as HTMLInputElement).value).toBe('99');
    await user.selectOptions(screen.getByLabelText('Currency'), 'AUD');
    expect((within(line).getByLabelText('Unit price (AUD)') as HTMLInputElement).value).toBe('');
    // A price the person typed is theirs: a currency switch never overwrites it.
    await user.type(within(line).getByLabelText('Unit price (AUD)'), '150');
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    expect((within(line).getByLabelText('Unit price (USD)') as HTMLInputElement).value).toBe('150');
  });

  it('shows the server refusal for an item archived after it was picked, and "Keep as manual line" saves without the item', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const draft = doc('INVOICE', { customerId: acme.id, billToSnapshot: null });
    const data = financeData({ customers: [acme], documents: [draft] });
    const item = catalogItem({ name: 'Retiring service' });
    data.catalog = [item];
    const { api, user } = setup({ data, target: `invoice:${draft.id}` });
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    await heading(/Edit draft invoice/);
    await user.click(screen.getByRole('button', { name: 'Add from catalog' }));
    await user.click(await screen.findByRole('button', { name: /Retiring service/ }));
    item.archivedAt = NOW; // archived by someone else meanwhile
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/product or service.*archived/);
    const n = draft.lines.length + 1;
    await user.click(screen.getByRole('button', { name: `Keep line ${n} as a manual line` }));
    expect(screen.queryByText(/From catalog:/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await heading(/Draft invoice/)).toBeTruthy();
    const patches = api.calls.filter((c) => c.method === 'PATCH');
    const last = (patches[patches.length - 1]!.body as { lines: Record<string, unknown>[] }).lines;
    expect(last[last.length - 1]).toEqual({ description: 'Retiring service', quantity: '1', unitPrice: '95', taxRateId: null });
  });

  it('is offered on quotes and invoices only, never on credit notes', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const cn = doc('CREDIT_NOTE', { customerId: acme.id });
    const data = financeData({ customers: [acme], documents: [cn] });
    data.catalog = [catalogItem()];
    const { user } = setup({ data, target: `credit-note:${cn.id}` });
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    await heading(/Edit draft credit note/);
    expect(screen.queryByRole('button', { name: 'Add from catalog' })).toBeNull();
  });
});
