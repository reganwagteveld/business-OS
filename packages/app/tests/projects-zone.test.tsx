// @vitest-environment jsdom
// PR 18: the Projects Zone interface against a stand-in for the PR 18 API (real clients and contracts).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createCustomersClient, createProjectsClient, memoryStorage, type AuthClient, type BusinessContext, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';
import { ProjectsZone } from '../src/zones/projects/projects-zone';
import { createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness, type FakeMember } from './support/fake-api';
import { emptyProjects, project, task, withProjects, type FakeProjects } from './support/fake-projects';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const WORK = ['projects:read', 'projects:create', 'projects:update', 'projects:manage_tasks'];
const ALL = ['business:read', 'members:read', 'customers:read', 'customers:write', ...WORK, 'projects:archive'];
const MEMBER = ['business:read', 'members:read', 'customers:read', 'customers:write', ...WORK];
const READ_ONLY = ['business:read', 'members:read', 'customers:read', 'projects:read'];
const ADA = uuid();
const BEN = uuid();
const team = (): FakeMember[] => [
  { id: uuid(), userId: ADA, name: 'Ada Lovelace', role: 'OWNER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: uuid(), userId: BEN, name: 'Ben Okafor', role: 'MEMBER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' },
];
const ctx = (slug: string, permissions = ALL): BusinessContext => ({
  business: { slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

function setup(opts: { business?: Partial<FakeBusiness>; projects?: Partial<FakeProjects>; permissions?: string[]; before?: (api: ReturnType<typeof withProjects>) => void } = {}) {
  const biz: FakeBusiness = { ...emptyBusiness(), members: team(), ...opts.business };
  const api = withProjects(createFakeApi({ alpha: biz }), { alpha: { ...emptyProjects(), ...opts.projects } });
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onOpenCustomer: vi.fn() };
  opts.before?.(api);
  render(<ProjectsZone client={createProjectsClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
    context={ctx('alpha', opts.permissions)} userLabel="Ada" {...handlers} />);
  return { api, biz, handlers, user: userEvent.setup() };
}
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

describe('project overview', () => {
  it('loading, then an honest empty state with New project', async () => {
    setup();
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Loading projects…');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New project' }).length).toBeGreaterThan(0);
  });

  it('a failed load is an error with Try again, never an empty list', async () => {
    const { user } = setup({
      projects: { projects: [project({ name: 'Comes back' })] },
      before: (api) => api.projectsNext((path) => (path.endsWith('/projects') ? new Response('{}', { status: 500 }) : undefined)),
    });
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText('No projects yet')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Comes back' })).toBeTruthy();
  });

  it('shows real records: linked customer, owner, due date, priority, task progress and status, with real counts', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const fitout = project({ name: 'Office fit-out', customerId: acme.id, ownerUserId: ADA, dueDate: '2026-12-31', priority: 'HIGH', status: 'ACTIVE' });
    const internal = project({ name: 'Staff onboarding', createdAt: '2026-11-10T00:00:00.000Z' });
    setup({
      business: { customers: [acme] },
      projects: { projects: [fitout, internal], tasks: [task(fitout.id, { status: 'DONE', completedAt: '2026-11-12T00:00:00.000Z' }), task(fitout.id)] },
    });
    const table = await screen.findByRole('table', { name: 'Projects' });
    const row = within(table).getByRole('row', { name: /Office fit-out/ });
    for (const text of ['Acme Pty Ltd', 'Ada Lovelace', '31 Dec 2026', 'High', 'Active', '1 of 2 tasks done']) expect(row.textContent).toContain(text);
    expect(within(table).getByRole('row', { name: /Staff onboarding/ }).textContent).toContain('No tasks yet'); // no fake 0% bar
    const filters = screen.getByRole('group', { name: 'Filter by status' });
    await waitFor(() => expect(within(filters).getByRole('button', { name: /^All/ }).textContent).toBe('All2'));
    expect(within(filters).getByRole('button', { name: /^Active/ }).textContent).toBe('Active1');
  });

  it('searches by name and filters by status on the server', async () => {
    const { api, user } = setup({ projects: { projects: [project({ name: 'Relocation', status: 'ACTIVE' }), project({ name: 'Renovation' })] } });
    await screen.findByRole('button', { name: 'Relocation' });
    await user.type(screen.getByLabelText('Search projects by name'), 'reloc');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Renovation' })).toBeNull());
    expect(api.callsTo(/GET .*\/projects$/).some((c) => c.query.q === 'reloc')).toBe(true);
    await user.click(within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name: /^On hold/ }));
    expect(await screen.findByText('No projects match')).toBeTruthy();
    expect(api.callsTo(/GET .*\/projects$/).at(-1)!.query).toMatchObject({ status: 'ON_HOLD', q: 'reloc' });
    await user.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await screen.findByRole('button', { name: 'Renovation' })).toBeTruthy();
  });
});

