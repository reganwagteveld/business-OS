import { useEffect, useState } from 'react';
import type { Outcome } from '../api/tenancy';
import { inputClass } from '../shell/frame';
import { SearchError } from './customer-picker';
import { useLoad } from './use-load';

// LC-2: pick a record from another Zone (an opportunity or a project) to link it. Records are only ever
// searched and chosen here, never created or copied: the form stores the id, and the server checks the rule.

/** One choosable record. `detail` is a short state such as "Won" or "Active", never colour only. */
export interface LinkOption {
  id: string; label: string; detail?: string;
  /** The customer this record belongs to, kept so a later customer change can tell whether the link still fits. */
  customerId?: string | null;
}

/**
 * A search box with the first matches already listed, then the chosen record as a chip with a Remove
 * control. `search` is called for every distinct (`searchKey`, text); a failed search is shown as a
 * failure, never as "nothing found". With `disabledReason` the box is inert and says why.
 */
export function LinkPicker({ id, label, noun, plural, hint, selected, searchKey, search, onPick, onSessionEnded, disabledReason, error }: {
  id: string;
  /** The field's name, e.g. "Project". */
  label: string;
  /** Lower-case singular, for messages: "project". */
  noun: string;
  /** Lower-case plural: "projects". */
  plural: string;
  hint?: string;
  /** `label: null` while the name is still being read. */
  selected: { id: string; label: string | null } | null;
  /** Everything the search depends on besides its text (business, customer): a change reloads it. */
  searchKey: string;
  search: (q: string, signal: AbortSignal) => Promise<Outcome<LinkOption[]>>;
  onPick: (option: LinkOption | null) => void;
  onSessionEnded: () => void;
  disabledReason?: string;
  error?: string;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useLoad(disabledReason || selected ? 'link-idle' : `link|${searchKey}|${q}`, (signal) => (disabledReason || selected ? Promise.resolve({ kind: 'ok' as const, data: [] }) : search(q, signal)));

  if (selected) {
    return (
      <div>
        <p id={id} className="mb-1.5 text-sm font-medium">{label}</p>
        <div role="group" aria-labelledby={id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-3">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{selected.label ?? `Loading ${noun}…`}</span>
          <button type="button" aria-label={`Remove ${noun}`} onClick={() => onPick(null)}
            className="rounded-md text-xs font-medium text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            Remove
          </button>
        </div>
        {error ? <p className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
      </div>
    );
  }
  const list = results.state.status === 'done' && results.state.outcome.kind === 'ok' ? results.state.outcome.data : [];
  const failure = results.state.status === 'done' && results.state.outcome.kind !== 'ok' ? results.state.outcome : null;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <input id={id} type="search" value={text} onChange={(e) => setText(e.target.value)} disabled={Boolean(disabledReason)} placeholder={`Search ${plural}`}
        aria-describedby={`${id}-hint`} autoComplete="off" maxLength={100} className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-60`} />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{disabledReason ?? hint ?? 'Optional.'}</p>
      {error ? <p className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
      {!disabledReason ? (
        <div aria-live="polite">
          {results.state.status === 'loading' ? <p className="mt-2 text-xs text-muted-foreground">Searching…</p> : failure ? (
            <SearchError outcome={failure} what={`search ${plural}`} onRetry={results.reload} onSessionEnded={onSessionEnded} />
          ) : list.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{q ? `No ${plural} match “${q}”.` : `No ${plural} to choose from.`}</p>
          ) : (
            <ul aria-label={`Matching ${plural}`} className="mt-2 divide-y divide-border rounded-xl border border-border">
              {list.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => { setText(''); onPick(o); }}
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                    {o.label}{o.detail ? <span className="ml-2 text-xs text-muted-foreground">{o.detail}</span> : null}
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
