import type { Project, ProjectTask, TaskStatus, WorkPriority } from '@business-os/contracts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Member } from '../../api/customers';
import type { ProjectsClient } from '../../api/projects';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { useDialog } from '../dialog';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { PriorityLabel, Progress, ProjectStatusBadge, TaskStatusBadge } from './badges';
import { formatDate, formatWhen, isDay, memberName, PRIORITIES, TASK_STATUSES } from './format';
import { customerLabel } from './project-list';

function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2.5 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

/** Plain words for a refused change. The record is reloaded so the screen shows the truth. */
function explain(outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>, what: 'project' | 'task'): string {
  if (outcome.kind === 'conflict') {
    switch (outcome.code) {
      case 'stale': return `Someone else changed this ${what} a moment ago. The latest version is shown; check it and try again.`;
      case 'archived': return what === 'project' ? 'This project is already archived.' : 'This task has been removed. The latest list is shown.';
      case 'not_archived': return `This ${what} is not archived. The latest version is shown.`;
      case 'project_archived': return 'This project is archived, so its tasks cannot change. Restore the project first.';
      default: return 'This change could not be made. The latest version is shown.';
    }
  }
  switch (outcome.kind) {
    case 'invalid_input': return outcome.message;
    case 'forbidden': return 'Your role does not allow this.';
    case 'not_found': return `This ${what} no longer exists in this business.`;
    case 'unreachable': return "Business OS didn't answer, so this may or may not have happened. The latest version is being loaded; check it before trying again.";
    case 'rate_limited': return 'Too many requests. Wait a moment and try again.';
    default: return 'Something went wrong. Nothing was changed.';
  }
}

/**
 * One project: its details, linked customer, owner, real task progress and its tasks. Edit, archive
 * and restore appear only where the role allows; the server checks every action again.
 */
export function ProjectDetail({ client, slug, id, locale, timeZone, members, canUpdate, canArchive, canManageTasks, onBack, onEdit, onOpenCustomer, onDraftChange, confirmLeave, onSessionEnded }: {
  client: ProjectsClient; slug: string; id: string; locale?: string; timeZone: string; members: Member[] | null;
  canUpdate: boolean; canArchive: boolean; canManageTasks: boolean;
  onBack: () => void; onEdit: (p: Project) => void; onOpenCustomer?: (customerId: string) => void;
  onDraftChange: (key: string, dirty: boolean) => void; confirmLeave: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const project = useLoad(`project|${slug}|${id}`, (signal) => client.get(slug, id, signal));
  const shown = project.state.status === 'done' ? (project.state.outcome.kind === 'ok' ? project.state.outcome.data : null) : project.previous?.kind === 'ok' ? project.previous.data : null;
  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-hidden="true">←</span> All projects
      </button>
      {shown === null && project.state.status === 'loading' ? <><h1 className="sr-only">Project</h1><Skeleton rows={4} label="Loading project…" /></> : null}
      {project.state.status === 'done' && project.state.outcome.kind !== 'ok' ? (
        <><h1 className="sr-only">Project</h1><Problem outcome={project.state.outcome} what="This project" onRetry={project.reload} onSessionEnded={onSessionEnded} /></>
      ) : null}
      {shown ? (
        <Loaded
          key={shown.id} project={shown} client={client} slug={slug} locale={locale} timeZone={timeZone} members={members}
          canUpdate={canUpdate} canArchive={canArchive} canManageTasks={canManageTasks} onEdit={onEdit} onOpenCustomer={onOpenCustomer}
          onChanged={project.reload} onDraftChange={onDraftChange} confirmLeave={confirmLeave} onSessionEnded={onSessionEnded}
        />
      ) : null}
    </div>
  );
}

