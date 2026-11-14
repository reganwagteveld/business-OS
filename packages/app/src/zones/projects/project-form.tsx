import type { Project } from '@business-os/contracts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CustomersClient, Member } from '../../api/customers';
import type { ProjectsClient } from '../../api/projects';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { CustomerPicker } from '../customer-picker';
import { isDay, PRIORITIES, PROJECT_STATUSES } from './format';
import { customerLabel } from './project-list';

interface Values { name: string; description: string; status: string; priority: string; customerId: string; ownerUserId: string; startDate: string; dueDate: string }
type Field = keyof Values;
const LABEL: Record<Field, string> = {
  name: 'name', description: 'description', status: 'status', priority: 'priority', customerId: 'customer', ownerUserId: 'owner', startDate: 'start date', dueDate: 'due date',
};

const valuesOf = (p: Project | undefined): Values => ({
  name: p?.name ?? '', description: p?.description ?? '', status: p?.status ?? 'PLANNED', priority: p?.priority ?? 'MEDIUM', customerId: p?.customerId ?? '',
  ownerUserId: p?.ownerUserId ?? '', startDate: p?.startDate ?? '', dueDate: p?.dueDate ?? '',
});

/** What goes on the wire: null clears an optional link or date; the contract turns '' text into null. */
function wire(field: Field, value: string): unknown {
  const v = value.trim();
  if (field === 'name' || field === 'description' || field === 'status' || field === 'priority') return v;
  return v === '' ? null : v;
}

