// @vitest-environment jsdom
// A2-D: Settings › Roles and access (read-only, from the A2-C description) and the role-change safeguards on
// Members, against a stand-in for the A2-B/A2-C API (real client and contracts). The server stays the only
// authority; these tests pin what the screen offers, says and refuses to offer.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccessRolesResponse, type Role } from '@business-os/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createSettingsClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { resetPreferenceMemory } from '../src/shell/preferences';
import { mailboxCutoff, mailboxCutoffSentence, matchesMembership } from '../src/zones/settings/access-model';
import { assignableRoles, canManageMember } from '../src/zones/settings/team-rules';
import { ACCESS_MODEL } from './support/access-model';
import { createFakeSettings, member, type FakeSettings } from './support/fake-settings';
import { uuid } from './support/fake-api';

const BASE = 'https://api.test';
const USER = { id: uuid(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };
const ME = uuid();
/** The real keys each role holds (from the server's own description), so the screen sees what production sends. */
const keys = (role: Role) => ACCESS_MODEL.roles.find((r) => r.role === role)!.permissions;
const BOB = member({ id: uuid(), name: 'Bob Builder', email: 'bob@example.com', role: 'MEMBER' });
const CARA = member({ id: uuid(), name: 'Cara Manager', email: 'cara@example.com', role: 'MANAGER' });
const DAN = member({ id: uuid(), name: 'Dan Admin', email: 'dan@example.com', role: 'ADMIN' });
const OLIVE = member({ id: uuid(), name: 'Olive Owner', email: 'olive@example.com', role: 'OWNER' });
const team = (role: Role) => [member({ id: ME, name: 'Ada Lovelace', email: 'ada@example.com', role }), { ...OLIVE }, { ...DAN }, { ...CARA }, { ...BOB }];

beforeEach(() => { localStorage.clear(); resetPreferenceMemory(); document.documentElement.className = ''; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(role: Role, opts: { fake?: FakeSettings; permissions?: string[] } = {}) {
  const fake = opts.fake ?? createFakeSettings(['alpha'], { alpha: team(role) });
  fake.setMe(ME);
  const ctx = (slug: string): BusinessContext => ({
    business: { slug, name: fake.profiles[slug]!.name, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
    membership: { id: ME, role, permissions: opts.permissions ?? [...keys(role)] },
  });
  const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: vi.fn() } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: fake.profiles.alpha!.name, role }] })),
    businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug) })),
    createBusiness: vi.fn(),
    platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: false } })),
  };
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: 'alpha' })} settings={createSettingsClient(BASE, { kind: 'cookie' }, fake.fetch)} />);
  return { fake, tenancy, auth, user: userEvent.setup() };
}

/** Opens Settings and waits for its first page, so a `before` hook acts on the next request only. */
async function openPage(user: ReturnType<typeof userEvent.setup>, page: string, wait = true, before?: () => void) {
  await screen.findByRole('heading', { level: 1, name: /Welcome to/ });
  await user.click(within(screen.getByRole('navigation', { name: 'Zones' })).getByRole('button', { name: 'Settings' }));
  await screen.findByRole('heading', { level: 1, name: 'Business profile' });
  await screen.findByText('Legal name');
  before?.();
  await user.click(await within(await screen.findByRole('navigation', { name: 'Business settings' })).findByRole('button', { name: page }));
  return wait ? screen.findByRole('heading', { level: 1, name: page }) : null;
}
const section = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section')!;
const fact = (scope: HTMLElement, label: string) => within(scope).getByText(label, { selector: 'dt' }).nextElementSibling!.textContent;
const matrixRow = (label: string) => within(screen.getByRole('table', { name: 'Permissions held by each role' })).getByRole('row', { name: new RegExp(`^${label}`) });

