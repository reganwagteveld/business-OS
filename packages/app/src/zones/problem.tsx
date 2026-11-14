import { useEffect } from 'react';
import type { Outcome } from '../api/tenancy';
import { actionClass, secondaryClass } from '../shell/frame';

/** Every way a read can fail, in words a person can act on. Offline, forbidden and an ended session are all different. */
export function Problem({ outcome, what, onRetry, onSessionEnded }: { outcome: Outcome<unknown>; what: string; onRetry: () => void; onSessionEnded: () => void }) {
  const ended = outcome.kind === 'unauthenticated';
  const unreachable = outcome.kind === 'unreachable';
  useEffect(() => {
    if (ended) onSessionEnded(); // the app re-checks the session and shows sign-in
  }, [ended, onSessionEnded]);
  // Offline: try again by itself when the connection returns.
  useEffect(() => {
    if (!unreachable) return;
    window.addEventListener('online', onRetry);
    return () => window.removeEventListener('online', onRetry);
  }, [unreachable, onRetry]);

  const offline = unreachable && typeof navigator !== 'undefined' && navigator.onLine === false;
  const copy = (() => {
    switch (outcome.kind) {
      case 'unauthenticated': return { title: 'Your session has ended', body: 'Please sign in again.' };
      case 'unreachable': return offline
        ? { title: "You're offline", body: `Check your internet connection. ${what} will load when it comes back, or you can try again now.` }
        : { title: "Can't reach Business OS", body: `The service did not respond. Nothing was changed. Try again in a moment.` };
      case 'forbidden': return { title: 'You do not have access', body: `Your role in this business does not include ${what.toLowerCase()}. Ask an owner or admin if you need it.` };
      case 'not_found': return { title: 'Not found', body: `${what} could not be found in this business. It may have been removed.` };
      case 'rate_limited': return { title: 'Too many requests', body: 'Please wait a moment and try again.' };
      case 'invalid_input': return { title: 'That request was not accepted', body: outcome.message };
      default: return { title: 'Something went wrong', body: `${what} could not be loaded. Nothing was changed.` };
    }
  })();
  return (
    <div role="alert" className="rounded-2xl border border-border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold tracking-tight">{copy.title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{copy.body}</p>
      {ended ? null : <button type="button" className={`${actionClass} mt-6`} onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Skeleton({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="h-14 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      ))}
    </div>
  );
}

export { actionClass, secondaryClass };
