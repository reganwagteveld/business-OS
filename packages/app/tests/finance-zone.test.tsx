// @vitest-environment jsdom
// Finance F3: the expenses and categories screens against a small stand-in for the F3 API. The real
// Finance client and shared contracts sit in front of it, so every request body is contract-checked and
// every response is parsed with the contract.
import {
  CreateExpenseCategoryRequest, CreateExpenseRequest, RecordExpenseRequest, UpdateExpenseCategoryRequest, VoidExpenseRequest,
  type ExpenseCategory, type FinanceExpense,
} from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFinanceClient, type BusinessContext } from '../src';
import { FinanceZone } from '../src/zones/finance/finance-zone';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const NOW = '2026-11-14T03:00:00.000Z';
const ALL = ['finance:read', 'finance:write', 'finance:expenses', 'finance:payments', 'finance:manage', 'finance:issue'];
const MANAGER = ['finance:read', 'finance:write', 'finance:expenses'];
const ctx = (permissions = ALL): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'MANAGER', permissions },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function category(name: string, over: Partial<ExpenseCategory> = {}): ExpenseCategory {
  return { id: randomUUID(), name, position: 10, systemKey: null, archivedAt: null, version: 1, createdAt: NOW, updatedAt: NOW, ...over };
}
function expense(over: Partial<FinanceExpense> = {}): FinanceExpense {
  return {
    id: randomUUID(), status: 'DRAFT', categoryId: randomUUID(), categoryName: null, projectId: null, customerId: null, description: 'Flights', supplierName: 'Air Co',
    referenceNumber: null, notes: null, incurredOn: '2026-11-02', dueDate: null, currencyCode: 'AUD', currencyScale: 2, subtotal: '100.00', taxAmount: '10.00',
    total: '110.00', taxTreatment: 'TAX_INCLUSIVE', taxRateId: randomUUID(), taxName: 'GST', taxRatePercent: '10', paidTotal: '0.00', outstanding: '0.00',
    paymentState: null, overdue: false, recordedAt: null, voidedAt: null, voidReason: null, version: 1, createdById: null, updatedById: null, recordedById: null,
    voidedById: null, createdAt: NOW, updatedAt: NOW, allocations: [], ...over,
  };
}
const listItem = (e: FinanceExpense) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'allocations'));