function Labelled({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint && !error ? <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Create or edit a project. The customer is picked from the Customer Zone's own records (only by
 * people who may read customers); the owner from the active members of this business. An edit sends
 * only what changed plus the version it was based on; a conflicting save keeps the person's changes.
 */
export function ProjectForm({ client, customers, slug, members, canReadCustomers, project, onSaved, onCancel, onDirtyChange, onSessionEnded }: {
  client: ProjectsClient; customers: CustomersClient; slug: string; members: Member[] | null; canReadCustomers: boolean; project?: Project;
  onSaved: (p: Project) => void; onCancel: () => void; onDirtyChange: (dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [base, setBase] = useState<Project | undefined>(project);
  const initial = useMemo(() => valuesOf(project), [project]);
  const baseValues = useMemo(() => valuesOf(base), [base]);
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [staleFields, setStaleFields] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const [customerName, setCustomerName] = useState<string | null>(project ? customerLabel(project) : null);

  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const set = (key: Field, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e));
  };
  const fail = (message: string, fields: Partial<Record<Field, string>> = {}) => {
    setErrors(fields);
    setFormError(message);
    queueMicrotask(() => summary.current?.focus());
  };
  const control = (key: Field, extra: { hint?: boolean } = {}) => ({
    id: `${uid}-${key}`,
    value: values[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
    'aria-invalid': errors[key] ? (true as const) : undefined,
    'aria-describedby': errors[key] ? `${uid}-${key}-error` : extra.hint ? `${uid}-${key}-hint` : undefined,
    className: inputClass,
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    const problems: Partial<Record<Field, string>> = {};
    if (!values.name.trim()) problems.name = 'A project name is required';
    if (values.startDate && !isDay(values.startDate)) problems.startDate = 'Enter a real date';
    if (values.dueDate && !isDay(values.dueDate)) problems.dueDate = 'Enter a real date';
    if (!problems.startDate && !problems.dueDate && values.startDate && values.dueDate && values.dueDate < values.startDate) problems.dueDate = 'The due date cannot be before the start date';
    if (Object.keys(problems).length) return fail('Check the highlighted fields.', problems);

    const send: Record<string, unknown> = {};
    for (const key of Object.keys(values) as Field[]) {
      if (base && values[key] === baseValues[key]) continue; // edits send only what changed
      if (!base && values[key].trim() === '') continue;
      send[key] = wire(key, values[key]);
    }
    if (base) {
      if (Object.keys(send).length === 0) return onCancel();
      send.version = base.version;
    }

    inFlight.current = true;
    setBusy(true);
    setFormError(null);
    let outcome: Outcome<Project>;
    try {
      outcome = base ? await client.update(slug, base.id, send) : await client.create(slug, send);
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'ok') {
      onDirtyChange(false);
      return onSaved(outcome.data);
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    if (outcome.kind === 'conflict' && outcome.code === 'stale' && base) {
      // Someone else saved first. Keep this person's edits, load theirs underneath, save nothing yet.
      const latest = await client.get(slug, base.id);
      if (latest.kind === 'ok') {
        const theirs = valuesOf(latest.data);
        const changed = (Object.keys(theirs) as Field[]).filter((k) => theirs[k] !== baseValues[k]).map((k) => LABEL[k]);
        setValues((mine) => Object.fromEntries((Object.keys(theirs) as Field[]).map((k) => [k, mine[k] !== baseValues[k] ? mine[k] : theirs[k]])) as unknown as Values);
        setBase(latest.data);
        setStaleFields(changed);
        return fail('Someone else changed this project while you were editing. Nothing was saved, and your changes are still here.');
      }
      return fail('Someone else changed this project while you were editing. Nothing was saved. Reload it before trying again.');
    }
    switch (outcome.kind) {
      case 'invalid_input': return fail(outcome.message, outcome.fields as Partial<Record<Field, string>>);
      case 'conflict':
        return fail(outcome.code === 'archived' ? 'This project is archived. Restore it before editing.'
          : outcome.code === 'archived_reference' ? 'The chosen customer has been archived. Choose another customer or none.'
          : 'This project changed in a way that prevents saving. Reload it and try again.');
      case 'not_found': return fail('The chosen customer no longer exists in this business, or this project was removed.');
      case 'forbidden': return fail(values.customerId !== baseValues.customerId
        ? 'Your role does not allow linking customers to projects in this business.'
        : 'Your role does not allow changing projects in this business.');
      case 'unreachable': return fail(base
        ? "Can't reach Business OS. Your changes are still here; save again when you're back online."
        : "Business OS didn't answer, so the project may or may not have been created. Check the list before creating it again. Your details are still here.");
      case 'rate_limited': return fail('Too many requests. Wait a moment and try again.');
      default: return fail('Something went wrong and nothing was saved. Your changes are still here.');
    }
  };

  const owners = (members ?? []).filter((m) => m.status === 'ACTIVE');
  const ownerMissing = values.ownerUserId && !owners.some((m) => m.userId === values.ownerUserId);
  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${uid}-h`} className="mx-auto max-w-3xl">
      <h1 id={`${uid}-h`} className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">{project ? `Edit ${project.name}` : 'New project'}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{project ? 'Change what you need; everything else stays as it is.' : 'Only a name is required. A project can be for a customer or entirely internal.'}</p>

      {formError ? (
        <div ref={summary} tabIndex={-1} role="alert" className="mb-6 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive outline-none">
          <p>{formError}</p>
          {staleFields ? (
            <p className="mt-2 text-foreground">
              {staleFields.length ? `They changed: ${[...new Set(staleFields)].join(', ')}. ` : ''}
              Review the form, then choose <strong>Save changes</strong> to save your version on top of theirs, or <strong>Cancel</strong> to keep theirs.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-4">
        <fieldset className="grid gap-4 rounded-2xl border border-border p-5 sm:grid-cols-2">
          <legend className="px-2 text-sm font-semibold">Project</legend>
          <div className="sm:col-span-2">
            <Labelled id={`${uid}-name`} label="Name" error={errors.name}>
              <input {...control('name')} maxLength={200} aria-required="true" autoComplete="off" />
            </Labelled>
          </div>
          <Labelled id={`${uid}-status`} label="Status" error={errors.status}>
            <select {...control('status')}>{PROJECT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
          </Labelled>
          <Labelled id={`${uid}-priority`} label="Priority" error={errors.priority}>
            <select {...control('priority')}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          </Labelled>
          <Labelled id={`${uid}-ownerUserId`} label="Owner" error={errors.ownerUserId} hint={members === null ? 'Loading your team…' : undefined}>
            <select {...control('ownerUserId', { hint: members === null })}>
              <option value="">No owner</option>
              {owners.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? 'Team member'}</option>)}
              {ownerMissing ? <option value={values.ownerUserId}>Current owner</option> : null}
            </select>
          </Labelled>
          <div className="sm:col-span-2">
            <Labelled id={`${uid}-description`} label="Description" error={errors.description} hint={`${values.description.length} / 5000`}>
              <textarea {...control('description', { hint: true })} rows={4} maxLength={5000} />
            </Labelled>
          </div>
        </fieldset>

        <fieldset className="grid gap-4 rounded-2xl border border-border p-5 sm:grid-cols-2">
          <legend className="px-2 text-sm font-semibold">Customer</legend>
          {canReadCustomers ? (
            <CustomerPicker
              id={`${uid}-customer`} customers={customers} slug={slug} selectedId={values.customerId} selectedName={customerName} error={errors.customerId} onSessionEnded={onSessionEnded}
              onPick={(c) => { set('customerId', c?.id ?? ''); setCustomerName(c?.displayName ?? null); }}
            />
          ) : (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              {values.customerId ? 'This project is linked to a customer. ' : ''}Your role does not include the Customers Zone, so customers cannot be chosen or changed here.
            </p>
          )}
        </fieldset>

        <fieldset className="grid gap-4 rounded-2xl border border-border p-5 sm:grid-cols-2">
          <legend className="px-2 text-sm font-semibold">Dates</legend>
          <Labelled id={`${uid}-startDate`} label="Start date" error={errors.startDate}>
            <input {...control('startDate')} type="date" />
          </Labelled>
          <Labelled id={`${uid}-dueDate`} label="Due date" error={errors.dueDate}>
            <input {...control('dueDate')} type="date" min={values.startDate || undefined} />
          </Labelled>
        </fieldset>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button type="submit" className={actionClass} disabled={busy}>{busy ? 'Saving…' : project ? 'Save changes' : 'Create project'}</button>
        <button type="button" className={secondaryClass} onClick={onCancel} disabled={busy}>Cancel</button>
        {dirty && !busy ? <span role="status" className="text-xs text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </form>
  );
}
