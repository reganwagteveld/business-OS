import type { EmployeePersonalDetails } from '@business-os/contracts';
import { Alert, AlertTitle, Button, Field, Input, Textarea } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { PeopleClient } from '../../api/people';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { Facts } from './profile-parts';

type Keys = 'personalEmail' | 'personalPhone' | 'homeAddress' | 'emergencyContactName' | 'emergencyContactRelationship' | 'emergencyContactPhone';
const FIELDS: { key: Keys; label: string; kind?: 'email' | 'tel' | 'area' }[] = [
  { key: 'personalEmail', label: 'Personal email', kind: 'email' }, { key: 'personalPhone', label: 'Personal phone', kind: 'tel' },
  { key: 'homeAddress', label: 'Home address', kind: 'area' }, { key: 'emergencyContactName', label: 'Emergency contact' },
  { key: 'emergencyContactRelationship', label: 'Relationship' }, { key: 'emergencyContactPhone', label: 'Emergency contact phone', kind: 'tel' },
];

/**
 * Personal contact details. Only mounted for people who hold people:read_sensitive; the server checks the
 * key again on every request. Not part of the directory or the employee object, so it is fetched only here,
 * and only when this section is on screen.
 */
export function PersonalSection({ client, slug, employeeId, canEdit, onDirtyChange, onSessionEnded }: {
  client: PeopleClient; slug: string; employeeId: string; canEdit: boolean; onDirtyChange: (dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`personal|${slug}|${employeeId}`, (signal) => client.personal(slug, employeeId, signal));
  const [editing, setEditing] = useState<EmployeePersonalDetails | null>(null);
  if (state.status === 'loading') return <p role="status" className="text-sm text-muted-foreground">Loading personal details…</p>;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="Personal details" onRetry={reload} onSessionEnded={onSessionEnded} />;
  const details = state.outcome.data;
  if (editing) {
    return (
      <PersonalForm client={client} slug={slug} employeeId={employeeId} details={editing} onDirtyChange={onDirtyChange} onSessionEnded={onSessionEnded}
        onCancel={() => { onDirtyChange(false); setEditing(null); }} onSaved={() => { onDirtyChange(false); setEditing(null); reload(); }} />
    );
  }
  const empty = FIELDS.every((f) => !details[f.key]);
  return (
    <div className="space-y-4">
      {empty ? <p className="text-sm text-muted-foreground">No personal details recorded yet.</p> : <Facts items={FIELDS.map((f) => [f.label, details[f.key]])} />}
      {canEdit ? <Button variant="outline" onClick={() => setEditing(details)}>{empty ? 'Add personal details' : 'Edit personal details'}</Button> : null}
    </div>
  );
}

function PersonalForm({ client, slug, employeeId, details, onSaved, onCancel, onDirtyChange, onSessionEnded }: {
  client: PeopleClient; slug: string; employeeId: string; details: EmployeePersonalDetails; onSaved: () => void; onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const initial = Object.fromEntries(FIELDS.map((f) => [f.key, details[f.key] ?? ''])) as Record<Keys, string>;
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const change = (key: Keys, value: string) => {
    const next = { ...values, [key]: value };
    setValues(next);
    onDirtyChange(JSON.stringify(next) !== JSON.stringify(initial));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    const send: Record<string, unknown> = { version: details.version };
    for (const f of FIELDS) if (values[f.key] !== initial[f.key]) send[f.key] = values[f.key].trim() === '' ? null : values[f.key].trim();
    if (Object.keys(send).length === 1) return onCancel();
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await client.updatePersonal(slug, employeeId, send);
      if (outcome.kind === 'ok') return onSaved();
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      setError(outcome.kind === 'conflict' ? 'These details were changed by someone else. Nothing was saved. Cancel and reopen to see the latest.'
        : outcome.kind === 'forbidden' ? 'Your role does not allow editing personal details. Nothing was saved.'
        : outcome.kind === 'invalid_input' ? outcome.message
        : outcome.kind === 'unreachable' ? 'Could not reach Business OS. Nothing was saved, and what you typed is still here.' : 'Something went wrong. Nothing was saved.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
      {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} className={f.kind === 'area' ? 'sm:col-span-2' : undefined}>
            {(c) => f.kind === 'area'
              ? <Textarea {...c} maxLength={500} value={values[f.key]} onChange={(e) => change(f.key, e.target.value)} />
              : <Input {...c} type={f.kind ?? 'text'} maxLength={254} value={values[f.key]} onChange={(e) => change(f.key, e.target.value)} />}
          </Field>
        ))}
      </div>
      <div className="flex gap-3">
        <Button type="submit" loading={busy}>Save personal details</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
