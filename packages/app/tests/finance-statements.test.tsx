// @vitest-environment jsdom
// Finance F6-2: the Receivables ageing view and the customer statement, against the in-memory Finance API
// with contract-valid statement and ageing answers. The real Finance client parses every response with
// the contracts, so a shape mismatch fails here.
import type { ReceivablesAgeing, ReceivablesAgeingDetail, Statement } from '@business-os/contracts';
import { ReceivablesAgeingDetailResponse, ReceivablesAgeingResponse, StatementResponse } from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createFinanceClient, type BusinessContext } from '../src';
import { CustomerFinance } from '../src/zones/finance/customer-finance';
import { FinanceZone, initialView } from '../src/zones/finance/finance-zone';
import { defaultFrom } from '../src/zones/finance/receivables';
import { customer } from './support/fake-api';
import { createFakeFinance, financeData } from './support/fake-finance';

const BASE = 'https://api.test';
const READ = ['finance:read', 'customers:read'];
const DOWNLOAD = [...READ, 'finance:documents_download'];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'MANAGER', permissions },
});

const acme = customer({ displayName: 'Acme Pty Ltd' });
const zero = { current: '0.00', days1To30: '0.00', days31To60: '0.00', days61To90: '0.00', days90Plus: '0.00', noDueDate: '0.00' };
const position = {
  buckets: { ...zero, days1To30: '50.00', days31To60: '100.00' }, receivable: '150.00', overdue: '150.00', unallocatedPayments: '90.00', unappliedCredit: '20.00',
  accountBalance: '40.00', balanced: true,
};
const ageing = (asOf: string): ReceivablesAgeing => ({
  asOf, timeZone: 'Australia/Perth',
  totals: [{ currencyCode: 'AUD', currencyScale: 2, openInvoiceCount: 2, customerCount: 1, ...position }],
  rows: [{ customerId: acme.id, currencyCode: 'AUD', currencyScale: 2, openInvoiceCount: 2, ...position }],
  nextCursor: null,
});
const detail = (asOf: string): ReceivablesAgeingDetail => ({
  asOf, timeZone: 'Australia/Perth', customerId: acme.id, currencyCode: 'AUD', currencyScale: 2, position,
  invoices: [
    { invoiceId: randomUUID(), number: 'INV-0001', issueDate: '2026-01-10', dueDate: '2026-02-09', total: '100.00', paid: '0.00', credited: '0.00', outstanding: '100.00', daysPastDue: 50, bucket: 'DAYS_31_60' },
    { invoiceId: randomUUID(), number: 'INV-0002', issueDate: '2026-02-05', dueDate: '2026-03-07', total: '50.00', paid: '0.00', credited: '0.00', outstanding: '50.00', daysPastDue: 24, bucket: 'DAYS_1_30' },
  ],
  credits: [
    { kind: 'PAYMENT', sourceId: randomUUID(), reference: 'EFT 1', date: '2026-02-01', available: '90.00' },
    { kind: 'CREDIT_NOTE', sourceId: randomUUID(), reference: 'CN-0001', date: '2026-02-15', available: '20.00' },
  ],
});
const statement = (q: Record<string, string>): Statement => ({
  customerId: q.customerId!, currencyCode: q.currencyCode!, currencyScale: 2, from: q.from!, to: q.to!, timeZone: 'Australia/Perth', openingBalance: '0.00',
  entries: [
    { date: '2026-01-10', type: 'INVOICE', sourceId: randomUUID(), reference: 'INV-0001', dueDate: '2026-02-09', amount: '100.00', balance: '100.00' },
    { date: '2026-02-01', type: 'PAYMENT', sourceId: randomUUID(), reference: 'EFT 1', dueDate: null, amount: '-60.00', balance: '40.00' },
  ],
  closingBalance: '40.00', position,
});

let clicked: { download: string }[] = [];
beforeEach(() => {
  clicked = [];
  URL.createObjectURL = vi.fn(() => 'blob:https://app.test/1');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ download: this.download });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(permissions: string[], o: { section?: string; target?: string } = {}) {
  const api = createFakeFinance({ alpha: financeData({ customers: [acme] }) });
  const base = api.fetch;
  // Statement and ageing answers (validated against the contracts before they are served).
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const q = Object.fromEntries(url.searchParams);
    const path = url.pathname.replace(/^\/api\/v1\/b\/alpha/, '');
    if (path === '/finance/receivables-ageing') {
      void base(input, init);
      return json(200, ReceivablesAgeingResponse.parse({ ageing: ageing(q.asOf ?? '2026-11-15') }));
    }
    if (path === '/finance/receivables-ageing/detail') {
      void base(input, init);
      return json(200, ReceivablesAgeingDetailResponse.parse({ detail: detail(q.asOf ?? '2026-11-15') }));
    }
    if (path === '/finance/statements') {
      void base(input, init);
      return json(200, StatementResponse.parse({ statement: statement(q) }));
    }
    if (path === '/finance/statements/pdf') {
      void base(input, init);
      return new Response('%PDF-1.7 statement', { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    return base(input, init);
  }) as typeof globalThis.fetch;
  const finance = createFinanceClient(BASE, { kind: 'cookie' }, fetch);
  const customers = createCustomersClient(BASE, { kind: 'cookie' }, fetch);
  render(
    <FinanceZone key="alpha" client={finance} customers={customers} context={ctx(permissions)} userLabel="Ada" section={o.section} initialTarget={o.target}
      onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} onSection={vi.fn()} onOpenCustomer={vi.fn()} />,
  );
  return { api, user: userEvent.setup() };
}

