// @vitest-environment jsdom
// GS-UI: the global search interface (docs/global-search-gs2.md). Built behind RECORD_SEARCH_ENABLED = false:
// the palette is tested directly, and the shell test pins that nothing is reachable while the constant is off.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchResponse, type SearchType } from '@business-os/contracts';
import { createSearchClient, type SearchClient, type SearchGroupView, type SearchOutcome, type SearchRow, type SearchView } from '../src/api/search';
import { AppShell } from '../src/shell/app-shell';
import { highlight } from '../src/shell/palette/highlight';
import { RECORD_SEARCH_ENABLED } from '../src/shell/palette/availability';
import { initialPaletteState, MAX_ROWS, paletteReducer, queryReady } from '../src/shell/palette/palette-state';
import { SearchPalette } from '../src/shell/palette/palette';
import { SearchEntry } from '../src/shell/palette/search-entry';
import { resolveNavigation, type ShellRoute } from '../src/shell/registry';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const nav = resolveNavigation({ state: 'ready', permissions: ['customers:read', 'sales:read', 'projects:read', 'finance:read'] });

function row(type: SearchType, title: string, over: Partial<SearchRow> = {}): SearchRow {
  const zone = type === 'customer' || type === 'contact' ? 'customers' : type === 'opportunity' ? 'sales' : type === 'project' || type === 'task' ? 'projects' : 'finance';
  return { type, id: randomUUID(), title, subtitle: null, badges: [], route: { zone, target: randomUUID() }, ...over };
}
const group = (type: SearchType, rows: SearchRow[], over: Partial<SearchGroupView> = {}): SearchGroupView => ({ type, rows, hasMore: false, nextCursor: null, ...over });
const view = (groups: SearchGroupView[], searchedTypes: SearchType[] = ['customer', 'opportunity', 'project']): SearchView => ({ searchedTypes, groups });

function fakeClient(impl: (input: Parameters<SearchClient['search']>[1]) => SearchOutcome<SearchView>) {
  const search = vi.fn(async (_slug: string, input: Parameters<SearchClient['search']>[1]) => impl(input));
  const resolve = vi.fn(async (): Promise<SearchOutcome<SearchRow[]>> => ({ kind: 'ok', data: [] }));
  return { client: { search, resolve } as SearchClient, search, resolve };
}

function mount(client: SearchClient, over: Partial<React.ComponentProps<typeof SearchPalette>> = {}) {
  const props = { open: true, onOpenChange: vi.fn(), client, slug: 'alpha', navigation: nav, onOpenRoute: vi.fn(), onOpenRecord: vi.fn(), onAccessLost: vi.fn(), recents: [], ...over };
  render(<SearchPalette {...props} />);
  return props;
}
const input = () => screen.getByRole('combobox', { name: 'Search or jump to' });

