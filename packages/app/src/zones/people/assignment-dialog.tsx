import type { Department, Employee } from '@business-os/contracts';
import { Alert, AlertTitle, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Input, Select } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { PeopleClient } from '../../api/people';
import { isDay } from './format';
import { ManagerPicker } from './manager-picker';

export type AssignmentKind = 'department' | 'manager';

const CONFLICT: Record<string, string> = {
  stale: 'Someone else changed this employee. Close this and reload to see the latest, then try again.',
  terminated: 'This employee has been terminated, so their assignments can no longer change.',
  archived_reference: 'That department has been archived. Choose another or none.',
  manager_cycle: 'That would make a reporting loop: this person already reports, directly or indirectly, to the chosen manager.',
  invalid_manager: 'That person cannot be this employee\'s manager. Choose someone who has not been terminated, and not the employee themselves.',
};

/**
 * Changes an employee's department or manager. The change takes effect on the date given (today in the
 * business's time zone when blank), closes the current assignment and opens a new one; history is kept.
 * Sends the version the person saw, locks while in flight, and shows the server's reason when it refuses
 * (stale version, archived department, self, terminated manager, reporting-line cycle, date rules).
 */
export function AssignmentDialog({ kind, client, slug, employee, departments, onClose, onChanged, onSessionEnded }: {
  kind: AssignmentKind; client: PeopleClient; slug: string; employee: Employee; departments: Department[] | null;
  onClose: () => void; onChanged: (e: Employee) => void; onSessionEnded: () => void;
}) {
  const current = kind === 'department' ? employee.department?.id ?? '' : employee.manager?.id ?? '';
  const [target, setTarget] = useState(current);
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const word = kind === 'department' ? 'department' : 'manager';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (target === current) return setError(`That is already the current ${word}.`);
    if (date && !isDay(date)) return setError('Enter a real date.');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const base = { version: employee.version, ...(date ? { effectiveDate: date } : {}) };
      const outcome = kind === 'department'
        ? await client.changeDepartment(slug, employee.id, { ...base, departmentId: target || null })
        : await client.changeManager(slug, employee.id, { ...base, managerEmployeeId: target || null });
      if (outcome.kind === 'ok') return onChanged(outcome.data);
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      if (outcome.kind === 'conflict') return setError((outcome.code && CONFLICT[outcome.code]) || 'That change conflicts with the current record. Reload and try again.');
      if (outcome.kind === 'forbidden') return setError('Your role does not allow changing assignments. Nothing was changed.');
      if (outcome.kind === 'not_found') return setError(`The chosen ${word} no longer exists in this business, or this employee was removed. Nothing was changed.`);
      if (outcome.kind === 'invalid_input') return setError(outcome.message);
      if (outcome.kind === 'unreachable') return setError('Could not reach Business OS. Nothing was changed. Try again.');
      setError('Something went wrong. Nothing was changed.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
          <DialogTitle>Change {word}: {employee.displayName}</DialogTitle>
          <DialogDescription>
            {kind === 'department' ? 'Moves them to another department from the date below.' : 'Sets who they report to from the date below.'} The previous assignment is kept in their history. Their sign-in and permissions are not changed.
          </DialogDescription>
          {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}
          {kind === 'department' ? (
            <Field label="Department">{(c) => (
              <Select {...c} value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">No department</option>
                {(departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            )}</Field>
          ) : (
            <ManagerPicker client={client} slug={slug} excludeId={employee.id} value={target} valueLabel={employee.manager?.name} onChange={(id) => setTarget(id)} />
          )}
          <Field label="Effective date" hint="Leave blank for today. It cannot be in the future or before the current assignment started.">
            {(c) => <Input {...c} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy}>Save {word}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
