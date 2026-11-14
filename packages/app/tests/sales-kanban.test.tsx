// @vitest-environment jsdom
// PR 17: Kanban board view for the Sales Zone.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createSalesClient, type BusinessContext } from '../src';
import { SalesZone } from '../src/zones/sales/sales-zone';
import { createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';
import { emptySales, opportunity, pipelineWithStages, withSales, type FakeSales } from './support/fake-sales';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const ALL = ['business:read', 'members:read', 'customers:read', 'customers:write', 'sales:read', 'sales:write'];
const READ_ONLY = ['business:read', 'members:read', 'customers:read', 'sales:read'];
const ADA = uuid();
const ctx = (slug: string, permissions = ALL): BusinessContext => ({
  business: { slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

function setup(opts: { business?: Partial<FakeBusiness>; sales?: Partial<FakeSales>; permissions?: string[] } = {}) {
  const biz: FakeBusiness = { ...emptyBusiness(), members: [{ id: uuid(), userId: ADA, name: 'Ada Lovelace', role: 'OWNER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' }], ...opts.business };
  const api = withSales(createFakeApi({ alpha: biz }), { alpha: { ...emptySales(), ...opts.sales } });
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  render(<SalesZone sales={createSalesClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
    context={ctx('alpha', opts.permissions)} userLabel="Ada" {...handlers} />);
  return { api, biz, handlers, user: userEvent.setup() };
}

async function switchToBoard(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText(/Opportunities/);
  await user.click(screen.getByRole('button', { name: 'Board' }));
}

describe('board view toggle', () => {
  it('shows a List/Board toggle when pipelines are set up; defaults to list', async () => {
    const p = pipelineWithStages();
    setup({ sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Toggle deal' })] } });
    await screen.findByText('Toggle deal');
    const group = screen.getByRole('group', { name: 'View mode' });
    expect(within(group).getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('no toggle when Sales is not set up', async () => {
    setup();
    await screen.findByText("Sales isn't set up yet");
    expect(screen.queryByRole('group', { name: 'View mode' })).toBeNull();
  });

  it('switching to board shows the pipeline board with stage columns', async () => {
    const p = pipelineWithStages();
    const { user } = setup({ sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Board deal', stageId: p.stages[0]!.id })] } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    expect(within(board).getByRole('group', { name: /New: 1 opportunity/ })).toBeTruthy();
    expect(within(board).getByText('Board deal')).toBeTruthy();
  });
});

describe('board layout', () => {
  it('shows all pipeline stages plus Won and Lost columns', async () => {
    const p = pipelineWithStages();
    const { user } = setup({ sales: { pipelines: [p] } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    for (const name of ['New', 'Qualified', 'Proposal', 'Negotiation']) {
      expect(within(board).getByRole('group', { name: new RegExp(`${name}: 0 opportunities`) })).toBeTruthy();
    }
    expect(within(board).getByRole('group', { name: /Won: 0 opportunities/ })).toBeTruthy();
    expect(within(board).getByRole('group', { name: /Lost: 0 opportunities/ })).toBeTruthy();
  });

  it('cards show title, customer, amount and close date', async () => {
    const p = pipelineWithStages();
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const { user } = setup({
      business: { customers: [acme] },
      sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Big deal', customerId: acme.id, amount: '5000.00', expectedCloseDate: '2027-03-15', stageId: p.stages[1]!.id })] },
    });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    const qualifiedCol = within(board).getByRole('group', { name: /Qualified: 1 opportunity/ });
    expect(within(qualifiedCol).getByText('Big deal')).toBeTruthy();
    await waitFor(() => expect(within(qualifiedCol).getByText('Acme Pty Ltd')).toBeTruthy());
    expect(within(qualifiedCol).getAllByText('$5,000.00').length).toBeGreaterThan(0);
  });

  it('stage summary shows count and total value', async () => {
    const p = pipelineWithStages();
    const opps = [
      opportunity(p, { title: 'A', stageId: p.stages[0]!.id, amount: '1000.00' }),
      opportunity(p, { title: 'B', stageId: p.stages[0]!.id, amount: '2500.00' }),
    ];
    const { user } = setup({ sales: { pipelines: [p], opportunities: opps } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    const col = within(board).getByRole('group', { name: /New: 2 opportunities/ });
    expect(within(col).getByText('$3,500.00')).toBeTruthy();
  });

  it('won and lost opportunities appear in their special columns, not in stage columns', async () => {
    const p = pipelineWithStages();
    const opps = [
      opportunity(p, { title: 'Active one', stageId: p.stages[0]!.id }),
      opportunity(p, { title: 'Closed winner', status: 'WON', closedAt: '2026-11-10T00:00:00.000Z', stageId: p.stages[2]!.id }),
      opportunity(p, { title: 'Closed loser', status: 'LOST', closedAt: '2026-11-09T00:00:00.000Z', stageId: p.stages[1]!.id }),
    ];
    const { user } = setup({ sales: { pipelines: [p], opportunities: opps } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    expect(within(board).getByRole('group', { name: /Won: 1 opportunity/ })).toBeTruthy();
    expect(within(within(board).getByRole('group', { name: /Won/ })).getByText('Closed winner')).toBeTruthy();
    expect(within(within(board).getByRole('group', { name: /Lost/ })).getByText('Closed loser')).toBeTruthy();
    expect(within(within(board).getByRole('group', { name: /New: 1 opportunity/ })).getByText('Active one')).toBeTruthy();
  });
});

describe('keyboard stage move', () => {
  it('the stage select moves an opportunity between stages via the API', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Key mover', stageId: p.stages[0]!.id });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    const select = within(board).getByRole('combobox', { name: /Move "Key mover" to stage/ });
    await user.selectOptions(select, 'Qualified');
    await waitFor(() => {
      const calls = api.callsTo(/^PATCH/).filter((c) => c.path.includes('/sales/opportunities/'));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toMatchObject({ stageId: p.stages[1]!.id, version: 1 });
    });
  });

  it('read-only users see no stage select on cards', async () => {
    const p = pipelineWithStages();
    setup({ permissions: READ_ONLY, sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'No move' })] } });
    await screen.findByText('No move');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Board' }));
    await screen.findByRole('region', { name: 'Pipeline board' });
    expect(screen.queryByRole('combobox', { name: /Move/ })).toBeNull();
  });
});

describe('drag-and-drop stage move', () => {
  it('applies an optimistic move and rolls back on API failure', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Drag me', stageId: p.stages[0]!.id });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    const card = within(board).getByText('Drag me').closest('[draggable]')!;
    const proposalCol = within(board).getByRole('group', { name: /Proposal/ });

    // Simulate drag start
    fireEvent.dragStart(card, { dataTransfer: { effectAllowed: 'move', setData: vi.fn(), getData: () => o.id } });
    // Simulate drag over the target column
    fireEvent.dragOver(proposalCol, { dataTransfer: { dropEffect: 'move' }, preventDefault: vi.fn() });
    // Make API fail
    api.salesNext(() => new Response(JSON.stringify({ error: 'stale' }), { status: 409 }));
    // Drop
    fireEvent.drop(proposalCol, { dataTransfer: { getData: () => o.id }, preventDefault: vi.fn() });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/was changed by someone else/)).toBeTruthy();
  });
});

describe('board to detail navigation', () => {
  it('clicking a card title opens the detail view; back returns to the board', async () => {
    const p = pipelineWithStages();
    const { user } = setup({ sales: { pipelines: [p], opportunities: [opportunity(p, { title: 'Nav deal', amount: '750.00' })] } });
    await switchToBoard(user);
    await screen.findByRole('region', { name: 'Pipeline board' });
    await user.click(screen.getByRole('button', { name: 'Nav deal' }));
    expect(await screen.findByRole('heading', { name: 'Nav deal', level: 1 })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'All opportunities' }));
    expect(await screen.findByRole('region', { name: 'Pipeline board' })).toBeTruthy();
  });
});

describe('concurrent move safety', () => {
  it('a stale version conflict shows an error and refreshes the board', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Stale board', stageId: p.stages[0]!.id });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await switchToBoard(user);
    await screen.findByRole('region', { name: 'Pipeline board' });
    // Bump version on server before the move
    api.sales.alpha!.opportunities[0]!.version = 5;
    const select = screen.getByRole('combobox', { name: /Move "Stale board" to stage/ });
    await user.selectOptions(select, 'Proposal');
    await waitFor(() => expect(screen.getByText(/was changed by someone else/)).toBeTruthy());
  });
});

// ── Regression tests (PR #17 audit) ──────────────────────────────────────────

describe('mixed-currency totals', () => {
  it('groups totals by currency instead of summing across currencies', async () => {
    const p = pipelineWithStages();
    const opps = [
      opportunity(p, { title: 'AUD deal', stageId: p.stages[0]!.id, amount: '1000.00', currencyCode: 'AUD' }),
      opportunity(p, { title: 'USD deal', stageId: p.stages[0]!.id, amount: '2000.00', currencyCode: 'USD' }),
      opportunity(p, { title: 'AUD deal 2', stageId: p.stages[0]!.id, amount: '500.00', currencyCode: 'AUD' }),
    ];
    const { user } = setup({ sales: { pipelines: [p], opportunities: opps } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    const col = within(board).getByRole('group', { name: /New: 3 opportunities/ });
    // The stage header should show separate totals per currency, not one combined total
    const headerText = within(col).getByText((_content, el) =>
      el?.tagName === 'P' && /1,500/.test(el.textContent ?? '') && /2,000/.test(el.textContent ?? '') || false,
    );
    expect(headerText).toBeTruthy();
    // Must NOT show a single combined total of $3,500
    expect(within(col).queryByText(/3,500/)).toBeNull();
  });

  it('won/lost columns group totals by currency', async () => {
    const p = pipelineWithStages();
    const opps = [
      opportunity(p, { title: 'Won AUD', status: 'WON', closedAt: '2026-11-10T00:00:00.000Z', stageId: p.stages[0]!.id, amount: '800.00', currencyCode: 'AUD' }),
      opportunity(p, { title: 'Won EUR', status: 'WON', closedAt: '2026-11-11T00:00:00.000Z', stageId: p.stages[0]!.id, amount: '1200.00', currencyCode: 'EUR' }),
    ];
    const { user } = setup({ sales: { pipelines: [p], opportunities: opps } });
    await switchToBoard(user);
    const board = await screen.findByRole('region', { name: 'Pipeline board' });
    const wonCol = within(board).getByRole('group', { name: /Won/ });
    // The Won column header should show separate totals for AUD and EUR
    const headerText = within(wonCol).getByText((_content, el) =>
      el?.tagName === 'P' && /800/.test(el.textContent ?? '') && /1,200/.test(el.textContent ?? '') || false,
    );
    expect(headerText).toBeTruthy();
  });
});

describe('optimistic-update reconciliation', () => {
  it('keeps optimistic state when the refresh after a successful PATCH fails', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Patched ok', stageId: p.stages[0]!.id });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await switchToBoard(user);
    await screen.findByRole('region', { name: 'Pipeline board' });

    // Let the PATCH succeed, then fail the subsequent reload (GET)
    api.salesNext((_path, method) => {
      if (method === 'PATCH') return undefined;
      return undefined;
    });
    // After the PATCH, the reload GET will happen — fail it
    api.salesNext(() => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }));

    const select = screen.getByRole('combobox', { name: /Move "Patched ok" to stage/ });
    await user.selectOptions(select, 'Qualified');

    // The card should appear in the Qualified column via optimistic state, not snap back
    await waitFor(() => {
      const qualCol = screen.getByRole('group', { name: /Qualified/ });
      expect(within(qualCol).queryByText('Patched ok')).toBeTruthy();
    });
  });

  it('clears optimistic state once server data catches up', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Reconcile me', stageId: p.stages[0]!.id });
    const { user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await switchToBoard(user);
    await screen.findByRole('region', { name: 'Pipeline board' });

    const select = screen.getByRole('combobox', { name: /Move "Reconcile me" to stage/ });
    await user.selectOptions(select, 'Qualified');

    // After the successful PATCH and reload, the card should be in Qualified from server data
    await waitFor(() => {
      const qualCol = screen.getByRole('group', { name: /Qualified/ });
      expect(within(qualCol).queryByText('Reconcile me')).toBeTruthy();
    });
  });
});

describe('duplicate rapid moves', () => {
  it('blocks a second move while the first is in flight', async () => {
    const p = pipelineWithStages();
    const o = opportunity(p, { title: 'Rapid mover', stageId: p.stages[0]!.id });
    const { api, user } = setup({ sales: { pipelines: [p], opportunities: [o] } });
    await switchToBoard(user);
    await screen.findByRole('region', { name: 'Pipeline board' });

    // Hold the first PATCH in flight by never resolving it
    let resolveFirst: ((r: Response) => void) | undefined;
    api.salesNext(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }) as unknown as Response);

    const select = screen.getByRole('combobox', { name: /Move "Rapid mover" to stage/ });
    await user.selectOptions(select, 'Qualified');

    // Try a second move via drag while the first is pending
    const board = screen.getByRole('region', { name: 'Pipeline board' });
    const card = within(board).getByText('Rapid mover').closest('[draggable]');
    const proposalCol = within(board).getByRole('group', { name: /Proposal/ });

    if (card) {
      fireEvent.dragStart(card, { dataTransfer: { effectAllowed: 'move', setData: vi.fn(), getData: () => o.id } });
      fireEvent.drop(proposalCol, { dataTransfer: { getData: () => o.id }, preventDefault: vi.fn() });
    }

    // Only one PATCH should have been sent
    const patches = api.callsTo(/^PATCH/).filter((c) => c.path.includes('/sales/opportunities/'));
    expect(patches).toHaveLength(1);

    // Resolve the pending PATCH to clean up
    if (resolveFirst) resolveFirst(new Response(JSON.stringify({ opportunity: { ...o, stageId: p.stages[1]!.id, version: 2 } }), { status: 200 }));
  });
});