describe('palette state machine', () => {
  it('needs two characters, discards stale responses and clears on short input', () => {
    expect(queryReady('k')).toBe(false);
    expect(queryReady(' ké ')).toBe(true);
    let s = paletteReducer(initialPaletteState, { type: 'input', query: 'kelp' });
    const first = s.seq;
    s = paletteReducer(s, { type: 'input', query: 'kelpi' });
    s = paletteReducer(s, { type: 'searched', seq: first, view: view([group('customer', [row('customer', 'Old')])]) });
    expect(s.groups).toEqual([]);
    s = paletteReducer(s, { type: 'searched', seq: s.seq, view: view([group('customer', [row('customer', 'New')])]) });
    expect(s.phase).toBe('results');
    s = paletteReducer(s, { type: 'input', query: 'k' });
    expect(s).toMatchObject({ phase: 'idle', groups: [] });
  });

  it('replaces on the first page, appends and dedupes after, and stops at the cap or on an empty page', () => {
    const initial = [row('customer', 'A'), row('customer', 'B')];
    let s = paletteReducer(initialPaletteState, { type: 'input', query: 'kelp' });
    s = paletteReducer(s, { type: 'searched', seq: s.seq, view: view([group('customer', initial, { hasMore: true })]) });
    const more = [initial[0]!, initial[1]!, row('customer', 'C')];
    s = paletteReducer(s, { type: 'pageDone', seq: s.seq, group: 'customer', replace: true, page: group('customer', more, { hasMore: true, nextCursor: 'c1' }) });
    expect(s.groups[0]!.rows.map((r) => r.title)).toEqual(['A', 'B', 'C']);
    expect(s.groups[0]).toMatchObject({ expanded: true, hasMore: true, nextCursor: 'c1' });
    const d = row('customer', 'D');
    s = paletteReducer(s, { type: 'pageDone', seq: s.seq, group: 'customer', replace: false, page: group('customer', [more[2]!, d], { hasMore: true, nextCursor: 'c2' }) });
    expect(s.groups[0]!.rows.map((r) => r.title)).toEqual(['A', 'B', 'C', 'D']);
    // A page with nothing new ends the group (cursor-loop guard).
    s = paletteReducer(s, { type: 'pageDone', seq: s.seq, group: 'customer', replace: false, page: group('customer', [d], { hasMore: true, nextCursor: 'c3' }) });
    expect(s.groups[0]).toMatchObject({ hasMore: false, nextCursor: null });
    // The 100-row cap.
    const many = Array.from({ length: MAX_ROWS + 20 }, (_, i) => row('customer', `R${i}`));
    s = paletteReducer(s, { type: 'pageDone', seq: s.seq, group: 'customer', replace: true, page: group('customer', many, { hasMore: true, nextCursor: 'x' }) });
    expect(s.groups[0]).toMatchObject({ capped: true, hasMore: false });
    expect(s.groups[0]!.rows).toHaveLength(MAX_ROWS);
  });

  it('drops a page that belongs to an older query and resets the cursor on a 400', () => {
    let s = paletteReducer(initialPaletteState, { type: 'input', query: 'kelp' });
    s = paletteReducer(s, { type: 'searched', seq: s.seq, view: view([group('customer', [row('customer', 'A')], { hasMore: true })]) });
    const seq = s.seq;
    s = paletteReducer(s, { type: 'archived', value: true });
    const stale = paletteReducer(s, { type: 'pageDone', seq, group: 'customer', replace: true, page: group('customer', [row('customer', 'Z')]) });
    expect(stale).toBe(s);
    let t = paletteReducer(initialPaletteState, { type: 'input', query: 'kelp' });
    t = paletteReducer(t, { type: 'searched', seq: t.seq, view: view([group('customer', [row('customer', 'A')], { hasMore: true })]) });
    t = paletteReducer(t, { type: 'pageDone', seq: t.seq, group: 'customer', replace: true, page: group('customer', [row('customer', 'A')], { hasMore: true, nextCursor: 'bad' }) });
    t = paletteReducer(t, { type: 'pageFailed', seq: t.seq, group: 'customer', resetCursor: true });
    expect(t.groups[0]).toMatchObject({ paging: 'error', nextCursor: null, expanded: false });
  });
});

describe('highlight', () => {
  it('marks words ignoring case and diacritics, and never produces markup', () => {
    expect(highlight('Kelp & Co', 'kelp co')).toEqual([{ text: 'Kelp', match: true }, { text: ' & ', match: false }, { text: 'Co', match: true }]);
    expect(highlight('Café Ünique', 'cafe unique').filter((s) => s.match).map((s) => s.text)).toEqual(['Café', 'Ünique']);
    const hostile = '<img src=x onerror=alert(1)>';
    expect(highlight(hostile, 'img').map((s) => s.text).join('')).toBe(hostile);
  });
});

