import type { FinanceClient } from '../../api/finance';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { isPositive } from './decimal';
import { formatDate, formatMoney } from './format';
import { DocumentBadges, isOverdue, todayIn } from './shared';

const SHOWN = 5;

/**
 * A customer's finance at a glance, on the customer's page in the Customers Zone. Shown only to people
 * who hold finance:read (the Customers Zone already required customers:read to get here); the Finance
 * API checks finance:read again on every request. Per currency, never converted or added together.
 * Credit is shown as credit, never as cash.
 */
export function CustomerFinance({ client, slug, customerId, locale, timeZone, onOpen, onSessionEnded }: {
  client: FinanceClient; slug: string; customerId: string; locale?: string; timeZone: string;
  /** Opens a document in the Finance Zone (`invoice:<id>` or `quote:<id>`). */
  onOpen: (target: string) => void; onSessionEnded: () => void;
}) {
  const balances = useLoad(`cust-fin-bal|${slug}|${customerId}`, (signal) => client.balances(slug, { customerId, limit: 25 }, signal));
  const invoices = useLoad(`cust-fin-inv|${slug}|${customerId}`, (signal) => client.documents(slug, 'invoices', { status: 'all', customerId, limit: SHOWN }, signal));
  const quotes = useLoad(`cust-fin-q|${slug}|${customerId}`, (signal) => client.documents(slug, 'quotes', { status: 'all', customerId, limit: 3 }, signal));
  const today = todayIn(timeZone);
  const failed = [balances, invoices, quotes].find((x) => x.state.status === 'done' && x.state.outcome.kind !== 'ok');
  const loading = [balances, invoices, quotes].some((x) => x.state.status === 'loading');
  const bal = balances.state.status === 'done' && balances.state.outcome.kind === 'ok' ? balances.state.outcome.data.balances : [];
  const inv = invoices.state.status === 'done' && invoices.state.outcome.kind === 'ok' ? invoices.state.outcome.data : null;
  const qs = quotes.state.status === 'done' && quotes.state.outcome.kind === 'ok' ? quotes.state.outcome.data : null;
  const money = (v: string, c: string) => formatMoney(v, c, locale);

  return (
    <section aria-label="Finance" className="rounded-2xl border border-border bg-card p-6">
      <h2 className="mb-4 text-sm font-semibold tracking-tight">Finance</h2>
      {loading ? <Skeleton rows={2} label="Loading finance…" /> : failed && failed.state.status === 'done' ? (
        <Problem outcome={failed.state.outcome} what="Finance for this customer" onRetry={() => [balances, invoices, quotes].forEach((x) => x.reload())} onSessionEnded={onSessionEnded} />
      ) : (
        <div className="space-y-5">
          {bal.length === 0 ? <p className="text-sm text-muted-foreground">Nothing owed and no credit on account.</p> : (
            <dl className="space-y-3 text-sm">
              {bal.map((b) => (
                <div key={b.currencyCode} className="rounded-xl border p-3">
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Open on invoices ({b.currencyCode})</dt><dd className="font-semibold tabular-nums">{money(b.receivable, b.currencyCode)}</dd></div>
                  {isPositive(b.overdue) ? <div className="mt-1 flex justify-between gap-3 text-destructive"><dt>Overdue</dt><dd className="tabular-nums">{money(b.overdue, b.currencyCode)}</dd></div> : null}
                  {isPositive(b.creditAvailable) ? (
                    <div className="mt-1 flex justify-between gap-3"><dt className="text-muted-foreground">Credit not yet used</dt><dd className="tabular-nums">{money(b.creditAvailable, b.currencyCode)}</dd></div>
                  ) : null}
                </div>
              ))}
            </dl>
          )}
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Invoices</h3>
            {inv && inv.documents.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No invoices for this customer.</p> : null}
            {inv && inv.documents.length > 0 ? (
              <ul className="mt-1 divide-y">
                {inv.documents.map((d) => (
                  <li key={d.id} className="py-2">
                    <button type="button" onClick={() => onOpen(`invoice:${d.id}`)} className="w-full text-left focus-visible:outline-2 focus-visible:outline-ring">
                      <span className="flex items-start justify-between gap-2 text-sm"><span className="font-medium hover:underline">{d.number ?? 'Draft invoice'}</span><span className="tabular-nums">{money(d.total, d.currencyCode)}</span></span>
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <DocumentBadges status={d.status} settlement={d.settlementState} overdue={isOverdue(d, today)} />{d.dueDate ? `Due ${formatDate(d.dueDate, locale)}` : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {inv?.nextCursor ? <p className="mt-2 text-xs text-muted-foreground">Showing the {SHOWN} most recent. See the Finance Zone for the rest.</p> : null}
          </div>
          {qs && qs.documents.length > 0 ? (
            <div>
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Quotes</h3>
              <ul className="mt-1 divide-y">
                {qs.documents.map((d) => (
                  <li key={d.id} className="py-2">
                    <button type="button" onClick={() => onOpen(`quote:${d.id}`)} className="flex w-full items-start justify-between gap-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring">
                      <span className="flex flex-wrap items-center gap-2"><span className="font-medium hover:underline">{d.number ?? 'Draft quote'}</span><DocumentBadges status={d.status} /></span>
                      <span className="tabular-nums">{money(d.total, d.currencyCode)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
