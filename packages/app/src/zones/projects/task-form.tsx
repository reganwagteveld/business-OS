import type { ProjectTask, WorkPriority } from '@business-os/contracts';
import { useEffect, useId, useState } from 'react';
import type { Member } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { isDay, PRIORITIES } from './format';

// Shared by the task list and the task board: plain words for refused changes, and the task form.

/** Plain words for a refused change. The record is reloaded so the screen shows the truth. */
export function explain(outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>, what: 'project' | 'task'): string {
  if (outcome.kind === 'conflict') {
    switch (outcome.code) {
      case 'stale': return `Someone else changed this ${what} a moment ago. The latest version is shown; check it and try again.`;
      case 'archived': return what === 'project' ? 'This project is already archived.' : 'This task has been removed. The latest list is shown.';
      case 'not_archived': return `This ${what} is not archived. The latest version is shown.`;
      case 'project_archived': return 'This project is archived, so its tasks cannot change. Restore the project first.';
      case 'order_changed': return 'The board changed while this task was being moved. The latest order is shown; try the move again.';
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

export interface TaskValues { title: string; description: string; priority: WorkPriority; assigneeUserId: string; dueDate: string }
export const taskValues = (t?: ProjectTask): TaskValues => ({
  title: t?.title ?? '', description: t?.description ?? '', priority: t?.priority ?? 'MEDIUM', assigneeUserId: t?.assigneeUserId ?? '', dueDate: t?.dueDate ?? '',
});

export function TaskFields({ uid, values, set, members, errors }: {
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

export function validate(v: TaskValues) {
  const errors: Partial<Record<keyof TaskValues, string>> = {};
  if (!v.title.trim()) errors.title = 'A task title is required';
  if (v.dueDate && !isDay(v.dueDate)) errors.dueDate = 'Enter a real date';
  return errors;
}

export function TaskEditor({ task, members, onSave, onCancel, onDirtyChange }: {
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