describe('creating and editing', () => {
  it('validates before sending, links an existing customer, offers only active members as owner, then opens the project', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const members = [...team(), { id: uuid(), userId: uuid(), name: 'Sam Suspended', role: 'MEMBER' as const, status: 'SUSPENDED' as const, createdAt: '2026-11-01T00:00:00.000Z' }];
    const { api, user } = setup({ business: { customers: [acme], members } });
    await user.click((await screen.findAllByRole('button', { name: 'New project' }))[0]!);
    await heading('New project');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('A project name is required')).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Acme fit-out');
    await user.type(screen.getByLabelText('Start date'), '2026-12-10');
    await user.type(screen.getByLabelText('Due date'), '2026-12-01');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('The due date cannot be before the start date')).toBeTruthy();
    expect(api.callsTo(/POST .*\/projects$/)).toHaveLength(0);

    await user.clear(screen.getByLabelText('Due date'));
    await user.type(screen.getByLabelText('Due date'), '2026-12-20');
    const owner = screen.getByLabelText('Owner') as HTMLSelectElement;
    await waitFor(() => expect([...owner.options].map((o) => o.textContent)).toEqual(['No owner', 'Ada Lovelace', 'Ben Okafor'])); // no suspended member
    await user.selectOptions(owner, 'Ben Okafor');
    await user.selectOptions(screen.getByLabelText('Priority'), 'High');
    await user.type(screen.getByLabelText('Customer'), 'Acme');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd/ }));
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await heading('Acme fit-out')).toBeTruthy();
    expect(screen.getByText('Acme fit-out was created.')).toBeTruthy();
    expect(api.callsTo(/POST .*\/projects$/)[0]!.body).toEqual({
      name: 'Acme fit-out', status: 'PLANNED', priority: 'HIGH', customerId: acme.id, ownerUserId: BEN, startDate: '2026-12-10', dueDate: '2026-12-20',
    });
    const details = screen.getByLabelText('Details');
    for (const text of ['Acme Pty Ltd', 'Ben Okafor', '10 Dec 2026', '20 Dec 2026']) expect(details.textContent).toContain(text);
    expect(screen.getByLabelText('Progress').textContent).toContain('No tasks yet');
  });

  it('an internal project needs no customer; an edit sends only what changed plus its version', async () => {
    const p = project({ name: 'Office move', description: 'Old text' });
    const { api, user } = setup({ projects: { projects: [p] } });
    await user.click(await screen.findByRole('button', { name: 'Office move' }));
    expect((await screen.findByLabelText('Details')).textContent).toContain('None (internal)');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await heading('Edit Office move');
    await user.selectOptions(screen.getByLabelText('Status'), 'Active');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await heading('Office move')).toBeTruthy();
    expect(api.callsTo(/PATCH/)[0]!.body).toEqual({ status: 'ACTIVE', version: 1 });
    expect(screen.getByText('Changes saved.')).toBeTruthy();
  });

  it('someone else saved first: nothing is overwritten, the person\'s edits stay and theirs are named', async () => {
    const p = project({ name: 'Shared plan' });
    const { api, user } = setup({ projects: { projects: [p] } });
    await user.click(await screen.findByRole('button', { name: 'Shared plan' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Description'), 'Mine');
    Object.assign(api.projects.alpha!.projects[0]!, { priority: 'URGENT', version: 2 }); // a colleague saves meanwhile
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Someone else changed this project/)).toBeTruthy();
    expect(screen.getByText(/They changed: priority/)).toBeTruthy();
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Mine');
    expect((screen.getByLabelText('Priority') as HTMLSelectElement).value).toBe('URGENT');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await heading('Shared plan')).toBeTruthy();
    expect(api.projects.alpha!.projects[0]).toMatchObject({ description: 'Mine', priority: 'URGENT', version: 3 });
  });

  it('warns before discarding unsaved edits', async () => {
    const { handlers, user } = setup();
    await user.click((await screen.findAllByRole('button', { name: 'New project' }))[0]!);
    await user.type(await screen.findByLabelText('Name'), 'Half typed');
    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Half typed');
    expect(handlers.onHome).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /All Zones/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(handlers.onHome).toHaveBeenCalledOnce();
  });
});