/** In-memory F3 API: strict bodies through the contracts, versioned edits, and a call log. */
function fakeApi(data: { categories: ExpenseCategory[]; expenses: FinanceExpense[] }) {
  const calls: { method: string; path: string; query: Record<string, string>; body: unknown }[] = [];
  const next: ((path: string, method: string) => Response | undefined)[] = [];
  const rate = { id: randomUUID(), name: 'GST', ratePercent: '10', createdAt: NOW, updatedAt: NOW, archivedAt: null };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace('/api/v1/b/alpha/finance', '');
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), body });
    for (let i = 0; i < next.length; i++) {
      const r = next[i]!(path, method);
      if (r) {
        next.splice(i, 1);
        return r;
      }
    }
    let m: RegExpExecArray | null;
    if (path === '/expense-categories' && method === 'GET') {
      const archived = url.searchParams.get('archived');
      return json(200, { categories: data.categories.filter((c) => archived === 'all' || (archived === 'archived' ? c.archivedAt : !c.archivedAt)) });
    }
    if (path === '/expense-categories' && method === 'POST') {
      const input = CreateExpenseCategoryRequest.parse(body);
      if (data.categories.some((c) => !c.archivedAt && c.name.toLowerCase() === input.name.toLowerCase())) return json(409, { error: 'duplicate_name' });
      const c = category(input.name, { position: 999 });
      data.categories.push(c);
      return json(201, { category: c });
    }
    if ((m = /^\/expense-categories\/([^/]+)$/.exec(path)) && method === 'PATCH') {
      const input = UpdateExpenseCategoryRequest.parse(body);
      const c = data.categories.find((x) => x.id === m![1])!;
      if (c.version !== input.version) return json(409, { error: 'stale' });
      Object.assign(c, { name: input.name ?? c.name, position: input.position ?? c.position, version: c.version + 1 });
      if (input.archived !== undefined) c.archivedAt = input.archived ? NOW : null;
      return json(200, { category: c });
    }
    if (path === '/tax-rates') return json(200, { taxRates: [rate] });
    if (path === '/expense-payables') return json(200, { payables: { asOf: '2026-11-14', currencies: [] } });
    if (path === '/expenses' && method === 'GET') return json(200, { expenses: data.expenses.map(listItem), nextCursor: null });
    if (path === '/expenses' && method === 'POST') {
      const { amount: _amount, ...input } = CreateExpenseRequest.parse(body);
      const e = expense({ ...input, supplierName: input.supplierName ?? null, referenceNumber: input.referenceNumber ?? null, notes: input.notes ?? null,
        dueDate: input.dueDate ?? null, taxRateId: input.taxRateId ?? null, projectId: null, customerId: null, currencyCode: input.currencyCode ?? 'AUD',
        total: _amount, subtotal: _amount, taxAmount: '0.00' });
      data.expenses.push(e);
      return json(201, { expense: e });
    }
    if ((m = /^\/expenses\/([^/]+)(?:\/(record|void))?$/.exec(path))) {
      const e = data.expenses.find((x) => x.id === m![1]);
      if (!e) return json(404, { error: 'not_found' });
      if (!m[2]) return json(200, { expense: e });
      if (m[2] === 'record') {
        const input = RecordExpenseRequest.parse(body);
        if (e.version !== input.version) return json(409, { error: 'stale' });
        Object.assign(e, { status: 'RECORDED', version: e.version + 1, paymentState: input.paidInFull ? 'PAID' : 'UNPAID', paidTotal: input.paidInFull ? e.total : '0.00',
          outstanding: input.paidInFull ? '0.00' : e.total, recordedAt: NOW, categoryName: 'Travel' });
        return json(200, { expense: e });
      }
      const input = VoidExpenseRequest.parse(body);
      if (e.status === 'RECORDED' && /[1-9]/.test(e.paidTotal)) return json(409, { error: 'has_payments' });
      Object.assign(e, { status: 'VOID', version: e.version + 1, voidReason: input.reason ?? null, paymentState: null });
      return json(200, { expense: e });
    }
    return json(404, { error: 'not_found' });
  }) as typeof globalThis.fetch;
  return { fetch, calls, rate, next: (h: (path: string, method: string) => Response | undefined) => next.push(h) };
}

