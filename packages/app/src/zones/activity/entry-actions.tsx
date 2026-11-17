import type { Activity } from '@business-os/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { ActivityTimelineItem } from './timeline-item';

/** What the logged-in person may change on the timeline. The server decides again on every call. */
export interface EntryManage {
  /** The signed-in user. Only the author of an entry may edit or remove it (the API refuses anyone else). */
  userId: string;
  client: Pick<CustomersClient, 'updateNote' | 'removeActivity'>;
  slug: string;
  /** Called after a change (or an unclear answer) so the timeline reloads from the server. */
  onChanged: () => void;
  onDraftChange: (key: string, dirty: boolean) => void;
  confirmDiscard: (action: () => void) => void;
  onSessionEnded: () => void;
}

const REMOVABLE = new Set(['note', 'call', 'meeting', 'email', 'interaction']);

export const canEditEntry = (a: Activity, userId: string) => a.type === 'note' && a.actorType === 'USER' && a.actorUserId === userId && !a.erasedAt;
export const canRemoveEntry = (a: Activity, userId: string) => REMOVABLE.has(a.type) && a.actorType === 'USER' && a.actorUserId === userId && !a.erasedAt;

type Mode = 'view' | 'edit' | 'remove';

/** One timeline entry with its own edit and remove controls. Entries the viewer cannot change render exactly as before. */
export function ManagedEntry({ a, who, locale, timeZone, manage }: { a: Activity; who: string | null; locale?: string; timeZone: string; manage: EntryManage }) {
  const [mode, setMode] = useState<Mode>('view');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const editable = canEditEntry(a, manage.userId);
  const removable = canRemoveEntry(a, manage.userId);
  const uid = useId();
  const [subject, setSubject] = useState(a.subject ?? '');
  const [body, setBody] = useState(a.body ?? '');
  const draftKey = `entry:${a.id}`;
  const dirty = mode === 'edit' && (subject !== (a.subject ?? '') || body !== (a.body ?? ''));
  const { onDraftChange } = manage;
  useEffect(() => onDraftChange(draftKey, dirty), [dirty, draftKey, onDraftChange]);
  useEffect(() => () => onDraftChange(draftKey, false), [draftKey, onDraftChange]);

  if (!editable && !removable) return <ActivityTimelineItem a={a} who={who} locale={locale} timeZone={timeZone} />;

  const finish = (outcome: Outcome<unknown>, verb: 'save' | 'remove') => {
    switch (outcome.kind) {
      case 'ok':
        setMode('view');
        return manage.onChanged();
      case 'unauthenticated': return manage.onSessionEnded();
      case 'invalid_input': return setError(outcome.message);
      case 'forbidden': return setError(`Only the person who wrote this entry can ${verb === 'save' ? 'edit' : 'remove'} it.`);
      case 'not_found':
        manage.onChanged();
        return setError('This entry no longer exists, so nothing was changed.');
      case 'conflict': return setError('This customer is archived, or this entry cannot be changed. Restore the customer to change its history.');
      case 'unreachable': // no reload here: it would close this editor and drop the text. Repeating the same change is safe.
        return setError(`Business OS didn't answer, so this may or may not have been ${verb === 'save' ? 'saved' : 'removed'}. Try again, or reload the page to check.`);
      default: return setError(`Something went wrong and the entry was not ${verb === 'save' ? 'saved' : 'removed'}.`);
    }
  };

  const run = async (verb: 'save' | 'remove', call: () => Promise<Outcome<unknown>>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let outcome: Outcome<unknown>;
    try {
      outcome = await call();
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    finish(outcome, verb);
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const patch: Record<string, string | null> = {};
    if (subject.trim() !== (a.subject ?? '')) patch.subject = subject.trim() || null;
    if (body.trim() !== (a.body ?? '')) patch.body = body.trim() || null;
    if (!subject.trim() && !body.trim()) return setError('Add a subject or some text, or remove the note instead.');
    if (Object.keys(patch).length === 0) return setMode('view');
    void run('save', () => manage.client.updateNote(manage.slug, a.id, patch));
  };

  const reset = () => { setMode('view'); setError(null); setSubject(a.subject ?? ''); setBody(a.body ?? ''); };

  if (mode === 'edit') {
    return (
      <li data-kind="editing" className="rounded-xl border border-border p-4">
        <form onSubmit={save} noValidate aria-label="Edit note" className="space-y-3">
          {error ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          {a.subject !== null ? (
            <div>
              <label htmlFor={`${uid}-subject`} className="mb-1 block text-xs font-medium">Subject</label>
              <input id={`${uid}-subject`} className={inputClass} maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          ) : null}
          <div>
            <label htmlFor={`${uid}-body`} className="mb-1 block text-xs font-medium">Note</label>
            <textarea id={`${uid}-body`} className={inputClass} rows={3} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={actionClass}>{busy ? 'Saving…' : 'Save changes'}</button>
            <button type="button" disabled={busy} className={secondaryClass} onClick={() => (dirty ? manage.confirmDiscard(reset) : reset())}>Cancel</button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <>
      <ActivityTimelineItem a={a} who={who} locale={locale} timeZone={timeZone}
        actions={mode === 'remove' ? (
          <div role="alertdialog" aria-label="Remove entry" className="mt-2 space-y-2 rounded-lg border border-border bg-muted px-3 py-2">
            <p className="text-sm">Remove this entry from the timeline? This cannot be undone.</p>
            <div className="flex gap-2">
              <button type="button" disabled={busy} className={actionClass} onClick={() => void run('remove', () => manage.client.removeActivity(manage.slug, a.id))}>{busy ? 'Removing…' : 'Remove entry'}</button>
              <button type="button" disabled={busy} className={secondaryClass} onClick={() => { setMode('view'); setError(null); }} autoFocus>Keep it</button>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex gap-3 text-xs">
            {editable ? <button type="button" className="underline" onClick={() => { setError(null); setMode('edit'); }}>Edit</button> : null}
            {removable ? <button type="button" className="underline" onClick={() => { setError(null); setMode('remove'); }}>Remove</button> : null}
          </div>
        )}
        notice={error} />
    </>
  );
}
