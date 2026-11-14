import type { Customer } from '@business-os/contracts';
import { useEffect, useState } from 'react';
import type { CustomersClient } from '../api/customers';
import type { Outcome } from '../api/tenancy';
import { inputClass } from '../shell/frame';
import { useLoad } from './use-load';

// Picking a Customer Zone record from another Zone (Sales, Projects). Customers are only ever searched
// and chosen here, never created or copied: the other Zone stores the customer's id.

/** Search the Customer Zone's active customers and pick one; no customers are created here. */
export function CustomerPicker({ id, customers, slug, selectedId, selectedName, error, onPick, onSessionEnded }: {
  id: string; customers: CustomersClient; slug: string; selectedId: string; selectedName: string | null; error?: string; onPick: (c: Customer | null) => void;
  onSessionEnded: () => void;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useLoad(`pick-customer|${slug}|${q}`, (signal) => (q ? customers.list(slug, { q, status: 'active', limit: 8 }, signal) : Promise.resolve({ kind: 'ok' as const, data: { customers: [], nextCursor: null } })));
  if (selectedId) {
    return (
      <div className="sm:col-span-2">
        <p id={id} className="mb-1.5 text-sm font-medium">Customer</p>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-3" aria-labelledby={id}>
          <span className="text-sm font-medium">{selectedName ?? 'Selected customer'}</span>
          <button type="button" onClick={() => onPick(null)} className="rounded-md text-xs font-medium text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            Change customer
          </button>
        </div>
        {error ? <p className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
      </div>
    );
  }
  const list = results.state.status === 'done' && results.state.outcome.kind === 'ok' ? results.state.outcome.data.customers : [];
  const failure = results.state.status === 'done' && results.state.outcome.kind !== 'ok' ? results.state.outcome : null;
  return (
    <div className="sm:col-span-2">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">Customer</label>
      <input id={id} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search your customers by name, email or phone" className={inputClass}
        aria-describedby={`${id}-hint`} autoComplete="off" maxLength={100} />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">Optional. Customers come from the Customers Zone.</p>
      {q ? (
        <div aria-live="polite">
          {results.state.status === 'loading' ? <p className="mt-2 text-xs text-muted-foreground">Searching…</p> : failure ? (
            <SearchError outcome={failure} what="search customers" onRetry={results.reload} onSessionEnded={onSessionEnded} />
          ) : list.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No active customers match “{q}”.</p>
          ) : (
            <ul aria-label="Matching customers" className="mt-2 divide-y divide-border rounded-xl border border-border">
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => { setText(''); onPick(c); }} className="block w-full px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                    {c.displayName}{c.email ? <span className="ml-2 text-xs text-muted-foreground">{c.email}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A search or lookup that failed is never shown as "no results": say what went wrong and offer a retry.
 * An ended session is handed back to the app (as on every other Sales screen), never retried.
 */
export function SearchError({ outcome, what, onRetry, onSessionEnded }: { outcome: Outcome<unknown>; what: string; onRetry: () => void; onSessionEnded: () => void }) {
  const ended = outcome.kind === 'unauthenticated';
  useEffect(() => {
    if (ended) onSessionEnded();
  }, [ended, onSessionEnded]);
  const text = ended ? 'Your session has ended. Please sign in again.'
    : outcome.kind === 'unreachable'
    ? (typeof navigator !== 'undefined' && navigator.onLine === false ? `You're offline, so we couldn't ${what}.` : `Can't reach Business OS, so we couldn't ${what}.`)
    : outcome.kind === 'forbidden' ? `Your role does not allow you to ${what}.`
    : outcome.kind === 'rate_limited' ? `Too many requests; we couldn't ${what} just now.`
    : `Something went wrong, so we couldn't ${what}.`;
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span>{text}</span>
      {outcome.kind !== 'forbidden' && !ended ? (
        <button type="button" onClick={onRetry} className="rounded-md font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
      ) : null}
    </div>
  );
}