function setup(o: { permissions?: string[]; categories?: ExpenseCategory[]; expenses?: FinanceExpense[]; before?: (api: ReturnType<typeof fakeApi>) => void; section?: string } = {}) {
  const travel = category('Travel', { systemKey: 'travel' });
  const data = { categories: o.categories ?? [travel, category('Software', { systemKey: 'software', position: 20 })], expenses: o.expenses ?? [] };
  const api = fakeApi(data);
  o.before?.(api);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  // F4: the Zone opens on its overview; these F3 tests start in the Expenses section (or Settings for categories).
  render(<FinanceZone client={createFinanceClient(BASE, { kind: 'cookie' }, api.fetch)} context={ctx(o.permissions)} userLabel="Ada" section={o.section ?? 'expenses'} {...handlers} />);
  return { api, data, travel: data.categories[0]!, user: userEvent.setup() };
}
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('expense list', () => {
  it('loads, then shows an honest empty state with New expense', async () => {
    setup();
    expect(await screen.findByText('No expenses yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New expense' }).length).toBeGreaterThan(0);
  });

  it('shows the server\'s amounts and states exactly, with no browser arithmetic', async () => {
    const paid = expense({ status: 'RECORDED', supplierName: 'Cloud Ltd', total: '99999999999999.99', paymentState: 'PAID', categoryName: 'Software' });
    const late = expense({ status: 'RECORDED', supplierName: 'Hire Co', total: '50.00', paymentState: 'UNPAID', overdue: true });
    setup({ expenses: [paid, late] });
    const table = await screen.findByRole('table', { name: 'Expenses' });
    const row = within(table).getByRole('row', { name: /Cloud Ltd/ });
    for (const text of ['Recorded', 'Paid', 'Software', '99,999,999,999,999.99']) expect(row.textContent).toContain(text);
    expect(within(table).getByRole('row', { name: /Hire Co/ }).textContent).toContain('Overdue');
  });

  it('filters on the server: search, status, payment state, category and dates', async () => {
    const { api, user, travel } = setup();
    await screen.findByText('No expenses yet');
    await user.selectOptions(screen.getByLabelText('Status'), 'recorded');
    await user.selectOptions(screen.getByLabelText('Payment'), 'overdue');
    await user.selectOptions(screen.getByLabelText('Category'), travel.id);
    await user.type(screen.getByLabelText('Search'), 'hub');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/expenses' && c.query.q === 'hub')).toBe(true));
    const last = api.calls.filter((c) => c.path === '/expenses').at(-1)!;
    expect(last.query).toMatchObject({ status: 'recorded', payment: 'overdue', categoryId: travel.id, q: 'hub', limit: '25' });
    expect(await screen.findByText('No expenses match these filters')).toBeTruthy();
  });

  it('a failed load is an error with Try again, never an empty list', async () => {
    const { user } = setup({ expenses: [expense({ supplierName: 'Comes back' })], before: (api) => api.next((p) => (p === '/expenses' ? json(500, {}) : undefined)) });
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText('No expenses yet')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Comes back' })).toBeTruthy();
  });

  it('without finance:expenses there is nothing to create', async () => {
    setup({ permissions: ['finance:read'] });
    await screen.findByText('No expenses yet');
    expect(screen.queryByRole('button', { name: 'New expense' })).toBeNull();
  });
});

