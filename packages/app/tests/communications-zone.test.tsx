// @vitest-environment jsdom
// Communications C2-UI-C: mailbox management against a stand-in for the connection API (real client and contracts).
// There is no mail anywhere in these tests, because the real API has none: the screens must say so and never simulate it.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCommunicationsClient, createCustomersClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { CommunicationsZone } from '../src/zones/communications/communications-zone';
import { createFakeApi, emptyBusiness, uuid, type FakeMember } from './support/fake-api';
import { connection, emptyComms, withComms, type FakeComms } from './support/fake-communications';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const MEMBER = ['business:read', 'members:read', 'communications:read'];
const CONNECT = [...MEMBER, 'communications:connect'];
const MANAGE = [...CONNECT, 'communications:manage_connections'];
const BOB = uuid();
const team = (): FakeMember[] => [{ id: uuid(), userId: BOB, name: 'Bob Builder', role: 'MEMBER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' }];
const ctx = (permissions: string[], role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' = 'MANAGER'): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role, permissions },
});

function setup(opts: { permissions?: string[]; role?: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER'; comms?: Partial<FakeComms>; returnResult?: string } = {}) {
  const permissions = opts.permissions ?? CONNECT;
  const api = withComms(createFakeApi({ alpha: { ...emptyBusiness(), members: team() } }), {
    alpha: { ...emptyComms(permissions.filter((p) => p.startsWith('communications:'))), role: opts.role ?? 'MANAGER', ...opts.comms },
  });
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  const openConsent = vi.fn();
  render(<CommunicationsZone client={createCommunicationsClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
    context={ctx(permissions, opts.role)} userLabel="Ada" openConsent={openConsent} returnResult={opts.returnResult} {...handlers} />);
  return { api, handlers, openConsent, user: userEvent.setup() };
}
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('honesty about mail', () => {
  it('says plainly that no mail is synced, and never calls a sync or mail endpoint', async () => {
    const { api } = setup({ comms: { connections: [connection()] } });
    expect(await screen.findByText('Mail is not available yet')).toBeTruthy();
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(api.calls.every((c) => !/sync|messages|conversations|send/.test(c.path))).toBe(true);
    expect(screen.queryByRole('button', { name: /sync now|refresh mail|compose|inbox/i })).toBeNull();
  });
});

describe('mailbox list', () => {
  it('loading, then an honest empty state', async () => {
    setup();
    expect(screen.getAllByRole('status').some((e) => e.textContent?.includes('Loading mailboxes'))).toBe(true);
    expect(await screen.findByText('No mailboxes connected')).toBeTruthy();
  });

  it('shows status, type and access, and a mailbox that needs reconnecting says why', async () => {
    setup({ comms: { connections: [
      connection({ mailboxAddress: 'ok@example.com' }),
      connection({ mailboxAddress: 'stale@example.com', status: 'NEEDS_REAUTH', lastErrorCode: 'owner_inactive', provider: 'MICROSOFT' }),
    ] } });
    const table = await screen.findByRole('table', { name: 'Mailboxes' });
    expect(within(table).getByText('Connected')).toBeTruthy();
    expect(within(table).getByText('Needs reconnecting')).toBeTruthy();
    expect(within(table).getAllByText('Only the owner').length).toBe(2);
  });

  it('shows a server failure with a retry that works', async () => {
    const { api, user } = setup({ comms: { connections: [connection()] } });
    api.commsNext((p) => (p.endsWith('/connections') ? new Response('{}', { status: 500 }) : undefined));
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
  });

  it('offline is its own message', async () => {
    const { api } = setup();
    api.commsNext((p) => (p.endsWith('/connections') ? 'network' : undefined));
    expect(await screen.findByText(/Can't reach|offline/i)).toBeTruthy();
  });
});

describe('connecting', () => {
  it('opens the provider consent once, and a provider this deployment lacks is disabled', async () => {
    const { user, openConsent, api } = setup();
    await screen.findByText('No mailboxes connected');
    expect((screen.getByRole('button', { name: /Connect Microsoft 365 mailbox/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Connect Google mailbox' }));
    await waitFor(() => expect(openConsent).toHaveBeenCalledTimes(1));
    expect(openConsent.mock.calls[0]![0]).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(api.callsTo(/POST .*\/connections\/authorize$/)[0]!.body).toEqual({ provider: 'GOOGLE' });
  });

  it('refuses a consent address on any other host', async () => {
    const { user, openConsent, api } = setup();
    await screen.findByText('No mailboxes connected');
    api.commsNext((p, m) => (m === 'POST' && p.endsWith('/authorize')
      ? new Response(JSON.stringify({ authorizationUrl: 'https://evil.example/phish', expiresAt: '2026-11-17T03:00:00.000Z' }), { status: 200, headers: { 'content-type': 'application/json' } }) : undefined));
    await user.click(screen.getByRole('button', { name: 'Connect Google mailbox' }));
    expect(await screen.findByText(/not recognised, so nothing was opened/)).toBeTruthy();
    expect(openConsent).not.toHaveBeenCalled();
  });

  it('people without communications:connect cannot start a connection', async () => {
    setup({ permissions: MEMBER });
    expect(await screen.findByText('No mailboxes connected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Connect Google/ })).toBeNull();
  });

  it('shows fixed wording for a return code and never echoes unknown ones', async () => {
    setup({ returnResult: 'connected' });
    expect(await screen.findByText('Mailbox connected. No mail is read yet.')).toBeTruthy();
    cleanup();
    setup({ returnResult: '<script>alert(1)</script>' });
    expect(await screen.findByText(/did not complete the connection/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('<script>alert');
  });
});

describe('managing a mailbox', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, address: string) => {
    await user.click(await screen.findByRole('button', { name: `Manage ${address}` }));
    return screen.findByRole('dialog');
  };

  it('sharing is refused until retention is set, with the reason, then works', async () => {
    const mine = connection();
    const { user, api } = setup({ comms: { connections: [mine] } });
    const dialog = await open(user, 'ada@example.com');
    await user.selectOptions(within(dialog).getByLabelText('Who can see this mailbox'), 'BUSINESS');
    expect(await within(dialog).findByText(/Set the ordinary retention period first/)).toBeTruthy();
    expect(mine.sharing).toBe('OWNER_ONLY');
    api.comms.alpha!.retention = { ordinaryRetentionDays: 400, updatedAt: null, version: 1 };
    await user.selectOptions(within(dialog).getByLabelText('Who can see this mailbox'), 'BUSINESS');
    await waitFor(() => expect(mine.sharing).toBe('BUSINESS'));
    expect(api.callsTo(/PATCH .*\/connections\//).at(-1)!.body).toMatchObject({ sharing: 'BUSINESS', version: 1 });
  });

  it('a stale change is reported, not applied', async () => {
    const mine = connection({ version: 3 });
    const { user } = setup({ comms: { connections: [mine] } });
    const dialog = await open(user, 'ada@example.com');
    mine.version = 4; // someone else changed it meanwhile
    await user.click(within(dialog).getByLabelText('Allow sync when it becomes available'));
    expect(await within(dialog).findByText(/Someone else changed this/)).toBeTruthy();
    expect(mine.syncEnabled).toBe(true);
  });

  it('disconnect asks first, says what it does not do, then disconnects', async () => {
    const mine = connection();
    const { user } = setup({ comms: { connections: [mine] } });
    const dialog = await open(user, 'ada@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/keeps the access you granted until you remove Pixa OS/)).toBeTruthy();
    expect(mine.status).toBe('ACTIVE');
    const confirm = (await screen.findAllByRole('button', { name: 'Disconnect' })).at(-1)!;
    await user.click(confirm);
    expect(await screen.findByText('ada@example.com was disconnected.')).toBeTruthy();
    expect(mine.status).toBe('DISCONNECTED');
  });

  it('someone else’s mailbox is read-only for a member and not even listed when private', async () => {
    const theirs = connection({ mailboxAddress: 'bob@example.com', isOwner: false, sharing: 'BUSINESS' });
    const hidden = connection({ mailboxAddress: 'secret@example.com', isOwner: false, sharing: 'OWNER_ONLY' });
    const { user } = setup({ permissions: CONNECT, comms: { connections: [theirs, hidden] } });
    expect(await screen.findByText('bob@example.com')).toBeTruthy();
    expect(screen.queryByText('secret@example.com')).toBeNull();
    const dialog = await open(user, 'bob@example.com');
    expect(within(dialog).queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(within(dialog).queryByLabelText('Who can see this mailbox')).toBeNull();
  });

  it('an administrator sees every mailbox but gets no reconnect or sharing control for a personal one that is not theirs', async () => {
    const theirs = connection({ mailboxAddress: 'bob@example.com', isOwner: false });
    const { user } = setup({ permissions: MANAGE, comms: { connections: [theirs] } });
    const dialog = await open(user, 'bob@example.com');
    expect(within(dialog).queryByLabelText('Who can see this mailbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Reconnect/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('business mailbox members: READ and SEND are separate and editable only with manage_connections', async () => {
    const biz = connection({ mailboxAddress: 'sales@example.com', kind: 'BUSINESS', sharing: 'MEMBERS', isOwner: false });
    const { user, api } = setup({ permissions: MANAGE, comms: { connections: [biz], members: { [biz.id]: [{ userId: BOB, access: 'READ', grantedById: uuid(), grantedAt: '2026-11-17T03:00:00.000Z', version: 1 }] } } });
    const dialog = await open(user, 'sales@example.com');
    expect(await within(dialog).findByText('Bob Builder')).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('Access for Bob Builder'), 'SEND');
    await waitFor(() => expect(api.callsTo(/PUT .*\/members\//).at(-1)!.body).toEqual({ access: 'SEND' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove Bob Builder' }));
    await waitFor(() => expect(api.comms.alpha!.members[biz.id]).toEqual([]));
  });

  it('a read-only person sees business members but cannot change them', async () => {
    const biz = connection({ mailboxAddress: 'sales@example.com', kind: 'BUSINESS', sharing: 'MEMBERS', isOwner: false });
    const { user } = setup({ permissions: CONNECT, comms: { connections: [biz], members: { [biz.id]: [{ userId: BOB, access: 'SEND', grantedById: uuid(), grantedAt: '2026-11-17T03:00:00.000Z', version: 1 }] } } });
    const dialog = await open(user, 'sales@example.com');
    expect(await within(dialog).findByText('Send')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Access for Bob Builder')).toBeNull();
  });
});

describe('business mailboxes and retention', () => {
  it('the Business mailboxes tab exists only with manage_connections', async () => {
    setup({ permissions: CONNECT });
    await screen.findByText('No mailboxes connected');
    expect(screen.queryByRole('button', { name: 'Business mailboxes' })).toBeNull();
  });

  it('shows the DNS record value once when a domain is added, then verifies it', async () => {
    const { user, api } = setup({ permissions: MANAGE });
    await user.click(await screen.findByRole('button', { name: 'Business mailboxes' }));
    await user.type(await screen.findByLabelText('Add a domain'), 'example.com');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(await screen.findByText('business-os-verification=abc')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('business-os-verification=abc')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Verify example.com' }));
    expect(await screen.findByText('Verified')).toBeTruthy();
    expect(api.callsTo(/POST .*\/verify$/)[0]!.body).toEqual({ version: 1 });
  });

  it('a consumer address needs an owner’s confirmation; a non-owner is told so', async () => {
    const owner = setup({ permissions: MANAGE, role: 'OWNER' });
    await owner.user.click(await screen.findByRole('button', { name: 'Business mailboxes' }));
    await owner.user.type(await screen.findByLabelText('Add a business address'), 'shop@gmail.com');
    await owner.user.click(screen.getByRole('button', { name: 'Add address' }));
    const confirm = await screen.findByRole('checkbox');
    expect((screen.getByRole('button', { name: 'Add address' }) as HTMLButtonElement).disabled).toBe(true);
    await owner.user.click(confirm);
    await owner.user.click(screen.getByRole('button', { name: 'Add address' }));
    expect(await screen.findByText('Owner confirmed')).toBeTruthy();
    expect(owner.api.callsTo(/POST .*\/business-addresses$/).at(-1)!.body).toEqual({ address: 'shop@gmail.com', attestation: { statement: 'v1', accepted: true } });
    cleanup();
    const admin = setup({ permissions: MANAGE, role: 'ADMIN' });
    await admin.user.click(await screen.findByRole('button', { name: 'Business mailboxes' }));
    await admin.user.type(await screen.findByLabelText('Add a business address'), 'shop@gmail.com');
    await admin.user.click(screen.getByRole('button', { name: 'Add address' }));
    expect(await screen.findByText('Only an owner can confirm a consumer address for business use.')).toBeTruthy();
  });

  it('retention has no default, can be set by a manager, and is read-only for others', async () => {
    const { user, api } = setup({ permissions: MANAGE });
    await user.click(await screen.findByRole('button', { name: 'Retention' }));
    expect(await screen.findByText('Not set')).toBeTruthy();
    await user.type(screen.getByLabelText('Retention period (days)'), '730');
    await user.click(screen.getByRole('button', { name: 'Save retention period' }));
    expect(await screen.findByText(/730 days/)).toBeTruthy();
    expect(api.callsTo(/PUT .*\/retention$/)[0]!.body).toEqual({ ordinaryRetentionDays: 730, version: null });
    cleanup();
    const reader = setup({ permissions: CONNECT });
    await reader.user.click(await screen.findByRole('button', { name: 'Retention' }));
    expect(await screen.findByText('Not set')).toBeTruthy();
    expect(screen.queryByLabelText('Retention period (days)')).toBeNull();
  });

  it('refuses a nonsense retention period before sending it', async () => {
    const { user, api } = setup({ permissions: MANAGE });
    await user.click(await screen.findByRole('button', { name: 'Retention' }));
    await user.type(await screen.findByLabelText('Retention period (days)'), '0');
    await user.click(screen.getByRole('button', { name: 'Save retention period' }));
    expect(await screen.findByText(/whole number of days/)).toBeTruthy();
    expect(api.callsTo(/PUT .*\/retention$/).length).toBe(0);
  });
});

describe('the app: navigation into Communications', () => {
  function mountApp(permissions: string[], search = '') {
    const api = withComms(createFakeApi({ alpha: { ...emptyBusiness(), members: team() } }), { alpha: { ...emptyComms(permissions.filter((p) => p.startsWith('communications:'))), connections: [connection()] } });
    const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: { id: BOB, email: 'ada@example.com', name: 'Ada', emailVerified: true } }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
    const tenancy: TenancyClient = {
      listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: 'Alpha Plumbing', role: 'MANAGER' as const }] })),
      businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: { ...ctx(permissions), business: { ...ctx(permissions).business, slug } } })),
      createBusiness: vi.fn(),
      platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: true } })),
    };
    const replaceLocation = vi.fn();
    render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
      communications={createCommunicationsClient(BASE, { kind: 'cookie' }, api.fetch)} storage={memoryStorage({ slug: 'alpha' })}
      location={{ pathname: '/', search }} replaceLocation={replaceLocation} />);
    return { api, replaceLocation, user: userEvent.setup() };
  }

  it('the Communications card opens Mailboxes; there is no Inbox entry', async () => {
    const { user } = mountApp(MEMBER);
    await user.click(await screen.findByRole('button', { name: 'Open the Communications Zone' }));
    expect(await heading('Mailboxes')).toBeTruthy();
    expect(screen.queryByText('Inbox')).toBeNull();
  });

  it('returning from the provider (?mailbox=connected) opens Mailboxes with fixed wording and cleans the address bar', async () => {
    const { replaceLocation } = mountApp(MEMBER, '?mailbox=connected');
    expect(await screen.findByText('Mailbox connected. No mail is read yet.')).toBeTruthy();
    expect(await heading('Mailboxes')).toBeTruthy();
    expect(replaceLocation).toHaveBeenCalledWith('/');
  });

  it('without communications:read the Zone is absent', async () => {
    mountApp(['business:read']);
    await screen.findByText(/Welcome to/);
    expect(screen.queryByRole('button', { name: 'Open the Communications Zone' })).toBeNull();
  });
});
