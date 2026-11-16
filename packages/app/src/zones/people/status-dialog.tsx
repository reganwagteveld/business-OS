import type { Employee, EmploymentStatus } from '@business-os/contracts';
import { Alert, AlertTitle, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Input, Textarea } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { PeopleClient } from '../../api/people';
import { isDay, STATUS_ERRORS, STATUS_LABEL } from './format';

const CONSEQUENCE: Partial<Record<EmploymentStatus, string>> = {
  TERMINATED: 'This ends the employment. Their end date is set, and their current department and manager assignments are closed. Nothing is deleted: their record and history stay. It is refused while they still have direct reports. Their sign-in and permissions in Business OS are not changed.',
  ON_LEAVE: 'Their record stays as it is. Leave types, balances and approvals are not part of this release. Their sign-in and permissions are not changed.',
  ACTIVE: 'Their sign-in and permissions in Business OS are not changed.',
  PENDING: 'Their sign-in and permissions in Business OS are not changed.',
};

/**
 * Confirms one employment status change. The server owns the rules (allowed transitions, date order,
 * direct reports); this dialog only sends the request with the version the person saw, locks while it is
 * in flight, and reports a refusal in words. Changing status never touches membership or permissions.
 */
export function StatusDialog({ client, slug, employee, to, label, onClose, onChanged, onSessionEnded }: {
  client: PeopleClient; slug: string; employee: Employee; to: EmploymentStatus; label: string;
  onClose: () => void; onChanged: (e: Employee) => void; onSessionEnded: () => void;
}) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (date && !isDay(date)) return setError('Enter a real date.');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await client.changeStatus(slug, employee.id, {
        status: to, version: employee.version, ...(date ? { effectiveDate: date } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (outcome.kind === 'ok') return onChanged(outcome.data);
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      if (outcome.kind === 'conflict') return setError((outcome.code && STATUS_ERRORS[outcome.code]) || 'That change conflicts with the current record. Reload and try again.');
      if (outcome.kind === 'forbidden') return setError('Your role does not allow changing employment status. Nothing was changed.');
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
          <DialogTitle>{label}: {employee.displayName}</DialogTitle>
          <DialogDescription>
            {STATUS_LABEL[employee.status]} to {STATUS_LABEL[to]}. {CONSEQUENCE[to]}
          </DialogDescription>
          {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}
          <Field label="Effective date" hint="Leave blank for today. It cannot be in the future.">{(c) => <Input {...c} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Reason (optional)" hint="Only people who can view sensitive details can read this later.">{(c) => <Textarea {...c} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={to === 'TERMINATED' ? 'destructive' : 'primary'} loading={busy}>Confirm: {label}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
