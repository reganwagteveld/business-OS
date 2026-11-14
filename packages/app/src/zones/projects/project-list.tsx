import type { Project, ProjectStatus } from '@business-os/contracts';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { Member } from '../../api/customers';
import type { ProjectsClient } from '../../api/projects';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLayout } from '../use-layout';
import { useLoad } from '../use-load';
import { PriorityLabel, Progress, ProjectStatusBadge } from './badges';
import { formatDate, memberName, PROJECT_STATUSES } from './format';

export interface ListQuery { q: string; status: ProjectStatus | 'all'; archived: 'active' | 'archived' | 'all'; sort: 'newest' | 'name' | 'due' }
export const DEFAULT_QUERY: ListQuery = { q: '', status: 'all', archived: 'active', sort: 'newest' };
const PAGE_SIZE = 25;
const WRAP = '[overflow-wrap:anywhere]';

/** The customer as the viewer may see it: its current name, a neutral label without Customer access, or nothing. */
export function customerLabel(p: Project): string | null {
  if (!p.customerId) return null;
  if (!p.customer) return 'Linked customer';
  return p.customer.archived ? `${p.customer.displayName} (archived)` : p.customer.displayName;
}

/**
 * Projects from the API: searched, filtered and sorted on the server, paged with its cursors. Counts
 * by status come from the server's summary of real, active projects, so nothing here is a placeholder.
 */
