// @vitest-environment jsdom
// A3 / A2-D stage 2: Members, Invitations and Ownership against a stand-in for the A2-B team API
// (real client and contracts). The server stays authoritative; these tests pin what the screen offers and says.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@business-os/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createSettingsClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { resetPreferenceMemory } from '../src/shell/preferences';
import { canAssignRole, canManageMember } from '../src/zones/settings/team-rules';
import { createFakeSettings, member, type FakeSettings } from './support/fake-settings';
import { uuid } from './support/fake-api';

const BASE = 'https://api.test';
const USER = { id: uuid(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };
const ME = uuid();
const ROLE_PERMS: Record<Role, string[]> = {
  OWNER: ['business:read', 'business:manage', 'members:read', 'members:invite', 'members:manage'],
  ADMIN: ['business:read', 'members:read', 'members:invite', 'members:manage'],
  MANAGER: ['business:read', 'members:read'],
  MEMBER: ['business:read'],
};
const BOB = member({ id: uuid(), name: 'Bob Builder', email: 'bob@example.com', role: 'MEMBER' });
const CARA = member({ id: uuid(), name: 'Cara Manager', email: 'cara@example.com', role: 'MANAGER' });
const DAN = member({ id: uuid(), name: 'Dan Admin', email: 'dan@example.com', role: 'ADMIN' });
const OLIVE = member({ id: uuid(), name: 'Olive Owner', email: 'olive@example.com', role: 'OWNER' });
const team = (role: Role) => [member({ id: ME, name: 'Ada Lovelace', email: 'ada@example.com', role }), { ...OLIVE }, { ...DAN }, { ...CARA }, { ...BOB }];

beforeEach(() => { localStorage.clear(); resetPreferenceMemory(); document.documentElement.className = ''; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(role: Role, opts: { fake?: FakeSettings; roster?: ReturnType<typeof team>; extra?: string[] } = {}) {
  const fake = opts.fake ?? createFakeSettings(['alpha'], { alpha: opts.roster ?? team(role) });
  fake.setMe(ME);
  const onSignOut = vi.fn();
  const ctx = (slug: string): BusinessContext => ({
    business: { slug, name: fake.profiles[slug]!.name, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
    membership: { id: ME, role, permissions: [...ROLE_PERMS[role], ...(opts.extra ?? [])] },
  });
  const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: onSignOut } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: fake.profiles.alpha!.name, role }] })),
    businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug) })),
    createBusiness: vi.fn(),
    platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: false } })),
  };
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })} settings={createSettingsClient(BASE, { kind: 'cookie' }, fake.fetch)} />);
  return { fake, user: userEvent.setup() };
}

async function openPage(user: ReturnType<typeof userEvent.setup>, page: string) {
  await screen.findByRole('heading', { level: 1, name: /Welcome to/ });
  await user.click(within(screen.getByRole('navigation', { name: 'Zones' })).getByRole('button', { name: 'Settings' }));
  await user.click(await within(await screen.findByRole('navigation', { name: 'Business settings' })).findByRole('button', { name: page }));
  return screen.findByRole('heading', { level: 1, name: page });
}
const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
const typeInto = async (user: ReturnType<typeof userEvent.setup>, phrase: string) => user.type(within(screen.getByRole('dialog')).getByLabelText(/Type .* to confirm/), phrase);

describe('rank rules (presentation mirror)', () => {
  it('matches the server: no self action, owners manage anyone, others only lower ranks, invite never grants Owner', () => {
    const owner = { role: 'OWNER' as Role, permissions: ROLE_PERMS.OWNER };
    const admin = { role: 'ADMIN' as Role, permissions: ROLE_PERMS.ADMIN };
    expect(canManageMember(owner, 'OWNER', false)).toBe(true);
    expect(canManageMember(owner, 'MEMBER', true)).toBe(false);
    expect(canManageMember(admin, 'ADMIN', false)).toBe(false);
    expect(canManageMember(admin, 'MANAGER', false)).toBe(true);
    expect(canManageMember({ role: 'MANAGER', permissions: ROLE_PERMS.MANAGER }, 'MEMBER', false)).toBe(false);
    expect(canAssignRole(owner, 'OWNER', 'invite')).toBe(false);
    expect(canAssignRole(owner, 'OWNER', 'change')).toBe(true);
    expect(canAssignRole(admin, 'OWNER', 'change')).toBe(false);
    expect(canAssignRole(admin, 'ADMIN', 'invite')).toBe(false);
  });
});

