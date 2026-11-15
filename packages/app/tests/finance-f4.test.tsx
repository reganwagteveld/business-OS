// @vitest-environment jsdom
// Finance F4: the Finance Zone interface (overview, quotes, invoices, credit notes, payments, settings and
// the customer's finance panel) against an in-memory Finance API. The real Finance and Customers clients
// and the shared contracts sit in front of it: every request body is contract-checked (strict) and every
// response is parsed with the contract, so a mismatch fails here.
import type { Customer, FinanceExpense } from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createFinanceClient, type BusinessContext } from '../src';
import { ZONES } from '../src/shell/registry';
import { CustomerFinance } from '../src/zones/finance/customer-finance';
import { compare, fromUnits, isPositive, subtract, sum, toUnits } from '../src/zones/finance/decimal';
import { FinanceZone, initialView } from '../src/zones/finance/finance-zone';
import { customer } from './support/fake-api';
import { createFakeFinance, doc, financeData, issued, type FinanceData } from './support/fake-finance';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const ALL = ['finance:read', 'finance:write', 'finance:issue', 'finance:payments', 'finance:expenses', 'finance:manage', 'customers:read'];
const MANAGER = ['finance:read', 'finance:write', 'finance:expenses', 'customers:read'];
const READER = ['finance:read'];
const ctx = (slug: string, permissions = ALL, name = 'Alpha Plumbing'): BusinessContext => ({
  business: { slug, name, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

function setup(o: { data?: FinanceData; permissions?: string[]; section?: string; target?: string; intent?: 'new'; extra?: Record<string, FinanceData>; before?: (api: ReturnType<typeof createFakeFinance>) => void } = {}) {
  const data = o.data ?? financeData();
  const api = createFakeFinance({ alpha: data, ...o.extra });
  o.before?.(api);
  const finance = createFinanceClient(BASE, { kind: 'cookie' }, api.fetch);
  const customers = createCustomersClient(BASE, { kind: 'cookie' }, api.fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection: vi.fn(), onOpenCustomer: vi.fn() };
  const permissions = o.permissions ?? ALL;
  const view = render(
    <FinanceZone key="alpha" client={finance} customers={permissions.includes('customers:read') ? customers : undefined} context={ctx('alpha', permissions)} userLabel="Ada"
      section={o.section} initialTarget={o.target} initialAction={o.intent} {...handlers} />,
  );
  return { api, data, finance, customers, handlers, view, user: userEvent.setup() };
}

function expenseOf(over: Partial<FinanceExpense> = {}): FinanceExpense {
  return {
    id: randomUUID(), status: 'RECORDED', categoryId: randomUUID(), categoryName: 'Rent', projectId: null, customerId: null, description: 'Studio rent', supplierName: 'Quayside',
    referenceNumber: null, notes: null, incurredOn: '2026-11-01', dueDate: '2026-11-07', currencyCode: 'AUD', currencyScale: 2, subtotal: '300.00', taxAmount: '30.00',
    total: '330.00', taxTreatment: 'TAX_INCLUSIVE', taxRateId: null, taxName: 'GST', taxRatePercent: '10', paidTotal: '0.00', outstanding: '330.00', paymentState: 'UNPAID',
    overdue: true, recordedAt: '2026-11-01T00:00:00.000Z', voidedAt: null, voidReason: null, version: 2, createdById: null, updatedById: null, recordedById: null,
    voidedById: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', allocations: [], ...over,
  };
}

function people(): { acme: Customer; zed: Customer } {
  return { acme: customer({ displayName: 'Acme Pty Ltd' }), zed: customer({ displayName: 'Zed Co' }) };
}

describe('exact decimals (no floating point)', () => {
  it('adds, subtracts and compares amount strings exactly at the currency scale', () => {
    expect(sum(['0.10', '0.20'], 2)).toBe('0.30');
    expect(sum(['99999999999999.99', '0.01'], 2)).toBe('100000000000000.00');
    expect(subtract('100.00', '33.33', 2)).toBe('66.67');
    expect(subtract('1', '2.5', 2)).toBe('-1.50');
    expect(compare('10.005', '10', 2)).toBeNull(); // more precision than the currency has
    expect(compare('1000', '999.99', 0)).toBeNull();
    expect(toUnits('1.20', 2)).toBe(120n);
    expect(fromUnits(5n, 2)).toBe('0.05');
    expect(isPositive('0.00')).toBe(false);
    expect(isPositive('0.01')).toBe(true);
    expect(sum(['abc'], 2)).toBeNull();
  });
});

describe('finance client', () => {
  it('refuses fields the server owns before sending, and sends the Idempotency-Key it is given', async () => {
    const api = createFakeFinance({ alpha: financeData() });
    const client = createFinanceClient(BASE, { kind: 'cookie' }, api.fetch);
    const bad = await client.createDocument('alpha', 'invoices', { customerId: randomUUID(), number: 'INV-9999', lines: [] }, 'k1');
    expect(bad.kind).toBe('invalid_input');
    const noKey = await client.recordPayment('alpha', { customerId: randomUUID(), amount: '1.5', receivedOn: '2026-11-01', method: 'CASH', total: '1.5' }, 'k2');
    expect(noKey.kind).toBe('invalid_input');
    expect(api.calls).toHaveLength(0);
    await client.recordPayment('alpha', { customerId: randomUUID(), amount: '1.50', receivedOn: '2026-11-01', method: 'CASH' }, 'key-123');
    expect(api.calls[0]!.headers['idempotency-key']).toBe('key-123');
    expect(typeof (api.calls[0]!.body as { amount: unknown }).amount).toBe('string'); // never a JSON number
  });
});

describe('navigation', () => {
  it('the registry gives Finance its sections, readable with finance:read only', () => {
    const fin = ZONES.find((z) => z.id === 'finance')!;
    expect(fin.requires).toEqual(['finance:read']);
    expect(fin.children?.map((c) => c.id)).toEqual(['overview', 'quotes', 'invoices', 'credit-notes', 'payments', 'expenses', 'settings']);
  });

  it('shell targets open the right record, and "new" respects permissions', () => {
    const can = { write: true, issue: true, payments: true, expenses: true, manage: true, readCustomers: true };
    expect(initialView('invoices', 'invoice:x', undefined, can)).toEqual({ name: 'document', path: 'invoices', id: 'x' });
    expect(initialView(undefined, 'abc', undefined, can)).toEqual({ name: 'expense', id: 'abc' }); // F3 bare expense id
    expect(initialView('quotes', undefined, 'new', can)).toEqual({ name: 'document-new', path: 'quotes' });
    expect(initialView('quotes', undefined, 'new', { ...can, write: false })).toEqual({ name: 'documents', path: 'quotes' });
    expect(initialView(undefined, undefined, undefined, can)).toEqual({ name: 'overview' });
  });
});

describe('overview', () => {
  it('shows receivables and payables per currency, never added across currencies, and never as cash or profit', async () => {
    const { acme, zed } = people();
    const data = financeData({
      customers: [acme, zed],
      documents: [
        issued('INVOICE', acme, 'INV-0001', { amount: '1000.00', dueDate: '2026-10-01' }),
        issued('INVOICE', zed, 'INV-0002', { amount: '250.50', currencyCode: 'USD' }),
        doc('INVOICE', { customerId: acme.id, amount: '40.00' }),
      ],
      payables: [{ currencyCode: 'AUD', currencyScale: 2, outstanding: '80.00', overdue: '0.00', openCount: 1, overdueCount: 0 }],
    });
    const { user, handlers } = setup({ data });
    await heading('Finance');
    const owed = await screen.findByRole('region', { name: 'Owed to you' });
    await within(owed).findByText('Outstanding on invoices (AUD)');
    expect(within(owed).getByText('Outstanding on invoices (USD)')).toBeTruthy();
    expect(owed.textContent).toContain('$1,000.00');
    expect(owed.textContent).toMatch(/US\$\s?250\.50|USD\s?250\.50/);
    expect(owed.textContent).not.toMatch(/1,250\.50/); // never added across currencies
    expect(owed.textContent).toContain('overdue on 1 of 1 open');
    expect(screen.getByRole('region', { name: 'You owe (recorded expenses)' }).textContent).toContain('$80.00');
    for (const label of screen.getAllByText(/\((AUD|USD)\)$/)) expect(label.textContent).not.toMatch(/cash|profit|revenue/i);
    // Attention: the overdue invoice and the unissued draft.
    const attention = screen.getByText('Needs attention').closest('section, div')!.parentElement!;
    await within(attention).findByText(/INV-0001 for Acme Pty Ltd is overdue/);
    expect(within(attention).getByText(/Draft invoice for Acme Pty Ltd is not issued yet/)).toBeTruthy();
    await user.click(within(attention).getByText(/INV-0001 for Acme Pty Ltd is overdue/));
    expect(await heading('INV-0001')).toBeTruthy();
    expect(handlers.onSection).toHaveBeenCalledWith('invoices');
  });

  it('quick actions follow the permission keys; a reader gets none', async () => {
    setup({ permissions: READER });
    await heading('Finance');
    for (const name of ['New invoice', 'New quote', 'Record payment', 'New expense']) expect(screen.queryByRole('button', { name })).toBeNull();
    cleanup();
    setup({ permissions: MANAGER });
    await heading('Finance');
    expect(screen.getByRole('button', { name: 'New invoice' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
  });

  it('a failed read is an error with Try again, never a zero', async () => {
    const { user } = setup({ before: (api) => api.next((c) => (c.path === '/finance/receivables' ? json(500, {}) : undefined)) });
    const owed = await screen.findByRole('region', { name: 'Owed to you' });
    expect(await within(owed).findByText('Something went wrong')).toBeTruthy();
    expect(owed.textContent).not.toMatch(/\$0\.00/);
    await user.click(within(owed).getByRole('button', { name: 'Try again' }));
    expect(await within(owed).findByText(/No issued invoices are open/)).toBeTruthy();
  });
});

describe('quotes', () => {
  it('drafts a quote with a picked customer and lines (contract-checked, idempotent), issues it with confirmation, accepts and converts it', async () => {
    const { acme } = people();
    const data = financeData({ customers: [acme] });
    const { api, user } = setup({ data, section: 'quotes' });
    await heading('Quotes');
    expect(await screen.findByText('No quotes yet')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'New quote' })[0]!);
    await heading('New quote');
    await user.type(screen.getByLabelText('Customer'), 'acme');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd/ }));
    await user.type(screen.getByLabelText('Description'), 'Install hot water system');
    await user.type(screen.getByLabelText('Unit price (AUD)'), '1200');
    await user.selectOptions(screen.getByLabelText('Tax'), data.rates[0]!.id);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await heading('Draft quote')).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/finance/quotes')!;
    expect(post.headers['idempotency-key']).toMatch(/.+/);
    expect(post.body).toEqual({
      customerId: acme.id, notes: null, validUntil: null, currencyCode: 'AUD',
      lines: [{ description: 'Install hot water system', quantity: '1', unitPrice: '1200', taxRateId: data.rates[0]!.id }],
    });
    // The server's totals, not the browser's.
    const amount = screen.getByText('Amount').closest('div')!.parentElement!;
    expect(amount.textContent).toContain('$1,200.00');
    expect(amount.textContent).toContain('$120.00');
    expect(amount.textContent).toContain('$1,320.00');

    await user.click(screen.getByRole('button', { name: 'Issue quote' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/QUO-0001/);
    expect(dialog.textContent).toContain('cannot be edited afterwards');
    await user.click(within(dialog).getByRole('button', { name: 'Issue quote' }));
    expect(await heading('QUO-0001')).toBeTruthy();
    expect(screen.getByText('Quote issued.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull(); // issued is read-only

    await user.click(screen.getByRole('button', { name: 'Mark accepted' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /accepted/i }));
    expect(await screen.findByText(/Acceptance is a recorded decision, not a payment/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Convert to invoice' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create draft invoice' }));
    expect(await heading('Draft invoice')).toBeTruthy();
    expect(screen.getByText(/Draft invoice created from the quote/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the quote' })).toBeTruthy();
  });

  it('a stale version is explained with a reload, and nothing is retried blindly', async () => {
    const { acme } = people();
    const draft = doc('QUOTE', { customerId: acme.id });
    const { api, user } = setup({ data: financeData({ customers: [acme], documents: [draft] }), target: `quote:${draft.id}` });
    await heading('Draft quote');
    draft.version = 5; // someone else edited it
    await user.click(screen.getByRole('button', { name: 'Issue quote' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue quote' }));
    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert.textContent).toContain('Someone else changed this record');
    expect(api.calls.filter((c) => c.path.endsWith('/issue'))).toHaveLength(1);
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('invoices', () => {
  it('lists with settlement filters on the server and separates unpaid, partly paid and paid', async () => {
    const { acme } = people();
    const data = financeData({
      customers: [acme],
      documents: [
        issued('INVOICE', acme, 'INV-0001'),
        issued('INVOICE', acme, 'INV-0002', { allocatedTotal: '40.00', settlementState: 'PARTIALLY_PAID' }),
        issued('INVOICE', acme, 'INV-0003', { allocatedTotal: '100.00', settlementState: 'PAID' }),
      ],
    });
    const { api, user } = setup({ data, section: 'invoices' });
    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(within(table).getByRole('row', { name: /INV-0001/ }).textContent).toContain('Unpaid');
    const partly = within(table).getByRole('row', { name: /INV-0002/ });
    expect(partly.textContent).toContain('Partly paid');
    expect(partly.textContent).toContain('$60.00'); // open = 100 − 40, exact
    expect(within(table).getByRole('row', { name: /INV-0003/ }).textContent).toContain('Paid');
    await user.selectOptions(screen.getByLabelText('Payment'), 'open');
    await waitFor(() => expect(api.calls.at(-1)?.query).toMatchObject({ settlement: 'open', status: 'all' }));
    await user.click(screen.getByLabelText('Overdue only'));
    await waitFor(() => expect(api.calls.at(-1)?.query).toMatchObject({ overdue: 'true' }));
  });

  it('a manager drafts but cannot issue or void; a reader sees no write actions', async () => {
    const { acme } = people();
    const draft = doc('INVOICE', { customerId: acme.id });
    const sent = issued('INVOICE', acme, 'INV-0009');
    setup({ data: financeData({ customers: [acme], documents: [draft, sent] }), permissions: MANAGER, target: `invoice:${draft.id}` });
    await heading('Draft invoice');
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).toBeNull();
    cleanup();
    setup({ data: financeData({ customers: [acme], documents: [sent] }), permissions: MANAGER, target: `invoice:${sent.id}` });
    await heading('INV-0009');
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create credit note' })).toBeTruthy();
    cleanup();
    setup({ data: financeData({ customers: [acme], documents: [sent] }), permissions: READER, target: `invoice:${sent.id}` });
    await heading('INV-0009');
    for (const name of ['Void', 'Record payment', 'Create credit note', 'Edit draft']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByText('Customer')).toBeTruthy(); // the bill-to snapshot names it without customers:read
    expect(screen.getAllByText('Acme Pty Ltd').length).toBeGreaterThan(0);
  });

  it('voiding needs a reason; an invoice with payments explains what to reverse first', async () => {
    const { acme } = people();
    const sent = issued('INVOICE', acme, 'INV-0004');
    const paid = issued('INVOICE', acme, 'INV-0005', { allocatedTotal: '10.00', settlementState: 'PARTIALLY_PAID' });
    const { api, user } = setup({ data: financeData({ customers: [acme], documents: [sent, paid] }), target: `invoice:${sent.id}` });
    await heading('INV-0004');
    await user.click(screen.getByRole('button', { name: 'Void' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Void invoice' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Reason/), 'Issued to the wrong customer');
    await user.click(confirm);
    await waitFor(() => expect(api.calls.find((c) => c.path.endsWith('/void'))?.body).toEqual({ version: 2, reason: 'Issued to the wrong customer' }));
    expect(await screen.findByText(/Voided.*Issued to the wrong customer.*The number stays in the sequence/)).toBeTruthy();
    cleanup();
    const second = setup({ data: financeData({ customers: [acme], documents: [paid] }), target: `invoice:${paid.id}` });
    await heading('INV-0005');
    await second.user.click(screen.getByRole('button', { name: 'Void' }));
    const d2 = await screen.findByRole('dialog');
    expect(d2.textContent).toContain('Reverse them first');
    expect((within(d2).getByRole('button', { name: 'Void invoice' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the draft form asks before discarding unsaved changes', async () => {
    const { acme } = people();
    const { user } = setup({ data: financeData({ customers: [acme] }), section: 'invoices', intent: 'new' });
    await heading('New invoice');
    await user.type(screen.getByLabelText('Description'), 'Half-done');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Half-done');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(await heading('Invoices')).toBeTruthy();
  });
});

describe('payments', () => {
  it('records a payment from an invoice with its allocation; a retry after a lost response reuses the Idempotency-Key and records it once', async () => {
    const { acme } = people();
    const inv = issued('INVOICE', acme, 'INV-0001', { amount: '300.00' });
    const data = financeData({ customers: [acme], documents: [inv] });
    const { api, user } = setup({ data, target: `invoice:${inv.id}` });
    await heading('INV-0001');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await heading('Record payment');
    const table = await screen.findByRole('table', { name: 'Open invoices' });
    await waitFor(() => expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('300.00')); // the invoice's open amount is suggested
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '120.50');
    const amountBox = within(table).getByLabelText('Amount for INV-0001') as HTMLInputElement;
    await user.clear(amountBox);
    await user.type(amountBox, '120.50');
    expect(screen.getByText(/Settling \$120\.50, leaving \$0\.00 unallocated/)).toBeTruthy();
    api.loseNextResponse('POST', '/finance/payments');
    await user.click(screen.getByRole('button', { name: /^Record \$120\.50/ }));
    // No answer: the server may have recorded it. Say so, and that retrying the same details is safe.
    expect((await screen.findByRole('alert')).textContent).toContain('may already have been recorded');
    expect(screen.getByRole('alert').textContent).toContain('will not be recorded twice');
    await user.click(screen.getByRole('button', { name: /^Record \$120\.50/ }));
    expect(await heading(/\$120\.50 from Acme Pty Ltd/)).toBeTruthy();
    const posts = api.calls.filter((c) => c.method === 'POST' && c.path === '/finance/payments');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers['idempotency-key']).toBe(posts[1]!.headers['idempotency-key']);
    expect(data.payments).toHaveLength(1);
    expect(posts[1]!.body).toMatchObject({ customerId: acme.id, amount: '120.50', method: 'BANK_TRANSFER', allocations: [{ invoiceId: inv.id, amount: '120.50' }] });
    expect(screen.getByText(/A manual record of money received outside Business OS/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/bank reconciliation|reconciled/i);
  });

  it('reverses an allocation (the payment stays) and then the payment, with a required reason', async () => {
    const { acme } = people();
    const inv = issued('INVOICE', acme, 'INV-0001', { amount: '300.00' });
    const data = financeData({ customers: [acme], documents: [inv] });
    const { api, user } = setup({ data, section: 'payments', intent: 'new' });
    await heading('Record payment');
    await user.type(screen.getByLabelText('Customer'), 'acme');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd/ }));
    await user.type(screen.getByLabelText('Amount'), '500');
    await user.click(screen.getByLabelText('Allocate it to invoices now'));
    const table = await screen.findByRole('table', { name: 'Open invoices' });
    await user.click(within(table).getByRole('checkbox'));
    expect((within(table).getByLabelText('Amount for INV-0001') as HTMLInputElement).value).toBe('300.00'); // up to what is open
    expect(screen.getByText(/leaving \$200\.00 unallocated/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Record \$500\.00/ }));
    await heading(/\$500\.00 from Acme Pty Ltd/);
    expect(screen.getByText('Unallocated (customer credit)').parentElement!.textContent).toContain('$200.00');
    await user.click(screen.getByRole('button', { name: 'Reverse' }));
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toContain('The payment stays recorded');
    await user.click(within(d).getByRole('button', { name: 'Reverse allocation' }));
    expect(await screen.findByText('Allocation reversed. The payment stays recorded.')).toBeTruthy();
    expect(data.payments[0]!.status).toBe('RECORDED');
    expect(inv.allocatedTotal).toBe('0.00');
    await user.click(screen.getByRole('button', { name: 'Reverse payment' }));
    const r = await screen.findByRole('dialog');
    expect((within(r).getByRole('button', { name: 'Reverse payment' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(r).getByLabelText(/Reason/), 'Cheque bounced');
    await user.click(within(r).getByRole('button', { name: 'Reverse payment' }));
    expect(await screen.findByText(/Reversed.*Cheque bounced/)).toBeTruthy();
    expect(api.calls.find((c) => c.path.endsWith('/reverse') && !c.path.includes('allocations'))?.body).toEqual({ version: 1, reason: 'Cheque bounced' });
  });

  it('over-allocation is caught before sending, and the server refusal is explained', async () => {
    const { acme } = people();
    const inv = issued('INVOICE', acme, 'INV-0001', { amount: '50.00' });
    const { user } = setup({ data: financeData({ customers: [acme], documents: [inv] }), target: `invoice:${inv.id}` });
    await heading('INV-0001');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByLabelText('Amount for INV-0001');
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '20');
    const box = await screen.findByLabelText('Amount for INV-0001');
    await user.clear(box);
    await user.type(box, '30');
    expect(screen.getByText(/\$10\.00 more than is available/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Record \$20\.00/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('expenses integration and submission safety', () => {
  it('a recorded, unpaid expense opens a supplier payment prefilled and matched, sent once with an Idempotency-Key', async () => {
    const e: FinanceExpense = {
      id: randomUUID(), status: 'RECORDED', categoryId: randomUUID(), categoryName: 'Rent', projectId: null, customerId: null, description: 'Studio rent', supplierName: 'Quayside',
      referenceNumber: null, notes: null, incurredOn: '2026-11-01', dueDate: '2026-11-07', currencyCode: 'AUD', currencyScale: 2, subtotal: '300.00', taxAmount: '30.00',
      total: '330.00', taxTreatment: 'TAX_INCLUSIVE', taxRateId: null, taxName: 'GST', taxRatePercent: '10', paidTotal: '0.00', outstanding: '330.00', paymentState: 'UNPAID',
      overdue: true, recordedAt: '2026-11-01T00:00:00.000Z', voidedAt: null, voidReason: null, version: 2, createdById: null, updatedById: null, recordedById: null,
      voidedById: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', allocations: [],
    };
    const data = financeData({ expenses: [e] });
    const { api, user } = setup({ data, target: e.id });
    await heading('Quayside');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await heading('Record supplier payment');
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('330.00');
    expect((await screen.findByLabelText('Amount for Quayside') as HTMLInputElement).value).toBe('330.00');
    const submit = screen.getByRole('button', { name: /^Record \$330\.00/ });
    await user.dblClick(submit); // a double click records once
    await heading(/\$330\.00 to Quayside/);
    const posts = api.calls.filter((c) => c.method === 'POST' && c.path === '/finance/expense-payments');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers['idempotency-key']).toMatch(/.+/);
    expect(posts[0]!.body).toMatchObject({ amount: '330.00', allocations: [{ expenseId: e.id, amount: '330.00' }] });
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0); // still no receipt uploads
  });

  it('every control in the finance forms has an accessible name, and dialogs are labelled', async () => {
    const { acme } = people();
    const { user } = setup({ data: financeData({ customers: [acme] }), section: 'invoices', intent: 'new' });
    await heading('New invoice');
    for (const el of document.querySelectorAll('main input, main select, main textarea, input, select, textarea')) {
      const id = el.getAttribute('id');
      const named = el.getAttribute('aria-label') || (id && document.querySelector(`label[for="${id}"]`)) || el.closest('label');
      expect(named, el.outerHTML.slice(0, 80)).toBeTruthy();
    }
    await user.type(screen.getByLabelText('Description'), 'x');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
  });
});

describe('audit corrections (F4 round 1)', () => {
  it('a supplier payment opened from an expense is not "unsaved" until the person edits it; any edit (no allocation change) arms the guard', async () => {
    const e = expenseOf();
    const { user } = setup({ data: financeData({ expenses: [e] }), target: e.id });
    await heading('Quayside');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await heading('Record supplier payment');
    await screen.findByLabelText('Amount for Quayside');
    // Hydrated from the expense only: leaving does not ask.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await heading('Quayside')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Editing one field (the reference) is an unsaved change: cancelling asks.
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByLabelText('Amount for Quayside');
    await user.type(screen.getByLabelText('Reference (optional)'), 'EFT 77');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
  });

  it('the expense a payment was started from is loaded and selected even when it is not in the first 100 open expenses', async () => {
    const many = Array.from({ length: 120 }, (_, i) => expenseOf({ supplierName: `Supplier ${i + 1}`, description: `Bill ${i + 1}` }));
    const last = many[119]!;
    const { api, user } = setup({ data: financeData({ expenses: many }), target: last.id });
    await heading('Supplier 120');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    const box = await screen.findByLabelText('Amount for Supplier 120') as HTMLInputElement;
    expect(box.value).toBe('330.00');
    expect(api.calls.some((c) => c.path === '/finance/expenses' && c.query.limit === '100')).toBe(true); // the page did not contain it
    expect(screen.queryByText(/will not be matched to any expense/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Record \$330\.00/ }));
    await heading(/\$330\.00 to Supplier 120/);
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/finance/expense-payments')!.body).toMatchObject({ allocations: [{ expenseId: last.id, amount: '330.00' }] });
  });

  it('the invoice a payment was started from is selected even when it is not in the first 100 open invoices; unticking it is called out', async () => {
    const { acme } = people();
    const invoices = Array.from({ length: 105 }, (_, i) => issued('INVOICE', acme, `INV-${String(i + 1).padStart(4, '0')}`, { amount: '10.00' }));
    const target = invoices[104]!;
    const { user } = setup({ data: financeData({ customers: [acme], documents: invoices }), target: `invoice:${target.id}` });
    await heading('INV-0105');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect((await screen.findByLabelText('Amount for INV-0105') as HTMLInputElement).value).toBe('10.00');
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('10.00');
    // Prefilled, untouched: leaving does not ask.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await heading('INV-0105')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByLabelText('Amount for INV-0105');
    await user.click(screen.getByLabelText('Allocate it to invoices now'));
    expect(screen.getByText(/will not be allocated to any invoice/)).toBeTruthy();
  });

  it('a lost answer on a supplier payment says it may already be recorded, and the identical retry reuses its Idempotency-Key', async () => {
    const e = expenseOf();
    const data = financeData({ expenses: [e] });
    const { api, user } = setup({ data, target: e.id });
    await heading('Quayside');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    await screen.findByLabelText('Amount for Quayside');
    api.loseNextResponse('POST', '/finance/expense-payments');
    await user.click(screen.getByRole('button', { name: /^Record \$330\.00/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('may already have been recorded');
    await user.click(screen.getByRole('button', { name: /^Record \$330\.00/ }));
    await heading(/\$330\.00 to Quayside/);
    const posts = api.calls.filter((c) => c.method === 'POST' && c.path === '/finance/expense-payments');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.headers['idempotency-key']).toBe(posts[0]!.headers['idempotency-key']);
    expect(data.expensePayments).toHaveLength(1);
  });

  it('a submit whose call rejects is shown as an uncertain outcome, the button comes back, and nothing is left unhandled', async () => {
    const { acme } = people();
    const inv = issued('INVOICE', acme, 'INV-0001');
    const data = financeData({ customers: [acme], documents: [inv] });
    const api = createFakeFinance({ alpha: data });
    const real = createFinanceClient(BASE, { kind: 'cookie' }, api.fetch);
    const client = { ...real, recordPayment: vi.fn(() => Promise.reject(new Error('boom'))) };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      render(<FinanceZone client={client} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} context={ctx('alpha')} userLabel="Ada"
        initialTarget={`invoice:${inv.id}`} onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
      const user = userEvent.setup();
      await heading('INV-0001');
      await user.click(screen.getByRole('button', { name: 'Record payment' }));
      await screen.findByLabelText('Amount for INV-0001');
      const submit = screen.getByRole('button', { name: /^Record \$100\.00/ });
      await user.click(submit);
      expect((await screen.findByRole('alert')).textContent).toContain('may already have been recorded');
      expect((submit as HTMLButtonElement).disabled).toBe(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('customer names still arrive under React Strict Mode (effects mounted twice)', async () => {
    const { acme } = people();
    const draft = doc('INVOICE', { customerId: acme.id });
    const api = createFakeFinance({ alpha: financeData({ customers: [acme], documents: [draft] }) });
    render(
      <StrictMode>
        <FinanceZone client={createFinanceClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} context={ctx('alpha')}
          userLabel="Ada" section="invoices" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />
      </StrictMode>,
    );
    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(await within(table).findByText('Acme Pty Ltd')).toBeTruthy(); // a draft has no snapshot: this is the live name
  });
});

describe('credit notes', () => {
  it('creates a credit note from an invoice, issues it and applies its credit (credit, not cash)', async () => {
    const { acme } = people();
    const inv = issued('INVOICE', acme, 'INV-0001', { amount: '200.00' });
    const data = financeData({ customers: [acme], documents: [inv] });
    const { api, user } = setup({ data, target: `invoice:${inv.id}` });
    await heading('INV-0001');
    await user.click(screen.getByRole('button', { name: 'Create credit note' }));
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toContain('Credit is not a refund or cash');
    await user.click(within(d).getByLabelText("Start from a copy of the invoice's lines"));
    await user.click(within(d).getByRole('button', { name: 'Create draft credit note' }));
    expect(await heading('Edit draft credit note')).toBeTruthy();
    expect(api.calls.find((c) => c.path.endsWith('/credit-notes') && c.method === 'POST')?.body).toEqual({ copyInvoiceLines: true });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await heading('Draft credit note');
    await user.click(screen.getByRole('button', { name: 'Issue credit note' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue credit note' }));
    await heading('CN-0001');
    await user.click(await screen.findByRole('button', { name: 'Apply credit to an invoice' }));
    const apply = await screen.findByRole('dialog');
    expect(apply.textContent).toContain('It is not cash received and not a refund');
    await within(apply).findByLabelText('Amount for INV-0001'); // the credited invoice is preselected
    await user.click(within(apply).getByRole('button', { name: 'Apply credit' }));
    expect(await screen.findByText('Credit applied.')).toBeTruthy();
    expect(inv.creditAppliedTotal).toBe('200.00');
  });
});

describe('settings', () => {
  it('a used series locks its starting number; a manager sees settings read-only; retention is not editable', async () => {
    const data = financeData();
    data.series[1]!.nextValue = 8; // invoices have been issued
    const { user } = setup({ data, section: 'settings' });
    await heading('Business details');
    expect(screen.getByText(/Retention policy: 7 years/)).toBeTruthy();
    expect(screen.queryByLabelText(/Retention/)).toBeNull();
    expect(screen.queryByLabelText(/Legal hold/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Numbering' }));
    await heading('Numbering');
    const invoices = (await screen.findByText('Invoices')).closest('section')!;
    expect(within(invoices).getByText('INV-0008')).toBeTruthy();
    expect((within(invoices).getByLabelText('Starting number') as HTMLInputElement).readOnly).toBe(true);
    expect(within(invoices).getByText(/Locked: this series has issued a number/)).toBeTruthy();
    const quotes = screen.getByText('Quotes').closest('section')!;
    expect((within(quotes).getByLabelText('Starting number') as HTMLInputElement).readOnly).toBe(false);
    cleanup();
    setup({ permissions: MANAGER, section: 'settings' });
    await heading('Business details');
    expect(await screen.findByText(/Only owners and admins can change them/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });

  it('saves seller details with the version it was based on', async () => {
    const data = financeData();
    const { api, user } = setup({ data, section: 'settings' });
    await heading('Business details');
    const legal = await screen.findByLabelText('Legal name');
    await user.clear(legal);
    await user.type(legal, 'Alpha Plumbing Group');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Settings saved/)).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/finance/settings')?.body).toMatchObject({ version: 0, sellerLegalName: 'Alpha Plumbing Group', defaultPaymentTermsDays: 14 });
  });
});

describe('business switch and customer permissions', () => {
  it('switching business remounts the Zone: nothing from the previous business is shown or requested', async () => {
    const { acme } = people();
    const alpha = financeData({ customers: [acme], documents: [issued('INVOICE', acme, 'INV-ALPHA')] });
    const beta = financeData({ customers: [], documents: [] });
    const { view, api } = setup({ data: alpha, section: 'invoices', extra: { beta } });
    await screen.findByRole('row', { name: /INV-ALPHA/ });
    const finance = createFinanceClient(BASE, { kind: 'cookie' }, api.fetch);
    const before = api.calls.length;
    view.rerender(<FinanceZone key="beta" client={finance} context={ctx('beta', ALL, 'Beta Builders')} userLabel="Ada" section="invoices" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(await screen.findByText('No invoices yet')).toBeTruthy();
    expect(screen.queryByText('INV-ALPHA')).toBeNull();
    expect(api.calls.slice(before).every((c) => c.slug === 'beta')).toBe(true);
  });

  it('the shell navigating to the section already open goes back to its list; the Zone moving itself does not reset', async () => {
    const { acme } = people();
    const inv = issued('INVOICE', acme, 'INV-0001');
    const data = financeData({ customers: [acme], documents: [inv] });
    const api = createFakeFinance({ alpha: data });
    const client = createFinanceClient(BASE, { kind: 'cookie' }, api.fetch);
    const props = { client, context: ctx('alpha', READER), userLabel: 'Ada', onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection: vi.fn() };
    const view = render(<FinanceZone key="z" {...props} section="invoices" navigation={{ n: 1 }} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /INV-0001/ }));
    await heading('INV-0001');
    view.rerender(<FinanceZone key="z" {...props} section="invoices" navigation={{ n: 2 }} />);
    expect(await heading('Invoices')).toBeTruthy();
  });

  it('without customers:read there is no customer search and no customer reads at all', async () => {
    const { acme } = people();
    const draft = doc('INVOICE', { customerId: acme.id });
    const { api } = setup({ data: financeData({ customers: [acme], documents: [draft] }), permissions: ['finance:read', 'finance:write'], section: 'invoices' });
    await screen.findByRole('table', { name: 'Invoices' });
    expect(screen.queryByLabelText('Customer')).toBeNull();
    expect(api.calls.some((c) => c.path.startsWith('/customers'))).toBe(false);
    expect(within(screen.getByRole('table', { name: 'Invoices' })).getAllByRole('row')[1]!.textContent).toContain('Customer'); // no live name without customers:read
  });

  it('the customer finance panel shows balances per currency and opens documents in Finance', async () => {
    const { acme } = people();
    const data = financeData({
      customers: [acme],
      documents: [issued('INVOICE', acme, 'INV-0001', { amount: '75.00', dueDate: '2026-10-01' }), issued('INVOICE', acme, 'INV-0002', { amount: '10.00', currencyCode: 'USD' })],
    });
    const api = createFakeFinance({ alpha: data });
    const onOpen = vi.fn();
    render(<CustomerFinance client={createFinanceClient(BASE, { kind: 'cookie' }, api.fetch)} slug="alpha" customerId={acme.id} locale="en-AU" timeZone="Australia/Perth" onOpen={onOpen} onSessionEnded={vi.fn()} />);
    const panel = await screen.findByRole('region', { name: 'Finance' });
    await within(panel).findByText('Open on invoices (AUD)');
    expect(within(panel).getByText('Open on invoices (USD)')).toBeTruthy();
    expect(within(panel).getAllByText('Overdue').some((el) => el.parentElement!.textContent!.includes('$75.00'))).toBe(true);
    await userEvent.setup().click(within(panel).getByRole('button', { name: /INV-0001/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.stringMatching(/^invoice:/));
    expect(api.calls.every((c) => c.path.startsWith('/finance/'))).toBe(true); // no customer reads from the panel
  });
});
