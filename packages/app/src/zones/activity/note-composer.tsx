import { useEffect, useId, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';

/**
 * A quick internal note on this customer, optionally restricted (visible only to its author, owners
 * and admins; the server enforces it). The text stays on any failure, a double click saves once, and
 * an unanswered request never claims success.
 */
export function NoteComposer({ client, slug, customerId, onSaved, onDraftChange, confirmDiscard, onSessionEnded }: {
  client: Pick<CustomersClient, 'createActivity'>; slug: string; customerId: string; onSaved: () => void;
  onDraftChange: (key: string, dirty: boolean) => void; confirmDiscard: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const inFlight = useRef(false);

  const dirty = open && (text !== '' || restricted);
  useEffect(() => onDraftChange('note', dirty), [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange('note', false), [onDraftChange]);
  const close = () => { setOpen(false); setText(''); setRestricted(false); setError(null); };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (!text.trim()) return setError('Write something first.');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let outcome: Outcome<unknown>;
    try {
      outcome = await client.createActivity(slug, { customerId, type: 'note', body: text.trim(), ...(restricted ? { visibility: 'RESTRICTED' } : {}) });
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    switch (outcome.kind) {
      case 'ok':
        close();
        setSaved(restricted ? 'Restricted note saved.' : 'Note saved.');
        return onSaved();
      case 'unauthenticated': return onSessionEnded();
      case 'invalid_input': return setError(outcome.message);
      case 'conflict': return setError('This customer was archived, so notes cannot be added. Your text is still here.');
      case 'forbidden': return setError('Your role does not allow adding notes in this business.');
      case 'unreachable':
        onSaved();
        return setError("Business OS didn't answer, so this note may or may not have been saved. Check the timeline before saving again. Your text is still here.");
      default: return setError('Something went wrong and the note was not saved. Your text is still here.');
    }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={secondaryClass} onClick={() => { setSaved(null); setOpen(true); }}>Add note</button>
        {saved ? <p role="status" className="text-sm">{saved}</p> : null}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${uid}-title`} className="space-y-3 rounded-xl border border-border p-4">
      <h3 id={`${uid}-title`} className="text-sm font-semibold">Add note</h3>
      {error ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <div>
        <label htmlFor={`${uid}-text`} className="mb-1 block text-xs font-medium">Note</label>
        <textarea id={`${uid}-text`} className={inputClass} rows={3} maxLength={10000} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
        Restricted: only me, owners and admins can see it
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={actionClass}>{busy ? 'Saving…' : 'Save note'}</button>
        <button type="button" disabled={busy} className={secondaryClass} onClick={() => (dirty ? confirmDiscard(close) : close())}>Cancel</button>
      </div>
    </form>
  );
}
