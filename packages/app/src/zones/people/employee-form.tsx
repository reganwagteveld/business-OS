import type { Department, Employee, Location } from '@business-os/contracts';
import { Alert, AlertDescription, AlertTitle, Button, Field, FormSection, Input, Select } from '@business-os/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Member } from '../../api/customers';
import type { PeopleClient } from '../../api/people';
import type { Outcome } from '../../api/tenancy';
import { ZonePage } from '../../shell/zone-page';
import { EMPLOYMENT_TYPES, isDay } from './format';
import { ManagerPicker } from './manager-picker';

interface Values {
  givenName: string; familyName: string; preferredName: string; employeeNumber: string; jobTitle: string; employmentType: string;
  workEmail: string; workPhone: string; locationId: string; userId: string; startDate: string; status: string; departmentId: string; managerEmployeeId: string;
}
type Key = keyof Values;
const LABEL: Record<Key, string> = {
  givenName: 'given name', familyName: 'family name', preferredName: 'preferred name', employeeNumber: 'employee number', jobTitle: 'job title',
  employmentType: 'employment type', workEmail: 'work email', workPhone: 'work phone', locationId: 'location', userId: 'linked team member',
  startDate: 'start date', status: 'status', departmentId: 'department', managerEmployeeId: 'manager',
};
const EDIT_KEYS: Key[] = ['givenName', 'familyName', 'preferredName', 'employeeNumber', 'jobTitle', 'employmentType', 'workEmail', 'workPhone', 'locationId', 'userId', 'startDate'];

const valuesOf = (e: Employee | undefined): Values => ({
  givenName: e?.givenName ?? '', familyName: e?.familyName ?? '', preferredName: e?.preferredName ?? '', employeeNumber: e?.employeeNumber ?? '',
  jobTitle: e?.jobTitle ?? '', employmentType: e?.employmentType ?? '', workEmail: e?.workEmail ?? '', workPhone: e?.workPhone ?? '',
  locationId: e?.location?.id ?? '', userId: e?.userId ?? '', startDate: e?.startDate ?? '', status: 'PENDING', departmentId: '', managerEmployeeId: '',
});
/** What goes on the wire: null clears an optional value; the contract trims text. */
const wire = (v: string): string | null => (v.trim() === '' ? null : v.trim());

/** Server reasons mapped to the field they belong to, so the message sits where the person can fix it. */
const FIELD_OF: Record<string, { key: Key; message: string }> = {
  duplicate_employee_number: { key: 'employeeNumber', message: 'Another employee already has this number.' },
  invalid_manager: { key: 'managerEmployeeId', message: 'That person cannot be a manager. Choose someone who has not been terminated.' },
  user_already_linked: { key: 'userId', message: 'This team member is already linked to another employee.' },
};

/**
 * Create or edit an employee (work details only). Status, department and reporting-line changes after
 * creation go through their own actions because they write history. Creating an employee never creates
 * a login, sends an invitation or changes anyone's access; the optional team-member link grants nothing.
 * An edit sends only what changed plus the version it was based on; a conflicting save keeps the
 * person's changes and loads the newer record underneath.
 */
