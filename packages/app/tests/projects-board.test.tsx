// @vitest-environment jsdom
// PR 19: the Projects board, against the stand-in Projects API (real clients and contracts).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createProjectsClient, type BusinessContext } from '../src';
import { DEFAULT_TASK_BOARD } from '../src/zones/projects/board-stages';
import { ProjectsZone } from '../src/zones/projects/projects-zone';
import { createFakeApi, emptyBusiness, uuid, type FakeBusiness, type FakeMember } from './support/fake-api';
import { emptyProjects, project, task, withProjects, type FakeProjects } from './support/fake-projects';

// jsdom has no DragEvent; without one, drag events lose clientY (which decides the drop slot).
if (!('DragEvent' in window)) {
  (window as unknown as { DragEvent: unknown }).DragEvent = class DragEvent extends MouseEvent {};
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const WORK = ['projects:read', 'projects:create', 'projects:update', 'projects:manage_tasks'];
const ALL = ['business:read', 'members:read', 'customers:read', ...WORK, 'projects:archive'];
const READ_ONLY = ['business:read', 'members:read', 'customers:read', 'projects:read'];
const ADA = uuid();
const BEN = uuid();
const team = (): FakeMember[] => [
  { id: uuid(), userId: ADA, name: 'Ada Lovelace', role: 'OWNER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: uuid(), userId: BEN, name: 'Ben Okafor', role: 'MEMBER', status: 'ACTIVE', createdAt: '2026-11-01T00:00:00.000Z' },
];
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: uuid(), role: 'MANAGER', permissions },
});

/** A project with tasks in a known order: To Do [a, b], In Progress [c, blocked d], Done [e]. */
function fixture(over: Partial<ReturnType<typeof project>> = {}) {
  const p = project({ name: 'Kitchen renovation', ...over });
  const t = {
    a: task(p.id, { title: 'Order cabinets', position: 1000, priority: 'HIGH', assigneeUserId: ADA, dueDate: '2020-01-10' }),
    b: task(p.id, { title: 'Book electrician', position: 2000, description: 'Needs a licensed sparky' }),
    c: task(p.id, { title: 'Remove old benchtop', position: 3000, status: 'IN_PROGRESS', assigneeUserId: BEN }),
    d: task(p.id, { title: 'Plumbing rough-in', position: 4000, status: 'BLOCKED', priority: 'URGENT' }),
    e: task(p.id, { title: 'Measure the room', position: 5000, status: 'DONE', completedAt: '2026-11-10T00:00:00.000Z' }),
  };
  return { p, t, tasks: Object.values(t) };
}

async function openBoard(opts: { permissions?: string[]; projects?: Partial<FakeProjects>; wrap?: (f: typeof fetch) => typeof fetch; archived?: boolean } = {}) {
  const biz: FakeBusiness = { ...emptyBusiness(), members: team() };
  const api = withProjects(createFakeApi({ alpha: biz }), { alpha: { ...emptyProjects(), ...opts.projects } });
  const f: typeof fetch = (input, init) => api.fetch(input, init);
  const net = opts.wrap ? opts.wrap(f) : f;
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onOpenCustomer: vi.fn() };
  render(<ProjectsZone client={createProjectsClient(BASE, { kind: 'cookie' }, net)} customers={createCustomersClient(BASE, { kind: 'cookie' }, net)}
    context={ctx(opts.permissions ?? ALL)} userLabel="Ada" {...handlers} />);
  const user = userEvent.setup();
  if (opts.archived) await user.selectOptions(await screen.findByLabelText('Records'), 'Archived');
  await user.click(await screen.findByRole('button', { name: 'Kitchen renovation' }));
  const board = await screen.findByRole('region', { name: 'Tasks' });
  await within(board).findByRole('list', { name: 'To Do tasks' });
  return { api, user, board, handlers };
}
const column = (board: HTMLElement, label: string) => within(board).getByRole('list', { name: `${label} tasks` });
const titles = (board: HTMLElement, label: string) => within(column(board, label)).queryAllByRole('button', { name: (n) => !/^Move/.test(n) && !/^Add task/.test(n) }).map((b) => b.textContent);
const moves = (api: ReturnType<typeof withProjects>) => api.callsTo(/POST .*\/move$/);
const card = (board: HTMLElement, title: string) => within(board).getByRole('button', { name: title }).closest('[draggable]') as HTMLElement;
const drag = (from: HTMLElement, to: HTMLElement, id: string, clientY: number) => {
  fireEvent.dragStart(from, { dataTransfer: { effectAllowed: 'move', setData: vi.fn(), getData: () => id } });
  fireEvent.dragOver(to, { clientY, dataTransfer: { dropEffect: 'move' } });
  fireEvent.drop(to, { clientY, dataTransfer: { getData: () => id } });
};

