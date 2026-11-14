import type { Customer } from '@business-os/contracts';
import { useEffect, useId, useState } from 'react';
import type { CustomersClient, RecordStatus } from '../../api/customers';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { useLayout } from '../use-layout';
import { locationOf } from './format';

export interface DirectoryQuery { q: string; status: RecordStatus }

const STATUSES: { value: RecordStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];
const PAGE_SIZE = 25;

export function KindBadge({ kind }: { kind: Customer['kind'] }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
      <span aria-hidden="true">{kind === 'COMPANY' ? '▣' : '◉'}</span>
      {kind === 'COMPANY' ? 'Company' : 'Individual'}
    </span>
  );
}

export function StatusBadge({ archived }: { archived: boolean }) {
  return (
    <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${archived ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-foreground'}`}>
      {archived ? 'Archived' : 'Active'}
    </span>
  );
}

/**
 * The customer directory: real records from the API, searched and filtered on the server, paged with
 * the server's cursors. The API orders by name (A–Z); other sort orders would need a new contract.
 */
export function Directory({ client, slug, locale, query, onQuery, canWrite, onOpen, onAdd, onSessionEnded }: {
  client: CustomersClient; slug: string; locale?: string; query: DirectoryQuery; onQuery: (q: DirectoryQuery) => void;
  canWrite: boolean; onOpen: (id: string) => void; onAdd: () => void; onSessionEnded: () => void;
}) {
  const searchId = useId();
  const [text, setText] = useState(query.q);
  const [pager, setPager] = useState<{ sig: string; stack: string[] }>({ sig: '', stack: [] });

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    if (text.trim() === query.q.trim()) return;
    const timer = setTimeout(() => onQuery({ ...query, q: text.trim() }), 300);
    return () => clearTimeout(timer);
  }, [text, query, onQuery]);

  const sig = `${query.q}|${query.status}`;
  const stack = pager.sig === sig ? pager.stack : [];
  const cursor = stack[stack.length - 1];
  const { state, reload } = useLoad(`${slug}|${sig}|${cursor ?? ''}`, (signal) => client.list(slug, { q: query.q, status: query.status, cursor, limit: PAGE_SIZE }, signal));

  const filtered = query.q !== '' || query.status !== 'active';
  const clear = () => {
    setText('');
    onQuery({ q: '', status: 'active' });
  };

  return (
    <section aria-labelledby="customers-title">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <h1 id="customers-title" className="text-3xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-muted-foreground">Companies and people you do business with.</p>
        </div>
        {canWrite ? <button type="button" className={actionClass} onClick={onAdd}>Add customer</button> : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-60">
          <label htmlFor={searchId} className="sr-only">Search customers by name, email or phone</label>
          <input id={searchId} type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} placeholder="Search by name, email or phone" className={inputClass} />
        </div>
        <div role="group" aria-label="Show customers" className="inline-flex rounded-xl border border-border p-1">
          {STATUSES.map((s) => (
            <button key={s.value} type="button" aria-pressed={query.status === s.value} onClick={() => onQuery({ ...query, status: s.value })}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${query.status === s.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {state.status === 'loading' ? <Skeleton label="Loading customers…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Customers" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'done' && state.outcome.kind === 'ok' ? (
        <Results
          customers={state.outcome.data.customers} nextCursor={state.outcome.data.nextCursor} locale={locale} onOpen={onOpen}
          page={stack.length + 1} onPrev={() => setPager({ sig, stack: stack.slice(0, -1) })}
          onNext={(next) => setPager({ sig, stack: [...stack, next] })}
          empty={<EmptyState query={query} filtered={filtered} canWrite={canWrite} onAdd={onAdd} onClear={clear} />}
        />
      ) : null}
    </section>
  );
}

function Results({ customers, nextCursor, locale, onOpen, page, onPrev, onNext, empty }: {
  customers: Customer[]; nextCursor: string | null; locale?: string; onOpen: (id: string) => void; page: number;
  onPrev: () => void; onNext: (cursor: string) => void; empty: React.ReactNode;
}) {
  const layout = useLayout();
  if (customers.length === 0 && page === 1) return <>{empty}</>;
  return (
    <>
      {layout === 'narrow'
        ? <CompactList customers={customers} locale={locale} onOpen={onOpen} />
        : <CustomerTable customers={customers} locale={locale} onOpen={onOpen} layout={layout} />}
      <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span aria-live="polite">Page {page} · sorted by name</span>
        <span className="flex gap-2">
          <button type="button" className={secondaryClass} onClick={onPrev} disabled={page === 1}>Previous</button>
          <button type="button" className={secondaryClass} onClick={() => nextCursor && onNext(nextCursor)} disabled={!nextCursor}>Next</button>
        </span>
      </nav>
    </>
  );
}

const WRAP = '[overflow-wrap:anywhere]';

/**
 * Wide: every column. Medium: the name leads, and type and location move under it so the table fits
 * without sideways scrolling. Either way the same facts are on screen.
 */
function CustomerTable({ customers, locale, onOpen, layout }: { customers: Customer[]; locale?: string; onOpen: (id: string) => void; layout: 'wide' | 'medium' }) {
  const wide = layout === 'wide';
  return (
    <div className="rounded-2xl border border-border bg-card">
      <table className="w-full table-fixed text-left text-sm">
        <caption className="sr-only">Customers, sorted by name A to Z</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className={`px-5 py-3 font-medium ${wide ? 'w-[22%]' : 'w-[36%]'}`}>{wide ? 'Name' : 'Customer'} <span aria-hidden="true" title="Sorted by name, A to Z">↑</span></th>
            {wide ? <th scope="col" className="w-[11%] px-5 py-3 font-medium">Type</th> : null}
            <th scope="col" className="px-5 py-3 font-medium">Email</th>
            <th scope="col" className={`px-5 py-3 font-medium ${wide ? 'w-[15%]' : 'w-[22%]'}`}>Phone</th>
            {wide ? <th scope="col" className="w-[16%] px-5 py-3 font-medium">Location</th> : null}
            <th scope="col" className="w-24 px-5 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {customers.map((c) => (
            <tr key={c.id} className="hover:bg-muted/50">
              <th scope="row" className={`px-5 py-3 align-top font-medium ${WRAP}`}>
                <button type="button" onClick={() => onOpen(c.id)} className="rounded-md text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {c.displayName}
                </button>
                {wide ? null : (
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground">
                    <KindBadge kind={c.kind} />
                    {locationOf(c, locale) ? <span>{locationOf(c, locale)}</span> : null}
                  </span>
                )}
              </th>
              {wide ? <td className="px-5 py-3 align-top"><KindBadge kind={c.kind} /></td> : null}
              <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{c.email ?? '—'}</td>
              <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{c.phone ?? '—'}</td>
              {wide ? <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{locationOf(c, locale) || '—'}</td> : null}
              <td className="px-5 py-3 align-top"><StatusBadge archived={c.archivedAt !== null} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Genuinely narrow windows: one compact record per customer, name first, everything else beneath it. */
function CompactList({ customers, locale, onOpen }: { customers: Customer[]; locale?: string; onOpen: (id: string) => void }) {
  return (
    <ul aria-label="Customers, sorted by name A to Z" className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
      {customers.map((c) => {
        const place = locationOf(c, locale);
        return (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen(c.id)} className={`block w-full px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${WRAP}`}>
              <span className="flex items-start justify-between gap-3">
                <span className="text-sm font-semibold">{c.displayName}</span>
                {c.archivedAt !== null ? <StatusBadge archived /> : null}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{c.kind === 'COMPANY' ? 'Company' : 'Individual'}{place ? ` · ${place}` : ''}</span>
              {c.email ? <span className="mt-1 block text-xs text-muted-foreground">{c.email}</span> : null}
              {c.phone ? <span className="block text-xs text-muted-foreground">{c.phone}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ query, filtered, canWrite, onAdd, onClear }: { query: DirectoryQuery; filtered: boolean; canWrite: boolean; onAdd: () => void; onClear: () => void }) {
  const searching = query.q !== '';
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
      <h2 className="text-lg font-semibold tracking-tight">
        {searching ? `No customers match “${query.q}”` : query.status === 'archived' ? 'No archived customers' : filtered ? 'No customers here' : 'No customers yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {searching ? 'Try a different name, email or phone number.' : query.status === 'archived' ? 'Customers you archive are kept here and can be restored.' : canWrite ? 'Add your first customer to start building your customer list.' : 'Customers added by your team will appear here.'}
      </p>
      <div className="mt-6 flex justify-center gap-3">
        {filtered ? <button type="button" className={secondaryClass} onClick={onClear}>Clear search and filters</button> : null}
        {!filtered && canWrite ? <button type="button" className={actionClass} onClick={onAdd}>Add customer</button> : null}
      </div>
    </div>
  );
}