describe('search client', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const withFetch = (res: () => Response | Promise<Response>) => {
    const f = vi.fn((url: string, init?: RequestInit) => { void url; void init; return Promise.resolve(res()); });
    return { f, client: createSearchClient(BASE, { kind: 'cookie' }, f as unknown as typeof fetch) };
  };

  it('posts the text in the body, never the URL, and keeps only the six result fields', async () => {
    const id = randomUUID();
    const { f, client } = withFetch(() => ok({ searchedTypes: ['customer'], groups: [{ type: 'customer', zone: 'customers', hasMore: false, nextCursor: null, items: [{ type: 'customer', id, title: 'Kelp', subtitle: null, badges: ['archived'], route: { zone: 'customers', target: id } }] }] }));
    const out = await client.search('alpha', { q: 'kelp', types: ['customer'], limit: 5, includeArchived: false, cursor: null });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/v1/b/alpha/search`);
    expect(String(url)).not.toContain('kelp');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ q: 'kelp', types: ['customer'] });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(Object.keys(out.data.groups[0]!.rows[0]!).sort()).toEqual(['badges', 'id', 'route', 'subtitle', 'title', 'type']);
  });

  it('treats a response with a hostile extra field as invalid, and a business id in a request as a client error', async () => {
    const id = randomUUID();
    const hostile = { searchedTypes: ['customer'], groups: [{ type: 'customer', zone: 'customers', hasMore: false, nextCursor: null, items: [{ type: 'customer', id, title: 'Kelp', subtitle: null, badges: [], amount: '9999.00', route: { zone: 'customers', target: id } }] }] };
    expect(SearchResponse.safeParse(hostile).success).toBe(false);
    const { client, f } = withFetch(() => ok(hostile));
    expect((await client.search('alpha', { q: 'kelp', cursor: null, limit: 5, includeArchived: false })).kind).toBe('invalid');
    // A stray field never leaves the client.
    const bad = await client.search('alpha', { q: 'kelp', businessId: 'x' } as never);
    expect(bad.kind).toBe('invalid_input');
    expect(f).toHaveBeenCalledTimes(1);
    // Below two characters nothing is sent either.
    expect((await client.search('alpha', { q: 'k', cursor: null, limit: 5, includeArchived: false })).kind).toBe('invalid_input');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('keeps offline, signed-out, busy and server errors apart', async () => {
    const q = { q: 'kelp', cursor: null, limit: 5, includeArchived: false };
    const status = async (s: number, body?: unknown) => (await withFetch(() => ok(body ?? {}, s)).client.search('alpha', q)).kind;
    expect(await status(401)).toBe('unauthenticated');
    expect(await status(403, { error: 'forbidden' })).toBe('forbidden');
    expect(await status(429, { error: 'search_busy' })).toBe('busy');
    expect(await status(503, { error: 'search_timeout' })).toBe('busy');
    expect(await status(404)).toBe('not_found');
    expect(await status(500)).toBe('failed');
    expect((await withFetch(() => { throw new TypeError('offline'); }).client.search('alpha', q)).kind).toBe('unreachable');
  });

  it('resolves recents through POST /search/resolve', async () => {
    const id = randomUUID();
    const { f, client } = withFetch(() => ok({ items: [{ type: 'customer', id, title: 'Kelp', subtitle: null, badges: [], route: { zone: 'customers', target: id } }] }));
    const out = await client.resolve('alpha', [{ type: 'customer', id }]);
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/api/v1/b/alpha/search/resolve`);
    expect(out.kind === 'ok' && out.data[0]!.title).toBe('Kelp');
  });
});