export function EmployeeForm({ client, slug, employee, departments, locations, members, canLink, onSaved, onCancel, onDirtyChange, onSessionEnded }: {
  client: PeopleClient; slug: string; employee?: Employee; departments: Department[] | null; locations: Location[] | null;
  /** Active team members for the optional link; null when the person may not list members. */
  members: Member[] | null; canLink: boolean;
  onSaved: (e: Employee) => void; onCancel: () => void; onDirtyChange: (dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const [base, setBase] = useState<Employee | undefined>(employee);
  const initial = useMemo(() => valuesOf(employee), [employee]);
  const baseValues = useMemo(() => valuesOf(base), [base]);
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [staleFields, setStaleFields] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const editing = Boolean(employee);

  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const set = (key: Key, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e));
  };
  const fail = (message: string, fields: Partial<Record<Key, string>> = {}) => {
    setErrors(fields);
    setFormError(message);
    queueMicrotask(() => summary.current?.focus());
  };
  const text = (key: Key, extra: { type?: string; maxLength?: number; placeholder?: string } = {}) => (c: object) => (
    <Input {...c} {...extra} value={values[key]} onChange={(e) => set(key, e.target.value)} />
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return; // a double click or Enter must never send a second request
    const problems: Partial<Record<Key, string>> = {};
    if (!values.givenName.trim()) problems.givenName = 'A given name is required';
    if (!values.familyName.trim()) problems.familyName = 'A family name is required';
    if (values.workEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.workEmail.trim())) problems.workEmail = 'Enter a valid email address';
    if (values.startDate && !isDay(values.startDate)) problems.startDate = 'Enter a real date';
    if (!editing && values.status === 'ACTIVE' && !values.startDate) problems.startDate = 'An active employee needs a start date';
    if (Object.keys(problems).length) return fail('Check the highlighted fields.', problems);

    const send: Record<string, unknown> = {};
    const keys = editing ? EDIT_KEYS : (Object.keys(values) as Key[]);
    for (const key of keys) {
      if (key === 'startDate' && base && base.status !== 'PENDING') continue; // only editable before the employee starts
      if (base ? values[key] === baseValues[key] : values[key].trim() === '' && key !== 'status') continue;
      send[key] = key === 'status' ? values[key] : wire(values[key]);
    }
    if (base) {
      if (Object.keys(send).length === 0) return onCancel();
      send.version = base.version;
    }

    inFlight.current = true;
    setBusy(true);
    setFormError(null);
    let outcome: Outcome<Employee>;
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
      const latest = await client.get(slug, base.id);
      if (latest.kind === 'ok') {
        const theirs = valuesOf(latest.data);
        const changed = EDIT_KEYS.filter((k) => theirs[k] !== baseValues[k]).map((k) => LABEL[k]);
        setValues((mine) => Object.fromEntries((Object.keys(theirs) as Key[]).map((k) => [k, mine[k] !== baseValues[k] ? mine[k] : theirs[k]])) as unknown as Values);
        setBase(latest.data);
        setStaleFields(changed);
        return fail('Someone else changed this employee while you were editing. Nothing was saved, and your changes are still here.');
      }
      return fail('Someone else changed this employee while you were editing. Nothing was saved. Reload it before trying again.');
    }
    if (outcome.kind === 'conflict') {
      const mapped = outcome.code ? FIELD_OF[outcome.code] : undefined;
      if (mapped) return fail(mapped.message, { [mapped.key]: mapped.message });
      return fail(outcome.code === 'terminated' ? 'This employee has been terminated, so their details can no longer be edited.'
        : outcome.code === 'archived_reference' ? 'The chosen department or location has been archived. Choose another or none.'
        : 'This change conflicts with the current record. Reload it and try again.');
    }
    switch (outcome.kind) {
      case 'invalid_input': return fail(outcome.message, (outcome.fields ?? {}) as Partial<Record<Key, string>>);
      case 'not_found': return fail('The chosen department, location or team member no longer exists in this business, or this employee was removed.');
      case 'forbidden': return fail('Your role does not allow changing employees. Nothing was saved.');
      case 'rate_limited': return fail('Too many requests. Wait a moment and try again.');
      case 'unreachable': return fail('Could not reach Business OS. Nothing was saved, and what you typed is still here. Try again.');
      default: return fail('Something went wrong. Nothing was saved. Try again.');
    }
  };

  const archivedOption = (id: string, name: string | undefined) => (id && name ? <option value={id}>{name} (archived)</option> : null);
  const locationOptions = (locations ?? []).filter((l) => !l.archivedAt);
  const currentLocation = base?.location && !locationOptions.some((l) => l.id === base.location!.id) ? base.location : null;
  const startLocked = Boolean(base && base.status !== 'PENDING');

  return (
    <ZonePage title={editing ? `Edit ${employee!.displayName}` : 'Add employee'} eyebrow="People"
      description={editing ? 'Update work details. Status changes are made from the employee page.' : 'Add a person to your team directory. This does not create a login or give them access.'}>
      <form onSubmit={(e) => void submit(e)} noValidate className="max-w-3xl space-y-8">
        <div ref={summary} tabIndex={-1} className="outline-none">
          {formError ? (
            <Alert tone="danger" role="alert">
              <AlertTitle>{formError}</AlertTitle>
              {staleFields && staleFields.length > 0 ? <AlertDescription>Also changed by someone else: {staleFields.join(', ')}. Review the fields, then save again.</AlertDescription> : null}
            </Alert>
          ) : null}
        </div>

        <FormSection title="Name and contact">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Given name" error={errors.givenName}>{text('givenName', { maxLength: 100 })}</Field>
            <Field label="Family name" error={errors.familyName}>{text('familyName', { maxLength: 100 })}</Field>
            <Field label="Preferred name" hint="Shown in place of the given name." error={errors.preferredName}>{text('preferredName', { maxLength: 100 })}</Field>
            <Field label="Employee number" hint="Optional. Must be unique in your business." error={errors.employeeNumber}>{text('employeeNumber', { maxLength: 30 })}</Field>
            <Field label="Work email" error={errors.workEmail}>{text('workEmail', { type: 'email', maxLength: 254 })}</Field>
            <Field label="Work phone" error={errors.workPhone}>{text('workPhone', { type: 'tel', maxLength: 40 })}</Field>
          </div>
        </FormSection>

        <FormSection title="Employment">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Job title" error={errors.jobTitle}>{text('jobTitle', { maxLength: 150 })}</Field>
            <Field label="Employment type" error={errors.employmentType}>{(c) => (
              <Select {...c} value={values.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
                <option value="">Not set</option>
                {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            )}</Field>
            {!editing ? (
              <Field label="Starting status" hint="Pending until they start. Active needs a start date." error={errors.status}>{(c) => (
                <Select {...c} value={values.status} onChange={(e) => set('status', e.target.value)}>
                  <option value="PENDING">Pending start</option><option value="ACTIVE">Active</option>
                </Select>
              )}</Field>
            ) : null}
            <Field label="Start date" hint={startLocked ? 'The start date can only be edited before the employee starts.' : undefined} error={errors.startDate}>
              {(c) => <Input {...c} type="date" value={values.startDate} disabled={startLocked} onChange={(e) => set('startDate', e.target.value)} />}
            </Field>
            {!editing ? (
              <Field label="Department" error={errors.departmentId}>{(c) => (
                <Select {...c} value={values.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
                  <option value="">None</option>
                  {(departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              )}</Field>
            ) : null}
            {!editing ? (
              <div className="sm:col-span-2">
                <ManagerPicker client={client} slug={slug} value={values.managerEmployeeId} onChange={(id) => set('managerEmployeeId', id)} error={errors.managerEmployeeId} />
              </div>
            ) : null}
            <Field label="Location" error={errors.locationId}>{(c) => (
              <Select {...c} value={values.locationId} onChange={(e) => set('locationId', e.target.value)}>
                <option value="">None</option>
                {archivedOption(currentLocation?.id ?? '', currentLocation?.name)}
                {locationOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            )}</Field>
          </div>
        </FormSection>

        {canLink && members ? (
          <FormSection title="Team member link" description="Optional. Links this record to an existing member of your business. It grants no access and changes no permissions.">
            <Field label="Linked team member" error={errors.userId}>{(c) => (
              <Select {...c} value={values.userId} onChange={(e) => set('userId', e.target.value)}>
                <option value="">Not linked</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? 'Team member'}</option>)}
              </Select>
            )}</Field>
          </FormSection>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={busy}>{editing ? 'Save changes' : 'Add employee'}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </ZonePage>
  );
}
