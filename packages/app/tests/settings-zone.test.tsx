// @vitest-environment jsdom
// A3 / A2-D stage 1: the Settings shell, Account preferences, Business profile and Regional settings,
// against a stand-in for the business profile API (real client and contracts).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createSettingsClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { resetPreferenceMemory } from '../src/shell/preferences';
import { SETTINGS_PAGES, pagesFor, resolvePage } from '../src/zones/settings/pages';
import { profilePatch } from '../src/zones/settings/business-profile';
import { regionalPatch } from '../src/zones/settings/regional-settings';
import { createFakeSettings, profile, type FakeSettings } from './support/fake-settings';
import { uuid } from './support/fake-api';

const BASE = 'https://api.test';
const USER = { id: uuid(), email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true };
const MEMBER = ['business:read', 'members:read'];
const OWNER = ['business:read', 'business:manage', 'members:read', 'members:invite', 'members:manage', 'audit:read'];

beforeEach(() => {
  localStorage.clear();
  resetPreferenceMemory();
  document.documentElement.className = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(opts: { permissions?: string[]; fake?: FakeSettings; slugs?: string[] } = {}) {
  const slugs = opts.slugs ?? ['alpha', 'beta'];
  const fake = opts.fake ?? createFakeSettings(slugs);
  const permissions = opts.permissions ?? OWNER;
  const ctx = (slug: string): BusinessContext => ({
    business: { slug, name: fake.profiles[slug]!.name, countryCode: fake.profiles[slug]!.countryCode, timeZone: fake.profiles[slug]!.timeZone, locale: fake.profiles[slug]!.locale, currency: fake.profiles[slug]!.currency },
    membership: { id: uuid(), role: 'OWNER', permissions },
  });
  const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: USER }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: slugs.map((s) => ({ slug: s, name: fake.profiles[s]!.name, role: 'OWNER' as const })) })),
    businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug) })),
    createBusiness: vi.fn(),
    platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: false } })),
  };
  render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} storage={memoryStorage({ slug: slugs[0] })} settings={createSettingsClient(BASE, { kind: 'cookie' }, fake.fetch)} />);
  return { fake, tenancy, user: userEvent.setup() };
}

const h1 = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name });
const zonesNav = () => screen.getByRole('navigation', { name: 'Zones' });

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await h1(/Welcome to/);
  await user.click(within(zonesNav()).getByRole('button', { name: 'Settings' }));
}

describe('Settings pages and permissions', () => {
  it('lists only pages whose backend exists, filtered by the server\'s permission keys', () => {
    expect(SETTINGS_PAGES.map((p) => `${p.scope}/${p.id}`)).toEqual(['account/preferences', 'business/profile', 'business/regional']);
    expect(pagesFor('business', MEMBER).map((p) => p.id)).toEqual(['profile', 'regional']);
    expect(pagesFor('business', []).map((p) => p.id)).toEqual([]); // no business:read: no Business pages
    expect(pagesFor('account', []).map((p) => p.id)).toEqual(['preferences']); // account pages need no business key
    expect(resolvePage('business', 'roles', MEMBER)?.id).toBe('profile'); // an unknown page never opens
    expect(resolvePage('business', undefined, [])).toBeNull();
  });

  it('opens from the sidebar on the Business scope, with Account beside it', async () => {
    const { user } = mount({ permissions: MEMBER });
    await openSettings(user);
    expect(await h1('Business profile')).toBeTruthy();
    const scopes = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(scopes).getAllByRole('button').map((b) => b.textContent)).toEqual(['Business', 'Account']);
    expect(within(scopes).getByRole('button', { name: 'Business' }).getAttribute('aria-current')).toBe('page');
    const pages = screen.getByRole('navigation', { name: 'Business settings' });
    expect(within(pages).getAllByRole('button').map((b) => b.textContent)).toEqual(['Business profile', 'Regional settings']);
    // Nothing is listed for features that do not exist yet.
    for (const name of [/Members/, /Roles/, /Invitations/, /Billing/, /Integrations/]) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('moves between scopes and pages by keyboard-reachable buttons, and focuses the new page heading', async () => {
    const { user } = mount();
    await openSettings(user);
    await h1('Business profile');
    await user.click(within(screen.getByRole('navigation', { name: 'Business settings' })).getByRole('button', { name: 'Regional settings' }));
    const heading = await h1('Regional settings');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Account' }));
    expect(await h1('Preferences')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Account settings' })).toBeTruthy();
  });
});

describe('Account › Preferences', () => {
  it('shows the signed-in identity read-only and applies theme and sidebar immediately, on this device only', async () => {
    const { user, fake } = mount({ permissions: MEMBER });
    await openSettings(user);
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Account' }));
    await h1('Preferences');
    const facts = screen.getByText('Signed in as').closest('section')!;
    expect(facts.textContent).toContain('Ada Lovelace');
    expect(facts.textContent).toContain('ada@example.com');
    expect(within(facts).queryByRole('textbox')).toBeNull(); // read-only: no name or email change exists yet
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('bos.theme')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(localStorage.getItem('bos.sidebar')).toBe('compact');
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]); // nothing is sent to the server
  });
});

