import { useRef, useState } from 'react';
import type { Outcome } from '../../api/tenancy';

/**
 * One save at a time, every failure in words a person can act on. `stale` is set when the server says
 * the record changed underneath the edit (409 stale), so the screen can offer to load the latest version
 * instead of a blind retry. A call that rejects is handled like a request that got no answer.
 */
export function useSave(onSessionEnded: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);

  async function run<T>(call: () => Promise<Outcome<T>>, onOk: (data: T) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setFields({});
    setStale(false);
    let out: Outcome<T>;
    try {
      out = await call();
    } catch {
      out = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (out.kind === 'ok') return onOk(out.data);
    setError(out.kind === 'invalid_input' && out.fields && Object.keys(out.fields).length > 0 ? 'Check the highlighted fields.' : describeFailure(out));
    if (out.kind === 'unauthenticated') onSessionEnded();
    if (out.kind === 'conflict' && out.code === 'stale') setStale(true);
    if (out.kind === 'invalid_input') setFields(out.fields ?? {});
  }
  return { busy, error, fields, stale, run, reset: () => { setError(null); setFields({}); setStale(false); } };
}

export function describeFailure(out: Outcome<unknown>): string {
  switch (out.kind) {
    case 'unauthenticated': return 'Your session has ended. Please sign in again.';
    case 'forbidden': return 'Your role in this business does not allow this change.';
    case 'not_found': return 'This business could not be found. It may no longer be available to you.';
    case 'conflict': return conflictMessage(out.code);
    case 'rate_limited': return 'Too many requests. Please wait a moment and try again.';
    case 'invalid_input': return out.message;
    case 'unreachable': return 'The connection dropped before Pixa OS answered, so this change may already have been saved. Load the latest version to check before trying again.';
    default: return 'That change could not be saved. Nothing was changed. Try again in a moment.';
  }
}

/** What a 409 means, in words. The server's code decides; unknown codes fall back to a safe prompt to reload. */
export function conflictMessage(code: string | undefined): string {
  switch (code) {
    case 'stale': return 'Someone else changed this while you were editing, so nothing was saved. Your edits are still here: load the latest version to see what changed.';
    case 'last_owner': return 'A business must always keep at least one active owner. Make someone else an owner first.';
    case 'member_not_active': return 'That person is suspended, so they cannot become an owner. Reactivate them first.';
    case 'already_owner': return 'That person is already an owner.';
    case 'already_member': return 'That email address already belongs to a member of this business.';
    case 'invitation_exists': return 'There is already an open invitation for that email address. Resend or revoke it instead.';
    case 'invitation_closed': return 'That invitation was already accepted or revoked. The list has been refreshed.';
    default: return 'That change could not be made. Reload and try again.';
  }
}
