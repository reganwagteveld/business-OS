import type { Opportunity, OpportunityStatus } from '@business-os/contracts';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { SalesClient } from '../../api/sales';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLayout } from '../use-layout';
import { useLoad } from '../use-load';
import { formatDate, formatMoney, STATUS_LABEL } from './format';
import type { Names, SalesRef } from './types';

export interface ListQuery { q: string; status: 'open' | 'won' | 'lost' | 'all'; archived: 'active' | 'archived' | 'all'; pipelineId: string; stageId: string }
const STATUSES: { value: ListQuery['status']; label: string }[] = [
  { value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }, { value: 'all', label: 'All' },
];
const PAGE_SIZE = 25;
const WRAP = '[overflow-wrap:anywhere]';

export function OutcomeBadge({ status, archived }: { status: OpportunityStatus; archived?: boolean }) {
  const tone = status === 'WON' ? 'bg-primary text-primary-foreground' : status === 'LOST' ? 'bg-muted text-muted-foreground line-through decoration-1' : 'bg-primary/10 text-foreground';
  return (
    <span className="inline-flex flex-wrap gap-1">
      <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${tone}`}>{STATUS_LABEL[status]}</span>
      {archived ? <span className="inline-flex rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Archived</span> : null}
    </span>
  );
}

/** "Proposal", or "Renewals · Proposal" when the business has more than one pipeline. */
export function stageLabel(refData: SalesRef, pipelineId: string, stageId: string): string {
  const entry = refData.pipelines.find((p) => p.pipeline.id === pipelineId);
  const stage = entry?.stages.find((s) => s.id === stageId)?.name ?? 'Archived stage';
  return refData.pipelines.length > 1 && entry ? `${entry.pipeline.name} · ${stage}` : stage;
}
export const ownerName = (refData: SalesRef, id: string | null) => (id ? refData.members.find((m) => m.userId === id)?.name ?? 'Team member' : null);

/**
 * Opportunities from the API: searched and filtered on the server, newest first, paged with the
 * server's cursors. Linked customers and contacts are the Customer Zone's own records, named by id.
 */
export function OpportunityList({ sales, slug, locale, refData, names, query, onQuery, canWrite, onOpen, onAdd, onSetUp, onSessionEnded, viewToggle }: {
  sales: SalesClient; slug: string; locale?: string; refData: SalesRef; names: Names; query: ListQuery; onQuery: (q: ListQuery) => void;
  canWrite: boolean; onOpen: (id: string) => void; onAdd: () => void; onSetUp: () => void; onSessionEnded: () => void;
  viewToggle?: ReactNode;
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
  const setUp = refData.pipelines.length > 0;
  const { state, reload } = useLoad(`opps|${slug}|${sig}|${cursor ?? ''}`, (signal) =>
    sales.list(slug, { q: query.q, status: query.status, archived: query.archived, pipelineId: query.pipelineId || undefined, stageId: query.stageId || undefined, cursor, limit: PAGE_SIZE }, signal));
  const rows = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data.opportunities : null;
  const { want } = names;
  useEffect(() => {
    if (rows) want({ customers: rows.map((r) => r.customerId), contacts: rows.map((r) => r.contactId) });
  }, [rows, want]);

  const filtered = query.q !== '' || query.status !== 'open' || query.archived !== 'active' || query.pipelineId !== '' || query.stageId !== '';
  const clear = () => {
    setText('');
    onQuery({ q: '', status: 'open', archived: 'active', pipelineId: '', stageId: '' });
  };
  const stagesOf = refData.pipelines.find((p) => p.pipeline.id === query.pipelineId)?.stages ?? [];

  return (
    <section aria-labelledby={`${uid}-title`}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <h1 id={`${uid}-title`} className="text-3xl font-semibold tracking-tight">Sales</h1>
          <p className="mt-1 text-sm text-muted-foreground">Opportunities with your customers, from first contact to won or lost.</p>
        </div>
        <div className="flex items-center gap-3">
          {viewToggle}
          {canWrite ? <button type="button" className={actionClass} onClick={onAdd}>Add opportunity</button> : null}
        </div>
      </div>

      {!setUp ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
          <h2 className="text-lg font-semibold tracking-tight">Sales isn't set up yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {canWrite
              ? 'Setting up creates a sales pipeline with four stages: New, Qualified, Proposal and Negotiation. You can add opportunities straight away.'
              : 'Someone in your team who can edit sales needs to set it up first.'}
          </p>
          {canWrite ? <button type="button" className={`${actionClass} mt-6`} onClick={onSetUp}>Set up Sales</button> : null}
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60">
              <label htmlFor={`${uid}-q`} className="sr-only">Search opportunities by title</label>
              <input id={`${uid}-q`} type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} placeholder="Search by title" className={inputClass} />
            </div>
            <div role="group" aria-label="Show opportunities" className="inline-flex rounded-xl border border-border p-1">
              {STATUSES.map((s) => (
                <button key={s.value} type="button" aria-pressed={query.status === s.value} onClick={() => onQuery({ ...query, status: s.value })}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${query.status === s.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-4 flex flex-wrap gap-3">
            {refData.pipelines.length > 1 ? (
              <Select id={`${uid}-pipeline`} label="Pipeline" value={query.pipelineId} onChange={(v) => onQuery({ ...query, pipelineId: v, stageId: '' })}>
                <option value="">All pipelines</option>
                {refData.pipelines.map((p) => <option key={p.pipeline.id} value={p.pipeline.id}>{p.pipeline.name}</option>)}
              </Select>
            ) : null}
            <Select id={`${uid}-stage`} label="Stage" value={query.stageId}
              onChange={(v) => onQuery({ ...query, stageId: v, pipelineId: query.pipelineId || refData.pipelines[0]!.pipeline.id })}>
              <option value="">All stages</option>
              {(query.pipelineId ? stagesOf : refData.pipelines.length === 1 ? refData.pipelines[0]!.stages : []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select id={`${uid}-archived`} label="Records" value={query.archived} onChange={(v) => onQuery({ ...query, archived: v as ListQuery['archived'] })}>
              <option value="active">Not archived</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </Select>
          </div>

          {state.status === 'loading' ? <Skeleton label="Loading opportunities…" /> : null}
          {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Opportunities" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
          {rows ? (
            rows.length === 0 && stack.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
                <h2 className="text-lg font-semibold tracking-tight">{filtered ? 'No opportunities match' : 'No open opportunities yet'}</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                  {filtered ? 'Try another search or filter.' : canWrite ? 'Add an opportunity when a customer shows interest in buying.' : 'Opportunities your team adds will appear here.'}
                </p>
                <div className="mt-6 flex justify-center gap-3">
                  {filtered ? <button type="button" className={secondaryClass} onClick={clear}>Clear search and filters</button> : null}
                  {!filtered && canWrite ? <button type="button" className={actionClass} onClick={onAdd}>Add opportunity</button> : null}
                </div>
              </div>
            ) : (
              <>
                <Rows rows={rows} refData={refData} names={names} locale={locale} onOpen={onOpen} />
                <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span aria-live="polite">Page {stack.length + 1} · newest first</span>
                  <span className="flex gap-2">
                    <button type="button" className={secondaryClass} onClick={() => setPager({ sig, stack: stack.slice(0, -1) })} disabled={stack.length === 0}>Previous</button>
                    <button type="button" className={secondaryClass} disabled={!(state.status === 'done' && state.outcome.kind === 'ok' && state.outcome.data.nextCursor)}
                      onClick={() => state.status === 'done' && state.outcome.kind === 'ok' && state.outcome.data.nextCursor && setPager({ sig, stack: [...stack, state.outcome.data.nextCursor] })}>Next</button>
                  </span>
                </nav>
              </>
            )
          ) : null}
        </>
      )}
    </section>
  );
}

function Select({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <div className="min-w-40">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>{children}</select>
    </div>
  );
}

function Rows({ rows, refData, names, locale, onOpen }: { rows: Opportunity[]; refData: SalesRef; names: Names; locale?: string; onOpen: (id: string) => void }) {
  const layout = useLayout();
  const who = (o: Opportunity) => [names.customer(o.customerId), names.contact(o.contactId)].filter(Boolean).join(' · ');
  if (layout === 'narrow') {
    return (
      <ul aria-label="Opportunities, newest first" className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {rows.map((o) => (
          <li key={o.id}>
            <button type="button" onClick={() => onOpen(o.id)} className={`block w-full px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${WRAP}`}>
              <span className="flex items-start justify-between gap-3">
                <span className="text-sm font-semibold">{o.title}</span>
                <OutcomeBadge status={o.status} archived={o.archivedAt !== null} />
              </span>
              {who(o) ? <span className="mt-1 block text-xs text-muted-foreground">{who(o)}</span> : null}
              <span className="mt-1 block text-xs text-muted-foreground">{stageLabel(refData, o.pipelineId, o.stageId)} · {formatMoney(o.amount, o.currencyCode, locale)}</span>
              <span className="block text-xs text-muted-foreground">
                {ownerName(refData, o.ownerUserId) ?? 'No owner'}{o.expectedCloseDate ? ` · closes ${formatDate(o.expectedCloseDate, locale)}` : ''}
              </span>
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
        <caption className="sr-only">Opportunities, newest first</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className={`px-5 py-3 font-medium ${wide ? 'w-[24%]' : 'w-[40%]'}`}>Opportunity</th>
            {wide ? <th scope="col" className="w-[18%] px-5 py-3 font-medium">Customer</th> : null}
            <th scope="col" className="px-5 py-3 font-medium">Stage</th>
            <th scope="col" className="w-[14%] px-5 py-3 text-right font-medium">Amount</th>
            {wide ? <th scope="col" className="w-[12%] px-5 py-3 font-medium">Owner</th> : null}
            {wide ? <th scope="col" className="w-[11%] px-5 py-3 font-medium">Close date</th> : null}
            <th scope="col" className="w-28 px-5 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((o) => (
            <tr key={o.id} className="hover:bg-muted/50">
              <th scope="row" className={`px-5 py-3 align-top font-medium ${WRAP}`}>
                <button type="button" onClick={() => onOpen(o.id)} className="rounded-md text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{o.title}</button>
                {!wide && who(o) ? <span className="mt-1 block text-xs font-normal text-muted-foreground">{who(o)}</span> : null}
                {!wide ? (
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    {ownerName(refData, o.ownerUserId) ?? 'No owner'}{o.expectedCloseDate ? ` · closes ${formatDate(o.expectedCloseDate, locale)}` : ''}
                  </span>
                ) : null}
                {wide && names.contact(o.contactId) ? <span className="mt-1 block text-xs font-normal text-muted-foreground">{names.contact(o.contactId)}</span> : null}
              </th>
              {wide ? <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{names.customer(o.customerId) ?? (o.customerId ? '…' : '—')}</td> : null}
              <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{stageLabel(refData, o.pipelineId, o.stageId)}</td>
              <td className="whitespace-nowrap px-5 py-3 text-right align-top tabular-nums">{formatMoney(o.amount, o.currencyCode, locale)}</td>
              {wide ? <td className={`px-5 py-3 align-top text-muted-foreground ${WRAP}`}>{ownerName(refData, o.ownerUserId) ?? '—'}</td> : null}
              {wide ? <td className="whitespace-nowrap px-5 py-3 align-top text-muted-foreground">{formatDate(o.expectedCloseDate, locale)}</td> : null}
              <td className="px-5 py-3 align-top"><OutcomeBadge status={o.status} archived={o.archivedAt !== null} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
