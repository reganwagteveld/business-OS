import type { Project, ProjectTask, TaskStatus, WorkPriority } from '@business-os/contracts';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { Member } from '../../api/customers';
import type { ProjectsClient } from '../../api/projects';
import type { Outcome } from '../../api/tenancy';
import { actionClass, secondaryClass } from '../../shell/frame';
import { useDialog } from '../dialog';
import { Problem, Skeleton } from '../problem';
import { useLayout } from '../use-layout';
import { useLoad } from '../use-load';
import { PriorityLabel, TaskStatusBadge } from './badges';
import { DEFAULT_TASK_BOARD, stageOf, type BoardStage } from './board-stages';
import { formatDate, formatWhen, memberName, PRIORITIES, TASK_STATUSES } from './format';
import { explain, TaskEditor } from './task-form';

// The project's tasks as a board (PR 19). The server owns status and order: every move is one
// POST …/move naming the task's version and the card it goes after, and the board is reloaded after
// every answer. While a move is in flight it is shown optimistically; a refused move is rolled back
// and explained. Dragging is one way to move; every move is also a button and a keyboard shortcut.

type Filters = { q: string; assignee: string; priority: WorkPriority | 'any'; due: 'any' | 'overdue' | 'week' | 'none' };
const NO_FILTERS: Filters = { q: '', assignee: 'any', priority: 'any', due: 'any' };
const filtering = (f: Filters) => f.q.trim() !== '' || f.assignee !== 'any' || f.priority !== 'any' || f.due !== 'any';