describe('receivables ageing', () => {
  it('shows buckets per customer with credit kept separate, a drill-down, and a statement link', async () => {
    const { api, user } = setup(READ, { section: 'receivables' });
    await screen.findByRole('heading', { name: 'Receivables ageing', level: 1 });
    const table = await screen.findByRole('table', { name: 'Receivables by customer' });
    expect(await within(table).findByText('Acme Pty Ltd')).toBeTruthy();
    expect(within(table).getByText('$150.00')).toBeTruthy();
    expect(within(table).getByText('$110.00')).toBeTruthy(); // credit: 90 unallocated + 20 unapplied, beside, not netted
    const totals = screen.getByLabelText('Totals in AUD');
    expect(within(totals).getByText('Payments not yet allocated')).toBeTruthy();
    expect(within(totals).getByText('$90.00')).toBeTruthy();

    await user.click(within(table).getByRole('button', { name: /Details for Acme Pty Ltd in AUD/ }));
    const invoices = await screen.findByRole('table', { name: 'Open invoices' });
    expect(within(invoices).getByText('INV-0001')).toBeTruthy();
    expect(within(invoices).getByText(/50 days past due/)).toBeTruthy();
    expect(screen.getByText(/Credit note CN-0001, not yet applied/)).toBeTruthy();

    const asOf = screen.getByLabelText('As of');
    await user.clear(asOf);
    await user.type(asOf, '2026-03-31');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/finance/receivables-ageing' && c.query.asOf === '2026-03-31')).toBe(true));

    await user.click(within(screen.getByRole('table', { name: 'Receivables by customer' })).getByRole('button', { name: /Statement for Acme Pty Ltd in AUD/ }));
    expect(await screen.findByRole('heading', { name: 'Statement for Acme Pty Ltd', level: 1 })).toBeTruthy();
  });

  it('never asks the server for a date after today', async () => {
    const { api, user } = setup(READ, { section: 'receivables' });
    await screen.findByRole('table', { name: 'Receivables by customer' });
    const before = api.calls.length;
    const asOf = screen.getByLabelText('As of');
    await user.clear(asOf);
    await user.type(asOf, '2999-01-01');
    expect(await screen.findByText('Choose a date on or before today.')).toBeTruthy();
    expect(api.calls.slice(before).some((c) => c.query.asOf === '2999-01-01')).toBe(false);
  });
});

describe('customer statement', () => {
  it('shows opening, dated activity and closing balances; no PDF download without finance:documents_download', async () => {
    const { api } = setup(READ, { target: `statement:${acme.id}:AUD` });
    expect(await screen.findByRole('heading', { name: 'Statement for Acme Pty Ltd', level: 1 })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Statement activity' });
    expect(within(table).getByText('Invoice INV-0001')).toBeTruthy();
    expect(within(table).getByText('Payment received EFT 1')).toBeTruthy();
    expect(within(table).getByText('Closing balance')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
    const call = api.calls.find((c) => c.path === '/finance/statements')!;
    expect(call.query).toMatchObject({ customerId: acme.id, currencyCode: 'AUD' });
    expect(call.query.from! <= call.query.to!).toBe(true);
  });

  it('downloads the PDF with finance:documents_download and says nothing was sent', async () => {
    const { api, user } = setup(DOWNLOAD, { target: `statement:${acme.id}:AUD` });
    await user.click(await screen.findByRole('button', { name: 'Download PDF' }));
    expect(await screen.findByText(/Nothing was sent to the customer/)).toBeTruthy();
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toMatch(/^statement-AUD-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(api.calls.filter((c) => c.path === '/finance/statements/pdf')).toHaveLength(1);
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('opens from shell targets, with or without a currency', () => {
    const can = { write: false, issue: false, payments: false, expenses: false, manage: false, billing: false, readCustomers: true };
    expect(initialView('receivables', `statement:${acme.id}:EUR`, undefined, can)).toEqual({ name: 'statement', customerId: acme.id, currencyCode: 'EUR' });
    expect(initialView('receivables', `statement:${acme.id}`, undefined, can)).toEqual({ name: 'statement', customerId: acme.id, currencyCode: undefined });
    expect(initialView('receivables', undefined, undefined, can)).toEqual({ name: 'receivables' });
    expect(defaultFrom('2026-02-15')).toBe('2025-11-01');
  });

  it('the customer page offers a statement per currency', async () => {
    const api = createFakeFinance({ alpha: financeData({ customers: [acme] }) });
    api.next((c) => (c.path === '/finance/customer-balances' ? json(200, {
      balances: [{ customerId: acme.id, currencyCode: 'AUD', currencyScale: 2, receivable: '25.00', overdue: '0.00', unallocatedPayments: '0.00', unappliedCredit: '5.00', creditAvailable: '5.00' }],
      asOf: '2026-11-15', nextCursor: null,
    }) : undefined));
    const onOpen = vi.fn();
    render(<CustomerFinance client={createFinanceClient(BASE, { kind: 'cookie' }, api.fetch)} slug="alpha" customerId={acme.id} timeZone="Australia/Perth" onOpen={onOpen} onSessionEnded={vi.fn()} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'AUD statement' }));
    expect(onOpen).toHaveBeenCalledWith(`statement:${acme.id}:AUD`);
  });
});
