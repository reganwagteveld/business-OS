import { useEffect, useId, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';

type Kind = 'note' | 'call' | 'meeting' | 'email';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'note', label: 'Note' }, { value: 'call', label: 'Call' }, { value: 'meeting', label: 'Meeting' }, { value: 'email', label: 'Email' },
];
type Draft = { type: Kind; when: string; subject: string; body: string };
const EMPTY: Draft = { type: 'note', when: '', subject: '', body: '' };

/** "2026-11-14T09:30" from a datetime-local field is the person's own local time; send it as an exact instant. */
export function toInstant(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Logs a note, call, meeting or email against this customer. The server attributes it to the signed-in
 * person and checks the customer is in this business and not archived. A draft is never dropped
 * silently, a double click sends once, and an unanswered request is reported as "may have been saved".
 */
export function ActivityComposer({ client, slug, customerId, onSaved, onDraftChange, confirmDiscard, onSessionEnded }: {
  client: CustomersClient; slug: string; customerId: string; onSaved: () => void;
  onDraftChange: (key: string, dirty: boolean) => void; confirmDiscard: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<'content' | 'when' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const inFlight = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const dirty = open && JSON.stringify(draft) !== JSON.stringify(EMPTY);
  useEffect(() => onDraftChange('activity', dirty), [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange('activity', false), [onDraftChange]);

  const fail = (message: string, field: 'content' | 'when' | null = null) => {
    setError(message);
    setInvalid(field);
    queueMicrotask(() => errorRef.current?.focus());
  };
  const close = () => {
    setOpen(false);
    setDraft(EMPTY);
    setError(null);
    setInvalid(null);
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return; // a second click while saving does nothing
    if (!draft.subject.trim() && !draft.body.trim()) return fail('Add a subject or some details.', 'content');
    const occurredAt = draft.when ? toInstant(draft.when) : undefined;
    if (occurredAt === null) return fail('Enter a valid date and time.', 'when');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    let outcome: Outcome<unknown>;
    try {
      outcome = await client.createActivity(slug, { customerId, type: draft.type, subject: draft.subject.trim(), body: draft.body.trim(), ...(occurredAt ? { occurredAt } : {}) });
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    switch (outcome.kind) {
      case 'ok': {
        const label = KINDS.find((k) => k.value === draft.type)!.label;
        close();
        setSaved(`${label} logged.`);
        return onSaved();
      }
      case 'unauthenticated': return onSessionEnded();
      case 'invalid_input': return fail(outcome.message, /date/i.test(outcome.message) ? 'when' : null);
      case 'conflict': return fail('This customer was archived, so activity cannot be logged. Your text is still here.');
      case 'forbidden': return fail('Your role does not allow logging activity in this business.');
      case 'not_found': return fail('This customer no longer exists in this business.');
      case 'unreachable':
        onSaved(); // refresh the timeline so the person can see whether it arrived before trying again
        return fail("Business OS didn't answer, so this may or may not have been logged. The timeline has been refreshed; check it before saving again. Your text is still here.");
      default: return fail('Something went wrong and nothing was logged. Your text is still here.');
    }
  };

  if (!open) {
    return (
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <button type="button" className={secondaryClass} onClick={() => { setSaved(null); setOpen(true); }}>Log activity</button>
        {saved ? <p role="status" className="text-sm">{saved}</p> : null}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${uid}-title`} className="mb-5 space-y-3 rounded-xl border border-border p-4">
      <h3 id={`${uid}-title`} className="text-sm font-semibold">Log activity</h3>
      {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive outline-none">{error}</p> : null}
      <div role="radiogroup" aria-label="Activity type" className="inline-flex flex-wrap rounded-xl border border-border p-1">
        {KINDS.map((k) => (
          <label key={k.value} className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${draft.type === k.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
            <input type="radio" name={`${uid}-type`} value={k.value} checked={draft.type === k.value} onChange={() => set('type', k.value)} className="sr-only" />
            {k.label}
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-subject`} className="mb-1 block text-xs font-medium">Subject</label>
          <input id={`${uid}-subject`} className={inputClass} maxLength={200} value={draft.subject} onChange={(e) => set('subject', e.target.value)}
            aria-invalid={invalid === 'content' ? true : undefined} />
        </div>
        <div>
          <label htmlFor={`${uid}-when`} className="mb-1 block text-xs font-medium">When</label>
          <input id={`${uid}-when`} type="datetime-local" className={inputClass} value={draft.when} onChange={(e) => set('when', e.target.value)}
            aria-invalid={invalid === 'when' ? true : undefined} aria-describedby={`${uid}-when-hint`} />
          <p id={`${uid}-when-hint`} className="mt-1 text-xs text-muted-foreground">Leave blank for now. Uses your device's time zone.</p>
        </div>
      </div>
      <div>
        <label htmlFor={`${uid}-body`} className="mb-1 block text-xs font-medium">Details</label>
        <textarea id={`${uid}-body`} className={inputClass} rows={4} maxLength={10000} value={draft.body} onChange={(e) => set('body', e.target.value)}
          aria-invalid={invalid === 'content' ? true : undefined} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className={actionClass}>{busy ? 'Saving…' : 'Save activity'}</button>
        <button type="button" disabled={busy} className={secondaryClass} onClick={() => (dirty ? confirmDiscard(close) : close())}>Cancel</button>
        {dirty && !busy ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </form>
  );
}
