import { Button, Card, CardContent, CardHeader, CardTitle, StatCard } from '@business-os/ui';
import type { ReactNode } from 'react';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { isPositive } from './decimal';
import { openAmount, useCustomerLabel } from './document-list';
import { useFinance, useRequestNames } from './env';
import { formatDate, formatMoney, METHOD_LABEL } from './format';
import { DocumentBadges, isOverdue, KIND_LABEL, LoadingRows, okData } from './shared';

/**
 * The Finance overview: what is open, what is overdue and what needs attention, from the server's own
 * per-currency figures (nothing is ever added across currencies, nothing is estimated). Outstanding is
 * what issued invoices still have open; it is not cash, and nothing here is profit.
 */
export function FinanceOverview() {
  const env = useFinance();
  const { client, slug, locale, today, can } = env;
  const receivables = useLoad(`ov-receivables|${slug}`, (signal) => client.receivables(slug, signal));
  const payables = useLoad(`ov-payables|${slug}`, (signal) => client.payables(slug, signal));
  const overdue = useLoad(`ov-overdue|${slug}`, (signal) => client.documents(slug, 'invoices', { status: 'all', overdue: true, limit: 5 }, signal));
  const drafts = useLoad(`ov-drafts|${slug}`, (signal) => client.documents(slug, 'invoices', { status: 'draft', limit: 5 }, signal));
  const overdueBills = useLoad(`ov-overdue-bills|${slug}`, (signal) => client.expenses(slug, { status: 'recorded', payment: 'overdue', limit: 5 }, signal));
  const unallocated = useLoad(`ov-unallocated|${slug}`, (signal) => client.payments(slug, { status: 'recorded', unallocated: true, limit: 5 }, signal));
  const recentInvoices = useLoad(`ov-recent-inv|${slug}`, (signal) => client.documents(slug, 'invoices', { status: 'all', limit: 5 }, signal));
  const recentQuotes = useLoad(`ov-recent-q|${slug}`, (signal) => client.documents(slug, 'quotes', { status: 'all', limit: 5 }, signal));
  const recentPayments = useLoad(`ov-recent-pay|${slug}`, (signal) => client.payments(slug, { status: 'all', limit: 5 }, signal));
  const label = useCustomerLabel();
  const docs = [okData(overdue.state), okData(drafts.state), okData(recentInvoices.state), okData(recentQuotes.state)].flatMap((p) => p?.documents ?? []);
  const pays = [okData(unallocated.state), okData(recentPayments.state)].flatMap((p) => p?.payments ?? []);
  useRequestNames([...docs.filter((d) => !d.billToSnapshot).map((d) => d.customerId), ...pays.map((p) => p.customerId)]);
  const money = (v: string, c: string) => formatMoney(v, c, locale);

  const quick = (
    <>
      {can.expenses ? <Button variant="outline" onClick={() => env.go({ name: 'expense-new' })}>New expense</Button> : null}
      {can.payments ? <Button variant="outline" onClick={() => env.go({ name: 'payment-new' })}>Record payment</Button> : null}
      {can.write ? <Button variant="outline" onClick={() => env.go({ name: 'document-new', path: 'quotes' })}>New quote</Button> : null}
      {can.write ? <Button onClick={() => env.go({ name: 'document-new', path: 'invoices' })}>New invoice</Button> : null}
    </>
  );
  const rec = okData(receivables.state);
  const pay = okData(payables.state);
  const attention = [
    ...(okData(overdue.state)?.documents ?? []).map((d) => ({
      key: `o${d.id}`, tone: 'danger' as const, text: `${d.number} for ${label(d)} is overdue (due ${formatDate(d.dueDate, locale)})`,
      amount: `${money(openAmount(d) ?? d.total, d.currencyCode)} open`, open: () => env.go({ name: 'document', path: 'invoices', id: d.id }),
    })),
    ...(okData(overdueBills.state)?.expenses ?? []).map((e) => ({
      key: `e${e.id}`, tone: 'warning' as const, text: `${e.supplierName ?? e.description} is past due (due ${formatDate(e.dueDate, locale)})`,
      amount: money(e.outstanding, e.currencyCode), open: () => env.go({ name: 'expense', id: e.id }),
    })),
    ...(okData(unallocated.state)?.payments ?? []).map((p) => ({
      key: `u${p.id}`, tone: 'info' as const, text: `A payment from ${env.names.get(p.customerId) ?? 'a customer'} on ${formatDate(p.receivedOn, locale)} has an unallocated amount`,
      amount: money(p.unallocatedAmount, p.currencyCode), open: () => env.go({ name: 'payment', id: p.id }),
    })),
    ...(okData(drafts.state)?.documents ?? []).map((d) => ({
      key: `d${d.id}`, tone: 'neutral' as const, text: `Draft invoice for ${label(d)} is not issued yet`,
      amount: money(d.total, d.currencyCode), open: () => env.go({ name: 'document', path: 'invoices', id: d.id }),
    })),
  ];
  const attentionLoading = [overdue, overdueBills, unallocated, drafts].some((x) => x.state.status === 'loading');
  const attentionFailed = [overdue, overdueBills, unallocated, drafts].find((x) => x.state.status === 'done' && x.state.outcome.kind !== 'ok');

  return (
    <ZonePage title="Finance" eyebrow="Overview" primaryActions={quick}
      description="Open invoices, unpaid expenses and what needs attention. Every figure is per currency and comes from your records; invoiced amounts are not cash, and nothing here is profit.">
      <section aria-labelledby="ov-receivables" className="space-y-3">
        <h2 id="ov-receivables" className="text-sm font-semibold tracking-tight">Owed to you</h2>
        {receivables.state.status === 'loading' ? <LoadingRows label="Loading receivables…" rows={1} /> : null}
        {receivables.state.status === 'done' && receivables.state.outcome.kind !== 'ok' ? (
          <Problem outcome={receivables.state.outcome} what="Receivables" onRetry={receivables.reload} onSessionEnded={env.onSessionEnded} />
        ) : null}
        {rec && rec.currencies.length === 0 ? <p className="text-sm text-muted-foreground">No issued invoices are open, and no customer credit is waiting to be used.</p> : null}
        {rec && rec.currencies.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rec.currencies.map((c) => (
              <StatCard key={c.currencyCode} label={`Outstanding on invoices (${c.currencyCode})`} value={money(c.outstanding, c.currencyCode)}
                trend={c.overdueCount > 0 ? 'down' : 'neutral'}
                change={<>
                  {c.overdueCount > 0 ? `${money(c.overdue, c.currencyCode)} overdue on ${c.overdueCount} of ${c.openCount} open` : `${c.openCount} open, none overdue`}
                  {isPositive(c.unallocatedPayments) || isPositive(c.unappliedCredit) ? (
                    <span className="mt-1 block font-normal text-muted-foreground">
                      Customer credit not yet used: {money(c.unallocatedPayments, c.currencyCode)} in payments, {money(c.unappliedCredit, c.currencyCode)} in credit notes
                    </span>
                  ) : null}
                </>} />
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="ov-payables" className="space-y-3">
        <h2 id="ov-payables" className="text-sm font-semibold tracking-tight">You owe (recorded expenses)</h2>
        {payables.state.status === 'loading' ? <LoadingRows label="Loading payables…" rows={1} /> : null}
        {payables.state.status === 'done' && payables.state.outcome.kind !== 'ok' ? (
          <Problem outcome={payables.state.outcome} what="Unpaid expenses" onRetry={payables.reload} onSessionEnded={env.onSessionEnded} />
        ) : null}
        {pay && pay.currencies.length === 0 ? <p className="text-sm text-muted-foreground">No recorded expenses are waiting to be paid.</p> : null}
        {pay && pay.currencies.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {pay.currencies.map((c) => (
              <StatCard key={c.currencyCode} label={`Unpaid expenses (${c.currencyCode})`} value={money(c.outstanding, c.currencyCode)} trend={c.overdueCount > 0 ? 'down' : 'neutral'}
                change={c.overdueCount > 0 ? `${money(c.overdue, c.currencyCode)} past due on ${c.overdueCount} of ${c.openCount}` : `${c.openCount} open, none past due`} />
            ))}
          </div>
        ) : null}
      </section>

      <Card>
        <CardHeader><CardTitle>Needs attention</CardTitle></CardHeader>
        <CardContent>
          {attentionLoading ? <LoadingRows label="Loading…" rows={2} /> : attentionFailed && attentionFailed.state.status === 'done' ? (
            <Problem outcome={attentionFailed.state.outcome} what="Items needing attention" onRetry={() => [overdue, overdueBills, unallocated, drafts].forEach((x) => x.reload())} onSessionEnded={env.onSessionEnded} />
          ) : attention.length === 0 ? <p className="text-sm text-muted-foreground">Nothing needs attention right now.</p> : (
            <ul className="divide-y">
              {attention.map((a) => (
                <li key={a.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <button type="button" onClick={a.open} className="flex items-center gap-2 text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                    <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[a.tone]}`} />{a.text}
                  </button>
                  <span className="tabular-nums">{a.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Recent title="Recent invoices" loaded={recentInvoices} onAll={() => env.go({ name: 'documents', path: 'invoices' })}
          render={(p) => p.documents.map((d) => (
            <RecentRow key={d.id} onOpen={() => env.go({ name: 'document', path: 'invoices', id: d.id })} title={`${d.number ?? 'Draft'} · ${label(d)}`}
              meta={<DocumentBadges status={d.status} settlement={d.settlementState} overdue={isOverdue(d, today)} />} amount={money(d.total, d.currencyCode)} />
          ))} empty="No invoices yet." />
        <Recent title="Recent quotes" loaded={recentQuotes} onAll={() => env.go({ name: 'documents', path: 'quotes' })}
          render={(p) => p.documents.map((d) => (
            <RecentRow key={d.id} onOpen={() => env.go({ name: 'document', path: 'quotes', id: d.id })} title={`${d.number ?? `Draft ${KIND_LABEL.QUOTE.toLowerCase()}`} · ${label(d)}`}
              meta={<DocumentBadges status={d.status} />} amount={money(d.total, d.currencyCode)} />
          ))} empty="No quotes yet." />
        <Recent title="Recent payments received" loaded={recentPayments} onAll={() => env.go({ name: 'payments' })}
          render={(p) => p.payments.map((x) => (
            <RecentRow key={x.id} onOpen={() => env.go({ name: 'payment', id: x.id })} title={`${env.names.get(x.customerId) ?? 'Customer'} · ${formatDate(x.receivedOn, locale)}`}
              meta={<span className="text-xs text-muted-foreground">{METHOD_LABEL[x.method]}{x.status === 'REVERSED' ? ' · reversed' : ''}</span>} amount={money(x.amount, x.currencyCode)} />
          ))} empty="No payments recorded yet." />
      </div>
    </ZonePage>
  );
}

const DOT = { danger: 'bg-destructive', warning: 'bg-warning', info: 'bg-info', neutral: 'bg-muted-foreground' } as const;

function Recent<T extends { documents?: unknown[]; payments?: unknown[] }>({ title, loaded, render, empty, onAll }: {
  title: string; loaded: ReturnType<typeof useLoad<T>>; render: (data: T) => ReactNode[]; empty: string; onAll: () => void;
}) {
  const env = useFinance();
  const data = okData(loaded.state);
  const rows = data ? render(data) : [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <Button size="sm" variant="ghost" onClick={onAll}>View all</Button>
      </CardHeader>
      <CardContent>
        {loaded.state.status === 'loading' ? <LoadingRows label={`Loading ${title.toLowerCase()}…`} rows={3} /> : null}
        {loaded.state.status === 'done' && loaded.state.outcome.kind !== 'ok' ? <Problem outcome={loaded.state.outcome} what={title} onRetry={loaded.reload} onSessionEnded={env.onSessionEnded} /> : null}
        {data && rows.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : null}
        {rows.length > 0 ? <ul className="divide-y">{rows}</ul> : null}
      </CardContent>
    </Card>
  );
}

function RecentRow({ title, meta, amount, onOpen }: { title: string; meta: ReactNode; amount: string; onOpen: () => void }) {
  return (
    <li className="py-2.5">
      <button type="button" onClick={onOpen} className="w-full text-left focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex items-start justify-between gap-2 text-sm">
          <span className="font-medium hover:underline [overflow-wrap:anywhere]">{title}</span>
          <span className="shrink-0 tabular-nums">{amount}</span>
        </span>
        <span className="mt-1 block">{meta}</span>
      </button>
    </li>
  );
}
