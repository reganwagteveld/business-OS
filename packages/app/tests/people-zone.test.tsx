// @vitest-environment jsdom
// People P2: the People Zone interface against a stand-in for the People API (real client and contracts).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, createPeopleClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { PeopleZone } from '../src/zones/people/people-zone';
import { createFakeApi, emptyBusiness, uuid, type FakeBusiness, type FakeMember } from './support/fake-api';
import { department, emptyPeople, employee, location, withPeople, type FakePeople } from './support/fake-people';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const ALL = ['business:read', 'members:read', 'people:read', 'people:manage', 'people:configure', 'people:read_sensitive'];
const READ = ['business:read', 'members:read', 'people:read'];
const ADA = uuid();
const team = (): FakeMember[] => [{ id: uuid(), userId: ADA, name: 'Ada Lovelace', role: 'OWNER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' }];
const ctx = (slug: string, permissions = ALL): BusinessContext => ({
  business: { slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

function setup(opts: { people?: Partial<FakePeople>; permissions?: string[]; before?: (api: ReturnType<typeof withPeople>) => void; extra?: Record<string, FakePeople> } = {}) {
  const permissions = opts.permissions ?? ALL;
  const biz: FakeBusiness = { ...emptyBusiness(), members: team() };
  const api = withPeople(createFakeApi({ alpha: biz, beta: { ...emptyBusiness() } }), {
    alpha: { ...emptyPeople(permissions.filter((p) => p.startsWith('people:'))), ...opts.people }, beta: emptyPeople(), ...opts.extra,
  });
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  opts.before?.(api);
  render(<PeopleZone client={createPeopleClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
    context={ctx('alpha', permissions)} userLabel="Ada" {...handlers} />);
  return { api, handlers, user: userEvent.setup() };
}
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('employee directory', () => {
  it('loading, then an honest empty state with Add employee', async () => {
    setup();
    expect(screen.getByRole('status').textContent).toContain('Loading employees…');
    expect(await screen.findByText('No employees yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add employee' }).length).toBeGreaterThan(0);
  });

  it('read-only people see the empty state without any way to add', async () => {
    setup({ permissions: READ });
    expect(await screen.findByText('No employees yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add employee' })).toBeNull();
  });

  it('lists real fields and hides terminated people by default', async () => {
    const ops = department({ name: 'Field operations' });
    setup({ people: { employees: [
      employee({ givenName: 'Grace', familyName: 'Hopper', employeeNumber: 'E-7', jobTitle: 'Lead plumber', department: { id: ops.id, name: ops.name, archived: false }, startDate: '2026-02-03' }),
      employee({ givenName: 'Gone', familyName: 'Person', status: 'TERMINATED' }),
    ], departments: [ops] } });
    const row = within(await screen.findByRole('table', { name: 'Employees' })).getByRole('row', { name: /Grace Hopper/ });
    for (const text of ['E-7', 'Lead plumber', 'Field operations', 'Active', '3 Feb 2026']) expect(row.textContent).toContain(text);
    expect(screen.queryByText('Gone Person')).toBeNull();
  });

  it('shows terminated people when asked, and filters and searches on the server', async () => {
    const { api, user } = setup({ people: { employees: [employee({ givenName: 'Ann', familyName: 'Active' }), employee({ givenName: 'Tom', familyName: 'Left', status: 'TERMINATED' })] } });
    await screen.findByRole('button', { name: 'Ann Active' });
    await user.selectOptions(screen.getByLabelText('Status'), 'TERMINATED');
    expect(await screen.findByRole('button', { name: 'Tom Left' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ann Active' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    await screen.findByRole('button', { name: 'Ann Active' });
    await user.type(screen.getByLabelText('Search'), 'Tom');
    await waitFor(() => expect(api.callsTo(/GET .*\/people\/employees$/).some((c) => c.query.q === 'Tom')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ann Active' })).toBeNull());
  });

  it('filters by department and location, sorts, and offers Clear filters when nothing matches', async () => {
    const d1 = department({ name: 'Sales' });
    const l1 = location({ name: 'Perth' });
    const { api, user } = setup({ people: { departments: [d1], locations: [l1], employees: [employee({ givenName: 'Sam', familyName: 'Seller', department: { id: d1.id, name: 'Sales', archived: false } }), employee({ givenName: 'Lou', familyName: 'Other' })] } });
    await screen.findByRole('button', { name: 'Sam Seller' });
    await user.selectOptions(await screen.findByLabelText('Department'), d1.id);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Lou Other' })).toBeNull());
    await user.selectOptions(screen.getByLabelText('Sort by'), 'newest');
    await waitFor(() => expect(api.callsTo(/GET .*\/people\/employees$/).some((c) => c.query.sort === 'newest' && c.query.departmentId === d1.id)).toBe(true));
    await user.selectOptions(screen.getByLabelText('Location'), l1.id);
    expect(await screen.findByText('No employees match these filters')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('button', { name: 'Sam Seller' })).toBeTruthy();
  });

  it('pages 25 at a time with Next and Previous', async () => {
    const employees = Array.from({ length: 30 }, (_, i) => employee({ givenName: `Person${String(i).padStart(2, '0')}`, familyName: 'Test' }));
    const { user } = setup({ people: { employees } });
    await screen.findByRole('button', { name: 'Person00 Test' });
    expect(within(screen.getByRole('table', { name: 'Employees' })).getAllByRole('row')).toHaveLength(26); // header + 25
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: 'Person29 Test' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Person00 Test' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('button', { name: 'Person00 Test' })).toBeTruthy();
  });

  it('a failed load is an error with Try again, never an empty list', async () => {
    const { user } = setup({
      people: { employees: [employee({ givenName: 'Comes', familyName: 'Back' })] },
      before: (api) => api.peopleNext((path) => (path.endsWith('/people/employees') ? new Response('{}', { status: 500 }) : undefined)),
    });
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText('No employees yet')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Comes Back' })).toBeTruthy();
  });

  it('an offline failure says so', async () => {
    setup({ before: (api) => api.peopleNext((path) => (path.endsWith('/people/employees') ? 'network' : undefined)) });
    expect(await screen.findByText(/Can't reach Business OS|You're offline/)).toBeTruthy();
  });
});

describe('creating an employee', () => {
  it('validates fields inline and keeps what was typed', async () => {
    const { api, user } = setup();
    await user.click((await screen.findAllByRole('button', { name: 'Add employee' }))[0]!);
    await heading('Add employee');
    await user.type(screen.getByLabelText('Work email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    expect(await screen.findByText('A given name is required')).toBeTruthy();
    expect(screen.getByText('A family name is required')).toBeTruthy();
    expect(screen.getByText('Enter a valid email address')).toBeTruthy();
    expect((screen.getByLabelText('Work email') as HTMLInputElement).value).toBe('not-an-email');
    expect(api.callsTo(/POST .*\/people\/employees$/)).toHaveLength(0);
  });

  it('creates through the API, sends no account or access fields, and opens the new profile', async () => {
    const { api, user } = setup({ people: { departments: [department({ name: 'Sales' })] } });
    await user.click((await screen.findAllByRole('button', { name: 'Add employee' }))[0]!);
    await user.type(await screen.findByLabelText('Given name'), 'Grace');
    await user.type(screen.getByLabelText('Family name'), 'Hopper');
    await user.type(screen.getByLabelText('Job title'), 'Engineer');
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    expect(await heading(/Grace Hopper/)).toBeTruthy();
    expect(screen.getByText('Grace Hopper was added.')).toBeTruthy();
    const posts = api.callsTo(/POST .*\/people\/employees$/);
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]!.body as object).sort()).toEqual(['familyName', 'givenName', 'jobTitle', 'status']);
    expect(api.callsTo(/\/members|invitations/).filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('a duplicate employee number is refused on that field, and a double click sends once', async () => {
    const { api, user } = setup({ people: { employees: [employee({ employeeNumber: 'E-1' })] } });
    await user.click((await screen.findAllByRole('button', { name: 'Add employee' }))[0]!);
    await user.type(await screen.findByLabelText('Given name'), 'New');
    await user.type(screen.getByLabelText('Family name'), 'Person');
    await user.type(screen.getByLabelText('Employee number'), 'e-1');
    const release = api.peopleHold(/POST .*\/people\/employees$/);
    const submit = screen.getByRole('button', { name: 'Add employee' });
    await user.dblClick(submit);
    release();
    expect(await screen.findAllByText('Another employee already has this number.')).toBeTruthy();
    expect(api.callsTo(/POST .*\/people\/employees$/)).toHaveLength(1);
    expect((screen.getByLabelText('Given name') as HTMLInputElement).value).toBe('New');
  });

  it('a server failure keeps the form and says nothing was saved', async () => {
    const { user } = setup({ before: (api) => api.peopleNext((path, method) => (method === 'POST' && path.endsWith('/people/employees') ? 'network' : undefined)) });
    await user.click((await screen.findAllByRole('button', { name: 'Add employee' }))[0]!);
    await user.type(await screen.findByLabelText('Given name'), 'A');
    await user.type(screen.getByLabelText('Family name'), 'B');
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    expect(await screen.findByText(/Nothing was saved/)).toBeTruthy();
    expect((screen.getByLabelText('Family name') as HTMLInputElement).value).toBe('B');
  });

  it('leaving a form with unsaved changes asks first', async () => {
    const { user } = setup();
    await user.click((await screen.findAllByRole('button', { name: 'Add employee' }))[0]!);
    await user.type(await screen.findByLabelText('Given name'), 'Half');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Given name') as HTMLInputElement).value).toBe('Half');
  });
});

describe('employee profile and editing', () => {
  const grace = () => employee({ givenName: 'Grace', familyName: 'Hopper', jobTitle: 'Engineer', workEmail: 'grace@example.com', employeeNumber: 'E-9', employmentType: 'FULL_TIME' });

  it('shows persisted work information, honest gaps and the separate-from-sign-in note', async () => {
    const { user } = setup({ people: { employees: [grace()] } });
    await user.click(await screen.findByRole('button', { name: 'Grace Hopper' }));
    await heading(/Grace Hopper/);
    for (const text of ['grace@example.com', 'Full time', 'E-9', 'Not linked']) expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThan(0);
    expect(screen.getByText(/separate from a sign-in/)).toBeTruthy();
  });

  it('edits only what changed and sends the version', async () => {
    const { api, user } = setup({ people: { employees: [grace()] } });
    await user.click(await screen.findByRole('button', { name: 'Grace Hopper' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const title = await screen.findByLabelText('Job title');
    expect((title as HTMLInputElement).value).toBe('Engineer');
    await user.clear(title);
    await user.type(title, 'Principal engineer');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeTruthy();
    expect(api.callsTo(/PATCH .*\/people\/employees\/[^/]+$/)[0]!.body).toEqual({ jobTitle: 'Principal engineer', version: 1 });
  });

  it('a concurrent edit is never silently overwritten: the person is told and their change is kept', async () => {
    const e = grace();
    const { api, user } = setup({ people: { employees: [e] } });
    await user.click(await screen.findByRole('button', { name: 'Grace Hopper' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const title = await screen.findByLabelText('Job title');
    api.people.alpha!.employees[0]!.version = 2; // someone else saved first
    api.people.alpha!.employees[0]!.workPhone = '0400';
    await user.clear(title);
    await user.type(title, 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Someone else changed this employee/)).toBeTruthy();
    expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe('Mine');
    expect((screen.getByLabelText('Work phone') as HTMLInputElement).value).toBe('0400');
    expect(api.people.alpha!.employees[0]!.jobTitle).toBe('Engineer');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeTruthy();
    expect(api.people.alpha!.employees[0]!.jobTitle).toBe('Mine');
  });

  it('links an existing team member without creating access', async () => {
    const { api, user } = setup({ people: { employees: [grace()] } });
    await user.click(await screen.findByRole('button', { name: 'Grace Hopper' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.selectOptions(await screen.findByLabelText('Linked team member'), ADA);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    expect(api.callsTo(/PATCH .*\/people\/employees\/[^/]+$/)[0]!.body).toEqual({ userId: ADA, version: 1 });
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  });

  it('a missing employee is a not-found message, not a blank page', async () => {
    setup({ before: () => undefined });
    await screen.findByText('No employees yet');
    cleanup();
    const api = withPeople(createFakeApi({ alpha: { ...emptyBusiness(), members: team() } }), { alpha: emptyPeople() });
    render(<PeopleZone client={createPeopleClient(BASE, { kind: 'cookie' }, api.fetch)} context={ctx('alpha')} userLabel="Ada" initialEmployeeId={uuid()}
      onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});

describe('employment status', () => {
  it('offers only the P1 transitions, confirms, and records the change', async () => {
    const { api, user } = setup({ people: { employees: [employee({ givenName: 'Sam', familyName: 'Staff' })] } });
    await user.click(await screen.findByRole('button', { name: 'Sam Staff' }));
    await heading(/Sam Staff/);
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull(); // already active
    await user.click(screen.getByRole('button', { name: 'Mark on leave' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('permissions are not changed');
    await user.click(within(dialog).getByRole('button', { name: /Confirm: Mark on leave/ }));
    expect(await screen.findByText('Sam Staff is now on leave.')).toBeTruthy();
    expect(api.callsTo(/POST .*\/status$/)[0]!.body).toEqual({ status: 'ON_LEAVE', version: 1 });
    expect(await screen.findByRole('button', { name: 'Return from leave' })).toBeTruthy();
  });

  it('terminating warns about consequences, keeps history, and a refusal is explained', async () => {
    const e = employee({ givenName: 'Boss', familyName: 'Manager' });
    const { api, user } = setup({ people: { employees: [e], withReports: [e.id] } });
    await user.click(await screen.findByRole('button', { name: 'Boss Manager' }));
    await user.click(await screen.findByRole('button', { name: 'Terminate' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Nothing is deleted');
    await user.click(within(dialog).getByRole('button', { name: /Confirm: Terminate/ }));
    expect(await within(dialog).findByText(/still has direct reports/)).toBeTruthy();
    expect(api.people.alpha!.employees[0]!.status).toBe('ACTIVE');
    api.people.alpha!.withReports = [];
    await user.click(within(dialog).getByRole('button', { name: /Confirm: Terminate/ }));
    expect(await screen.findByText(/Employment ended/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rehire as active' })).toBeTruthy();
    expect((await screen.findAllByText('Terminated')).length).toBeGreaterThan(0);
  });

  it('a stale status change is refused and nothing changes', async () => {
    const { api, user } = setup({ people: { employees: [employee({ givenName: 'Sam', familyName: 'Staff' })] } });
    await user.click(await screen.findByRole('button', { name: 'Sam Staff' }));
    await user.click(await screen.findByRole('button', { name: 'Mark on leave' }));
    api.people.alpha!.employees[0]!.version = 5;
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Confirm/ }));
    expect(await screen.findByText(/Someone else changed this employee/)).toBeTruthy();
    expect(api.people.alpha!.employees[0]!.status).toBe('ACTIVE');
  });

  it('an invalid transition the screen did not expect is refused by the server and explained', async () => {
    const { api, user } = setup({ people: { employees: [employee({ givenName: 'Sam', familyName: 'Staff' })] } });
    await user.click(await screen.findByRole('button', { name: 'Sam Staff' }));
    await user.click(await screen.findByRole('button', { name: 'Mark on leave' }));
    api.people.alpha!.employees[0]!.status = 'PENDING'; // changed elsewhere; PENDING cannot go on leave
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Confirm/ }));
    expect(await screen.findByText(/not allowed from the current status/)).toBeTruthy();
  });

  it('read-only people cannot change status or edit', async () => {
    const { user } = setup({ permissions: READ, people: { employees: [employee({ givenName: 'Sam', familyName: 'Staff' })] } });
    await user.click(await screen.findByRole('button', { name: 'Sam Staff' }));
    await heading(/Sam Staff/);
    for (const name of ['Edit', 'Mark on leave', 'Terminate']) expect(screen.queryByRole('button', { name })).toBeNull();
  });
});

describe('sensitive details', () => {
  const e = employee({ givenName: 'Pat', familyName: 'Private' });
  it('are never requested without people:read_sensitive, and the section is not shown', async () => {
    const { api, user } = setup({ permissions: ['business:read', 'people:read', 'people:manage'], people: { employees: [e], personal: { [e.id]: { personalEmail: 'secret@home.test', personalPhone: null, homeAddress: null, emergencyContactName: null, emergencyContactRelationship: null, emergencyContactPhone: null, version: 1, updatedAt: null } } } });
    await user.click(await screen.findByRole('button', { name: 'Pat Private' }));
    await heading(/Pat Private/);
    expect(screen.queryByText('Personal details')).toBeNull();
    expect(screen.queryByText('secret@home.test')).toBeNull();
    expect(api.callsTo(/\/personal$/)).toHaveLength(0);
  });

  it('the server refuses them too: a forged request is a 403', async () => {
    const api = withPeople(createFakeApi({ alpha: emptyBusiness() }), { alpha: { ...emptyPeople(['people:read', 'people:manage']), employees: [e] } });
    const client = createPeopleClient(BASE, { kind: 'cookie' }, api.fetch);
    expect((await client.personal('alpha', e.id)).kind).toBe('forbidden');
    expect((await client.updatePersonal('alpha', e.id, { personalEmail: 'x@y.test', version: 0 })).kind).toBe('forbidden');
  });

  it('are shown and editable with the key', async () => {
    const { api, user } = setup({ people: { employees: [e] } });
    await user.click(await screen.findByRole('button', { name: 'Pat Private' }));
    await user.click(await screen.findByRole('button', { name: 'Add personal details' }));
    await user.type(await screen.findByLabelText('Personal email'), 'pat@home.test');
    await user.click(screen.getByRole('button', { name: 'Save personal details' }));
    expect(await screen.findByText('pat@home.test')).toBeTruthy();
    expect(api.callsTo(/PATCH .*\/personal$/)[0]!.body).toEqual({ personalEmail: 'pat@home.test', version: 0 });
  });
});

describe('server authorization and tenant isolation (not just hidden buttons)', () => {
  it('a read-only caller cannot create, edit or change status even by calling the API', async () => {
    const e = employee();
    const api = withPeople(createFakeApi({ alpha: emptyBusiness() }), { alpha: { ...emptyPeople(['people:read']), employees: [e] } });
    const client = createPeopleClient(BASE, { kind: 'cookie' }, api.fetch);
    expect((await client.create('alpha', { givenName: 'A', familyName: 'B' })).kind).toBe('forbidden');
    expect((await client.update('alpha', e.id, { jobTitle: 'X', version: 1 })).kind).toBe('forbidden');
    expect((await client.changeStatus('alpha', e.id, { status: 'ON_LEAVE', version: 1 })).kind).toBe('forbidden');
    expect((await client.createDepartment('alpha', { name: 'X' })).kind).toBe('forbidden');
    expect(api.people.alpha!.employees[0]!.version).toBe(1);
  });

  it('another business\'s employee id is not found, and the client never sends a business id in a body', async () => {
    const theirs = employee({ givenName: 'Beta', familyName: 'Secret' });
    const api = withPeople(createFakeApi({ alpha: emptyBusiness(), beta: emptyBusiness() }), { alpha: emptyPeople(), beta: { ...emptyPeople(), employees: [theirs] } });
    const client = createPeopleClient(BASE, { kind: 'cookie' }, api.fetch);
    expect((await client.get('alpha', theirs.id)).kind).toBe('not_found');
    expect((await client.update('alpha', theirs.id, { jobTitle: 'X', version: 1 })).kind).toBe('not_found');
    expect((await client.changeStatus('alpha', theirs.id, { status: 'ON_LEAVE', version: 1 })).kind).toBe('not_found');
    expect((await client.create('alpha', { givenName: 'A', familyName: 'B', businessId: uuid() })).kind).toBe('invalid_input');
    const list = await client.list('alpha', { status: 'all' });
    expect(list.kind === 'ok' && list.data.employees).toEqual([]);
  });

  it('switching business discards the previous business\'s people', async () => {
    const api = withPeople(createFakeApi({ alpha: { ...emptyBusiness(), members: team() }, beta: { ...emptyBusiness(), members: team() } }), {
      alpha: { ...emptyPeople(), employees: [employee({ givenName: 'Alpha', familyName: 'Only' })] }, beta: { ...emptyPeople(), employees: [employee({ givenName: 'Beta', familyName: 'Only' })] },
    });
    const view = (slug: string) => <PeopleZone key={slug} client={createPeopleClient(BASE, { kind: 'cookie' }, api.fetch)} context={ctx(slug)} userLabel="Ada" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />;
    const { rerender } = render(view('alpha'));
    expect(await screen.findByRole('button', { name: 'Alpha Only' })).toBeTruthy();
    rerender(view('beta'));
    expect(await screen.findByRole('button', { name: 'Beta Only' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Alpha Only' })).toBeNull();
  });
});

describe('departments and locations', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, tab: 'Departments' | 'Locations') => {
    await screen.findByRole('table', { name: 'Employees' }).catch(() => undefined);
    await user.click(await screen.findByRole('button', { name: tab }));
    await heading(tab);
  };

  it('creates a department without leaving People, and it becomes a choice for employees', async () => {
    const { user } = setup();
    await open(user, 'Departments');
    expect(await screen.findByText('No departments yet')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Add department' })[0]!);
    await user.type(await screen.findByLabelText('Name'), 'Field crew');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add department' }));
    expect(await screen.findByText('Field crew was added.')).toBeTruthy();
    expect(within(await screen.findByRole('table', { name: 'Departments' })).getByText('Field crew')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Employees' }));
    expect(await screen.findByRole('option', { name: 'Field crew' })).toBeTruthy();
  });

  it('rejects a duplicate name on the field and edits with the version', async () => {
    const d = department({ name: 'Sales' });
    const { api, user } = setup({ people: { departments: [d, department({ name: 'Ops' })] } });
    await open(user, 'Departments');
    await user.click(await screen.findByRole('button', { name: 'Edit Ops' }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'sales');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('An active department with this name already exists.')).toBeTruthy();
    await user.clear(name);
    await user.type(name, 'Operations');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeTruthy();
    expect(api.callsTo(/PATCH .*\/departments\/[^/]+$/).pop()!.body).toEqual({ name: 'Operations', version: 1 });
  });

  it('archive is refused while people are assigned, and works (and restores) once empty', async () => {
    const d = department({ name: 'Busy' });
    const e = employee({ department: { id: d.id, name: 'Busy', archived: false } });
    const { api, user } = setup({ people: { departments: [d], employees: [e] } });
    await open(user, 'Departments');
    await user.click(await screen.findByRole('button', { name: 'Archive Busy' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive department' }));
    expect(await screen.findByText(/People are still assigned to this department/)).toBeTruthy();
    expect(api.people.alpha!.departments[0]!.archivedAt).toBeNull();
    api.people.alpha!.employees[0]!.department = null;
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive department' }));
    expect(await screen.findByText('Busy was archived.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archive Busy' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Show'), 'archived');
    await user.click(await screen.findByRole('button', { name: 'Restore Busy' }));
    expect(await screen.findByText('Busy was restored.')).toBeTruthy();
  });

  it('locations work the same way', async () => {
    const { api, user } = setup();
    await open(user, 'Locations');
    await user.click((await screen.findAllByRole('button', { name: 'Add location' }))[0]!);
    await user.type(await screen.findByLabelText('Name'), 'Perth depot');
    await user.type(screen.getByLabelText('Address'), '1 Example St');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add location' }));
    expect(await screen.findByText('Perth depot was added.')).toBeTruthy();
    expect(api.callsTo(/POST .*\/locations$/)[0]!.body).toEqual({ name: 'Perth depot', address: '1 Example St' });
  });

  it('people without people:configure can view but not change them', async () => {
    const { user } = setup({ permissions: READ, people: { departments: [department({ name: 'Sales' })] } });
    await open(user, 'Departments');
    expect(await screen.findByText('Sales')).toBeTruthy();
    for (const name of [/Add department/, /Edit Sales/, /Archive Sales/]) expect(screen.queryByRole('button', { name })).toBeNull();
  });
});

describe('the app: navigation into People', () => {
  function mountApp(permissions: string[]) {
    const api = withPeople(createFakeApi({ alpha: { ...emptyBusiness(), members: team() } }), { alpha: { ...emptyPeople(), employees: [employee({ givenName: 'Nav', familyName: 'Test' })] } });
    const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: { id: ADA, email: 'ada@example.com', name: 'Ada', emailVerified: true } }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
    const tenancy: TenancyClient = {
      listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: [{ slug: 'alpha', name: 'Alpha Plumbing', role: 'MANAGER' as const }] })),
      businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug, permissions) })),
      createBusiness: vi.fn(),
      platformAccess: vi.fn(async () => ({ kind: 'ok' as const, data: { canCreateBusiness: true } })),
    };
    render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
      people={createPeopleClient(BASE, { kind: 'cookie' }, api.fetch)} storage={memoryStorage({ slug: 'alpha' })} />);
    return { api, user: userEvent.setup() };
  }

  it('the People card opens the directory and an employee profile', async () => {
    const { user } = mountApp(ALL);
    await user.click(await screen.findByRole('button', { name: 'Open the People Zone' }));
    await user.click(await screen.findByRole('button', { name: 'Nav Test' }));
    expect(await heading(/Nav Test/)).toBeTruthy();
  });

  it('without people:read the Zone is a "coming soon"-free absence: no card, no navigation entry', async () => {
    mountApp(['business:read', 'members:read']);
    await screen.findByText(/Welcome to/);
    expect(screen.queryByRole('button', { name: 'Open the People Zone' })).toBeNull();
  });
});

describe('department and manager assignments', () => {
  const setupTeam = () => {
    const sales = department({ name: 'Sales' });
    const ops = department({ name: 'Operations' });
    const boss = employee({ givenName: 'Bea', familyName: 'Boss' });
    const sam = employee({ givenName: 'Sam', familyName: 'Staff', department: { id: ops.id, name: 'Operations', archived: false } });
    const gone = employee({ givenName: 'Gus', familyName: 'Gone', status: 'TERMINATED' });
    return { sales, ops, boss, sam, gone };
  };
  const openProfile = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(await screen.findByRole('button', { name }));
    await heading(new RegExp(name));
  };

  it('moves an employee to another department with an effective date and shows the history', async () => {
    const { sales, ops, sam } = setupTeam();
    const { api, user } = setup({ people: { departments: [sales, ops], employees: [sam] } });
    await openProfile(user, 'Sam Staff');
    await user.click(screen.getByRole('button', { name: 'Change department' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Department'), sales.id);
    await user.type(within(dialog).getByLabelText('Effective date'), '2026-11-10');
    await user.click(within(dialog).getByRole('button', { name: 'Save department' }));
    expect(await screen.findByText("Sam Staff's department was updated.")).toBeTruthy();
    expect(api.callsTo(/POST .*\/department$/)[0]!.body).toEqual({ departmentId: sales.id, effectiveDate: '2026-11-10', version: 1 });
    expect(await screen.findByText(/Department: Sales/)).toBeTruthy();
    expect(within(screen.getByText('Department and reporting history').closest('section')!).getByText(/Department: Sales/).parentElement!.textContent).toContain('to now');
  });

  it('clears a department, and refuses a stale version or an archived department with an explanation', async () => {
    const { sales, ops, sam } = setupTeam();
    const { api, user } = setup({ people: { departments: [sales, ops], employees: [sam] } });
    await openProfile(user, 'Sam Staff');
    await user.click(screen.getByRole('button', { name: 'Change department' }));
    let dialog = await screen.findByRole('dialog');
    api.people.alpha!.employees[0]!.version = 4; // someone else saved first
    await user.selectOptions(within(dialog).getByLabelText('Department'), '');
    await user.click(within(dialog).getByRole('button', { name: 'Save department' }));
    expect(await within(dialog).findByText(/Someone else changed this employee/)).toBeTruthy();
    expect(api.people.alpha!.employees[0]!.department?.name).toBe('Operations');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Change department' }));
    dialog = await screen.findByRole('dialog');
    api.people.alpha!.employees[0]!.version = 1;
    sales.archivedAt = '2026-11-15T00:00:00.000Z'; // archived after the choices loaded
    await user.selectOptions(within(dialog).getByLabelText('Department'), sales.id);
    await user.click(within(dialog).getByRole('button', { name: 'Save department' }));
    expect(await within(dialog).findByText(/That department has been archived/)).toBeTruthy();
  });

  it('sets a manager from a server-side search, never offering the employee or terminated people', async () => {
    const { boss, sam, gone } = setupTeam();
    const { api, user } = setup({ people: { employees: [boss, sam, gone] } });
    await openProfile(user, 'Sam Staff');
    await user.click(screen.getByRole('button', { name: 'Change manager' }));
    const dialog = await screen.findByRole('dialog');
    const select = await within(dialog).findByLabelText('Reports to');
    await waitFor(() => expect(within(select).queryByRole('option', { name: /Bea Boss/ })).toBeTruthy());
    expect(within(select).queryByRole('option', { name: /Sam Staff/ })).toBeNull();
    expect(within(select).queryByRole('option', { name: /Gus Gone/ })).toBeNull();
    await user.type(within(dialog).getByLabelText('Find a person'), 'Bea');
    await waitFor(() => expect(api.callsTo(/GET .*\/people\/employees$/).some((c) => c.query.q === 'Bea' && c.query.limit === '25')).toBe(true));
    await user.selectOptions(select, boss.id);
    await user.click(within(dialog).getByRole('button', { name: 'Save manager' }));
    expect(await screen.findByText("Sam Staff's manager was updated.")).toBeTruthy();
    expect(api.callsTo(/POST .*\/manager$/)[0]!.body).toEqual({ managerEmployeeId: boss.id, version: 1 });
    expect(await screen.findByText(/Reports to: Bea Boss/)).toBeTruthy();
  });

  it('a reporting-line cycle, a terminated manager and a self-assignment are refused by the server and explained', async () => {
    const { boss, sam, gone } = setupTeam();
    boss.manager = { id: sam.id, name: sam.displayName, status: 'ACTIVE' }; // Bea already reports to Sam
    const { api, user } = setup({ people: { employees: [boss, sam, gone] } });
    await openProfile(user, 'Sam Staff');
    await user.click(screen.getByRole('button', { name: 'Change manager' }));
    const dialog = await screen.findByRole('dialog');
    const select = await within(dialog).findByLabelText('Reports to');
    await waitFor(() => expect(within(select).queryByRole('option', { name: /Bea Boss/ })).toBeTruthy());
    await user.selectOptions(select, boss.id);
    await user.click(within(dialog).getByRole('button', { name: 'Save manager' }));
    expect(await within(dialog).findByText(/reporting loop/)).toBeTruthy();
    expect(api.people.alpha!.employees.find((x) => x.id === sam.id)!.manager).toBeNull();
    // the client never offers these, but a forged request is refused by the server as well
    const client = createPeopleClient(BASE, { kind: 'cookie' }, api.fetch);
    expect((await client.changeManager('alpha', sam.id, { managerEmployeeId: sam.id, version: 1 })).kind).toBe('conflict');
    expect((await client.changeManager('alpha', sam.id, { managerEmployeeId: gone.id, version: 1 })).kind).toBe('conflict');
  });

  it('a future effective date is refused with the server\'s message', async () => {
    const { sales, sam } = setupTeam();
    const { user } = setup({ people: { departments: [sales], employees: [sam] } });
    await openProfile(user, 'Sam Staff');
    await user.click(screen.getByRole('button', { name: 'Change department' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Department'), sales.id);
    await user.type(within(dialog).getByLabelText('Effective date'), '2030-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'Save department' }));
    expect(await within(dialog).findByText('The effective date cannot be in the future.')).toBeTruthy();
  });

  it('can be chosen when adding an employee', async () => {
    const { boss, sales } = setupTeam();
    const { api, user } = setup({ people: { employees: [boss], departments: [sales] } });
    await user.click((await screen.findAllByRole('button', { name: 'Add employee' }))[0]!);
    await user.type(await screen.findByLabelText('Given name'), 'New');
    await user.type(screen.getByLabelText('Family name'), 'Hire');
    await user.selectOptions(screen.getByLabelText('Department'), sales.id);
    const select = screen.getByLabelText('Reports to');
    await waitFor(() => expect(within(select).queryByRole('option', { name: /Bea Boss/ })).toBeTruthy());
    await user.selectOptions(select, boss.id);
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    await heading(/New Hire/);
    expect(api.callsTo(/POST .*\/people\/employees$/)[0]!.body).toMatchObject({ departmentId: sales.id, managerEmployeeId: boss.id });
  });

  it('read-only people have no change actions, and the API refuses a forged change', async () => {
    const { sales, sam, boss } = setupTeam();
    const { api, user } = setup({ permissions: READ, people: { departments: [sales], employees: [sam, boss] } });
    await openProfile(user, 'Sam Staff');
    expect(screen.queryByRole('button', { name: 'Change department' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change manager' })).toBeNull();
    const client = createPeopleClient(BASE, { kind: 'cookie' }, api.fetch);
    expect((await client.changeDepartment('alpha', sam.id, { departmentId: sales.id, version: 1 })).kind).toBe('forbidden');
    expect((await client.changeManager('alpha', sam.id, { managerEmployeeId: boss.id, version: 1 })).kind).toBe('forbidden');
  });

  it('terminated employees offer no assignment changes, and another business\'s ids are not found', async () => {
    const { sam, gone } = setupTeam();
    const theirs = employee({ givenName: 'Beta', familyName: 'Secret' });
    const { api, user } = setup({ people: { employees: [sam, gone] }, extra: { beta: { ...emptyPeople(), employees: [theirs] } } });
    await user.selectOptions(await screen.findByLabelText('Status'), 'TERMINATED');
    await openProfile(user, 'Gus Gone');
    expect(screen.queryByRole('button', { name: 'Change department' })).toBeNull();
    const client = createPeopleClient(BASE, { kind: 'cookie' }, api.fetch);
    expect((await client.changeDepartment('alpha', theirs.id, { departmentId: null, version: 1 })).kind).toBe('not_found');
    expect((await client.changeManager('alpha', sam.id, { managerEmployeeId: theirs.id, version: 1 })).kind).toBe('not_found');
  });
});
