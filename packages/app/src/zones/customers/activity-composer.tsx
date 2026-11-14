import { useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';

type Kind = 'note' | 'call' | 'meeting' | 'email';
export function ActivityComposer({ client, slug, customerId, onSaved, onSessionEnded }: {
  client: CustomersClient; slug: string; customerId: string; onSaved: () => void; onSessionEnded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<Kind>('note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!subject.trim() && !body.trim()) { setError('Add a subject or some details.'); return; }
    setBusy(true); setError(null);
    try {
      const result = await client.createActivity(slug, { customerId, type, subject: subject.trim(), body: body.trim() });
      if (result.kind === 'unauthenticated') return onSessionEnded();
      if (result.kind !== 'ok') {
        setError(result.kind === 'invalid_input' ? result.message : result.kind === 'forbidden' ? 'Your role cannot log activity.'
          : result.kind === 'conflict' ? 'Restore this customer before logging activity.'
          : 'Could not log this activity. Your text is still here.');
        return;
      }
      setSubject(''); setBody(''); setOpen(false); onSaved();
    } catch { setError('Could not connect. Your text is still here.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="mb-4">
      {!open ? <button type="button" className={secondaryClass} onClick={() => setOpen(true)}>Log activity</button> : (
        <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={(event) => void submit(event)}>
          <h3 className="text-sm font-semibold">Log activity</h3>
          <label className="block text-xs font-medium">Type
            <select className={inputClass} value={type} onChange={e => setType(e.target.value as Kind)}>
              <option value="note">Note</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="email">Email</option>
            </select>
          </label>
          <label className="block text-xs font-medium">Subject
            <input className={inputClass} maxLength={200} value={subject} onChange={e => setSubject(e.target.value)} />
          </label>
          <label className="block text-xs font-medium">Details
            <textarea className={inputClass} rows={4} maxLength={10000} value={body} onChange={e => setBody(e.target.value)} />
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={actionClass}>{busy ? 'Saving…' : 'Save activity'}</button>
            <button type="button" disabled={busy} className={secondaryClass} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