describe('Business › Business profile', () => {
  it('a member without business:manage sees a read-only layout: values, no form, no save', async () => {
    const { user } = mount({ permissions: MEMBER });
    await openSettings(user);
    await h1('Business profile');
    const details = (await screen.findByText('Details')).closest('section')!;
    expect(details.textContent).toContain('Alpha Plumbing');
    expect(details.textContent).toContain('office@alpha.example');
    expect(details.textContent).toContain('1 Hay Street, 6000 Perth, WA, Australia');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByText(/Only owners and admins can change these/)).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy(); // URL name, fixed
  });

  it('loading is announced, then the form shows the stored values', async () => {
    const fake = createFakeSettings();
    const release = fake.hold();
    const { user } = mount({ fake });
    await openSettings(user);
    expect((await screen.findByRole('status', { name: '' })).textContent).toContain('Loading the business profile');
    release();
    expect(((await screen.findByLabelText('Business name')) as HTMLInputElement).value).toBe('Alpha Plumbing');
    expect((screen.getByLabelText('Legal name') as HTMLInputElement).value).toBe('alpha Plumbing Pty Ltd');
    expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('AU');
  });

  it('saves only what changed with the loaded version, refreshes the shell, and clears the unsaved state', async () => {
    const { user, fake } = mount();
    await openSettings(user);
    const name = await screen.findByLabelText('Business name');
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(name);
    await user.type(name, 'Alpha Plumbing & Gas');
    expect(screen.getByText('You have unsaved changes.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Business profile saved.')).toBeTruthy();
    const patch = fake.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ name: 'Alpha Plumbing & Gas', version: 1 });
    // The shell's business name follows without leaving the page.
    await waitFor(() => expect(screen.getAllByText('Alpha Plumbing & Gas').length).toBeGreaterThan(0));
    expect(fake.profiles.alpha!.version).toBe(2);
    expect(((await screen.findByLabelText('Business name')) as HTMLInputElement).value).toBe('Alpha Plumbing & Gas');
    expect(screen.getByText('No changes to save.')).toBeTruthy();
  });

  it('a blank optional field clears it, and a bad value is explained next to the field without a request', async () => {
    const { user, fake } = mount();
    await openSettings(user);
    await user.clear(await screen.findByLabelText('Legal name'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Business profile saved.');
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ legalName: null, version: 1 });
    await user.type(await screen.findByLabelText('Website'), 'example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Use a full address starting with https://')).toBeTruthy();
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('a stale version is refused, the draft stays visible, and loading the latest version shows what changed', async () => {
    const { user, fake } = mount();
    await openSettings(user);
    const name = await screen.findByLabelText('Business name');
    await user.clear(name);
    await user.type(name, 'Mine');
    fake.editElsewhere('alpha', { name: 'Theirs' });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Someone else changed this while you were editing');
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Mine');
    expect(fake.profiles.alpha!.name).toBe('Theirs'); // nothing was overwritten
    await user.click(screen.getByRole('button', { name: 'Load the latest version' }));
    await waitFor(() => expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Theirs'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('error states are specific: server error with retry, no access, offline, and an uncertain save', async () => {
    const fake = createFakeSettings();
    fake.failNext([500]);
    const { user } = mount({ fake });
    await openSettings(user);
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Business name')).toBeTruthy();
    // A save whose answer never arrived may still have gone through.
    await user.type(screen.getByLabelText('Contact phone'), '08 5555 0100');
    fake.failNext(['network']);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('may already have been saved');
    // The server says no (for example the role changed since the page loaded).
    fake.failNext([403]);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Your role in this business does not allow this change'));
  });

  it('no access to read, and offline, each get their own explanation', async () => {
    const forbidden = createFakeSettings();
    forbidden.failNext([403]);
    const first = mount({ fake: forbidden });
    await openSettings(first.user);
    expect((await screen.findByRole('alert')).textContent).toContain('You do not have access');
    cleanup();
    const offline = createFakeSettings();
    offline.failNext(['network']);
    const second = mount({ fake: offline });
    await openSettings(second.user);
    expect((await screen.findByRole('alert')).textContent).toMatch(/offline|Can't reach/);
  });

  it('asks before discarding unsaved edits on every way of leaving, and keeps them when told to', async () => {
    const { user } = mount();
    await openSettings(user);
    await user.type(await screen.findByLabelText('Contact phone'), '123');
    const pages = screen.getByRole('navigation', { name: 'Business settings' });
    await user.click(within(pages).getByRole('button', { name: 'Regional settings' }));
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Contact phone') as HTMLInputElement).value).toBe('123');
    await user.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await user.click(within(zonesNav()).getByRole('button', { name: 'Home' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(await h1(/Welcome to/)).toBeTruthy();
  });
});

describe('Business › Regional settings', () => {
  const regional = async (user: ReturnType<typeof userEvent.setup>) => {
    await openSettings(user);
    await h1('Business profile');
    await user.click(within(screen.getByRole('navigation', { name: 'Business settings' })).getByRole('button', { name: 'Regional settings' }));
    await h1('Regional settings');
  };

  it('read-only for members: every regional value is shown, in words', async () => {
    const { user } = mount({ permissions: MEMBER });
    await regional(user);
    const facts = (await screen.findByText('Current settings')).closest('section')!;
    for (const text of ['Australia (AU)', 'Australia/Perth', 'en-AU', 'AUD', 'Starts in July']) expect(facts.textContent).toContain(text);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('changing currency asks first, naming what changes and what does not; cancelling changes nothing', async () => {
    const { user, fake } = mount();
    await regional(user);
    await user.selectOptions(await screen.findByLabelText('Default currency'), 'NZD');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change regional settings?' });
    expect(dialog.textContent).toContain('Default currency: AUD → NZD');
    expect(dialog.textContent).toContain('Does not change: amounts and currencies already stored, documents already issued');
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change settings' }));
    expect(await screen.findByText(/Regional settings saved/)).toBeTruthy();
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ currency: 'NZD', version: 1 });
    expect(fake.profiles.alpha!.currency).toBe('NZD');
  });

  it('the financial year start saves without the confirmation, and can be cleared', async () => {
    const { user, fake } = mount();
    await regional(user);
    await user.selectOptions(await screen.findByLabelText('Financial year starts in'), '');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Regional settings saved/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ fiscalYearStartMonth: null, version: 1 });
  });

  it('an invalid language and region is refused before any request', async () => {
    const { user, fake } = mount();
    await regional(user);
    const locale = await screen.findByLabelText('Language and region');
    await user.clear(locale);
    await user.type(locale, 'english');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a language and region such as en-AU.')).toBeTruthy();
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('switching business discards the page: the other business\'s values load, never the previous one\'s', async () => {
    const { user, fake } = mount();
    fake.profiles.beta = profile('beta', { currency: 'EUR', countryCode: 'DE', timeZone: 'Europe/Berlin', locale: 'de-DE' });
    await regional(user);
    await user.selectOptions(await screen.findByLabelText('Default currency'), 'NZD'); // an unsaved edit in alpha
    await user.click(screen.getByRole('button', { name: /Switch business/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Beta Plumbing/ }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' })); // the unsaved-changes guard asks first
    await h1(/Welcome to/);
    await user.click(within(zonesNav()).getByRole('button', { name: 'Settings' }));
    await h1('Business profile');
    expect(((await screen.findByLabelText('Business name')) as HTMLInputElement).value).toBe('Beta Plumbing');
    expect(fake.calls.filter((c) => c.path.includes('/b/beta/')).length).toBeGreaterThan(0);
  });
});

describe('request builders', () => {
  const start = { name: 'A', legalName: '', tradingName: '', contactEmail: '', contactPhone: '', website: '', line1: '', line2: '', city: '', region: '', postalCode: '', addressCountry: '' };
  it('profilePatch sends only changes and the version', () => {
    expect(profilePatch(start, start, 3)).toEqual({ version: 3 });
    expect(profilePatch(start, { ...start, city: 'Perth', addressCountry: 'AU' }, 3)).toEqual({ version: 3, address: { city: 'Perth', countryCode: 'AU' } });
    expect(profilePatch({ ...start, addressCountry: 'AU' }, start, 3)).toEqual({ version: 3, address: { countryCode: null } });
  });
  it('regionalPatch never includes unchanged codes', () => {
    const r = { countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD', fiscalYearStartMonth: '7' };
    expect(regionalPatch(r, r, 2)).toEqual({ version: 2 });
    expect(regionalPatch(r, { ...r, fiscalYearStartMonth: '' }, 2)).toEqual({ version: 2, fiscalYearStartMonth: null });
  });
});
