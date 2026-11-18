import type { FinanceDocumentListItem } from '@business-os/contracts';
import { KIND_PATH, type DocumentPath, type FinanceClient } from '../../api/finance';
import type { Outcome } from '../../api/tenancy';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { formatMoney } from './format';
import { DocumentBadges, isOverdue, KIND_LABEL, todayIn } from './shared';

/** What the Sales Zone needs to reach Finance. Present only for a person holding both sales:read and finance:read. */
export interface SalesFinanceLinks {
  client: FinanceClient;
  /** Opens a quote or invoice in the Finance Zone. */
  onOpen: (path: DocumentPath, id: string) => void;
  /** Starts a quote in the Finance Zone, prefilled from this opportunity (needs finance:write as well). */
  onCreateQuote?: (opportunityId: string) => void;
}

const PAGE = 25;

async function loadDocuments(client: FinanceClient, slug: string, opportunityId: string, signal: AbortSignal): Promise<Outcome<{ rows: FinanceDocumentListItem[]; more: boolean }>> {
  const [quotes, invoices] = await Promise.all([
    client.documents(slug, 'quotes', { status: 'all', opportunityId, limit: PAGE }, signal),
    client.documents(slug, 'invoices', { status: 'all', opportunityId, limit: PAGE }, signal),
  ]);
  if (quotes.kind !== 'ok') return quotes;
  if (invoices.kind !== 'ok') return invoices;
  return { kind: 'ok', data: { rows: [...quotes.data.documents, ...invoices.data.documents], more: quotes.data.nextCursor !== null || invoices.data.nextCursor !== null } };
}

/**
 * The quotes and invoices linked to one opportunity (LC-2, docs/cross-zone-workflows-wf1.md §11.2). Read through the
 * Finance API, which checks finance:read and sales:read. The caller renders it only for a person holding both:
 * for everyone else the panel does not exist, so nothing here hints that Finance records exist. Each row shows its
 * own currency; nothing is added up across currencies, and a draft shows no number.
 */
export function OpportunityDocuments({ finance, slug, opportunityId, locale, timeZone, onSessionEnded }: {
  finance: SalesFinanceLinks; slug: string; opportunityId: string; locale?: string; timeZone: string; onSessionEnded: () => void;
}) {
  const today = todayIn(timeZone);
  const { state, reload } = useLoad(`opp-docs|${slug}|${opportunityId}`, (signal) => loadDocuments(finance.client, slug, opportunityId, signal));
  // A role that lost Finance access mid-session sees the panel disappear, not an error that names Finance.
  if (state.status === 'done' && state.outcome.kind === 'forbidden') return null;
  return (
    <section aria-label="Quotes and invoices" className="rounded-2xl border border-border bg-card p-6">
      <h2 className="mb-4 text-sm font-semibold tracking-tight">Quotes and invoices</h2>
      {state.status === 'loading' ? <Skeleton rows={2} label="Loading quotes and invoices…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Quotes and invoices" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'done' && state.outcome.kind === 'ok' ? (() => {
        const { rows, more } = state.outcome.data;
        if (rows.length === 0) return <p className="text-sm text-muted-foreground">No quotes or invoices are linked to this opportunity yet.</p>;
        const sorted = [...rows].sort((a, b) => a.kind.localeCompare(b.kind) || b.createdAt.localeCompare(a.createdAt));
        return (
          <>
            <ul className="divide-y divide-border">
              {sorted.map((d) => (
                <li key={d.id} className="py-2.5">
                  <button type="button" onClick={() => finance.onOpen(KIND_PATH[d.kind], d.id)} className="w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium hover:underline [overflow-wrap:anywhere]">{KIND_LABEL[d.kind]} {d.number ?? '(draft)'}</span>
                      <span className="shrink-0"><DocumentBadges status={d.status} settlement={d.settlementState} overdue={isOverdue(d, today)} /></span>
                    </span>
                    <span className="mt-1 block text-xs tabular-nums text-muted-foreground">{formatMoney(d.total, d.currencyCode, locale)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {more ? <p className="mt-3 text-xs text-muted-foreground">Showing the latest {PAGE} quotes and {PAGE} invoices. Open Finance to see the rest.</p> : null}
          </>
        );
      })() : null}
    </section>
  );
}