function Loaded({ project, client, slug, locale, timeZone, members, canUpdate, canArchive, canManageTasks, onEdit, onOpenCustomer, onChanged, onDraftChange, confirmLeave, onSessionEnded }: {
  project: Project; client: ProjectsClient; slug: string; locale?: string; timeZone: string; members: Member[] | null;
  canUpdate: boolean; canArchive: boolean; canManageTasks: boolean; onEdit: (p: Project) => void; onOpenCustomer?: (customerId: string) => void;
  onChanged: () => void; onDraftChange: (key: string, dirty: boolean) => void; confirmLeave: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const archived = project.archivedAt !== null;
  const [confirming, setConfirming] = useState(false);
  const { ref: archiveRef, onKeyDown: onArchiveKey } = useDialog(confirming, () => setConfirming(false));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const inFlight = useRef(false);

  const change = async (action: 'archive' | 'restore') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    let outcome: Outcome<Project>;
    try {
      outcome = action === 'archive' ? await client.archive(slug, project.id) : await client.restore(slug, project.id);
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    if (outcome.kind === 'ok') {
      setConfirming(false);
      setMessage({ tone: 'ok', text: action === 'archive' ? 'Project archived. Its tasks are kept.' : 'Project restored.' });
    } else setMessage({ tone: 'error', text: explain(outcome, 'project') });
    onChanged();
  };

  const customer = customerLabel(project);
  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">{project.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <ProjectStatusBadge status={project.status} archived={archived} />
            <PriorityLabel priority={project.priority} />
            {customer ? <span className="text-sm text-muted-foreground">{customer}</span> : <span className="text-sm text-muted-foreground">Internal project</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canUpdate && !archived ? <button type="button" className={secondaryClass} onClick={() => confirmLeave(() => onEdit(project))}>Edit</button> : null}
          {canArchive && !archived ? <button type="button" className={secondaryClass} disabled={busy} onClick={() => setConfirming(true)}>Archive</button> : null}
          {canArchive && archived ? <button type="button" className={actionClass} disabled={busy} onClick={() => void change('restore')}>{busy ? 'Restoring…' : 'Restore project'}</button> : null}
        </div>
      </header>

      {archived ? <p role="status" className="mb-6 rounded-xl border border-border bg-muted px-4 py-3 text-sm">This project is archived. It and its tasks are kept but read-only until it is restored.</p> : null}
      {confirming ? (
        <div ref={archiveRef} onKeyDown={onArchiveKey} role="alertdialog" aria-labelledby="archive-project-title" aria-describedby="archive-project-body" className="mb-6 rounded-2xl border border-border bg-card p-5">
          <h2 id="archive-project-title" className="text-base font-semibold [overflow-wrap:anywhere]">Archive {project.name}?</h2>
          <p id="archive-project-body" className="mt-1 text-sm text-muted-foreground">It will be hidden from the project list and become read-only. Nothing is deleted: its tasks are kept, and you can restore it at any time.</p>
          <div className="mt-4 flex gap-3">
            <button type="button" className={actionClass} disabled={busy} onClick={() => confirmLeave(() => void change('archive'))}>{busy ? 'Archiving…' : 'Archive project'}</button>
            <button type="button" className={secondaryClass} disabled={busy} onClick={() => setConfirming(false)} autoFocus>Keep active</button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={`mb-6 rounded-xl border px-4 py-3 text-sm ${message.tone === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-muted'}`}>{message.text}</p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <TasksPanel
            project={project} client={client} slug={slug} locale={locale} members={members} canManage={canManageTasks && !archived}
            onTasksChanged={onChanged} onDraftChange={onDraftChange} confirmLeave={confirmLeave} onSessionEnded={onSessionEnded}
          />
        </div>
        <div className="space-y-5">
          <Panel title="Progress">
            <Progress counts={project.taskCounts} />
            {project.taskCounts.total === 0 ? <p className="mt-2 text-xs text-muted-foreground">Progress appears once the project has tasks.</p> : null}
          </Panel>
          <Panel title="Details">
            <dl className="divide-y divide-border">
              <Row label="Customer">
                {project.customerId
                  ? project.customer && onOpenCustomer
                    ? <button type="button" onClick={() => confirmLeave(() => onOpenCustomer(project.customerId!))} className="rounded-md text-left font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{customer}</button>
                    : customer
                  : muted('None (internal)')}
              </Row>
              <Row label="Owner">{memberName(members, project.ownerUserId) ?? muted('No owner')}</Row>
              <Row label="Start date">{project.startDate ? formatDate(project.startDate, locale) : muted('Not set')}</Row>
              <Row label="Due date">{project.dueDate ? formatDate(project.dueDate, locale) : muted('Not set')}</Row>
              {project.completedAt ? <Row label="Completed">{formatWhen(project.completedAt, timeZone, locale)}</Row> : null}
              <Row label="Created">{formatWhen(project.createdAt, timeZone, locale)}</Row>
            </dl>
          </Panel>
          <Panel title="Description">
            {project.description ? <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{project.description}</p> : <p className="text-sm text-muted-foreground">No description.</p>}
          </Panel>
        </div>
      </div>
    </>
  );
}

type Filter = TaskStatus | 'all';

/**
 * The project's tasks in its order, filterable by status. Loaded in full (following the server's
 * cursors) so counts and filters are exact; a project too large to load says so instead of showing part.
 */
function TasksPanel({ project, client, slug, locale, members, canManage, onTasksChanged, onDraftChange, confirmLeave, onSessionEnded }: {
  project: Project; client: ProjectsClient; slug: string; locale?: string; members: Member[] | null; canManage: boolean;
  onTasksChanged: () => void; onDraftChange: (key: string, dirty: boolean) => void; confirmLeave: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const tasks = useLoad(`tasks|${slug}|${project.id}`, (signal) => client.tasks(slug, project.id, { archived: 'active' }, signal));
  const list = tasks.state.status === 'done' ? (tasks.state.outcome.kind === 'ok' ? tasks.state.outcome.data : null) : tasks.previous?.kind === 'ok' ? tasks.previous.data : null;
  const [filter, setFilter] = useState<Filter>('all');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectTask | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const { ref: removeRef, onKeyDown: onRemoveKey } = useDialog(removing !== null, () => setRemoving(null));

  const refresh = () => {
    tasks.reload();
    onTasksChanged();
  };
  /** One change per task at a time (a double click never sends two); the list is reloaded after every answer. */
  async function act(task: ProjectTask, label: string | null, run: () => Promise<Outcome<ProjectTask>>): Promise<boolean> {
    if (inFlight.current.has(task.id)) return false;
    inFlight.current.add(task.id);
    setBusyId(task.id);
    setMessage(null);
    let outcome: Outcome<ProjectTask>;
    try {
      outcome = await run();
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current.delete(task.id);
      setBusyId(null);
    }
    if (outcome.kind === 'unauthenticated') {
      onSessionEnded();
      return false;
    }
    if (outcome.kind === 'ok') {
      if (label) setMessage({ tone: 'ok', text: label });
    } else setMessage({ tone: 'error', text: explain(outcome, 'task') });
    if (!(outcome.kind === 'invalid_input' || outcome.kind === 'forbidden')) refresh();
    return outcome.kind === 'ok';
  }
  const setStatus = (t: ProjectTask, status: TaskStatus) =>
    act(t, status === 'DONE' ? `${t.title} marked done.` : null, () => client.updateTask(slug, project.id, t.id, { version: t.version, status }));

  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, list?.filter((t) => t.status === s.value).length ?? 0])) as Record<TaskStatus, number>;
  const visible = list ? (filter === 'all' ? list : list.filter((t) => t.status === filter)) : null;
  const filters: { value: Filter; label: string; n: number }[] = [{ value: 'all', label: 'All', n: list?.length ?? 0 }, ...TASK_STATUSES.map((s) => ({ value: s.value, label: s.label, n: counts[s.value] }))];

  return (
    <Panel title="Tasks" aside={list ? <span className="text-xs text-muted-foreground">{project.taskCounts.total === 0 ? 'No tasks' : `${counts.DONE} of ${list.length} done`}</span> : undefined}>
      {canManage ? <NewTask client={client} slug={slug} projectId={project.id} members={members} onAdded={(t) => { setMessage({ tone: 'ok', text: `${t.title} was added.` }); setFilter((f) => (f === 'all' || f === t.status ? f : 'all')); refresh(); }} onDraftChange={onDraftChange} onSessionEnded={onSessionEnded} /> : null}
      {list && list.length > 0 ? (
        <div role="group" aria-label="Show tasks by status" className="mb-4 flex flex-wrap gap-2">
          {filters.map((f) => (
            <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring ${filter === f.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}>
              {f.label} <span className="tabular-nums opacity-80">{f.n}</span>
            </button>
          ))}
        </div>
      ) : null}
      {message ? (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={`mb-4 rounded-xl border px-3 py-2 text-sm ${message.tone === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-muted'}`}>{message.text}</p>
      ) : null}
      {removing ? (
        <div ref={removeRef} onKeyDown={onRemoveKey} role="alertdialog" aria-labelledby="remove-task-title" aria-describedby="remove-task-body" className="mb-4 rounded-xl border border-border bg-background p-4">
          <h3 id="remove-task-title" className="text-sm font-semibold [overflow-wrap:anywhere]">Remove “{removing.title}”?</h3>
          <p id="remove-task-body" className="mt-1 text-xs text-muted-foreground">It leaves this list and the progress count. It is archived, not deleted, so its history is kept.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className={actionClass} disabled={busyId === removing.id}
              onClick={() => { const t = removing; void act(t, `${t.title} was removed.`, () => client.archiveTask(slug, project.id, t.id)).then(() => setRemoving(null)); }}>
              Remove task
            </button>
            <button type="button" className={secondaryClass} onClick={() => setRemoving(null)} autoFocus>Keep it</button>
          </div>
        </div>
      ) : null}

      {list === null && tasks.state.status === 'loading' ? <Skeleton rows={3} label="Loading tasks…" /> : null}
      {tasks.state.status === 'done' && tasks.state.outcome.kind !== 'ok' ? <Problem outcome={tasks.state.outcome} what="Tasks" onRetry={tasks.reload} onSessionEnded={onSessionEnded} /> : null}
      {visible ? (
        list!.length === 0 ? (
          <p className="text-sm text-muted-foreground">{canManage ? 'No tasks yet. Add the first one above.' : 'No tasks yet.'}</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks with this status. <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => setFilter('all')}>Show all tasks</button></p>
        ) : (
          <ul aria-label={filter === 'all' ? 'Task list' : `Task list: ${filters.find((f) => f.value === filter)!.label}`} className="divide-y divide-border">
            {visible.map((t) => editing === t.id ? (
              <li key={t.id} className="py-3">
                <TaskEditor
                  task={t} members={members}
                  onCancel={() => { onDraftChange('task-edit', false); setEditing(null); }}
                  onDirtyChange={(d) => onDraftChange('task-edit', d)}
                  onSave={async (patch) => {
                    const ok = await act(t, 'Task saved.', () => client.updateTask(slug, project.id, t.id, { version: t.version, ...patch }));
                    if (ok) {
                      onDraftChange('task-edit', false);
                      setEditing(null);
                    }
                    return ok;
                  }}
                />
              </li>
            ) : (
              <TaskRow
                key={t.id} task={t} locale={locale} members={members} canManage={canManage} busy={busyId === t.id}
                onToggleDone={() => void setStatus(t, t.status === 'DONE' ? 'TODO' : 'DONE')}
                onStatus={(s) => void setStatus(t, s)}
                onEdit={() => confirmLeave(() => { onDraftChange('task-edit', false); setEditing(t.id); })}
                onRemove={() => setRemoving(t)}
              />
            ))}
          </ul>
        )
      ) : null}
    </Panel>
  );
}

