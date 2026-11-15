// @vitest-environment jsdom
// Finance F6-1: recurring invoice screens against an in-memory schedule store in front of the F4 fake
// Finance API. The real Finance client parses every response with the shared contracts, so a shape
// mismatch fails here.
import type { RecurringInvoice, RecurringRun } from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createFinanceClient, type BusinessContext } from '../src';
import { FinanceZone } from '../src/zones/finance/finance-zone';
import { cadence, runProblem } from '../src/zones/finance/recurring';
import { createFakeFinance, financeData } from './support/fake-finance';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const NOW = '2026-11-15T00:00:00.000Z';
const BILLING = ['finance:read', 'finance:write', 'finance:issue', 'finance:billing'];
const READER = ['finance:read'];
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function template(over: Partial<RecurringInvoice> = {}): RecurringInvoice {
  return {
    id: randomUUID(), name: 'Monthly maintenance', customerId: randomUUID(), contactId: null, projectId: null, currencyCode: 'AUD', currencyScale: 2,
    frequency: 'MONTHLY', intervalCount: 1, startDate: '2026-10-31', endDate: null, timeZone: 'Australia/Perth', paymentTermsDays: 14, notes: null,
    lines: [{ description: 'Maintenance', quantity: '1', unitPrice: '100.00', discountAmount: '0.00', taxRateId: null }],
    status: 'ACTIVE', nextPeriodIndex: 1, nextRunOn: '2026-11-30', generatedCount: 1, failedCount: 1, pausedAt: null, cancelledAt: null, endedAt: null,
    version: 3, createdById: null, updatedById: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}
function run(t: RecurringInvoice, over: Partial<RecurringRun> = {}): RecurringRun {
  return {
    id: randomUUID(), recurringInvoiceId: t.id, periodIndex: 0, periodDate: '2026-10-31', status: 'FAILED', attempts: 1, maxAttempts: 5, runAfter: NOW,
    errorCode: 'archived_reference', documentId: null, documentStatus: null, documentNumber: null, trigger: 'SCHEDULE', requestedById: null,
    startedAt: NOW, finishedAt: NOW, createdAt: NOW, ...over,
  };
}

function setup(o: { permissions?: string[]; templates?: RecurringInvoice[]; runs?: RecurringRun[]; section?: string } = {}) {
  const templates = o.templates ?? [];
  const runs = o.runs ?? [];
  const api = createFakeFinance({ alpha: financeData() });
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /\/finance\/recurring-invoices(?:\/([^/]+))?(\/.*)?$/.exec(url.pathname);
    if (!m) return api.fetch(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const [, id, tail = ''] = m;
    calls.push({ method, path: `${id ?? ''}${tail}`, body });
    if (!id) return json(200, { recurringInvoices: templates, nextCursor: null });
    const t = templates.find((x) => x.id === id);
    if (!t) return json(404, { error: 'not_found' });
    if (tail === '' && method === 'GET') return json(200, { recurringInvoice: t });
    if (tail === '/preview') return json(200, { preview: { currencyCode: 'AUD', subtotal: '100.00', taxTotal: '0.00', total: '100.00', problem: null, periods: [{ periodIndex: 1, periodDate: '2026-11-30', dueDate: '2026-12-14' }] } });
    if (tail === '/runs') return json(200, { runs: runs.filter((r) => r.recurringInvoiceId === id), nextCursor: null });
    if (tail === '/pause') {
      if ((body as { version: number }).version !== t.version) return json(409, { error: 'version_conflict' });
      Object.assign(t, { status: 'PAUSED', pausedAt: NOW, version: t.version + 1 });
      return json(200, { recurringInvoice: t });
    }
    if (tail === '/generate') {
      const r = run(t, { periodIndex: t.nextPeriodIndex, periodDate: t.nextRunOn!, status: 'GENERATED', errorCode: null, documentId: randomUUID(), documentStatus: 'DRAFT', trigger: 'MANUAL' });
      runs.unshift(r);
      Object.assign(t, { nextPeriodIndex: t.nextPeriodIndex + 1, generatedCount: t.generatedCount + 1, version: t.version + 1 });
      return json(201, { run: r, recurringInvoice: t });
    }
    const action = /^\/runs\/([^/]+)\/(retry|skip)$/.exec(tail);
    if (action) {
      const r = runs.find((x) => x.id === action[1])!;
      Object.assign(r, action[2] === 'retry' ? { status: 'PENDING', errorCode: null } : { status: 'SKIPPED', errorCode: 'skipped_by_user' });
      return json(200, { run: r });
    }
    return json(404, { error: 'not_found' });
  }) as typeof globalThis.fetch;
  const permissions = o.permissions ?? BILLING;
  const finance = createFinanceClient(BASE, { kind: 'cookie' }, fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection: vi.fn(), onOpenCustomer: vi.fn() };
  render(
    <FinanceZone key="alpha" client={finance} customers={permissions.includes('customers:read') ? createCustomersClient(BASE, { kind: 'cookie' }, api.fetch) : undefined}
      context={ctx(permissions)} userLabel="Ada" section={o.section ?? 'invoices'} {...handlers} />,
  );
  return { calls, templates, runs, user: userEvent.setup() };
}