export function ProjectList({ client, slug, locale, members, query, onQuery, canCreate, onOpen, onAdd, onSessionEnded }: {
  client: ProjectsClient; slug: string; locale?: string; members: Member[] | null; query: ListQuery; onQuery: (q: ListQuery) => void;
  canCreate: boolean; onOpen: (id: string) => void; onAdd: () => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [text, setText] = useState(query.q);
  const [pager, setPager] = useState<{ sig: string; stack: string[] }>({ sig: '', stack: [] });
  useEffect(() => {
    if (text.trim() === query.q.trim()) return;
    const timer = setTimeout(() => onQuery({ ...query, q: text.trim() }), 300);
    return () => clearTimeout(timer);
  }, [text, query, onQuery]);

  const sig = JSON.stringify(query);
  const stack = pager.sig === sig ? pager.stack : [];
  const cursor = stack[stack.length - 1];
  const { state, reload } = useLoad(`projects|${slug}|${sig}|${cursor ?? ''}`, (signal) =>
    client.list(slug, { q: query.q, status: query.status, archived: query.archived, sort: query.sort, cursor, limit: PAGE_SIZE }, signal));
  const summary = useLoad(`project-summary|${slug}`, (signal) => client.summary(slug, signal));
  const rows = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data.projects : null;
  const counts = summary.state.status === 'done' && summary.state.outcome.kind === 'ok' ? summary.state.outcome.data : null;

  const filtered = query.q !== '' || query.status !== 'all' || query.archived !== 'active';
  const clear = () => {
    setText('');
    onQuery({ ...DEFAULT_QUERY, sort: query.sort });
  };
  const statusFilters: { value: ListQuery['status']; label: string }[] = [{ value: 'all', label: 'All' }, ...PROJECT_STATUSES];

  return (
    <section aria-labelledby={`${uid}-title`}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <h1 id={`${uid}-title`} className="text-3xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">Organise and track work, for a customer or for your own business.</p>
        </div>
        {canCreate ? <button type="button" className={actionClass} onClick={onAdd}>New project</button> : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <label htmlFor={`${uid}-q`} className="sr-only">Search projects by name</label>
          <input id={`${uid}-q`} type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} placeholder="Search by project name" className={inputClass} />
        </div>
        <Select id={`${uid}-sort`} label="Sort" value={query.sort} onChange={(v) => onQuery({ ...query, sort: v as ListQuery['sort'] })}>
          <option value="newest">Newest first</option>
          <option value="name">Name (A to Z)</option>
          <option value="due">Due date (soonest first)</option>
        </Select>
        <Select id={`${uid}-archived`} label="Records" value={query.archived} onChange={(v) => onQuery({ ...query, archived: v as ListQuery['archived'] })}>
          <option value="active">Not archived</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </Select>
      </div>
      <div role="group" aria-label="Filter by status" className="mb-5 flex flex-wrap gap-2">
        {statusFilters.map((s) => {
          const n = counts && query.archived === 'active' ? (s.value === 'all' ? counts.active : counts.byStatus[s.value]) : null;
          return (
            <button key={s.value} type="button" aria-pressed={query.status === s.value} onClick={() => onQuery({ ...query, status: s.value })}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${query.status === s.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}>
              {s.label}{n !== null ? <span className="ml-1.5 tabular-nums opacity-80">{n}</span> : null}
            </button>
          );
        })}
      </div>

      {state.status === 'loading' ? <Skeleton label="Loading projects…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Projects" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {rows ? (
        rows.length === 0 && stack.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
            <h2 className="text-lg font-semibold tracking-tight">{filtered ? 'No projects match' : 'No projects yet'}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              {filtered ? 'Try another search or filter.'
                : canCreate ? 'Create a project for customer work, or for something internal such as an office move or onboarding a new hire.'
                : 'Projects your team creates will appear here.'}
            </p>
            <div className="mt-6 flex justify-center gap-3">
              {filtered ? <button type="button" className={secondaryClass} onClick={clear}>Clear search and filters</button> : null}
              {!filtered && canCreate ? <button type="button" className={actionClass} onClick={onAdd}>New project</button> : null}
            </div>
          </div>
        ) : (
          <>
            <Rows rows={rows} members={members} locale={locale} onOpen={onOpen} />
            <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span aria-live="polite">Page {stack.length + 1}</span>
              <span className="flex gap-2">
                <button type="button" className={secondaryClass} onClick={() => setPager({ sig, stack: stack.slice(0, -1) })} disabled={stack.length === 0}>Previous</button>
                <button type="button" className={secondaryClass} disabled={!(state.status === 'done' && state.outcome.kind === 'ok' && state.outcome.data.nextCursor)}
                  onClick={() => state.status === 'done' && state.outcome.kind === 'ok' && state.outcome.data.nextCursor && setPager({ sig, stack: [...stack, state.outcome.data.nextCursor] })}>Next</button>
              </span>
            </nav>
          </>
        )
      ) : null}
    </section>
  );
}

function Select({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <div className="min-w-40">
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>{children}</select>
    </div>
  );
}

function Rows({ rows, members, locale, onOpen }: { rows: Project[]; members: Member[] | null; locale?: string; onOpen: (id: string) => void }) {
  const layout = useLayout();
  if (layout === 'narrow') {
    return (
      <ul aria-label="Projects" className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {rows.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onOpen(p.id)} className={`block w-full px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${WRAP}`}>
              <span className="flex items-start justify-between gap-3">
                <span className="text-sm font-semibold">{p.name}</span>
                <ProjectStatusBadge status={p.status} archived={p.archivedAt !== null} />
              </span>
              {customerLabel(p) ? <span className="mt-1 block text-xs text-muted-foreground">{customerLabel(p)}</span> : null}
              <span className="mt-1 block text-xs text-muted-foreground">
                {memberName(members, p.ownerUserId) ?? 'No owner'}{p.dueDate ? ` · due ${formatDate(p.dueDate, locale)}` : ''}
              </span>
              <span className="mt-2 flex items-center justify-between gap-3"><Progress counts={p.taskCounts} compact /><PriorityLabel priority={p.priority} /></span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  const wide = layout === 'wide';
  return (
    <div className="rounded-2xl border border-border bg-card">
      <table className="w-full table-fixed text-left text-sm">
        <caption className="sr-only">Projects</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className={`px-5 py-3 font-medium ${wide ? 'w-[26%]' : 'w-[40%]'}`}>Project</th>
            {wide ? <th scope="col" className="w-[17%] px-5 py-3 font-medium">Customer</th> : null}
            {wide ? <th scope="col" className="w-[13%] px-5 py-3 font-medium">Owner</th> : null}
            <th scope="col" className="px-5 py-3 font-medium">Progress</th>
            {wide ? <th scope="col" className="w-[11%] px-5 py-3 font-medium">Due</th> : null}
            <th scope="col" className="w-24 px-5 py-3 font-medium">Priority</th>
            <th scope="col" className="w-32 px-5 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((p) => (
            <tr key={p.id} className="hover:bg-muted/50">
              <th scope="row" className={`px-5 py-3 align-top font-medium ${WRAP}`}>
                <button type="button" onClick={() => onOpen(p.id)} className="rounded-md text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{p.name}</button>
                {!wide ? (
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    {[customerLabel(p), memberName(members, p.ownerUserId) ?? 'No owner', p.dueDate ? `due ${formatDate(p.dueDate, locale)}` : null].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </th>
              {wide ? <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{customerLabel(p) ?? '—'}</td> : null}
              {wide ? <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{memberName(members, p.ownerUserId) ?? '—'}</td> : null}
              <td className="px-5 py-3 align-top"><Progress counts={p.taskCounts} /></td>
              {wide ? <td className="whitespace-nowrap px-5 py-3 align-top text-muted-foreground">{formatDate(p.dueDate, locale)}</td> : null}
              <td className="px-5 py-3 align-top"><PriorityLabel priority={p.priority} /></td>
              <td className="px-5 py-3 align-top"><ProjectStatusBadge status={p.status} archived={p.archivedAt !== null} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
