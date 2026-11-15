// @vitest-environment jsdom
// Finance F4 inside the real application shell: leaving a supplier payment with unsaved changes through
// the Finance section navigation, the sidebar or a business switch asks first (audit F4 round 1, P1).
import type { FinanceExpense } from '@business-os/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, createFinanceClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { createFakeFinance, financeData } from './support/fake-finance';
import { switchBusiness } from './support/shell';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const PERMS = ['business:read', 'customers:read', 'finance:read', 'finance:write', 'finance:issue', 'finance:payments', 'finance:expenses', 'finance:manage'];
const USER = { id: randomUUID(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };
const ctx = (slug: string): BusinessContext => ({
  business: { slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions: PERMS },
});
const expense = (over: Partial<FinanceExpense> = {}): FinanceExpense => ({
  id: randomUUID(), status: 'RECORDED', categoryId: randomUUID(), categoryName: 'Rent', projectId: null, customerId: null, description: 'Studio rent', supplierName: 'Quayside',
  referenceNumber: null, notes: null, incurredOn: '2026-11-01', dueDate: '2026-11-07', currencyCode: 'AUD', currencyScale: 2, subtotal: '300.00', taxAmount: '30.00',
  total: '330.00', taxTreatment: 'TAX_INCLUSIVE', taxRateId: null, taxName: 'GST', taxRatePercent: '10', paidTotal: '0.00', outstanding: '330.00', paymentState: 'UNPAID',
  overdue: true, recordedAt: '2026-11-01T00:00:00.000Z', voidedAt: null, voidReason: null, version: 2, createdById: null, updatedById: null, recordedById: null,
  voidedById: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', allocations: [], ...over,
});

function mount() {
  const api = createFakeFinance({ alpha: financeData({ expenses: [expense()] }), beta: financeData() });
  const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: ['alpha', 'beta'].map((s) => ({ slug: s, name: ctx(s).business.name, role: 'OWNER' as const })) })),
    businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug) })),
    createBusiness: vi.fn(),
  };
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })}
    customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)} finance={createFinanceClient(BASE, { kind: 'cookie' }, api.fetch)} />);
  return { api, user: userEvent.setup() };
}
const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

async function openDirtySupplierPayment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(await screen.findByRole('navigation', { name: 'Zones' })).getByRole('button', { name: 'Finance' }));
  await h1('Finance');
  await user.click(screen.getAllByRole('button', { name: /^Expenses$/ })[0]!);
  await user.click(await screen.findByRole('button', { name: 'Quayside' }));
  await h1('Quayside');
  await user.click(screen.getByRole('button', { name: 'Record payment' }));
  await h1('Record supplier payment');
  await screen.findByLabelText('Amount for Quayside');
  await user.selectOptions(screen.getByLabelText('Method'), 'CASH'); // one field, no allocation change
}

describe('Finance inside the shell: unsaved supplier payment', () => {
  it('leaving through the Finance section navigation asks first, and "Keep editing" keeps the form', async () => {
    const { user } = mount();
    await openDirtySupplierPayment(user);
    await user.click(screen.getAllByRole('button', { name: /^Invoices$/ })[0]!);
    const ask = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Method') as HTMLSelectElement).value).toBe('CASH');
    await user.click(screen.getAllByRole('button', { name: /^Invoices$/ })[0]!);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(await h1('Invoices')).toBeTruthy();
  });

  it('switching business asks first; after discarding, nothing from the previous business is shown', async () => {
    const { api, user } = mount();
    await openDirtySupplierPayment(user);
    await switchBusiness(user, /Beta Plumbing/);
    const ask = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(ask).getByRole('button', { name: 'Discard changes' }));
    await screen.findByRole('button', { name: /Switch business.*Beta Plumbing/ });
    expect(screen.queryByText('Quayside')).toBeNull();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