const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('recurring invoice words', () => {
  it('describes cycles and failure codes in plain language', () => {
    expect(cadence('MONTHLY', 1)).toMatch(/month/i);
    expect(cadence('WEEKLY', 2)).toMatch(/2 weeks/i);
    expect(runProblem(null)).toBeNull();
    expect(runProblem('archived_reference')).toMatch(/archived/);
    expect(runProblem('something_new')).toMatch(/could not be generated/);
  });
});

describe('recurring invoices screens', () => {
  it('opens from Invoices; a reader sees schedules but no way to create or change them', async () => {
    const t = template();
    const { user } = setup({ permissions: READER, templates: [t], runs: [run(t)] });
    await heading('Invoices');
    await user.click(screen.getAllByRole('button', { name: 'Recurring invoices' })[0]!);
    await heading('Recurring invoices');
    expect(screen.queryByRole('button', { name: 'New recurring invoice' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Monthly maintenance, open schedule/ }));
    await heading('Monthly maintenance');
    const history = await screen.findByRole('table', { name: 'Generation history' });
    expect(within(history).getByText('Failed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate next draft now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(within(history).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says plainly that drafts are never issued or sent automatically', async () => {
    const { user } = setup({ templates: [] });
    await heading('Invoices');
    await user.click(screen.getAllByRole('button', { name: 'Recurring invoices' })[0]!);
    await heading('Recurring invoices');
    expect(screen.getByText(/nothing is sent automatically/)).toBeTruthy();
    expect(await screen.findByText('No recurring invoices yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New recurring invoice' }).length).toBeGreaterThan(0);
  });

  it('pauses with the current version and retries a failed period', async () => {
    const t = template();
    const failed = run(t);
    const { user, calls } = setup({ templates: [t], runs: [failed] });
    await heading('Invoices');
    await user.click(screen.getAllByRole('button', { name: 'Recurring invoices' })[0]!);
    await user.click(await screen.findByRole('button', { name: /Monthly maintenance, open schedule/ }));
    await heading('Monthly maintenance');
    expect(await screen.findByText(/would total/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));
    await screen.findByText(/Schedule paused/);
    expect(calls.find((c) => c.path.endsWith('/pause'))?.body).toEqual({ version: 3 });
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();

    const history = await screen.findByRole('table', { name: 'Generation history' });
    await user.click(within(history).getByRole('button', { name: 'Retry' }));
    await screen.findByText(/queued and will be generated shortly/);
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith(`/runs/${failed.id}/retry`))).toBe(true);
  });

  it('"generate now" creates a draft and opens it, without issuing it', async () => {
    const t = template({ failedCount: 0 });
    const { user, calls } = setup({ templates: [t], runs: [] });
    await heading('Invoices');
    await user.click(screen.getAllByRole('button', { name: 'Recurring invoices' })[0]!);
    await user.click(await screen.findByRole('button', { name: /Monthly maintenance, open schedule/ }));
    await heading('Monthly maintenance');
    expect(await screen.findByText('No period has come up yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Generate next draft now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/It is not issued or sent/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Generate draft' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/generate'))).toBe(true));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/').pop())).toEqual(['generate']);
    expect(await screen.findByText(/Draft invoice generated from the schedule/)).toBeTruthy();
  });
});