/** Today as YYYY-MM-DD in the business's time zone, for due-date filters. */
function todayIn(timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function matches(t: ProjectTask, f: Filters, today: string) {
  const q = f.q.trim().toLowerCase();
  if (q && !t.title.toLowerCase().includes(q) && !(t.description ?? '').toLowerCase().includes(q)) return false;
  if (f.assignee === 'none' ? t.assigneeUserId !== null : f.assignee !== 'any' && t.assigneeUserId !== f.assignee) return false;
  if (f.priority !== 'any' && t.priority !== f.priority) return false;
  if (f.due === 'none' && t.dueDate !== null) return false;
  if (f.due === 'overdue' && !(t.dueDate !== null && t.dueDate < today && t.status !== 'DONE')) return false;
  if (f.due === 'week' && !(t.dueDate !== null && t.dueDate >= today && t.dueDate <= addDays(today, 7))) return false;
  return true;
}

/** The project's order with one task moved: removed, then put directly after `afterId` (or first), with its new status. */
function applyMove(rows: ProjectTask[], id: string, status: TaskStatus, afterId: string | null) {
  const moving = rows.find((t) => t.id === id);
  if (!moving) return rows;
  const rest = rows.filter((t) => t.id !== id);
  const at = afterId ? rest.findIndex((t) => t.id === afterId) + 1 : 0;
  if (afterId && at === 0) return rows;
  return [...rest.slice(0, at), { ...moving, status }, ...rest.slice(at)];
}

type Pending = { id: string; status: TaskStatus; afterId: string | null };

export function TaskBoard({ project, client, slug, locale, timeZone, members, canManage, viewSwitch, onTasksChanged, onDraftChange, confirmLeave, onSessionEnded, initialTaskId, onInitialTaskSettled, board = DEFAULT_TASK_BOARD }: {
  project: Project; client: ProjectsClient; slug: string; locale?: string; timeZone: string; members: Member[] | null; canManage: boolean;
  viewSwitch: ReactNode; onTasksChanged: () => void; onDraftChange: (key: string, dirty: boolean) => void; confirmLeave: (action: () => void) => void;
  onSessionEnded: () => void;
  /**
   * GS2-A: a task whose panel opens once the board's tasks load (a `<projectId>:task:<taskId>` target).
   * Only a task in this board's own list opens; anything else (removed, archived or another project's)
   * leaves the board as it is with a note. `onInitialTaskSettled` is called once it has been handled.
   */
  initialTaskId?: string; onInitialTaskSettled?: () => void;
  board?: readonly BoardStage[];
}) {
  const uid = useId();
  const layout = useLayout();
  // The last good list stays on screen while a reload runs, or if one fails after a successful change.
  const [lastGood, setLastGood] = useState<ProjectTask[] | null>(null);
  const tasks = useLoad(`tasks|${slug}|${project.id}`, async (signal) => {
    const outcome = await client.tasks(slug, project.id, { archived: 'active' }, signal);
    if (outcome.kind === 'ok') setLastGood(outcome.data);
    return outcome;
  });
  const fresh = tasks.state.status === 'done' && tasks.state.outcome.kind === 'ok' ? tasks.state.outcome.data : null;
  const server = fresh ?? lastGood;

  // Optimistic moves. One is shown until the server's list has caught up with it: `until` is the
  // version the server answered with (Infinity while the request is in flight). Refused moves are
  // removed at once, so the card goes straight back.
  const [pending, setPending] = useState<(Pending & { until: number })[]>([]);
  const inFlight = useRef(new Set<string>());
  const rows = useMemo(() => {
    if (!server) return null;
    const live = pending.filter((m) => (server.find((t) => t.id === m.id)?.version ?? Infinity) < m.until);
    return live.reduce((acc, m) => applyMove(acc, m.id, m.status, m.afterId), server);
  }, [server, pending]);
  const moving = new Set(pending.filter((m) => m.until === Infinity).map((m) => m.id));

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const today = todayIn(timeZone);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialTaskId ?? null);
  // A card to put focus on once it is rendered (after a keyboard move, a refused move, or closing its
  // panel). Consumed once, so a later refresh never steals focus.
  const focusNext = useRef<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusCard = useCallback((id: string) => { focusNext.current = id; setFocusTick((n) => n + 1); }, []);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ stage: string; index: number } | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  // The arrival task is settled against the first successful load: it stays open if the server's
  // list has it, and otherwise is dropped with a note. A failed load keeps waiting for a retry.
  const arrival = useRef(initialTaskId ?? null);
  useEffect(() => {
    const id = arrival.current;
    if (!id || !fresh) return;
    arrival.current = null;
    if (!fresh.some((t) => t.id === id)) {
      setOpenId((current) => (current === id ? null : current));
      setMessage({ tone: 'ok', text: 'That task is no longer on this board. It may have been removed.' });
    }
    onInitialTaskSettled?.();
  }, [fresh, onInitialTaskSettled]);

  const refresh = useCallback(() => {
    tasks.reload();
    onTasksChanged();
  }, [tasks, onTasksChanged]);

  // Keyboard and menu moves keep focus on the moved card, even when it lands in another column.
  useLayoutEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-task-open="${id}"]`);
    if (!el) return;
    focusNext.current = null;
    if (document.activeElement !== el) el.focus();
  }, [focusTick, rows]);

  const columnOf = (stage: BoardStage, list: ProjectTask[]) => list.filter((t) => stage.statuses.includes(t.status));
  const visible = (list: ProjectTask[]) => list.filter((t) => matches(t, filters, today));

  /**
   * Moves `task` into `stage` at `index` among that column's visible cards (other than itself). The
   * anchor is the visible card before that slot; with none it goes first. Within its own column a
   * task keeps its status; into another column it takes the column's status.
   */
  async function move(task: ProjectTask, stage: BoardStage, index: number, how: 'drag' | 'keys') {
    if (!rows || !canManage || inFlight.current.has(task.id)) return;
    const others = visible(columnOf(stage, rows)).filter((t) => t.id !== task.id);
    const at = Math.max(0, Math.min(index, others.length));
    const afterId = at > 0 ? others[at - 1]!.id : null;
    const sameStage = stageOf(board, task.status)?.id === stage.id;
    const status = sameStage ? task.status : stage.dropStatus;
    const current = visible(columnOf(stage, rows)).findIndex((t) => t.id === task.id);
    if (sameStage && current === at) return; // dropped where it already is
    inFlight.current.add(task.id);
    setPending((p) => [...p.filter((m) => m.id !== task.id), { id: task.id, status, afterId, until: Infinity }]);
    setMessage(null);
    if (how === 'keys') focusCard(task.id);
    let outcome: Outcome<ProjectTask>;
    try {
      outcome = await client.moveTask(slug, project.id, task.id, { version: task.version, status, afterTaskId: afterId });
    } catch {
      outcome = { kind: 'unreachable' };
    }
    inFlight.current.delete(task.id);
    if (outcome.kind === 'unauthenticated') {
      setPending((p) => p.filter((m) => m.id !== task.id));
      return onSessionEnded();
    }
    if (outcome.kind === 'ok') {
      const until = outcome.data.version;
      setPending((p) => p.map((m) => (m.id === task.id ? { ...m, until } : m)));
      setAnnounce(`${task.title} moved to ${stage.label}, position ${at + 1} of ${others.length + 1}.`);
    } else {
      setPending((p) => p.filter((m) => m.id !== task.id));
      setMessage({ tone: 'error', text: `${task.title} was not moved. ${explain(outcome, 'task')}` });
      setAnnounce(`${task.title} was not moved.`);
    }
    if (how === 'keys') focusCard(task.id);
    refresh(); // the server's order is the truth; the optimistic place lasts only until it arrives
  }

  function keyMove(task: ProjectTask, dir: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom') {
    if (!rows) return;
    const stageIndex = board.findIndex((s) => s.statuses.includes(task.status));
    const stage = board[stageIndex];
    if (!stage) return;
    const col = visible(columnOf(stage, rows));
    const i = col.findIndex((t) => t.id === task.id);
    if (dir === 'up' && i > 0) return void move(task, stage, i - 1, 'keys');
    if (dir === 'down' && i < col.length - 1) return void move(task, stage, i + 1, 'keys');
    if (dir === 'top' && i > 0) return void move(task, stage, 0, 'keys');
    if (dir === 'bottom' && i < col.length - 1) return void move(task, stage, col.length - 1, 'keys');
    const target = board[stageIndex + (dir === 'left' ? -1 : dir === 'right' ? 1 : 0)];
    if ((dir === 'left' || dir === 'right') && target && target !== stage) {
      return void move(task, target, visible(columnOf(target, rows)).length, 'keys'); // to the end of the next column
    }
  }
  const onCardKey = (task: ProjectTask) => (event: KeyboardEvent) => {
    if (!canManage || !event.altKey) return;
    const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'top', End: 'bottom' } as const)[event.key as 'ArrowUp'];
    if (!dir) return;
    event.preventDefault();
    keyMove(task, dir);
  };

  // ---- drag and drop (HTML5; Tauri's own file drop is disabled on the window so this works on Windows too)
  const slotFrom = (event: DragEvent, list: HTMLElement) => {
    const cards = [...list.querySelectorAll<HTMLElement>('[data-card]')].filter((el) => el.dataset.card !== dragId);
    return cards.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2 < event.clientY;
    }).length;
  };
  const onDragOver = (stage: BoardStage) => (event: DragEvent<HTMLElement>) => {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const index = slotFrom(event, event.currentTarget);
    setDrop((d) => (d?.stage === stage.id && d.index === index ? d : { stage: stage.id, index }));
  };
  const onDrop = (stage: BoardStage) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain') || dragId;
    const index = slotFrom(event, event.currentTarget);
    setDrop(null);
    setDragId(null);
    const task = rows?.find((t) => t.id === id);
    if (task) void move(task, stage, index, 'drag');
  };

  const open = rows?.find((t) => t.id === openId) ?? null; // a task removed elsewhere simply closes

  const people = (members ?? []).filter((m) => m.status === 'ACTIVE');
  const control = 'rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const shownCount = rows ? visible(rows).length : 0;
  const columnClass = layout === 'narrow' ? 'w-[85%] shrink-0 snap-start' : 'min-w-0';

  return (
    <section aria-label="Tasks" className="rounded-2xl border border-border bg-card p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Tasks</h2>
        {viewSwitch}
      </div>
      <p id={`${uid}-help`} className="sr-only">
        {canManage ? 'Drag a card to move it, or use its Move button. With a card focused, Alt and the arrow keys move it between columns and up or down; Alt Home and Alt End move it to the top or bottom.' : ''}
      </p>
      <p aria-live="polite" className="sr-only">{announce}</p>

      <div role="search" aria-label="Find tasks" className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
        <div>
          <label htmlFor={`${uid}-q`} className="sr-only">Search tasks</label>
          <input id={`${uid}-q`} type="search" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder="Search tasks" maxLength={100} className={`w-full ${control}`} />
        </div>
        <div>
          <label htmlFor={`${uid}-assignee`} className="sr-only">Assignee filter</label>
          <select id={`${uid}-assignee`} value={filters.assignee} onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))} className={`w-full ${control}`}>
            <option value="any">Anyone</option>
            <option value="none">Unassigned</option>
            {people.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? 'Team member'}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-priority`} className="sr-only">Priority filter</label>
          <select id={`${uid}-priority`} value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value as Filters['priority'] }))} className={`w-full ${control}`}>
            <option value="any">Any priority</option>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-due`} className="sr-only">Due date filter</label>
          <select id={`${uid}-due`} value={filters.due} onChange={(e) => setFilters((f) => ({ ...f, due: e.target.value as Filters['due'] }))} className={`w-full ${control}`}>
            <option value="any">Any due date</option>
            <option value="overdue">Overdue</option>
            <option value="week">Due in the next 7 days</option>
            <option value="none">No due date</option>
          </select>
        </div>
        {filtering(filters) ? <button type="button" onClick={() => setFilters(NO_FILTERS)} className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Clear filters</button> : null}
      </div>
      {rows && filtering(filters) ? <p role="status" className="mb-3 text-xs text-muted-foreground">Showing {shownCount} of {rows.length} {rows.length === 1 ? 'task' : 'tasks'}.</p> : null}
      {!canManage && rows ? <p className="mb-3 text-xs text-muted-foreground">{project.archivedAt ? 'This project is archived, so its board is read-only.' : 'You can view this board. Your role does not allow changing tasks.'}</p> : null}

      {message ? (
        <div role={message.tone === 'error' ? 'alert' : 'status'} className={`mb-4 flex flex-wrap items-start justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${message.tone === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-muted'}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="text-xs font-medium underline-offset-2 hover:underline">Dismiss</button>
        </div>
      ) : null}

      {rows === null && tasks.state.status === 'loading' ? <Skeleton rows={3} label="Loading tasks…" /> : null}
      {rows === null && tasks.state.status === 'done' && tasks.state.outcome.kind !== 'ok' ? <Problem outcome={tasks.state.outcome} what="Tasks" onRetry={tasks.reload} onSessionEnded={onSessionEnded} /> : null}
      {rows && tasks.state.status === 'done' && tasks.state.outcome.kind !== 'ok' && tasks.state.outcome.kind !== 'unauthenticated' ? (
        <p role="alert" className="mb-3 text-xs text-destructive">The board could not be refreshed, so it may be out of date. <button type="button" className="font-medium underline" onClick={tasks.reload}>Try again</button></p>
      ) : null}
      {rows && rows.length > 0 && shownCount === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">No tasks match these filters. <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button></p>
      ) : null}

      {rows ? (
        <div ref={boardRef} aria-describedby={`${uid}-help`}
          className={layout === 'narrow' ? 'flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2' : `grid gap-4`} style={layout === 'narrow' ? undefined : { gridTemplateColumns: `repeat(${board.length}, minmax(0, 1fr))` }}>
          {board.map((stage) => {
            const all = columnOf(stage, rows);
            const cards = visible(all);
            const isTarget = drop?.stage === stage.id;
            return (
              <div key={stage.id} role="group" aria-labelledby={`${uid}-${stage.id}`} className={`${columnClass} flex flex-col rounded-xl border bg-background ${isTarget ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}>
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                  <h3 id={`${uid}-${stage.id}`} className="text-sm font-semibold">{stage.label}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground" aria-label={filtering(filters) ? `${cards.length} of ${all.length} tasks shown` : `${all.length} ${all.length === 1 ? 'task' : 'tasks'}`}>
                    {filtering(filters) ? `${cards.length}/${all.length}` : all.length}
                  </span>
                </div>
                <ol aria-label={`${stage.label} tasks`} className="flex min-h-24 flex-1 flex-col gap-2 p-2"
                  onDragOver={canManage ? onDragOver(stage) : undefined} onDrop={canManage ? onDrop(stage) : undefined}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop((d) => (d?.stage === stage.id ? null : d)); }}>
                  {cards.map((t, i) => (
                    <li key={t.id} data-card={t.id} className="list-none">
                      {isTarget && drop!.index === i ? <div aria-hidden="true" className="mb-2 h-0.5 rounded bg-primary" /> : null}
                      <Card
                        task={t} locale={locale} members={members} today={today} canManage={canManage} board={board}
                        moving={moving.has(t.id)} dragging={dragId === t.id} menuOpen={menuId === t.id}
                        position={{ index: i, count: cards.length, stage }}
                        onOpen={() => confirmLeave(() => setOpenId(t.id))}
                        onKeyDown={onCardKey(t)}
                        onMenu={(openIt) => setMenuId(openIt ? t.id : null)}
                        onMove={(dir) => { setMenuId(null); keyMove(t, dir); }}
                        onMoveTo={(target) => { setMenuId(null); void move(t, target, visible(columnOf(target, rows)).length, 'keys'); }}
                        onDragStart={(e) => { setDragId(t.id); setMenuId(null); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); }}
                        onDragEnd={() => { setDragId(null); setDrop(null); }}
                      />
                    </li>
                  ))}
                  {isTarget && drop!.index >= cards.length ? <li aria-hidden="true" className="h-0.5 list-none rounded bg-primary" /> : null}
                  {cards.length === 0 ? <li className="list-none px-2 py-4 text-center text-xs text-muted-foreground">{all.length > 0 ? 'No matching tasks' : canManage ? 'No tasks. Add one below or drag one here.' : 'No tasks'}</li> : null}
                </ol>
                {canManage ? (
                  <QuickAdd stage={stage} client={client} slug={slug} projectId={project.id} onDraftChange={onDraftChange} onSessionEnded={onSessionEnded}
                    onAdded={(t) => { setAnnounce(`${t.title} added to ${stage.label}.`); refresh(); }} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {open ? (
        <TaskDetail key={open.id} task={open} client={client} slug={slug} projectId={project.id} locale={locale} timeZone={timeZone} members={members} canManage={canManage}
          onClose={() => { setOpenId(null); focusCard(open.id); }} onChanged={refresh} onDraftChange={onDraftChange} confirmLeave={confirmLeave} onSessionEnded={onSessionEnded} />
      ) : null}
    </section>
  );
}

type Dir = 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';

function Card({ task, locale, members, today, canManage, board, moving, dragging, menuOpen, position, onOpen, onKeyDown, onMenu, onMove, onMoveTo, onDragStart, onDragEnd }: {
  task: ProjectTask; locale?: string; members: Member[] | null; today: string; canManage: boolean; board: readonly BoardStage[];
  moving: boolean; dragging: boolean; menuOpen: boolean; position: { index: number; count: number; stage: BoardStage };
  onOpen: () => void; onKeyDown: (e: KeyboardEvent) => void; onMenu: (open: boolean) => void; onMove: (dir: Dir) => void; onMoveTo: (stage: BoardStage) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void; onDragEnd: () => void;
}) {
  const uid = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [menuOpen]);
  const overdue = task.dueDate !== null && task.dueDate < today && task.status !== 'DONE';
  const assignee = memberName(members, task.assigneeUserId);
  const { index, count, stage } = position;
  const here = board.findIndex((s) => s.id === stage.id);
  const item = 'block w-full rounded-md px-3 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40';
  return (
    <div
      draggable={canManage && !moving}
      onDragStart={canManage ? onDragStart : undefined}
      onDragEnd={canManage ? onDragEnd : undefined}
      className={`rounded-lg border bg-card p-3 shadow-sm transition-opacity ${dragging ? 'opacity-40' : ''} ${moving ? 'opacity-60' : ''} ${canManage ? 'cursor-grab active:cursor-grabbing' : ''} ${task.status === 'BLOCKED' ? 'border-destructive/40' : 'border-border'}`}
    >
      <button type="button" data-task-open={task.id} onClick={onOpen} onKeyDown={onKeyDown} aria-describedby={`${uid}-meta`}
        className={`block w-full rounded-sm text-left text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere] ${task.status === 'DONE' ? 'text-muted-foreground' : ''}`}>
        {task.title}
      </button>
      <div id={`${uid}-meta`} className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {task.status === 'BLOCKED' ? <TaskStatusBadge status="BLOCKED" /> : null}
        <PriorityLabel priority={task.priority} />
        <span>{assignee ?? 'Unassigned'}</span>
        {task.dueDate ? <span className={overdue ? 'font-semibold text-destructive' : ''}>{overdue ? 'Overdue · ' : 'Due '}{formatDate(task.dueDate, locale)}</span> : null}
        <span className="sr-only">{`${stage.label}, ${index + 1} of ${count}.`}</span>
      </div>
      {canManage ? (
        <div className="relative mt-2" onKeyDown={(e) => { if (e.key === 'Escape' && menuOpen) { e.stopPropagation(); onMenu(false); toggle.current?.focus(); } }}>
          <button ref={toggle} type="button" aria-expanded={menuOpen} aria-controls={`${uid}-menu`} disabled={moving} onClick={() => onMenu(!menuOpen)}
            aria-label={`Move ${task.title}`} className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
            {moving ? 'Moving…' : 'Move'}
          </button>
          {menuOpen ? (
            <div ref={menuRef} id={`${uid}-menu`} role="group" aria-label={`Move ${task.title}`} className="absolute left-0 z-10 mt-1 w-48 rounded-lg border border-border bg-card p-1 shadow-lg">
              <button type="button" className={item} disabled={index === 0} onClick={() => onMove('top')}>Move to top</button>
              <button type="button" className={item} disabled={index === 0} onClick={() => onMove('up')}>Move up</button>
              <button type="button" className={item} disabled={index >= count - 1} onClick={() => onMove('down')}>Move down</button>
              <button type="button" className={item} disabled={index >= count - 1} onClick={() => onMove('bottom')}>Move to bottom</button>
              {board.map((s, i) => (i === here ? null : (
                <button key={s.id} type="button" className={item} onClick={() => onMoveTo(s)}>Move to {s.label}</button>
              )))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Inline task creation at the end of one column; the new task takes the column's status. */
function QuickAdd({ stage, client, slug, projectId, onAdded, onDraftChange, onSessionEnded }: {
  stage: BoardStage; client: ProjectsClient; slug: string; projectId: string; onAdded: (t: ProjectTask) => void;
  onDraftChange: (key: string, dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const key = `board-new-${stage.id}`;
  useEffect(() => onDraftChange(key, title.trim() !== ''), [key, title, onDraftChange]);
  useEffect(() => () => onDraftChange(key, false), [key, onDraftChange]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (!title.trim()) return setProblem('A task title is required');
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    let outcome: Outcome<ProjectTask>;
    try {
      outcome = await client.createTask(slug, projectId, { title: title.trim(), status: stage.dropStatus });
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'ok') {
      setTitle('');
      onAdded(outcome.data);
      return;
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    setProblem(outcome.kind === 'unreachable' ? "Business OS didn't answer, so the task may or may not have been added. Check the board before adding it again." : explain(outcome, 'task'));
  };

  if (!open) {
    return (
      <div className="p-2 pt-0">
        <button type="button" onClick={() => setOpen(true)} aria-label={`Add task to ${stage.label}`} className="w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <span aria-hidden="true">+ </span>Add task
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label={`Add a task to ${stage.label}`} className="p-2 pt-0"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setTitle(''); setProblem(null); setOpen(false); } }}>
      <label htmlFor={`${uid}-title`} className="sr-only">New task title in {stage.label}</label>
      <input id={`${uid}-title`} autoFocus value={title} onChange={(e) => { setTitle(e.target.value); setProblem(null); }} maxLength={200} placeholder="Task title" autoComplete="off"
        aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${uid}-problem` : undefined}
        className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      {problem ? <p id={`${uid}-problem`} role="alert" className="mt-1 text-xs font-medium text-destructive">{problem}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" disabled={busy} onClick={() => { setTitle(''); setProblem(null); setOpen(false); }} className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">Cancel</button>
      </div>
    </form>
  );
}

/**
 * One task in a modal side panel: everything about it, and (for people who may change tasks) its
 * status, its details, and Remove. Saves go through the same versioned PATCH as the list view.
 */
function TaskDetail({ task, client, slug, projectId, locale, timeZone, members, canManage, onClose, onChanged, onDraftChange, confirmLeave, onSessionEnded }: {
  task: ProjectTask; client: ProjectsClient; slug: string; projectId: string; locale?: string; timeZone: string; members: Member[] | null; canManage: boolean;
  onClose: () => void; onChanged: () => void; onDraftChange: (key: string, dirty: boolean) => void; confirmLeave: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const inFlight = useRef(false);
  const close = () => confirmLeave(() => { onDraftChange('board-task-edit', false); onClose(); });
  const { ref, onKeyDown } = useDialog(true, close, { trap: true });

  async function act(label: string, run: () => Promise<Outcome<ProjectTask>>) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    let outcome: Outcome<ProjectTask>;
    try {
      outcome = await run();
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'unauthenticated') {
      onSessionEnded();
      return false;
    }
    setMessage(outcome.kind === 'ok' ? { tone: 'ok', text: label } : { tone: 'error', text: explain(outcome, 'task') });
    if (!(outcome.kind === 'invalid_input' || outcome.kind === 'forbidden')) onChanged();
    return outcome.kind === 'ok';
  }

  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="[overflow-wrap:anywhere]">{value}</dd></div>
  );
  return (
    <div className="fixed inset-0 z-[15] flex justify-end bg-background/80 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`}
        className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={`${uid}-title`} className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{task.title}</h2>
          <button type="button" autoFocus onClick={close} className="rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Close</button>
        </div>
        {message ? <p role={message.tone === 'error' ? 'alert' : 'status'} className={`mb-4 rounded-xl border px-3 py-2 text-sm ${message.tone === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-muted'}`}>{message.text}</p> : null}

        {canManage ? (
          <div className="mb-4">
            <label htmlFor={`${uid}-status`} className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
            <select id={`${uid}-status`} value={task.status} disabled={busy} onChange={(e) => void act('Status changed.', () => client.updateTask(slug, projectId, task.id, { version: task.version, status: e.target.value as TaskStatus }))}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring">
              {TASK_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        ) : <div className="mb-4"><TaskStatusBadge status={task.status} /></div>}

        {editing ? (
          <TaskEditor task={task} members={members}
            onCancel={() => { onDraftChange('board-task-edit', false); setEditing(false); }}
            onDirtyChange={(d) => onDraftChange('board-task-edit', d)}
            onSave={async (patch) => {
              const ok = await act('Task saved.', () => client.updateTask(slug, projectId, task.id, { version: task.version, ...patch }));
              if (ok) { onDraftChange('board-task-edit', false); setEditing(false); }
              return ok;
            }} />
        ) : (
          <>
            <dl className="divide-y divide-border">
              {row('Priority', <PriorityLabel priority={task.priority} />)}
              {row('Assignee', memberName(members, task.assigneeUserId) ?? <span className="text-muted-foreground">Unassigned</span>)}
              {row('Due date', task.dueDate ? formatDate(task.dueDate, locale) : <span className="text-muted-foreground">Not set</span>)}
              {task.completedAt ? row('Completed', formatWhen(task.completedAt, timeZone, locale)) : null}
              {row('Created', formatWhen(task.createdAt, timeZone, locale))}
              {row('Updated', formatWhen(task.updatedAt, timeZone, locale))}
            </dl>
            <h3 className="mt-5 text-xs font-medium text-muted-foreground">Description</h3>
            {task.description ? <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{task.description}</p> : <p className="mt-1 text-sm text-muted-foreground">No description.</p>}
            {canManage ? (
              <div className="mt-6 flex flex-wrap gap-2">
                <button type="button" className={secondaryClass} disabled={busy} onClick={() => setEditing(true)}>Edit details</button>
                <button type="button" className={secondaryClass} disabled={busy} onClick={() => setRemoving(true)}>Remove</button>
              </div>
            ) : null}
            {removing ? (
              <div role="alertdialog" aria-labelledby={`${uid}-rm`} aria-describedby={`${uid}-rm-body`} className="mt-4 rounded-xl border border-border bg-background p-4">
                <h3 id={`${uid}-rm`} className="text-sm font-semibold [overflow-wrap:anywhere]">Remove “{task.title}”?</h3>
                <p id={`${uid}-rm-body`} className="mt-1 text-xs text-muted-foreground">It leaves the board and the progress count. It is archived, not deleted, so its history is kept.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" className={actionClass} disabled={busy}
                    onClick={() => void act(`${task.title} was removed.`, () => client.archiveTask(slug, projectId, task.id)).then((ok) => { if (ok) onClose(); else setRemoving(false); })}>
                    Remove task
                  </button>
                  <button type="button" className={secondaryClass} onClick={() => setRemoving(false)} autoFocus>Keep it</button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