describe('search palette', () => {
  it('shows commands only and makes no request under two characters', async () => {
    const { client, search, resolve } = fakeClient(() => ({ kind: 'ok', data: view([]) }));
    const user = userEvent.setup();
    mount(client);
    expect(screen.getByRole('option', { name: /Go to Customers/ })).toBeTruthy();
    await user.type(input(), 'k');
    await new Promise((r) => setTimeout(r, 300));
    expect(search).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('renders groups in Zone order with title, subtitle and fixed badge labels, and only those', async () => {
    const hostileRow = { ...row('invoice', 'INV-0042', { subtitle: 'Kelp & Co · due 3 Dec', badges: ['void'] }), amount: '12,000.00', notes: 'secret note' } as SearchRow;
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([
      group('invoice', [hostileRow]),
      group('customer', [row('customer', 'Kelp & Co Seafood', { subtitle: 'kelp@example.com', badges: ['archived', 'bogus' as never] })]),
    ], ['customer', 'invoice']) }));
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'kelp');
    const customers = await screen.findByRole('group', { name: 'Customers' });
    const finance = screen.getByRole('group', { name: 'Finance · Invoices' });
    expect(customers.compareDocumentPosition(finance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(customers).getByText('kelp@example.com')).toBeTruthy();
    expect(within(customers).getByText('Archived')).toBeTruthy();
    expect(within(customers).queryByText(/bogus/i)).toBeNull();
    const dom = document.body.textContent ?? '';
    expect(dom).not.toContain('12,000.00');
    expect(dom).not.toContain('secret note');
    expect(screen.getByText(/Searched: Customers and Finance/)).toBeTruthy();
  });

  it('sends one multi-type request with limit 5 for the Zones the person can open', async () => {
    const { client, search } = fakeClient(() => ({ kind: 'ok', data: view([]) }));
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'kelp');
    await screen.findByText(/No records match/);
    expect(search).toHaveBeenCalledTimes(1);
    const sent = search.mock.calls[0]![1];
    expect(sent).toMatchObject({ q: 'kelp', limit: 5, includeArchived: false, cursor: null });
    expect(sent.types).toEqual(['customer', 'contact', 'opportunity', 'project', 'task', 'quote', 'invoice', 'credit_note', 'catalog_item']);
    expect(search.mock.calls[0]![0]).toBe('alpha');
  });

  it('opens the active row with Enter, moves with the arrows and keeps focus in the input', async () => {
    const a = row('customer', 'Kelp One');
    const b = row('customer', 'Kelp Two');
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([group('customer', [a, b])]) }));
    const user = userEvent.setup();
    const props = mount(client);
    await user.type(input(), 'kelp');
    await screen.findByText('Two');
    const options = screen.getAllByRole('option', { name: /Kelp/ });
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(props.onOpenRecord).toHaveBeenCalledWith(b, 'kelp');
  });

  it('runs a command', async () => {
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([]) }));
    const user = userEvent.setup();
    const props = mount(client);
    await user.click(screen.getByRole('option', { name: /Go to Sales/ }));
    expect(props.onOpenRoute).toHaveBeenCalledWith({ zone: 'sales' });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Show more: first page has no cursor and replaces, then the cursor appends without duplicates', async () => {
    const five = Array.from({ length: 5 }, (_, i) => row('customer', `Kelp ${i}`));
    const extra = Array.from({ length: 20 }, (_, i) => row('customer', `Kelp more ${i}`));
    const more2 = [row('customer', 'Kelp last')];
    const { client, search } = fakeClient((i) => {
      if (i.cursor === 'c1') return { kind: 'ok', data: view([group('customer', [extra[19]!, ...more2])]) };
      if (i.types?.length === 1) return { kind: 'ok', data: view([group('customer', [...five, ...extra], { hasMore: true, nextCursor: 'c1' })]) };
      return { kind: 'ok', data: view([group('customer', five, { hasMore: true })]) };
    });
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'kelp');
    await user.click(await screen.findByRole('button', { name: 'Show more customers' }));
    await screen.findByText(/more 19/);
    expect(search.mock.calls[1]![1]).toMatchObject({ types: ['customer'], limit: 25, cursor: null });
    await user.click(screen.getByRole('button', { name: 'Show more customers' }));
    await screen.findByText(/last/);
    expect(search.mock.calls[2]![1]).toMatchObject({ types: ['customer'], limit: 25, cursor: 'c1' });
    expect(screen.getAllByText(/more 19/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Show more customers' })).toBeNull();
  });

  it('changing the text or Include archived discards expanded groups and cursors', async () => {
    const { client, search } = fakeClient((i) => ({ kind: 'ok', data: view([group('customer', [row('customer', 'Kelp')], { hasMore: i.cursor === null && i.types?.length !== 1 })]) }));
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'kelp');
    await screen.findByRole('button', { name: 'Show more customers' });
    await user.click(screen.getByRole('checkbox', { name: 'Include archived' }));
    await waitFor(() => expect(search.mock.calls.at(-1)![1]).toMatchObject({ includeArchived: true, cursor: null, limit: 5 }));
    expect(search.mock.calls.at(-1)![1].types!.length).toBeGreaterThan(1);
  });

  it('old rows disappear and cannot be opened while a new text or archived scope is loading', async () => {
    const old = row('customer', 'Kelp old');
    let release: (v: SearchOutcome<SearchView>) => void = () => {};
    let calls = 0;
    const search = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { kind: 'ok', data: view([group('customer', [old])]) } as SearchOutcome<SearchView>;
      return new Promise<SearchOutcome<SearchView>>((r) => { release = r; });
    });
    const client = { search, resolve: vi.fn() } as unknown as SearchClient;
    const user = userEvent.setup();
    const props = mount(client);
    await user.type(input(), 'kelp');
    await screen.findByRole('group', { name: 'Customers' });
    // A longer text: the first response is delayed, so nothing from the old text may be shown or opened.
    await user.type(input(), 'x');
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('group', { name: 'Customers' })).toBeNull();
    await user.keyboard('{Enter}');
    expect(props.onOpenRecord).not.toHaveBeenCalled();
    release({ kind: 'ok', data: view([group('customer', [row('customer', 'Kelpx new')])]) });
    await screen.findByText(/new/);
    // Include archived: the same rule while the scoped response is delayed.
    await user.click(screen.getByRole('checkbox', { name: 'Include archived' }));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/new/)).toBeNull();
    await user.keyboard('{Enter}');
    expect(props.onOpenRecord).not.toHaveBeenCalled();
    release({ kind: 'ok', data: view([group('customer', [row('customer', 'Kelpx archived')])]) });
    await screen.findByText(/archived/);
  });

  it('a 400 on a later page resets pagination: the next Show more has no cursor, replaces and does not loop', async () => {
    const five = Array.from({ length: 5 }, (_, i) => row('customer', `Kelp ${i}`));
    const page1 = Array.from({ length: 25 }, (_, i) => row('customer', `Kelp p${i}`));
    const fresh = Array.from({ length: 25 }, (_, i) => row('customer', `Kelp f${i}`));
    let single = 0;
    const { client, search } = fakeClient((i) => {
      if (i.types?.length !== 1) return { kind: 'ok', data: view([group('customer', five, { hasMore: true })]) };
      single += 1;
      if (single === 1) return { kind: 'ok', data: view([group('customer', page1, { hasMore: true, nextCursor: 'c1' })]) };
      if (single === 2) return { kind: 'failed', status: 400 };
      return { kind: 'ok', data: view([group('customer', fresh, { hasMore: false })]) };
    });
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'kelp');
    await user.click(await screen.findByRole('button', { name: 'Show more customers' }));
    await screen.findByText(/p24/);
    await user.click(screen.getByRole('button', { name: 'Show more customers' }));
    await waitFor(() => expect(screen.getAllByText(/Couldn't load more/).length).toBeGreaterThan(0));
    expect(search.mock.calls.at(-1)![1].cursor).toBe('c1');
    const before = search.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(search.mock.calls.length).toBe(before);
    await user.click(screen.getByRole('button', { name: 'Show more customers' }));
    await screen.findByText(/f24/);
    expect(search.mock.calls.at(-1)![1]).toMatchObject({ types: ['customer'], cursor: null, limit: 25 });
    expect(screen.queryByText(/p24/)).toBeNull();
  });

  it('no results names only the searched Zones and offers Include archived', async () => {
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([], ['customer', 'opportunity']) }));
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'zzz');
    expect(await screen.findByText(/No records match “zzz” in Customers and Sales/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('No results');
  });

  it.each([
    ['offline', { kind: 'unreachable' as const }, /You're offline/],
    ['server error', { kind: 'failed' as const, status: 500 }, /Search didn't finish/],
  ])('shows fixed copy for a %s and keeps the palette usable', async (_n, outcome, copy) => {
    const { client } = fakeClient(() => outcome);
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'cust');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(copy);
    expect(alert.textContent).not.toContain('cust');
    expect(screen.getByRole('option', { name: /Go to Customers/ })).toBeTruthy();
  });

  it('retries once when busy and then offers a retry; a retry succeeds', async () => {
    let calls = 0;
    const { client, search } = fakeClient(() => {
      calls += 1;
      return calls <= 2 ? { kind: 'busy' } : { kind: 'ok', data: view([group('customer', [row('customer', 'Kelp')])]) };
    });
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'kelp');
    expect(await screen.findByText('Search is busy. Try again.', {}, { timeout: 3000 })).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('group', { name: 'Customers' })).toBeTruthy();
  });

  it('signed out or no longer allowed (401/403) drops the results and tells the host', async () => {
    const { client } = fakeClient(() => ({ kind: 'forbidden' }));
    const user = userEvent.setup();
    const props = mount(client);
    await user.type(input(), 'kelp');
    await waitFor(() => expect(props.onAccessLost).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not search when the person can open no searchable Zone', async () => {
    const { client, search } = fakeClient(() => ({ kind: 'ok', data: view([]) }));
    const user = userEvent.setup();
    mount(client, { navigation: resolveNavigation({ state: 'ready', permissions: [] }) });
    await user.type(input(), 'kelp');
    await new Promise((r) => setTimeout(r, 300));
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByText(/not available/i)).toBeNull();
  });

  it('lists recents re-authorised through resolve and opens them', async () => {
    const r = row('customer', 'Recent Kelp');
    const { client, resolve } = fakeClient(() => ({ kind: 'ok', data: view([]) }));
    resolve.mockResolvedValue({ kind: 'ok', data: [r] });
    const user = userEvent.setup();
    const props = mount(client, { recents: [{ type: r.type, id: r.id }] });
    await user.click(await screen.findByRole('option', { name: /Recent Kelp/ }));
    expect(resolve).toHaveBeenCalledWith('alpha', [{ type: r.type, id: r.id }], expect.anything());
    expect(props.onOpenRecord).toHaveBeenCalledWith(r, '');
  });

  it('sends nothing and keeps no storage while closed or after a session', async () => {
    const { client, search, resolve } = fakeClient(() => ({ kind: 'ok', data: view([group('customer', [row('customer', 'Kelp')])]) }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mount(client, { open: false });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    cleanup();
    const user = userEvent.setup();
    mount(client);
    await user.type(input(), 'kelp');
    await screen.findByRole('group', { name: 'Customers' });
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('search entry (button, shortcut, context)', () => {
  function entry(client: SearchClient, over: { slug?: string; route?: ShellRoute; guarded?: (a: () => void) => void; onNavigate?: (r: ShellRoute) => void; navigation?: typeof nav } = {}) {
    const onNavigate = over.onNavigate ?? vi.fn();
    const guarded = over.guarded ?? ((a: () => void) => a());
    const tree = (o: typeof over) => (
      <SearchEntry search={{ client, onSessionEnded: vi.fn() }} slug={o.slug ?? 'alpha'} navigation={o.navigation ?? nav} route={o.route ?? { zone: 'home' }} guarded={o.guarded ?? guarded} onNavigate={o.onNavigate ?? onNavigate} compact={false} />
    );
    const view = render(tree(over));
    return { onNavigate, rerender: (o: typeof over) => view.rerender(tree(o)) };
  }

  it('opens from the button and from Ctrl/⌘+K, closes with Escape, and ignores editable fields', async () => {
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([]) }));
    const user = userEvent.setup();
    render(<><input aria-label="Other field" />{null}</>);
    entry(client);
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByLabelText('Other field'));
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(document.body);
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('navigates through the shell guard, and an unknown or unreadable Zone lands on Home', async () => {
    const target = row('customer', 'Kelp', { route: { zone: 'customers', target: 'abc' } });
    const finance = row('invoice', 'INV-1', { route: { zone: 'people', target: 'x' } });
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([group('customer', [target]), group('invoice', [finance])]) }));
    const guarded = vi.fn((a: () => void) => a());
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    entry(client, { guarded, onNavigate });
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await user.type(screen.getByRole('combobox'), 'kelp');
    await user.click(await screen.findByRole('option', { name: /Kelp/ }));
    expect(guarded).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenLastCalledWith({ zone: 'customers', target: 'abc' });
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await user.type(screen.getByRole('combobox'), 'inv');
    await user.click(await screen.findByRole('option', { name: /INV-1/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ zone: 'home' });
  });

  it('a cancelled guard reopens with the same text; a completed navigation starts fresh', async () => {
    const hit = row('customer', 'Kelp');
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([group('customer', [hit])]) }));
    const user = userEvent.setup();
    const cancel = vi.fn();
    const e = entry(client, { guarded: cancel });
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await user.type(screen.getByRole('combobox'), 'kelp');
    await user.click(await screen.findByRole('option', { name: /Kelp/ }));
    expect(cancel).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('kelp');
    await user.keyboard('{Escape}');
    e.rerender({ guarded: cancel, route: { zone: 'customers', target: 'abc' } });
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
  });

  it('a business switch empties the open palette in the same render', async () => {
    const { client } = fakeClient(() => ({ kind: 'ok', data: view([group('customer', [row('customer', 'Kelp')])]) }));
    const user = userEvent.setup();
    const e = entry(client);
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await user.type(screen.getByRole('combobox'), 'kelp');
    await screen.findByRole('group', { name: 'Customers' });
    e.rerender({ slug: 'beta' });
    expect(screen.queryByRole('group', { name: 'Customers' })).toBeNull();
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
  });
});