describe('tasks', () => {
  it('adds tasks, marks one done, and progress comes from the real tasks', async () => {
    const p = project({ name: 'Renovation' });
    const { api, user } = setup({ projects: { projects: [p] } });
    await user.click(await screen.findByRole('button', { name: 'Renovation' }));
    const tasks = await screen.findByRole('region', { name: 'Tasks' });
    expect(await within(tasks).findByText('No tasks yet. Add the first one above.')).toBeTruthy();
    await user.click(within(tasks).getByRole('button', { name: 'Add task' }));
    expect(await within(tasks).findByText('A task title is required')).toBeTruthy();
    await user.type(within(tasks).getByLabelText('New task title'), 'Get quotes');
    await user.click(within(tasks).getByRole('button', { name: 'Priority, assignee and due date' }));
    await user.selectOptions(within(tasks).getByLabelText('Assignee'), 'Ada Lovelace');
    await user.selectOptions(within(tasks).getByLabelText('Priority'), 'Urgent');
    await user.click(within(tasks).getByRole('button', { name: 'Add task' }));
    expect(await within(tasks).findByText('Get quotes', { selector: 'p' })).toBeTruthy();
    expect(api.callsTo(/POST .*\/tasks$/)[0]!.body).toEqual({ title: 'Get quotes', priority: 'URGENT', assigneeUserId: ADA });
    await user.type(within(tasks).getByLabelText('New task title'), 'Pick supplier');
    await user.click(within(tasks).getByRole('button', { name: 'Add task' }));
    await within(tasks).findByText('Pick supplier', { selector: 'p' });

    await user.click(within(tasks).getByRole('checkbox', { name: 'Mark “Get quotes” as done' }));
    expect(await screen.findByText('Get quotes marked done.')).toBeTruthy();
    expect(api.projects.alpha!.tasks[0]).toMatchObject({ status: 'DONE', version: 2 });
    expect(api.projects.alpha!.tasks[0]!.completedAt).not.toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Progress').textContent).toContain('1 of 2 tasks done'));
    expect(screen.getByRole('progressbar', { name: '1 of 2 tasks done' })).toBeTruthy();

    // Grouped by status: Done shows only the done task.
    await user.click(within(tasks).getByRole('button', { name: /^Done/ }));
    const done = within(tasks).getByRole('list', { name: 'Task list: Done' });
    expect(within(done).getAllByRole('listitem')).toHaveLength(1);
    expect(done.textContent).toContain('Get quotes');
  });

  it('edits a task and changes its status; a stale change reloads instead of overwriting', async () => {
    const p = project({ name: 'Website refresh' });
    const t = task(p.id, { title: 'Draft copy' });
    const { api, user } = setup({ projects: { projects: [p], tasks: [t] } });
    await user.click(await screen.findByRole('button', { name: 'Website refresh' }));
    const tasks = await screen.findByRole('region', { name: 'Tasks' });
    await within(tasks).findByText('Draft copy', { selector: 'p' });
    await user.selectOptions(within(tasks).getByLabelText('Status of Draft copy'), 'Blocked');
    await waitFor(() => expect(api.projects.alpha!.tasks[0]).toMatchObject({ status: 'BLOCKED', version: 2 }));
    await user.click(within(tasks).getByRole('button', { name: 'Edit Draft copy' }));
    const editor = await within(tasks).findByRole('form', { name: 'Edit task Draft copy' });
    await user.clear(within(editor).getByLabelText('Title'));
    await user.type(within(editor).getByLabelText('Title'), 'Final copy');
    await user.type(within(editor).getByLabelText('Due date'), '2026-12-05');
    await user.click(within(editor).getByRole('button', { name: 'Save task' }));
    expect(await within(tasks).findByText('Final copy', { selector: 'p' })).toBeTruthy();
    expect(api.callsTo(/PATCH .*\/tasks\//).at(-1)!.body).toEqual({ version: 2, title: 'Final copy', dueDate: '2026-12-05' });

    Object.assign(api.projects.alpha!.tasks[0]!, { version: 9 }); // someone else changed it
    await user.selectOptions(within(tasks).getByLabelText('Status of Final copy'), 'Done');
    expect(await within(tasks).findByText(/Someone else changed this task/)).toBeTruthy();
    expect(api.projects.alpha!.tasks[0]!.status).toBe('BLOCKED');
  });

  it('removing a task asks first and archives it', async () => {
    const p = project({ name: 'Cleanup' });
    const { api, user } = setup({ projects: { projects: [p], tasks: [task(p.id, { title: 'Mistake' })] } });
    await user.click(await screen.findByRole('button', { name: 'Cleanup' }));
    const tasks = await screen.findByRole('region', { name: 'Tasks' });
    await within(tasks).findByText('Mistake', { selector: 'p' });
    await user.click(await within(tasks).findByRole('button', { name: 'Remove Mistake' }));
    const dialog = within(tasks).getByRole('alertdialog');
    expect(dialog.textContent).toContain('archived, not deleted');
    await user.click(within(dialog).getByRole('button', { name: 'Remove task' }));
    expect(await screen.findByText('Mistake was removed.')).toBeTruthy();
    expect(api.projects.alpha!.tasks[0]!.archivedAt).not.toBeNull();
    await waitFor(() => expect(within(tasks).queryByRole('button', { name: 'Remove Mistake' })).toBeNull());
  });
});

describe('archive and permissions', () => {
  it('archiving asks first, keeps the tasks and makes the project read-only; restore brings it back', async () => {
    const p = project({ name: 'Old office' });
    const { api, user } = setup({ projects: { projects: [p], tasks: [task(p.id, { title: 'Hand back keys' })] } });
    await user.click(await screen.findByRole('button', { name: 'Old office' }));
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Archive Old office?' });
    expect(dialog.textContent).toContain('its tasks are kept');
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
    expect(await screen.findByText('Project archived. Its tasks are kept.')).toBeTruthy();
    expect(await screen.findByText(/read-only until it is restored/)).toBeTruthy();
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    expect(await within(tasks).findByText('Hand back keys', { selector: 'p' })).toBeTruthy();
    expect(within(tasks).queryByRole('checkbox')).toBeNull();
    expect(within(tasks).queryByLabelText('New task title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Restore project' }));
    expect(await screen.findByText('Project restored.')).toBeTruthy();
    expect(api.projects.alpha!.projects[0]!.archivedAt).toBeNull();
  });

  it('read-only access sees projects and tasks but no create, edit, archive or task controls', async () => {
    const p = project({ name: 'Look only' });
    setup({ permissions: READ_ONLY, projects: { projects: [p], tasks: [task(p.id, { title: 'Viewed task', status: 'IN_PROGRESS' })] } });
    await user().click(await screen.findByRole('button', { name: 'Look only' }));
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    const tasks = await screen.findByRole('region', { name: 'Tasks' });
    expect(await within(tasks).findByText('Viewed task', { selector: 'p' })).toBeTruthy();
    expect(within(tasks).getByText('In progress', { selector: 'span' })).toBeTruthy(); // status as text, not a control
    for (const name of ['Edit', 'Archive', 'Restore project', 'Add task', 'Remove Viewed task']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Status of/ })).toBeNull();
  });

  it('a member can edit and manage tasks but is not offered Archive', async () => {
    setup({ permissions: MEMBER, projects: { projects: [project({ name: 'Member view' })] } });
    await user().click(await screen.findByRole('button', { name: 'Member view' }));
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByLabelText('New task title')).toBeTruthy();
  });

  it('without Customer Zone access: no customer lookup, and a linked customer is not named', async () => {
    const acme = customer({ displayName: 'Hidden Customer' });
    const { api } = setup({
      permissions: ['business:read', 'members:read', ...WORK],
      business: { customers: [acme] },
      projects: { customersVisible: false, projects: [project({ name: 'Linked work', customerId: acme.id })] },
    });
    const row = await screen.findByRole('row', { name: /Linked work/ });
    expect(row.textContent).toContain('Linked customer');
    expect(document.body.textContent).not.toContain('Hidden Customer');
    await user().click(within(row).getByRole('button', { name: 'Linked work' }));
    await user().click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByText(/does not include the Customers Zone/)).toBeTruthy();
    expect(screen.queryByLabelText('Customer')).toBeNull();
    expect(api.callsTo(/\/customers(\?|$)/)).toHaveLength(0);
  });
});