function TaskRow({ task, locale, members, canManage, busy, onToggleDone, onStatus, onEdit, onRemove }: {
  task: ProjectTask; locale?: string; members: Member[] | null; canManage: boolean; busy: boolean;
  onToggleDone: () => void; onStatus: (s: TaskStatus) => void; onEdit: () => void; onRemove: () => void;
}) {
  const uid = useId();
  const done = task.status === 'DONE';
  const meta = [memberName(members, task.assigneeUserId) ?? 'Unassigned', task.dueDate ? `due ${formatDate(task.dueDate, locale)}` : null].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      {canManage ? (
        <input id={`${uid}-done`} type="checkbox" checked={done} disabled={busy} onChange={onToggleDone} className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
          aria-label={done ? `Mark “${task.title}” as not done` : `Mark “${task.title}” as done`} />
      ) : null}
      <div className="min-w-0 flex-1 basis-48">
        <p className={`text-sm font-medium [overflow-wrap:anywhere] ${done ? 'text-muted-foreground line-through decoration-1' : ''}`}>{task.title}</p>
        {task.description ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">{task.description}</p> : null}
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{meta}</span><PriorityLabel priority={task.priority} /></p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <>
            <label htmlFor={`${uid}-status`} className="sr-only">Status of {task.title}</label>
            <select id={`${uid}-status`} value={task.status} disabled={busy} onChange={(e) => onStatus(e.target.value as TaskStatus)} className="rounded-lg border border-input bg-background px-2 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring">
              {TASK_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <button type="button" onClick={onEdit} disabled={busy} aria-label={`Edit ${task.title}`} className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Edit</button>
            <button type="button" onClick={onRemove} disabled={busy} aria-label={`Remove ${task.title}`} className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Remove</button>
          </>
        ) : <TaskStatusBadge status={task.status} />}
      </div>
    </li>
  );
}