describe('expense form and lifecycle', () => {
  it('creates a draft with a contract-checked body and opens it', async () => {
    const { api, user } = setup();
    await user.click((await screen.findAllByRole('button', { name: 'New expense' }))[0]!);
    await heading('New expense');
    await user.type(screen.getByLabelText('Description'), 'Laptop');
    await user.type(screen.getByLabelText('Supplier'), 'Tech Store');
    await user.selectOptions(screen.getByLabelText('Tax'), 'TAX_INCLUSIVE');
    await user.selectOptions(screen.getByLabelText('Tax rate'), api.rate.id);
    await user.type(screen.getByLabelText('Total paid'), '1650.00');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await heading('Tech Store')).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/expenses')!;
    expect(post.body).toMatchObject({ description: 'Laptop', supplierName: 'Tech Store', taxTreatment: 'TAX_INCLUSIVE', taxRateId: api.rate.id, amount: '1650.00', currencyCode: 'AUD' });
    expect(post.body).not.toHaveProperty('total');
    expect(screen.getByRole('status').textContent).toContain('Draft expense saved');
  });

  it('shows the server\'s validation message and keeps the input', async () => {
    const { user } = setup({ before: (api) => api.next((p, m) => (p === '/expenses' && m === 'POST' ? json(400, { error: 'invalid_dates', message: 'An expense cannot be incurred in the future.' }) : undefined)) });
    await user.click((await screen.findAllByRole('button', { name: 'New expense' }))[0]!);
    await user.type(await screen.findByLabelText('Description'), 'Later');
    await user.type(screen.getByLabelText('Total paid'), '10');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be incurred in the future');
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Later');
  });

  it('records a draft as paid in full when the role may record payments', async () => {
    const draft = expense();
    const { api, user } = setup({ expenses: [draft] });
    await user.click(await screen.findByRole('button', { name: 'Air Co' }));
    await user.click(await screen.findByRole('button', { name: 'Record expense' }));
    await user.click(await screen.findByLabelText('It has already been paid in full'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record expense' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/record'))).toBe(true));
    expect(api.calls.find((c) => c.path.endsWith('/record'))!.body).toMatchObject({ version: 1, paidInFull: { method: 'BANK_TRANSFER' } });
    expect(await screen.findByText('Expense recorded and marked as paid.')).toBeTruthy();
  });

  it('a manager records without the payment option (finance:payments is not held)', async () => {
    const { api, user } = setup({ permissions: MANAGER, expenses: [expense()] });
    await user.click(await screen.findByRole('button', { name: 'Air Co' }));
    await user.click(await screen.findByRole('button', { name: 'Record expense' }));
    expect(screen.queryByLabelText('It has already been paid in full')).toBeNull();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record expense' }));
    await waitFor(() => expect(api.calls.find((c) => c.path.endsWith('/record'))?.body).toEqual({ version: 1 }));
  });

  it('voiding needs a reason; a paid expense explains that its payments must be reversed first', async () => {
    const recorded = expense({ status: 'RECORDED', supplierName: 'Hire Co', paymentState: 'UNPAID', version: 2 });
    const paid = expense({ status: 'RECORDED', supplierName: 'Paid Co', paymentState: 'PAID', paidTotal: '110.00', version: 2 });
    const { api, user } = setup({ expenses: [recorded, paid] });
    await user.click(await screen.findByRole('button', { name: 'Hire Co' }));
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('button', { name: 'Void expense' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Reason'), 'Duplicate bill');
    await user.click(within(dialog).getByRole('button', { name: 'Void expense' }));
    await waitFor(() => expect(api.calls.find((c) => c.path.endsWith('/void'))?.body).toEqual({ version: 2, reason: 'Duplicate bill' }));
    await user.click(await screen.findByRole('button', { name: 'All expenses' }));
    await user.click(await screen.findByRole('button', { name: 'Paid Co' }));
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    expect(within(screen.getByRole('dialog')).getByText(/Reverse those payment links first/)).toBeTruthy();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Void expense' })).toBeNull();
  });

  it('a recorded expense offers no edit and shows no receipt upload or download', async () => {
    const { user } = setup({ expenses: [expense({ status: 'RECORDED', paymentState: 'UNPAID' })] });
    await user.click(await screen.findByRole('button', { name: 'Air Co' }));
    await heading('Air Co');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText(/receipt/i)).toBeNull();
    expect(document.querySelectorAll('a[href^="http"], a[href^="blob:"], a[download], input[type="file"]')).toHaveLength(0);
  });
});

describe('categories', () => {
  it('adds, renames and archives categories (finance:manage)', async () => {
    const { api, user } = setup({ section: 'settings' });
    await user.click(await screen.findByRole('button', { name: 'Expense categories' }));
    await heading('Expense categories');
    await user.type(screen.getByLabelText('New category'), 'Training');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect(await screen.findByText('Training was added.')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Expense categories' });
    await user.click(within(within(table).getByRole('row', { name: /Software/ })).getByRole('button', { name: 'Rename' }));
    const box = screen.getByLabelText('New name for Software');
    await user.clear(box);
    await user.type(box, 'Software and SaaS');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Category renamed.')).toBeTruthy();
    await screen.findByText('Software and SaaS');
    const travelRow = within(screen.getByRole('table', { name: 'Expense categories' })).getByRole('row', { name: /^Travel/ });
    await waitFor(() => expect((within(travelRow).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(travelRow).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Travel archived.')).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ version: 1, name: 'Software and SaaS' }, { version: 1, archived: true }]);
  });

  it('a duplicate name is explained; without finance:manage the list is read-only', async () => {
    const { user } = setup({ section: 'settings' });
    await user.click(await screen.findByRole('button', { name: 'Expense categories' }));
    await user.type(await screen.findByLabelText('New category'), 'travel');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already has that name');
    cleanup();
    const ro = setup({ permissions: MANAGER, section: 'settings' });
    await ro.user.click(await screen.findByRole('button', { name: 'Expense categories' }));
    await screen.findByRole('table', { name: 'Expense categories' });
    expect(screen.queryByLabelText('New category')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });
});