describe('roles description (presentation helpers)', () => {
  it('the test copy is the real description and satisfies the shared contract: fixed roles, nothing editable', () => {
    const parsed = AccessRolesResponse.parse(ACCESS_MODEL);
    expect(parsed.model).toEqual({ customRoles: false, editable: false });
    expect(parsed.roles.map((r) => r.role)).toEqual(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']);
  });

  it('agrees with the screen’s own rank rules, so no screen offers more than the description allows', () => {
    for (const r of ACCESS_MODEL.roles) {
      const actor = { role: r.role, permissions: r.permissions };
      expect(assignableRoles(actor, 'change')).toEqual(r.canAssign);
      expect(assignableRoles(actor, 'invite')).toEqual(r.canInvite);
      expect((['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as Role[]).filter((t) => canManageMember(actor, t, false))).toEqual(r.canManage);
    }
  });

  it('works out which mailbox connections a role change ends, as the server does', () => {
    expect(mailboxCutoff(ACCESS_MODEL, 'ADMIN', 'MEMBER')).toEqual({ personal: true, business: true });
    expect(mailboxCutoff(ACCESS_MODEL, 'ADMIN', 'MANAGER')).toEqual({ personal: false, business: true });
    expect(mailboxCutoff(ACCESS_MODEL, 'MANAGER', 'MEMBER')).toEqual({ personal: true, business: false });
    expect(mailboxCutoff(ACCESS_MODEL, 'OWNER', 'ADMIN')).toEqual({ personal: false, business: false }); // step-down keeps mailboxes
    expect(mailboxCutoff(ACCESS_MODEL, 'MEMBER', 'MANAGER')).toEqual({ personal: false, business: false });
    expect(mailboxCutoffSentence({ personal: false, business: false })).toBeNull();
  });

  it('notices when the business context and the description disagree', () => {
    expect(matchesMembership(ACCESS_MODEL, 'MANAGER', keys('MANAGER'))).toBe(true);
    expect(matchesMembership(ACCESS_MODEL, 'MANAGER', keys('ADMIN'))).toBe(false);
    expect(matchesMembership(ACCESS_MODEL, 'MANAGER', [...keys('MANAGER'), 'finance:manage'])).toBe(false);
  });
});

describe('Settings › Roles and access', () => {
  it.each(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as Role[])('is listed and readable for %s, with nothing to edit', async (role) => {
    const { user, fake } = mount(role);
    await openPage(user, 'Roles and access');
    await screen.findByRole('heading', { level: 2, name: 'Your role' });
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /edit|create role|custom role|save/i })).toBeNull();
    expect(screen.getByText(/custom roles are not available/)).toBeTruthy();
    expect(fake.calls.filter((c) => c.path.endsWith('/access/roles')).every((c) => c.method === 'GET')).toBe(true);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('explains an admin’s own reach: invites and manages only roles below Admin, never Owner', async () => {
    const { user } = mount('ADMIN');
    await openPage(user, 'Roles and access');
    const mine = section('Your role');
    expect(fact(mine, 'Role')).toContain('Admin');
    expect(fact(mine, 'You can invite')).toContain('Manager and Member');
    expect(fact(mine, 'You can change, suspend or remove')).toContain('Other members who are Manager and Member');
    expect(fact(mine, 'You can give these roles')).toBe('Manager and Member');
    await user.click(within(mine).getByRole('button', { name: 'Change someone’s role in Members' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Members' })).toBeTruthy();
  });

  it('tells a member they manage no one, and offers only a way to see the team', async () => {
    const { user } = mount('MEMBER');
    await openPage(user, 'Roles and access');
    const mine = section('Your role');
    expect(fact(mine, 'You can invite')).toContain('No one');
    expect(fact(mine, 'You can change, suspend or remove')).toContain('No one');
    expect(within(mine).getAllByRole('button').map((b) => b.textContent)).toEqual(['See who has which role in Members']);
  });

  it('shows the full matrix from the server, with words not colour', async () => {
    const { user } = mount('MANAGER');
    await openPage(user, 'Roles and access');
    const cells = (label: string) => within(matrixRow(label)).getAllByRole('cell').map((c) => c.textContent);
    expect(cells('Manage business settings')).toEqual(['Yes', 'Yes', 'No', 'No']);
    expect(cells('Read the audit log')).toEqual(['Yes', 'Yes', 'No', 'No']);
    expect(cells('Manage members')).toEqual(['Yes', 'Yes', 'Yes', 'No']);
    expect(cells('Connect your mailbox')).toEqual(['Yes', 'Yes', 'Yes', 'No']);
    const total = ACCESS_MODEL.zones.reduce((n, z) => n + z.permissions.length, 0);
    const table = screen.getByRole('table', { name: 'Permissions held by each role' });
    expect(within(table).getAllByRole('rowheader')).toHaveLength(total);
    expect(within(table).getByRole('columnheader', { name: /Manager\s*You/ })).toBeTruthy();
  });

  it('states the owner and mailbox protections', async () => {
    const { user } = mount('OWNER');
    await openPage(user, 'Roles and access');
    const rules = section('Rules that protect the business');
    expect(fact(rules, 'Hand over ownership')).toContain('Owner');
    expect(fact(rules, 'Leave the business')).toContain('Every role');
    expect(fact(rules, 'At least one owner')).toContain('last active owner cannot');
    const mail = section('Mailbox access follows the role');
    expect(fact(mail, 'Connect their own mailbox')).toBe('Owner, Admin and Manager');
    expect(fact(mail, 'Manage business mailboxes')).toBe('Owner and Admin');
    expect(fact(mail, 'When access ends')).toContain('does not reconnect them');
  });

  it('shows a loading state, then the page', async () => {
    const { user, fake } = mount('MEMBER');
    let release = () => {};
    await openPage(user, 'Roles and access', false, () => { release = fake.hold(); });
    expect(await screen.findByText('Loading roles…')).toBeTruthy();
    release();
    expect(await screen.findByRole('heading', { level: 2, name: 'Your role' })).toBeTruthy();
  });

  it.each([
    [403, 'You do not have access'],
    [500, 'Something went wrong'],
    ['network', "Can't reach Business OS"],
  ] as const)('explains a failed read (%s) and recovers on retry', async (failure, title) => {
    const { user, fake } = mount('ADMIN');
    await openPage(user, 'Roles and access', true, () => fake.failNext([failure]));
    expect(await screen.findByRole('heading', { level: 2, name: title })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Your role' })).toBeTruthy();
  });

  it('refuses a description that claims roles are editable (contract literal), instead of showing it', async () => {
    const fake = createFakeSettings(['alpha'], { alpha: team('OWNER') });
    fake.access.model = { ...fake.access.model, model: { customRoles: true, editable: true } } as unknown as typeof fake.access.model;
    const { user } = mount('OWNER', { fake });
    await openPage(user, 'Roles and access');
    expect(await screen.findByRole('heading', { level: 2, name: 'Something went wrong' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('offers a refresh when the person’s access no longer matches their role', async () => {
    const { user, tenancy } = mount('MANAGER', { permissions: [...keys('ADMIN')] });
    await openPage(user, 'Roles and access');
    expect(await screen.findByText('Your access may have changed')).toBeTruthy();
    const before = vi.mocked(tenancy.businessContext).mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh my access' }));
    await waitFor(() => expect(vi.mocked(tenancy.businessContext).mock.calls.length).toBeGreaterThan(before));
  });
});

describe('Members › role change safeguards', () => {
  async function chooseRole(user: ReturnType<typeof userEvent.setup>, who: string, role: string) {
    await user.selectOptions(await within(await screen.findByRole('row', { name: new RegExp(who) })).findByRole('combobox'), role);
    return screen.findByRole('dialog');
  }

  it('says exactly which mailboxes a demotion disconnects', async () => {
    const { user } = mount('OWNER');
    await openPage(user, 'Members');
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    let dialog = await chooseRole(user, 'Dan Admin', 'Member');
    await waitFor(() => expect(dialog.textContent).toContain('every mailbox they connected, their own and the business’s, is disconnected now'));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await chooseRole(user, 'Dan Admin', 'Manager');
    expect(dialog.textContent).toContain('business mailboxes they connected are disconnected now. Their own mailbox stays connected.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await chooseRole(user, 'Bob Builder', 'Manager');
    expect(dialog.textContent).toContain('Mailboxes they connected stay connected.');
  });

  it('falls back to the general mailbox rule when the roles description cannot be read', async () => {
    const { user, fake } = mount('OWNER');
    await screen.findByRole('heading', { level: 1, name: /Welcome to/ });
    fake.access.model = { broken: true } as unknown as typeof fake.access.model; // fails contract validation
    await openPage(user, 'Members');
    const dialog = await chooseRole(user, 'Cara Manager', 'Member');
    expect(dialog.textContent).toContain('If the new role cannot connect mailboxes, mailboxes they connected are disconnected now.');
  });

  it('shows the server’s refusal of a role change it no longer allows, and changes nothing', async () => {
    const { user, fake } = mount('ADMIN');
    await openPage(user, 'Members');
    const dialog = await chooseRole(user, 'Bob Builder', 'Manager');
    fake.failNext([403]);
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await within(dialog).findByText('Your role in this business does not allow this change.')).toBeTruthy();
    expect(fake.members.alpha!.find((m) => m.id === BOB.id)!.role).toBe('MEMBER');
  });

  it('never offers an admin the Owner or Admin role, nor any action on an owner or another admin', async () => {
    const { user } = mount('ADMIN');
    await openPage(user, 'Members');
    const select = await within(await screen.findByRole('row', { name: /Cara Manager/ })).findByRole('combobox');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Change role…', 'Member']);
    expect(within(screen.getByRole('row', { name: /Olive Owner/ })).queryByRole('combobox')).toBeNull();
    expect(within(screen.getByRole('row', { name: /Dan Admin/ })).queryByRole('button')).toBeNull();
  });

  it('explains the last-owner rule when the server refuses to demote the only active owner', async () => {
    const { user, fake } = mount('OWNER');
    await openPage(user, 'Members');
    const dialog = await chooseRole(user, 'Olive Owner', 'Admin');
    fake.members.alpha!.find((m) => m.id === ME)!.role = 'ADMIN'; // meanwhile, the caller stepped down elsewhere
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await within(dialog).findByText(/must always keep at least one active owner/)).toBeTruthy();
    expect(fake.members.alpha!.find((m) => m.id === OLIVE.id)!.role).toBe('OWNER');
  });
});
