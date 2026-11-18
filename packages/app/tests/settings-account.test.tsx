// @vitest-environment jsdom
// A3-A: Account › Profile, Password and Signed-in devices, against a stand-in for the /api/v1/me routes (real
// account client and contracts in front of it, so a request or response that breaks the contract fails here).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@business-os/contracts';
import { App, createAccountClient, createSettingsClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { resetPreferenceMemory } from '../src/shell/preferences';
import { createFakeSettings } from './support/fake-settings';
import { uuid } from './support/fake-api';

const BASE = 'https://api.test';
const PASSWORD = 'correct horse battery staple';
const MEMBER = ['business:read', 'members:read'];

type Call = { method: string; path: string; body?: unknown };

/** The /api/v1/me routes as the server answers them: strict bodies, the same status codes and error codes. */
function createFakeAccount(initialName: string) {
  const calls: Call[] = [];
  const state = { name: initialName, password: PASSWORD, failNext: [] as ('network' | number)[] };
  const here = uuid();
  const now = '2026-11-18T06:00:00.000Z';
  let sessions: AccountSession[] = [
    { id: here, client: 'browser', current: true, createdAt: now, lastActiveAt: now, expiresAt: '2026-12-18T06:00:00.000Z' },
    { id: uuid(), client: 'desktop', current: false, createdAt: '2026-11-10T01:00:00.000Z', lastActiveAt: '2026-11-17T09:30:00.000Z', expiresAt: '2026-12-10T01:00:00.000Z' },
    { id: uuid(), client: 'browser', current: false, createdAt: '2026-11-01T01:00:00.000Z', lastActiveAt: '2026-11-02T09:30:00.000Z', expiresAt: '2026-12-01T01:00:00.000Z' },
  ];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const fail = state.failNext.shift();
    if (fail === 'network') throw new TypeError('Failed to fetch');
    if (typeof fail === 'number') return json(fail, { error: fail === 429 ? 'rate_limited' : 'internal_error' });
    if (url.pathname === '/api/v1/me' && method === 'PATCH') {
      state.name = body.name.trim();
      return json(200, { user: { id: USER.id, email: USER.email, name: state.name, emailVerified: true } });
    }
    if (url.pathname === '/api/v1/me/password' && method === 'POST') {
      if (body.currentPassword !== state.password) return json(400, { error: 'invalid_password', message: 'Your current password is not correct.' });
      if (body.newPassword === state.password) return json(400, { error: 'password_unchanged', message: 'Choose a new password that is different from your current one.' });
      state.password = body.newPassword;
      const ended = sessions.filter((s) => !s.current).length;
      sessions = sessions.filter((s) => s.current);
      return json(200, { otherSessionsEnded: ended });
    }
    if (url.pathname === '/api/v1/me/sessions' && method === 'GET') return json(200, { sessions, truncated: false });
    if (url.pathname === '/api/v1/me/sessions/revoke-others' && method === 'POST') {
      if (body.password !== state.password) return json(400, { error: 'invalid_password', message: 'Your password is not correct.' });
      const ended = sessions.filter((s) => !s.current).length;
      sessions = sessions.filter((s) => s.current);
      return json(200, { ended });
    }
    const one = /^\/api\/v1\/me\/sessions\/([^/]+)$/.exec(url.pathname);
    if (one && method === 'DELETE') {
      if (one[1] === here) return json(409, { error: 'use_sign_out' });
      if (!sessions.some((s) => s.id === one[1])) return json(404, { error: 'not_found' });
      sessions = sessions.filter((s) => s.id !== one[1]);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not_found' });
  };
  return { calls, state, fetch: fetchImpl, sessions: () => sessions };
}

const USER = { id: uuid(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };

beforeEach(() => {
  localStorage.clear();
  resetPreferenceMemory();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  const slugs = ['alpha'];
  const settingsFake = createFakeSettings(slugs);
  const account = createFakeAccount(USER.name);
  const ctx: BusinessContext = {
    business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
    membership: { id: uuid(), role: 'MEMBER', permissions: MEMBER },
  };
  const session = vi.fn(async () => ({ kind: 'signed-in', user: { ...USER, name: account.state.name } }) as SessionCheck);
  const auth = { session, signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: 'Alpha Plumbing', role: 'MEMBER' as const }] })),
    businessContext: vi.fn(async () => ({ kind: 'ok' as const, data: ctx })),
    createBusiness: vi.fn(),
    platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: false } })),
  };
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })}
    settings={createSettingsClient(BASE, { kind: 'cookie' }, settingsFake.fetch)} account={createAccountClient(BASE, { kind: 'cookie' }, account.fetch)} />);
  return { account, session, user: userEvent.setup() };
}

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });

async function openAccountPage(user: ReturnType<typeof userEvent.setup>, page: string) {
  await h1(/Welcome to/);
  await user.click(within(screen.getByRole('navigation', { name: 'Zones' })).getByRole('button', { name: 'Settings' }));
  await user.click(within(await screen.findByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Account' }));
  await user.click(within(await screen.findByRole('navigation', { name: 'Account settings' })).getByRole('button', { name: page }));
  await h1(page);
}

describe('Account › Profile', () => {
  it('saves only the name, then refreshes who is signed in across the shell', async () => {
    const { account, session, user } = mount();
    await openAccountPage(user, 'Profile');
    const input = screen.getByRole('textbox', { name: 'Your name' });
    expect((input as HTMLInputElement).value).toBe('Ada Lovelace');
    expect(screen.getByRole('button', { name: 'Save name' }).hasAttribute('disabled')).toBe(true);
    await user.clear(input);
    await user.type(input, 'Ada King');
    const before = session.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Your name was saved.')).toBeTruthy();
    expect(account.calls.filter((c) => c.method !== 'GET')).toEqual([{ method: 'PATCH', path: '/api/v1/me', body: { name: 'Ada King' } }]);
    await waitFor(() => expect(session.mock.calls.length).toBeGreaterThan(before)); // the shell re-reads the signed-in person
    expect(screen.getByText('ada@example.com')).toBeTruthy(); // the email is shown, never editable
    expect(screen.queryByRole('textbox', { name: /email/i })).toBeNull();
  });

  it('refuses an empty name before sending anything', async () => {
    const { account, user } = mount();
    await openAccountPage(user, 'Profile');
    await user.clear(screen.getByRole('textbox', { name: 'Your name' }));
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), '   ');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Enter your name')).toBeTruthy();
    expect(account.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('Account › Password', () => {
  it('checks the confirmation locally, explains a wrong current password next to it, then changes and clears the form', async () => {
    const { account, user } = mount();
    await openAccountPage(user, 'Password');
    const current = screen.getByLabelText('Current password');
    const next = screen.getByLabelText(/^New password/);
    const confirm = screen.getByLabelText('Confirm new password');
    expect(current.getAttribute('autocomplete')).toBe('current-password');
    expect(next.getAttribute('autocomplete')).toBe('new-password');

    await user.type(current, PASSWORD);
    await user.type(next, 'a brand new passphrase');
    await user.type(confirm, 'a different passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The two new passwords do not match.')).toBeTruthy();
    expect(account.calls).toEqual([]);

    await user.clear(confirm);
    await user.type(confirm, 'a brand new passphrase');
    await user.clear(current);
    await user.type(current, 'the wrong password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Your current password is not correct.')).toBeTruthy();

    await user.clear(current);
    await user.type(current, PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Your password was changed, and 2 other devices were signed out.')).toBeTruthy();
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
    expect(account.state.password).toBe('a brand new passphrase');
    expect(account.calls.at(-1)).toEqual({ method: 'POST', path: '/api/v1/me/password', body: { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' } });
  });

  it('refuses a short new password before sending, and says when there are too many attempts', async () => {
    const { account, user } = mount();
    await openAccountPage(user, 'Password');
    await user.type(screen.getByLabelText('Current password'), PASSWORD);
    await user.type(screen.getByLabelText(/^New password/), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 12 characters')).toBeTruthy();
    expect(account.calls).toEqual([]);

    account.state.failNext.push(429);
    await user.clear(screen.getByLabelText(/^New password/));
    await user.type(screen.getByLabelText(/^New password/), 'long enough passphrase');
    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Too many requests/)).toBeTruthy();
    expect(account.state.password).toBe(PASSWORD);
  });
});

describe('Account › Signed-in devices', () => {
  it('lists devices, marks this one without a sign-out button, and signs out another after confirming', async () => {
    const { account, user } = mount();
    await openAccountPage(user, 'Signed-in devices');
    const rows = within(await screen.findByRole('region', { name: 'Sessions' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('This device')).toBeTruthy();
    expect(within(rows[0]!).queryByRole('button')).toBeNull();
    expect(within(rows[1]!).getByText('Pixa OS desktop app')).toBeTruthy();

    await user.click(within(rows[1]!).getByRole('button', { name: /^Sign out Pixa OS desktop app/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out device' }));
    expect(await screen.findByText('That device was signed out.')).toBeTruthy();
    expect(account.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/api/v1/me/sessions/'))).toBe(true);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Sessions' })).getAllByRole('listitem')).toHaveLength(2));
  });

  it('signing out all other devices needs the password; a wrong one is explained in the dialog', async () => {
    const { account, user } = mount();
    await openAccountPage(user, 'Signed-in devices');
    await screen.findByRole('region', { name: 'Sessions' });
    await user.click(screen.getByRole('button', { name: 'Sign out all other devices' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out other devices' }));
    expect(account.calls.filter((c) => c.method === 'POST')).toEqual([]); // nothing sent without a password

    await user.type(within(dialog).getByLabelText('Your password'), 'not it');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out other devices' }));
    expect(await within(dialog).findByText('Your password is not correct.')).toBeTruthy();
    expect(account.sessions()).toHaveLength(3);

    await user.clear(within(dialog).getByLabelText('Your password'));
    await user.type(within(dialog).getByLabelText('Your password'), PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Sign out other devices' }));
    expect(await screen.findByText('2 other devices were signed out.')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Sessions' })).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Sign out all other devices' })).toBeNull();
  });

  it('an ended session sends the person back to sign in', async () => {
    const { account, session, user } = mount();
    account.state.failNext.push(401);
    await openAccountPage(user, 'Signed-in devices').catch(() => undefined);
    await waitFor(() => expect(session.mock.calls.length).toBeGreaterThan(1));
  });
});