describe('Settings navigation by role', () => {
  it.each([
    ['OWNER', ['Business profile', 'Regional settings', 'Members', 'Invitations', 'Ownership and leaving']],
    ['ADMIN', ['Business profile', 'Regional settings', 'Members', 'Invitations', 'Ownership and leaving']],
    ['MANAGER', ['Business profile', 'Regional settings', 'Members', 'Ownership and leaving']],
    ['MEMBER', ['Business profile', 'Regional settings', 'Ownership and leaving']],
  ] as [Role, string[]][])('%s sees only the pages their permission keys allow', async (role, pages) => {
    const { user } = mount(role);
    await screen.findByRole('heading', { level: 1, name: /Welcome to/ });
    await user.click(within(screen.getByRole('navigation', { name: 'Zones' })).getByRole('button', { name: 'Settings' }));
    const nav = await screen.findByRole('navigation', { name: 'Business settings' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(pages);
  });
});

describe('Members', () => {
  it('shows the directory with emails for an inviter and rank-limited actions', async () => {
    const { user } = mount('ADMIN');
    await openPage(user, 'Members');
    expect(await screen.findByText('bob@example.com')).toBeTruthy();
    expect(within(row('Ada Lovelace')).getByText('You')).toBeTruthy();
    expect(within(row('Ada Lovelace')).queryByRole('button')).toBeNull(); // never on yourself
    expect(within(row('Olive Owner')).queryByRole('button')).toBeNull(); // outranks an Admin
    expect(within(row('Dan Admin')).queryByRole('button')).toBeNull(); // equal rank
    expect(within(row('Bob Builder')).getByRole('button', { name: 'Remove Bob Builder' })).toBeTruthy();
    const select = within(row('Bob Builder')).getByRole('combobox', { name: /Change role for Bob/ });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Change role…', 'Manager']); // never Owner or Admin for an Admin
  });

  it('hides emails and every action from a manager, who can only read', async () => {
    const { user } = mount('MANAGER', { fake: Object.assign(createFakeSettings(['alpha'], { alpha: team('MANAGER') })) });
    await openPage(user, 'Members');
    await screen.findByText('Bob Builder');
    expect(screen.queryByRole('columnheader', { name: 'Email' })).toBeNull();
    expect(screen.queryByText('bob@example.com')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /Remove|Suspend|Reactivate/ })).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('lets an owner change a role after confirming, and then reloads the directory', async () => {
    const { user, fake } = mount('OWNER');
    await openPage(user, 'Members');
    await user.selectOptions(await within(await screen.findByRole('row', { name: /Bob Builder/ })).findByRole('combobox'), 'Manager');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Make Bob Builder Manager?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await screen.findByText('Bob Builder is now Manager.');
    expect(fake.calls.some((c) => c.method === 'PATCH' && c.path.endsWith(`/members/${BOB.id}`) && JSON.stringify(c.body) === '{"role":"MANAGER"}')).toBe(true);
    expect(within(row('Bob Builder')).getByText('Manager')).toBeTruthy();
  });

  it('suspends and reactivates', async () => {
    const { user } = mount('OWNER');
    await openPage(user, 'Members');
    await user.click(await screen.findByRole('button', { name: 'Suspend Bob Builder' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Suspend' }));
    await screen.findByText('Bob Builder is suspended.');
    await user.click(await screen.findByRole('button', { name: 'Reactivate Bob Builder' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reactivate' }));
    await screen.findByText('Bob Builder can sign in again.');
  });

  it('removes a member only after typing their name', async () => {
    const { user, fake } = mount('OWNER');
    await openPage(user, 'Members');
    await user.click(await screen.findByRole('button', { name: 'Remove Bob Builder' }));
    const confirmButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove member' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    await typeInto(user, 'Bob Builder');
    await user.click(confirmButton);
    await screen.findByText('Bob Builder was removed.');
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.path.endsWith(`/members/${BOB.id}`))).toBe(true);
    await waitFor(() => expect(screen.queryByRole('row', { name: /Bob Builder/ })).toBeNull());
  });

  it('removes a suspended co-owner (an owner may manage another owner)', async () => {
    const { user } = mount('OWNER', { roster: [member({ id: ME, name: 'Ada Lovelace', role: 'OWNER' }), member({ id: OLIVE.id, name: 'Olive Owner', role: 'OWNER', status: 'SUSPENDED' })] });
    await openPage(user, 'Members');
    await user.click(await screen.findByRole('button', { name: 'Remove Olive Owner' }));
    await typeInto(user, 'Olive Owner');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove member' }));
    await screen.findByText('Olive Owner was removed.');
  });

  it('shows loading, offline and forbidden states with a way back', async () => {
    const fake = createFakeSettings(['alpha'], { alpha: team('OWNER') });
    const { user } = mount('OWNER', { fake });
    await screen.findByRole('heading', { level: 1, name: /Welcome to/ });
    await user.click(within(screen.getByRole('navigation', { name: 'Zones' })).getByRole('button', { name: 'Settings' }));
    await screen.findByRole('navigation', { name: 'Business settings' });
    const release = fake.hold();
    await user.click(screen.getByRole('button', { name: 'Members' }));
    expect(await screen.findByText('Loading members…')).toBeTruthy();
    fake.failNext(['network']);
    release();
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    await screen.findByText('Bob Builder');
  });
});

describe('Invitations', () => {
  it('offers roles below the sender and never Owner', async () => {
    const { user } = mount('ADMIN');
    await openPage(user, 'Invitations');
    const role = await screen.findByLabelText('Role');
    expect(within(role).getAllByRole('option').map((o) => o.textContent)).toEqual(['Manager', 'Member']);
  });

  it('sends an invitation and lists it as pending', async () => {
    const { user, fake } = mount('OWNER');
    await openPage(user, 'Invitations');
    await user.type(await screen.findByLabelText('Email address'), 'New.Person@Example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByText('Invitation sent to new.person@example.com.');
    expect(fake.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ email: 'new.person@example.com' });
    expect(await screen.findByRole('row', { name: /new.person@example.com/ })).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('says plainly when the invitation was saved but the email failed', async () => {
    const { user, fake } = mount('OWNER');
    fake.options.deliveryFails = true;
    await openPage(user, 'Invitations');
    await user.type(await screen.findByLabelText('Email address'), 'x@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/saved, but the email could not be sent/)).toBeTruthy();
    expect(await screen.findByRole('row', { name: /x@example.com/ })).toBeTruthy();
  });

  it('explains already_member and invitation_exists', async () => {
    const { user } = mount('OWNER');
    await openPage(user, 'Invitations');
    const email = await screen.findByLabelText('Email address');
    await user.type(email, 'bob@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/already belongs to a member/)).toBeTruthy();
    await user.clear(email);
    await user.type(email, 'again@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByText('Invitation sent to again@example.com.');
    await user.type(screen.getByLabelText('Email address'), 'again@example.com');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/already an open invitation/)).toBeTruthy();
  });

  it('resends (once a minute) and revokes after confirmation', async () => {
    const { user, fake } = mount('OWNER');
    fake.invitations.alpha!.push({ id: uuid(), email: 'wait@example.com', role: 'MEMBER', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-11-16T00:00:00.000Z' });
    await openPage(user, 'Invitations');
    fake.options.resendTooSoon = true;
    await user.click(await screen.findByRole('button', { name: 'Resend invitation to wait@example.com' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Resend invitation' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toBeTruthy(); // 429 explained in the dialog, which stays open
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    fake.options.resendTooSoon = false;
    await user.click(screen.getByRole('button', { name: 'Resend invitation to wait@example.com' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Resend invitation' }));
    await screen.findByText('Invitation sent to wait@example.com.');
    await user.click(await screen.findByRole('button', { name: 'Revoke invitation to wait@example.com' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke invitation' }));
    await screen.findByText('The invitation for wait@example.com was revoked.');
    await waitFor(() => expect(screen.queryByRole('row', { name: /wait@example.com/ })).toBeNull());
  });

  it('marks an expired invitation', async () => {
    const { user, fake } = mount('OWNER');
    fake.invitations.alpha!.push({ id: uuid(), email: 'old@example.com', role: 'MEMBER', expiresAt: '2020-01-01T00:00:00.000Z', createdAt: '2019-12-01T00:00:00.000Z' });
    await openPage(user, 'Invitations');
    expect(await screen.findByText('Expired')).toBeTruthy();
  });

  it('shows an empty state when nothing is open', async () => {
    const { user } = mount('OWNER');
    await openPage(user, 'Invitations');
    expect(await screen.findByText(/no open invitations/i)).toBeTruthy();
  });
});

describe('Ownership and leaving', () => {
  it('lets an owner hand over ownership by typing the business name, optionally stepping down', async () => {
    const { user, fake } = mount('OWNER');
    await openPage(user, 'Ownership and leaving');
    await user.selectOptions(await screen.findByLabelText('Member'), BOB.id);
    await user.click(screen.getByLabelText('Step down to Admin afterwards'));
    await user.click(screen.getByRole('button', { name: 'Make owner…' }));
    const confirmButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Make owner' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    await typeInto(user, 'Alpha Plumbing');
    await user.click(confirmButton);
    await screen.findByText('Bob Builder is now an owner, and you are now an Admin.');
    expect(fake.calls.find((c) => c.path.endsWith('/transfer-ownership'))?.body).toEqual({ stepDown: true, confirm: true });
  });

  it('does not show hand-over or step-down to an admin, only leaving', async () => {
    const { user } = mount('ADMIN');
    await openPage(user, 'Ownership and leaving');
    await screen.findByRole('button', { name: 'Leave business…' });
    expect(screen.queryByRole('button', { name: 'Make owner…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Step down as owner…' })).toBeNull();
  });

  it('steps down after confirmation', async () => {
    const { user, fake } = mount('OWNER');
    await openPage(user, 'Ownership and leaving');
    await user.click(await screen.findByRole('button', { name: 'Step down as owner…' }));
    await typeInto(user, 'Alpha Plumbing');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Step down' }));
    await screen.findByText('You are now an Admin.');
    expect(fake.calls.find((c) => c.path.endsWith('/membership/step-down'))?.body).toEqual({ confirm: true });
  });

  it('refuses the last owner stepping down, with the server\'s reason', async () => {
    const { user } = mount('OWNER', { roster: [member({ id: ME, name: 'Ada Lovelace', role: 'OWNER' }), { ...BOB }] });
    await openPage(user, 'Ownership and leaving');
    await user.click(await screen.findByRole('button', { name: 'Step down as owner…' }));
    await typeInto(user, 'Alpha Plumbing');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Step down' }));
    expect(await within(screen.getByRole('dialog')).findByText(/last owner|only owner|another owner/i)).toBeTruthy();
  });

  it('leaves the business and returns to the business chooser', async () => {
    const { user, fake } = mount('MEMBER');
    await openPage(user, 'Ownership and leaving');
    await user.click(await screen.findByRole('button', { name: 'Leave business…' }));
    await typeInto(user, 'Alpha Plumbing');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Leave business' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path.endsWith('/membership/leave'))).toBe(true));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Business settings' })).toBeNull());
  });
});

describe('Zone configuration', () => {
  it('shows links only for Zones the person can open and says when they cannot change it', async () => {
    const { user } = mount('MANAGER', { extra: ['finance:read'] });
    await openPage(user, 'Zone configuration');
    expect(await screen.findByText('Finance settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Products & services in Finance' })).toBeTruthy();
    expect(screen.queryByText('Departments and locations')).toBeNull(); // no people:read
    expect(screen.getAllByText(/You can view it but not change it/).length).toBe(2);
  });
});