interface TaskValues { title: string; description: string; priority: WorkPriority; assigneeUserId: string; dueDate: string }
const taskValues = (t?: ProjectTask): TaskValues => ({
  title: t?.title ?? '', description: t?.description ?? '', priority: t?.priority ?? 'MEDIUM', assigneeUserId: t?.assigneeUserId ?? '', dueDate: t?.dueDate ?? '',
});

function TaskFields({ uid, values, set, members, errors }: {
  uid: string; values: TaskValues; set: (k: keyof TaskValues, v: string) => void; members: Member[] | null; errors: Partial<Record<keyof TaskValues, string>>;
}) {
  const people = (members ?? []).filter((m) => m.status === 'ACTIVE');
  const missing = values.assigneeUserId && !people.some((m) => m.userId === values.assigneeUserId);
  const small = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <label htmlFor={`${uid}-priority`} className="mb-1 block text-xs font-medium text-muted-foreground">Priority</label>
        <select id={`${uid}-priority`} value={values.priority} onChange={(e) => set('priority', e.target.value)} className={small}>
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${uid}-assignee`} className="mb-1 block text-xs font-medium text-muted-foreground">Assignee</label>
        <select id={`${uid}-assignee`} value={values.assigneeUserId} onChange={(e) => set('assigneeUserId', e.target.value)} className={small}>
          <option value="">Unassigned</option>
          {people.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? 'Team member'}</option>)}
          {missing ? <option value={values.assigneeUserId}>Current assignee</option> : null}
        </select>
      </div>
      <div>
        <label htmlFor={`${uid}-due`} className="mb-1 block text-xs font-medium text-muted-foreground">Due date</label>
        <input id={`${uid}-due`} type="date" value={values.dueDate} onChange={(e) => set('dueDate', e.target.value)} className={small}
          aria-invalid={errors.dueDate ? true : undefined} aria-describedby={errors.dueDate ? `${uid}-due-error` : undefined} />
        {errors.dueDate ? <p id={`${uid}-due-error`} className="mt-1 text-xs font-medium text-destructive">{errors.dueDate}</p> : null}
      </div>
    </div>
  );
}

function validate(v: TaskValues) {
  const errors: Partial<Record<keyof TaskValues, string>> = {};
  if (!v.title.trim()) errors.title = 'A task title is required';
  if (v.dueDate && !isDay(v.dueDate)) errors.dueDate = 'Enter a real date';
  return errors;
}

function NewTask({ client, slug, projectId, members, onAdded, onDraftChange, onSessionEnded }: {
  client: ProjectsClient; slug: string; projectId: string; members: Member[] | null; onAdded: (t: ProjectTask) => void;
  onDraftChange: (key: string, dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [values, setValues] = useState<TaskValues>(taskValues());
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof TaskValues, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const title = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(values) !== JSON.stringify(taskValues());
  useEffect(() => onDraftChange('task-new', dirty), [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange('task-new', false), [onDraftChange]);
  const set = (k: keyof TaskValues, v: string) => {
    setValues((x) => ({ ...x, [k]: v }));
    setErrors((e) => (k in e ? {} : e));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length) return;
    const body: Record<string, unknown> = { title: values.title.trim(), priority: values.priority };
    if (values.assigneeUserId) body.assigneeUserId = values.assigneeUserId;
    if (values.dueDate) body.dueDate = values.dueDate;
    if (values.description.trim()) body.description = values.description.trim();
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    let outcome: Outcome<ProjectTask>;
    try {
      outcome = await client.createTask(slug, projectId, body);
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'ok') {
      setValues(taskValues());
      setMore(false);
      onAdded(outcome.data);
      title.current?.focus();
      return;
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    setProblem(outcome.kind === 'unreachable'
      ? "Business OS didn't answer, so the task may or may not have been added. Check the list before adding it again."
      : outcome.kind === 'conflict' && outcome.code === 'project_archived' ? 'This project is archived, so tasks cannot be added.'
      : explain(outcome, 'task'));
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label="Add a task" className="mb-5 rounded-xl border border-border p-4">
      <div className="flex flex-wrap gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor={`${uid}-title`} className="sr-only">New task title</label>
          <input id={`${uid}-title`} ref={title} value={values.title} onChange={(e) => set('title', e.target.value)} maxLength={200} placeholder="Add a task" autoComplete="off" className={inputClass}
            aria-invalid={errors.title ? true : undefined} aria-describedby={errors.title ? `${uid}-title-error` : undefined} />
        </div>
        <button type="submit" className={actionClass} disabled={busy}>{busy ? 'Adding…' : 'Add task'}</button>
      </div>
      {errors.title ? <p id={`${uid}-title-error`} className="mt-1 text-xs font-medium text-destructive">{errors.title}</p> : null}
      <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="mt-2 rounded-md text-xs font-medium text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        {more ? 'Fewer options' : 'Priority, assignee and due date'}
      </button>
      {more ? <div className="mt-3"><TaskFields uid={uid} values={values} set={set} members={members} errors={errors} /></div> : null}
      {problem ? <p role="alert" className="mt-3 text-xs font-medium text-destructive">{problem}</p> : null}
    </form>
  );
}

function TaskEditor({ task, members, onSave, onCancel, onDirtyChange }: {
  task: ProjectTask; members: Member[] | null; onSave: (patch: Record<string, unknown>) => Promise<boolean>; onCancel: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const uid = useId();
  const initial = taskValues(task);
  const [values, setValues] = useState<TaskValues>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof TaskValues, string>>>({});
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const set = (k: keyof TaskValues, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length || busy) return;
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(values) as (keyof TaskValues)[]) {
      if (values[k] === initial[k]) continue;
      patch[k] = k === 'title' || k === 'description' || k === 'priority' ? values[k].trim() : values[k] || null;
    }
    if (Object.keys(patch).length === 0) return onCancel();
    setBusy(true);
    await onSave(patch);
    setBusy(false);
  };
  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-label={`Edit task ${task.title}`} className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <label htmlFor={`${uid}-title`} className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
        <input id={`${uid}-title`} autoFocus value={values.title} onChange={(e) => set('title', e.target.value)} maxLength={200} className={inputClass}
          aria-invalid={errors.title ? true : undefined} aria-describedby={errors.title ? `${uid}-title-error` : undefined} />
        {errors.title ? <p id={`${uid}-title-error`} className="mt-1 text-xs font-medium text-destructive">{errors.title}</p> : null}
      </div>
      <div>
        <label htmlFor={`${uid}-description`} className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
        <textarea id={`${uid}-description`} value={values.description} onChange={(e) => set('description', e.target.value)} rows={2} maxLength={5000} className={inputClass} />
      </div>
      <TaskFields uid={uid} values={values} set={set} members={members} errors={errors} />
      <div className="flex gap-2">
        <button type="submit" className={actionClass} disabled={busy}>{busy ? 'Saving…' : 'Save task'}</button>
        <button type="button" className={secondaryClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