describe('board layout', () => {
  it('opens on the board: To Do, In Progress and Done, in the stored order, with counts; Blocked shows inside In Progress', async () => {
    const { p, tasks } = fixture();
    const { board } = await openBoard({ projects: { projects: [p], tasks } });
    expect(DEFAULT_TASK_BOARD.map((s) => s.label)).toEqual(['To Do', 'In Progress', 'Done']);
    for (const label of ['To Do', 'In Progress', 'Done']) expect(within(board).getByRole('group', { name: new RegExp(`^${label}`) })).toBeTruthy();
    expect(titles(board, 'To Do')).toEqual(['Order cabinets', 'Book electrician']);
    expect(titles(board, 'In Progress')).toEqual(['Remove old benchtop', 'Plumbing rough-in']);
    expect(titles(board, 'Done')).toEqual(['Measure the room']);
    expect(within(column(board, 'In Progress')).getByText('Blocked')).toBeTruthy();
    expect(within(board).getAllByLabelText('2 tasks', { selector: 'span' })).toHaveLength(2);
    expect(within(board).getByLabelText('1 task', { selector: 'span' })).toBeTruthy();
    // Card facts: assignee, priority, overdue due date.
    const a = card(board, 'Order cabinets');
    expect(a.textContent).toContain('Ada Lovelace');
    expect(a.textContent).toContain('High');
    expect(a.textContent).toContain('Overdue');
    expect(card(board, 'Book electrician').textContent).toContain('Unassigned');
    // The view switch: Board is pressed; List shows the PR 18 list.
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a failed load is an error with Try again (never an empty board); an empty project shows honest empty columns', async () => {
    const biz: FakeBusiness = { ...emptyBusiness(), members: team() };
    const api = withProjects(createFakeApi({ alpha: biz }), { alpha: { ...emptyProjects(), projects: [project({ name: 'Kitchen renovation' })] } });
    api.projectsNext((path, method) => (method === 'GET' && path.endsWith('/tasks') ? new Response('{}', { status: 500 }) : undefined));
    render(<ProjectsZone client={createProjectsClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
      context={ctx(ALL)} userLabel="Ada" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} onOpenCustomer={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Kitchen renovation' }));
    const board = await screen.findByRole('region', { name: 'Tasks' });
    expect(await within(board).findByText('Something went wrong')).toBeTruthy();
    expect(within(board).queryByRole('list', { name: 'To Do tasks' })).toBeNull();
    await user.click(within(board).getByRole('button', { name: 'Try again' }));
    expect(await within(board).findAllByText('No tasks. Add one below or drag one here.')).toHaveLength(3);
  });
});

describe('moving tasks', () => {
  it('drag and drop between columns: one server move after the last card, persisted, completion stamped', async () => {
    const { p, t, tasks } = fixture();
    const { api, board } = await openBoard({ projects: { projects: [p], tasks } });
    drag(card(board, 'Book electrician'), column(board, 'Done'), t.b.id, 10_000);
    await waitFor(() => expect(titles(board, 'Done')).toEqual(['Measure the room', 'Book electrician']));
    expect(moves(api)).toHaveLength(1);
    expect(moves(api)[0]!.body).toEqual({ version: 1, status: 'DONE', afterTaskId: t.e.id });
    const stored = api.projects.alpha!.tasks.find((x) => x.id === t.b.id)!;
    expect(stored).toMatchObject({ status: 'DONE', version: 2 });
    expect(stored.completedAt).not.toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Progress').textContent).toContain('2 of 5 tasks done'));
  });

  it('drag within a column reorders it; a Blocked task stays Blocked inside In Progress', async () => {
    const { p, t, tasks } = fixture();
    const { api, board } = await openBoard({ projects: { projects: [p], tasks } });
    drag(card(board, 'Plumbing rough-in'), column(board, 'In Progress'), t.d.id, 0); // above everything
    await waitFor(() => expect(titles(board, 'In Progress')).toEqual(['Plumbing rough-in', 'Remove old benchtop']));
    expect(moves(api)[0]!.body).toEqual({ version: 1, status: 'BLOCKED', afterTaskId: null });
    expect(api.projects.alpha!.tasks.find((x) => x.id === t.d.id)!.status).toBe('BLOCKED');
    // Dropping a card where it already is sends nothing.
    drag(card(board, 'Order cabinets'), column(board, 'To Do'), t.a.id, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(moves(api)).toHaveLength(1);
  });

  it('keyboard: Alt+arrows move between columns and within one; focus stays on the card and the move is announced', async () => {
    const { p, t, tasks } = fixture();
    const { api, board, user } = await openBoard({ projects: { projects: [p], tasks } });
    const button = within(board).getByRole('button', { name: 'Book electrician' });
    button.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(titles(board, 'In Progress')).toEqual(['Remove old benchtop', 'Plumbing rough-in', 'Book electrician']));
    expect(moves(api)[0]!.body).toEqual({ version: 1, status: 'IN_PROGRESS', afterTaskId: t.d.id });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Book electrician'));
    expect(await screen.findByText('Book electrician moved to In Progress, position 3 of 3.')).toBeTruthy();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(titles(board, 'In Progress')).toEqual(['Remove old benchtop', 'Book electrician', 'Plumbing rough-in']));
    expect(moves(api)[1]!.body).toEqual({ version: 2, status: 'IN_PROGRESS', afterTaskId: t.c.id });
    await user.keyboard('{Alt>}{Home}{/Alt}');
    await waitFor(() => expect(titles(board, 'In Progress')[0]).toBe('Book electrician'));
    expect(moves(api)[2]!.body).toEqual({ version: 3, status: 'IN_PROGRESS', afterTaskId: null });
    // Plain arrows do nothing (they belong to the page).
    await user.keyboard('{ArrowLeft}');
    expect(moves(api)).toHaveLength(3);
    // Alt+Left from the first column goes nowhere.
    within(board).getByRole('button', { name: 'Order cabinets' }).focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(moves(api)).toHaveLength(3);
  });

  it('the Move button offers every move as a plain button', async () => {
    const { p, t, tasks } = fixture();
    const { api, board, user } = await openBoard({ projects: { projects: [p], tasks } });
    await user.click(within(board).getByRole('button', { name: 'Move Order cabinets', expanded: false }));
    const menu = within(board).getByRole('group', { name: 'Move Order cabinets' });
    expect((within(menu).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true); // already first
    expect(within(menu).queryByRole('button', { name: 'Move to To Do' })).toBeNull();
    await user.click(within(menu).getByRole('button', { name: 'Move to Done' }));
    await waitFor(() => expect(titles(board, 'Done')).toEqual(['Measure the room', 'Order cabinets']));
    expect(moves(api)[0]!.body).toEqual({ version: 1, status: 'DONE', afterTaskId: t.e.id });
    // Escape closes the menu without moving.
    await user.click(within(board).getByRole('button', { name: 'Move Book electrician', expanded: false }));
    await user.keyboard('{Escape}');
    expect(within(board).queryByRole('group', { name: 'Move Book electrician' })).toBeNull();
    expect(moves(api)).toHaveLength(1);
  });

  it('a stale move is refused: the card goes back, the latest board is shown, and nothing is overwritten', async () => {
    const { p, t, tasks } = fixture();
    const { api, board, user } = await openBoard({ projects: { projects: [p], tasks } });
    Object.assign(api.projects.alpha!.tasks.find((x) => x.id === t.a.id)!, { version: 7, title: 'Order cabinets (changed)' }); // someone else edited it
    within(board).getByRole('button', { name: 'Order cabinets' }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect((await within(board).findByRole('alert')).textContent).toMatch(/Order cabinets was not moved\. Someone else changed this task/);
    await waitFor(() => expect(titles(board, 'To Do')).toEqual(['Order cabinets (changed)', 'Book electrician']));
    expect(api.projects.alpha!.tasks.find((x) => x.id === t.a.id)).toMatchObject({ status: 'TODO', version: 7 });
  });

  it('order_changed, a network failure and archived-in-the-meantime are each explained and rolled back', async () => {
    const { p, t, tasks } = fixture();
    const { api, board } = await openBoard({ projects: { projects: [p], tasks } });
    const once = (r: Response | 'network') => api.projectsNext((path) => (path.endsWith('/move') ? r : undefined));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    once(json(409, { error: 'order_changed' }));
    drag(card(board, 'Order cabinets'), column(board, 'Done'), t.a.id, 10_000);
    expect((await within(board).findByRole('alert')).textContent).toMatch(/board changed while this task was being moved/);
    await waitFor(() => expect(titles(board, 'To Do')).toEqual(['Order cabinets', 'Book electrician']));

    once('network');
    drag(card(board, 'Order cabinets'), column(board, 'Done'), t.a.id, 10_000);
    await waitFor(() => expect(within(board).getByRole('alert').textContent).toMatch(/didn't answer/));
    await waitFor(() => expect(titles(board, 'To Do')).toEqual(['Order cabinets', 'Book electrician']));

    api.projects.alpha!.projects[0]!.archivedAt = '2026-11-14T05:00:00.000Z'; // archived by someone else
    drag(card(board, 'Order cabinets'), column(board, 'Done'), t.a.id, 10_000);
    await waitFor(() => expect(within(board).getByRole('alert').textContent).toMatch(/project is archived/));
    expect(api.projects.alpha!.tasks.find((x) => x.id === t.a.id)).toMatchObject({ status: 'TODO', version: 1 });
  });

  it('while a move is in flight the card shows Moving…, and a second move of it is ignored (one request)', async () => {
    const { p, t, tasks } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { api, board } = await openBoard({
      projects: { projects: [p], tasks },
      wrap: (f) => (async (input, init) => { if (String(input).endsWith('/move')) await gate; return f(input, init); }) as typeof fetch,
    });
    drag(card(board, 'Order cabinets'), column(board, 'Done'), t.a.id, 10_000);
    await waitFor(() => expect(titles(board, 'Done')).toEqual(['Measure the room', 'Order cabinets'])); // shown at once
    expect(within(board).getByRole('button', { name: 'Move Order cabinets' }).textContent).toBe('Moving…');
    drag(card(board, 'Order cabinets'), column(board, 'In Progress'), t.a.id, 10_000);
    release();
    await waitFor(() => expect(api.projects.alpha!.tasks.find((x) => x.id === t.a.id)!.status).toBe('DONE'));
    await waitFor(() => expect(within(board).getByRole('button', { name: 'Move Order cabinets' }).textContent).toBe('Move'));
    expect(moves(api)).toHaveLength(1);
    expect(titles(board, 'Done')).toEqual(['Measure the room', 'Order cabinets']);
  });
});

describe('creating and editing on the board', () => {
  it('inline add in a column creates the task with that column\'s status, at its end', async () => {
    const { p, tasks } = fixture();
    const { api, board, user } = await openBoard({ projects: { projects: [p], tasks } });
    await user.click(within(board).getByRole('button', { name: 'Add task to In Progress' }));
    const form = within(board).getByRole('form', { name: 'Add a task to In Progress' });
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(within(form).getByRole('alert').textContent).toBe('A task title is required');
    await user.type(within(form).getByLabelText('New task title in In Progress'), 'Install sink{Enter}');
    await waitFor(() => expect(titles(board, 'In Progress')).toEqual(['Remove old benchtop', 'Plumbing rough-in', 'Install sink']));
    expect(api.callsTo(/POST .*\/tasks$/)[0]!.body).toEqual({ title: 'Install sink', status: 'IN_PROGRESS' });
    // The form stays open for the next one; Escape closes it.
    expect((within(form).getByLabelText('New task title in In Progress') as HTMLInputElement).value).toBe('');
    await user.keyboard('{Escape}');
    expect(within(board).queryByRole('form', { name: 'Add a task to In Progress' })).toBeNull();
  });

  it('the task panel shows the details, edits them with the version, changes status, and closes with Escape back to the card', async () => {
    const { p, tasks } = fixture();
    const { api, board, user } = await openBoard({ projects: { projects: [p], tasks } });
    await user.click(within(board).getByRole('button', { name: 'Book electrician' }));
    const panel = await screen.findByRole('dialog', { name: 'Book electrician' });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.textContent).toContain('Needs a licensed sparky');
    expect(panel.textContent).toContain('Unassigned');
    await user.click(within(panel).getByRole('button', { name: 'Edit details' }));
    const editor = within(panel).getByRole('form', { name: 'Edit task Book electrician' });
    await user.selectOptions(within(editor).getByLabelText('Assignee'), 'Ben Okafor');
    await user.selectOptions(within(editor).getByLabelText('Priority'), 'Urgent');
    await user.type(within(editor).getByLabelText('Due date'), '2026-12-01');
    await user.click(within(editor).getByRole('button', { name: 'Save task' }));
    expect(await within(panel).findByText('Task saved.')).toBeTruthy();
    expect(api.callsTo(/PATCH .*\/tasks\//).at(-1)!.body).toEqual({ version: 1, priority: 'URGENT', assigneeUserId: BEN, dueDate: '2026-12-01' });
    await waitFor(() => expect(card(board, 'Book electrician').textContent).toContain('Ben Okafor'));
    await user.selectOptions(within(panel).getByLabelText('Status'), 'Blocked');
    await waitFor(() => expect(titles(board, 'In Progress')).toContain('Book electrician'));
    expect(api.callsTo(/PATCH .*\/tasks\//).at(-1)!.body).toEqual({ version: 2, status: 'BLOCKED' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement?.textContent).toBe('Book electrician');
  });

  it('removing from the panel asks first and archives the task', async () => {
    const { p, t, tasks } = fixture();
    const { api, board, user } = await openBoard({ projects: { projects: [p], tasks } });
    await user.click(within(board).getByRole('button', { name: 'Measure the room' }));
    const panel = await screen.findByRole('dialog', { name: 'Measure the room' });
    await user.click(within(panel).getByRole('button', { name: 'Remove' }));
    const confirm = within(panel).getByRole('alertdialog');
    expect(confirm.textContent).toContain('archived, not deleted');
    await user.click(within(confirm).getByRole('button', { name: 'Remove task' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(titles(board, 'Done')).toEqual([]));
    expect(api.projects.alpha!.tasks.find((x) => x.id === t.e.id)!.archivedAt).not.toBeNull();
  });
});

describe('search and filters', () => {
  it('search, assignee, priority and due filters narrow every column, with honest counts and a clear way back', async () => {
    const { p, tasks } = fixture();
    const { board, user } = await openBoard({ projects: { projects: [p], tasks } });
    await user.type(within(board).getByLabelText('Search tasks'), 'sparky'); // matches the description
    expect(titles(board, 'To Do')).toEqual(['Book electrician']);
    expect(titles(board, 'In Progress')).toEqual([]);
    expect(within(column(board, 'In Progress')).getByText('No matching tasks')).toBeTruthy();
    expect(within(board).getByText('Showing 1 of 5 tasks.')).toBeTruthy();
    expect(within(board).getByLabelText('1 of 2 tasks shown')).toBeTruthy();
    await user.click(within(board).getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(titles(board, 'To Do')).toEqual(['Order cabinets', 'Book electrician']);

    await user.selectOptions(within(board).getByLabelText('Assignee filter'), 'Ben Okafor');
    expect(titles(board, 'In Progress')).toEqual(['Remove old benchtop']);
    expect(titles(board, 'To Do')).toEqual([]);
    await user.selectOptions(within(board).getByLabelText('Assignee filter'), 'Unassigned');
    expect(titles(board, 'To Do')).toEqual(['Book electrician']);
    await user.selectOptions(within(board).getByLabelText('Assignee filter'), 'Anyone');

    await user.selectOptions(within(board).getByLabelText('Priority filter'), 'Urgent');
    expect(titles(board, 'In Progress')).toEqual(['Plumbing rough-in']);
    await user.selectOptions(within(board).getByLabelText('Priority filter'), 'Any priority');

    await user.selectOptions(within(board).getByLabelText('Due date filter'), 'Overdue');
    expect([...titles(board, 'To Do'), ...titles(board, 'In Progress'), ...titles(board, 'Done')]).toEqual(['Order cabinets']);
    await user.selectOptions(within(board).getByLabelText('Due date filter'), 'No due date');
    expect(titles(board, 'To Do')).toEqual(['Book electrician']);

    await user.type(within(board).getByLabelText('Search tasks'), 'nothing like this');
    expect(within(board).getByText(/No tasks match these filters/)).toBeTruthy();
  });

  it('with a filter on, a drop lands after the visible card it was dropped under', async () => {
    const { p, t, tasks } = fixture();
    const { api, board, user } = await openBoard({ projects: { projects: [p], tasks } });
    await user.selectOptions(within(board).getByLabelText('Priority filter'), 'Urgent');
    drag(card(board, 'Plumbing rough-in'), column(board, 'Done'), t.d.id, 10_000);
    await waitFor(() => expect(moves(api)).toHaveLength(1));
    expect(moves(api)[0]!.body).toEqual({ version: 1, status: 'DONE', afterTaskId: null }); // Done has no visible card
  });
});

describe('read-only boards', () => {
  it('without task permission: the board is visible but nothing can be dragged, moved or added; the panel is read-only', async () => {
    const { p, tasks } = fixture();
    const { api, board, user } = await openBoard({ permissions: READ_ONLY, projects: { projects: [p], tasks } });
    expect(within(board).getByText(/Your role does not allow changing tasks/)).toBeTruthy();
    expect(board.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(within(board).queryByRole('button', { name: /^Move / })).toBeNull();
    expect(within(board).queryByRole('button', { name: /Add task/ })).toBeNull();
    const button = within(board).getByRole('button', { name: 'Order cabinets' });
    button.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    drag(card(board, 'Order cabinets'), column(board, 'Done'), tasks[0]!.id, 10_000);
    expect(moves(api)).toHaveLength(0);
    await user.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Order cabinets' });
    expect(within(panel).queryByLabelText('Status')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('an archived project\'s board is read-only for everyone and says so', async () => {
    const { p, tasks } = fixture({ archivedAt: '2026-11-13T00:00:00.000Z' });
    const { api, board, user } = await openBoard({ archived: true, projects: { projects: [p], tasks } });
    expect(within(board).getByText('This project is archived, so its board is read-only.')).toBeTruthy();
    expect(board.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(within(board).queryByRole('button', { name: /Add task/ })).toBeNull();
    within(board).getByRole('button', { name: 'Order cabinets' }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(moves(api)).toHaveLength(0);
  });
});