const user = () => userEvent.setup();

describe('the app: navigation, customers, business switching and desktop', () => {
  function mountApp(businesses: Record<string, FakeBusiness>, projects: Record<string, FakeProjects>, slugs: string[], permissions = ALL) {
    const api = withProjects(createFakeApi(businesses), projects);
    const auth = { session: vi.fn(async () => ({ kind: 'signed-in', user: { id: ADA, email: 'ada@example.com', name: 'Ada', emailVerified: true } }) as SessionCheck), signOut: vi.fn(async () => undefined) } as unknown as AuthClient;
    const tenancy: TenancyClient = {
      listBusinesses: vi.fn(async () => ({ kind: 'ok' as const, data: slugs.map((s) => ({ slug: s, name: ctx(s).business.name, role: 'MANAGER' as const })) })),
      businessContext: vi.fn(async (slug: string) => ({ kind: 'ok' as const, data: ctx(slug, permissions) })),
      createBusiness: vi.fn(),
    };
    render(<App platform="web" apiBaseUrl={BASE} auth={auth} tenancy={tenancy} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
      projects={createProjectsClient(BASE, { kind: 'cookie' }, api.fetch)} storage={memoryStorage({ slug: slugs[0] })} />);
    return { api, user: userEvent.setup() };
  }

  it('the Projects card opens the Zone; switching business shows only the new business\'s projects', async () => {
    const { api, user } = mountApp(
      { alpha: { ...emptyBusiness(), members: team() }, beta: { ...emptyBusiness(), members: team() } },
      { alpha: { ...emptyProjects(), projects: [project({ name: 'Alpha secret project' })] }, beta: { ...emptyProjects(), projects: [project({ name: 'Beta project' })] } },
      ['alpha', 'beta'],
    );
    await user.click(await screen.findByRole('button', { name: 'Open the Projects Zone' }));
    expect(await screen.findByRole('button', { name: 'Alpha secret project' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Switch business/ }));
    expect(screen.queryByText('Alpha secret project')).toBeNull();
    api.calls.length = 0;
    await user.click(await screen.findByRole('button', { name: /Beta Plumbing/ }));
    await user.click(await screen.findByRole('button', { name: 'Open the Projects Zone' }));
    expect(await screen.findByRole('button', { name: 'Beta project' })).toBeTruthy();
    expect(screen.queryByText('Alpha secret project')).toBeNull();
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['beta']));
  });

  it('without projects:read the Projects card stays closed', async () => {
    mountApp({ alpha: emptyBusiness() }, { alpha: emptyProjects() }, ['alpha'], ['business:read', 'members:read', 'customers:read']);
    await screen.findByText('Welcome to Alpha Plumbing.');
    expect(screen.getByLabelText('Projects Zone — coming soon')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the Projects Zone' })).toBeNull();
  });

  it('a customer\'s page lists its projects and opens one; the project links back to the customer', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const linked = project({ name: 'Acme fit-out', customerId: acme.id });
    const { user } = mountApp(
      { alpha: { ...emptyBusiness(), customers: [acme], members: team() } },
      { alpha: { ...emptyProjects(), projects: [linked, project({ name: 'Unrelated' })], tasks: [task(linked.id, { status: 'DONE', completedAt: '2026-11-12T00:00:00.000Z' })] } },
      ['alpha'],
    );
    await user.click(await screen.findByRole('button', { name: 'Open the Customers Zone' }));
    await user.click(await screen.findByRole('button', { name: 'Acme Pty Ltd' }));
    const panel = await screen.findByRole('region', { name: 'Projects' });
    expect(await within(panel).findByText('Acme fit-out')).toBeTruthy();
    expect(within(panel).queryByText('Unrelated')).toBeNull();
    expect(panel.textContent).toContain('1 of 1 task done');
    await user.click(within(panel).getByRole('button', { name: /Acme fit-out/ }));
    expect(await heading('Acme fit-out')).toBeTruthy();
    await user.click(within(screen.getByLabelText('Details')).getByRole('button', { name: 'Acme Pty Ltd' }));
    expect(await heading('Acme Pty Ltd')).toBeTruthy();
  });

  it('desktop: Projects requests carry the bearer token and no cookies; bad bodies never leave the client', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ projects: [], nextCursor: null }), { status: 200 }));
    const client = createProjectsClient('http://localhost:3000', { kind: 'bearer', getToken: async () => 'desktop-token' } as never, fetchMock as unknown as typeof fetch);
    expect((await client.list('alpha', { status: 'all', archived: 'active' })).kind).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/v1/b/alpha/projects?status=all&archived=active');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer desktop-token');
    expect(init.credentials).toBe('omit');
    expect((await client.create('alpha', { name: 'x', businessId: uuid() })).kind).toBe('invalid_input');
    expect((await client.create('alpha', { name: 'x', startDate: '2026-12-02', dueDate: '2026-12-01' })).kind).toBe('invalid_input');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