describe('enablement gate', () => {
  it('ships disabled, and the shell keeps the disabled button and makes no search request', async () => {
    expect(RECORD_SEARCH_ENABLED).toBe(false);
    const { client, search } = fakeClient(() => ({ kind: 'ok', data: view([]) }));
    const user = userEvent.setup();
    render(
      <AppShell
        business={{ slug: 'alpha', name: 'Alpha' }} businesses={[]} user={{ name: null, email: 'a@example.com' }} route={{ zone: 'home' }}
        navigation={nav} onNavigate={vi.fn()} onChooseBusiness={vi.fn()} onSignOut={vi.fn()} search={{ client, onSessionEnded: vi.fn() }}
      ><p>x</p></AppShell>,
    );
    const button = screen.getByRole('button', { name: 'Search (not available yet)' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await user.click(button);
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it('the source holds the guardrails: constant false, no raw hex, no HTML injection, no storage, no result iteration', () => {
    const dir = join(__dirname, '../src/shell/palette');
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    expect(readFileSync(join(dir, 'availability.ts'), 'utf8')).toMatch(/RECORD_SEARCH_ENABLED = false;/);
    for (const f of [...files.map((f) => join(dir, f)), join(__dirname, '../src/api/search.ts')]) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|history\.(push|replace)State/);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
      expect(src, f).not.toMatch(/Object\.(keys|entries|values)\s*\(\s*(row|result|r|o\.row)\b/);
      expect(src, f).not.toMatch(/rounded-(full|pill)|\bpill\b/i);
    }
  });
});
