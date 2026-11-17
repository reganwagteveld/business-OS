import type { Opportunity } from '@business-os/contracts';
import type { SalesClient } from '../../api/sales';
import type { Outcome } from '../../api/tenancy';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { formatDate, formatMoney, STATUS_LABEL } from './format';

const SHOWN = 10;
const PAGE = 50;
/** At most this many pages are read for the headline figures (500 deals); beyond that the figures say they are partial. */
const MAX_PAGES = 10;

/** Follows the server's cursors so the open count and value cover every deal, up to a cap. */
async function loadAll(client: SalesClient, slug: string, customerId: string, signal: AbortSignal): Promise<Outcome<{ opportunities: Opportunity[]; partial: boolean }>> {
  const all: Opportunity[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const out = await client.list(slug, { status: 'all', archived: 'active', customerId, cursor, limit: PAGE }, signal);
    if (out.kind !== 'ok') return out;
    all.push(...out.data.opportunities);
    if (!out.data.nextCursor) return { kind: 'ok', data: { opportunities: all, partial: false } };
    cursor = out.data.nextCursor;
  }
  return { kind: 'ok', data: { opportunities: all, partial: true } };
}

/**
 * A customer's sales opportunities, on the customer's page. Read from the Sales API (which checks
 * Sales read access); nothing about the deals is stored on the customer. Open deals come first, with
 * their combined value per currency; won and lost deals follow.
 */
export function CustomerOpportunities({ client, slug, customerId, locale, onOpen, onViewAll, onSessionEnded }: {
  client: SalesClient; slug: string; customerId: string; locale?: string; onOpen: (opportunityId: string) => void; onViewAll?: () => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`customer-opportunities|${slug}|${customerId}`, (signal) =>
    loadAll(client, slug, customerId, signal));
  return (
    <section aria-label="Opportunities" className="rounded-2xl border border-border bg-card p-6">
      <h2 className="mb-4 text-sm font-semibold tracking-tight">Opportunities</h2>
      {state.status === 'loading' ? <Skeleton rows={2} label="Loading opportunities…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Opportunities" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'done' && state.outcome.kind === 'ok' ? (() => {
        const { opportunities, partial } = state.outcome.data;
        if (opportunities.length === 0) return <p className="text-sm text-muted-foreground">No opportunities for this customer.</p>;
        const rank = { OPEN: 0, WON: 1, LOST: 2 } as const;
        const sorted = [...opportunities].sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt.localeCompare(a.updatedAt));
        const open = opportunities.filter((o) => o.status === 'OPEN');
        const totals = new Map<string, number>();
        for (const o of open) if (o.amount) totals.set(o.currencyCode, (totals.get(o.currencyCode) ?? 0) + Number(o.amount));
        return (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              {partial ? `Of the first ${opportunities.length} deals: ` : ''}{open.length} open{totals.size ? ` · ${[...totals].map(([code, sum]) => formatMoney(sum.toFixed(4), code, locale)).join(', ')}` : ''}
            </p>
            <ul className="divide-y divide-border">
              {sorted.slice(0, SHOWN).map((o) => (
                <li key={o.id} className="py-2.5">
                  <button type="button" onClick={() => onOpen(o.id)} className="w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium hover:underline [overflow-wrap:anywhere]">{o.title}</span>
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs">{STATUS_LABEL[o.status]}</span>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {o.amount ? formatMoney(o.amount, o.currencyCode, locale) : 'No amount'}
                      {o.expectedCloseDate && o.status === 'OPEN' ? ` · closes ${formatDate(o.expectedCloseDate, locale)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {sorted.length > SHOWN ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing {SHOWN} of {sorted.length}{partial ? '+' : ''}.{onViewAll ? <> <button type="button" className="underline" onClick={onViewAll}>Open Sales</button> to see the rest.</> : ' See the Sales Zone for the rest.'}
              </p>
            ) : null}
          </>
        );
      })() : null}
    </section>
  );
}
