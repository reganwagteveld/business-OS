import type { ExpenseCategory } from '@business-os/contracts';
import { Badge, Button, Field, Input, Select, StatCard, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useEffect, useState } from 'react';
import type { ExpenseQuery, FinanceClient } from '../../api/finance';
import { ZonePage, type ZonePageTab } from '../../shell/zone-page';
import { useLoad } from '../use-load';
import { Problem } from '../problem';
import { formatDate, formatMoney, PAYMENT_LABEL, PAYMENT_TONE, STATUS_LABEL, STATUS_TONE } from './format';

export interface ListFilters {
  q: string; status: ExpenseQuery['status']; payment: ExpenseQuery['payment'] | ''; categoryId: string; from: string; to: string;
}
export const DEFAULT_FILTERS: ListFilters = { q: '', status: 'all', payment: '', categoryId: '', from: '', to: '' };
const PAGE_SIZE = 25;
const WRAP = '[overflow-wrap:anywhere]';

/**
 * Expenses from the API: searched, filtered and paged on the server (keyset cursors). The payables
 * figures come from the server's own per-currency totals of recorded, unpaid expenses; drafts and
 * void expenses never count, and nothing is summed in the browser.
 */
export function ExpenseList({ client, slug, locale, categories, filters, onFilters, tabs, onTab, canCreate, onOpen, onAdd, onSessionEnded }: {
  client: FinanceClient; slug: string; locale?: string; categories: ExpenseCategory[] | null; filters: ListFilters; onFilters: (f: ListFilters) => void;
  tabs: readonly ZonePageTab[]; onTab: (id: string) => void; canCreate: boolean; onOpen: (id: string) => void; onAdd: () => void; onSessionEnded: () => void;
}) {
  const [text, setText] = useState(filters.q);
  const [pager, setPager] = useState<{ sig: string; stack: string[] }>({ sig: '', stack: [] });
  useEffect(() => {
    if (text.trim() === filters.q.trim()) return;
    const timer = setTimeout(() => onFilters({ ...filters, q: text.trim() }), 300);
    return () => clearTimeout(timer);
  }, [text, filters, onFilters]);

  const sig = JSON.stringify(filters);
  const stack = pager.sig === sig ? pager.stack : [];
  const cursor = stack[stack.length - 1];
  const { state, reload } = useLoad(`expenses|${slug}|${sig}|${cursor ?? ''}`, (signal) => client.expenses(slug, {
    q: filters.q || undefined, status: filters.status, payment: filters.payment || undefined, categoryId: filters.categoryId || undefined,
    from: filters.from || undefined, to: filters.to || undefined, cursor, limit: PAGE_SIZE,
  }, signal));
  const payables = useLoad(`expense-payables|${slug}`, (signal) => client.payables(slug, signal));
  const page = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
  const filtered = sig !== JSON.stringify(DEFAULT_FILTERS);
  const set = (patch: Partial<ListFilters>) => onFilters({ ...filters, ...patch });
  const categoryName = (id: string) => categories?.find((c) => c.id === id)?.name ?? 'Category';
  const totals = payables.state.status === 'done' && payables.state.outcome.kind === 'ok' ? payables.state.outcome.data.currencies : null;

  const add = canCreate ? <Button onClick={onAdd}>New expense</Button> : undefined;
  return (
    <ZonePage
      title="Expenses" description="What the business spends, with tax and payment status." eyebrow="Finance"
      primaryActions={add} tabs={tabs} currentTab="expenses" onTab={onTab}
    >
      {totals && totals.length > 0 ? (
        <section aria-label="Unpaid expenses" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {totals.map((t) => (
            <StatCard key={t.currencyCode} label={`Unpaid (${t.currencyCode})`} value={formatMoney(t.outstanding, t.currencyCode, locale)}
              change={t.overdueCount > 0 ? `${formatMoney(t.overdue, t.currencyCode, locale)} overdue in ${t.overdueCount}` : `${t.openCount} open`}
              trend={t.overdueCount > 0 ? 'down' : 'neutral'} />
          ))}
        </section>
      ) : null}

      <div role="search" aria-label="Filter expenses" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Field label="Search" className="lg:col-span-2">{(c) => <Input {...c} type="search" value={text} placeholder="Supplier, description or reference" onChange={(e) => setText(e.target.value)} />}</Field>
        <Field label="Status">{(c) => (
          <Select {...c} value={filters.status} onChange={(e) => set({ status: e.target.value as ListFilters['status'] })}>
            <option value="all">All</option><option value="draft">Draft</option><option value="recorded">Recorded</option><option value="void">Void</option>
          </Select>
        )}</Field>
        <Field label="Payment">{(c) => (
          <Select {...c} value={filters.payment} onChange={(e) => set({ payment: e.target.value as ListFilters['payment'] })}>
            <option value="">Any</option><option value="open">Not fully paid</option><option value="overdue">Overdue</option>
            <option value="unpaid">Unpaid</option><option value="partially_paid">Partly paid</option><option value="paid">Paid</option>
          </Select>
        )}</Field>
        <Field label="Category">{(c) => (
          <Select {...c} value={filters.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">All categories</option>
            {(categories ?? []).map((cat) => <option key={cat.id} value={cat.id}>{cat.name}{cat.archivedAt ? ' (archived)' : ''}</option>)}
          </Select>
        )}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">{(c) => <Input {...c} type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
          <Field label="Before">{(c) => <Input {...c} type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />}</Field>
        </div>
      </div>

      {state.status === 'loading' ? <LoadingRows /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Expenses" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {page && page.expenses.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-10 text-center">
          <p className="font-semibold">{filtered ? 'No expenses match these filters' : 'No expenses yet'}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered ? 'Try a different search or clear the filters.' : canCreate ? 'Record what the business spends to see it here.' : 'Expenses recorded by your team will appear here.'}
          </p>
          <div className="mt-4 flex justify-center gap-3">
            {filtered ? <Button variant="outline" onClick={() => { setText(''); onFilters(DEFAULT_FILTERS); }}>Clear filters</Button> : add}
          </div>
        </div>
      ) : null}
      {page && page.expenses.length > 0 ? (
        <>
          <Table aria-label="Expenses">
            <TableCaption>{filtered ? 'Filtered expenses, most recent first.' : 'Expenses, most recent first.'}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead><TableHead>Expense</TableHead><TableHead className="hidden md:table-cell">Category</TableHead>
                <TableHead>Status</TableHead><TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.expenses.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(e.incurredOn, locale)}</TableCell>
                  <TableCell className={WRAP}>
                    <button type="button" className="text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onOpen(e.id)}>
                      {e.supplierName ?? e.description}
                    </button>
                    {e.supplierName ? <p className="text-xs text-muted-foreground">{e.description}</p> : null}
                  </TableCell>
                  <TableCell className={`hidden md:table-cell ${WRAP}`}>{e.categoryName ?? categoryName(e.categoryId)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                      {e.paymentState ? <Badge tone={PAYMENT_TONE[e.paymentState]}>{PAYMENT_LABEL[e.paymentState]}</Badge> : null}
                      {e.overdue ? <Badge tone="danger">Overdue</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoney(e.total, e.currencyCode, locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav aria-label="Pages" className="flex justify-between gap-3">
            <Button variant="outline" disabled={stack.length === 0} onClick={() => setPager({ sig, stack: stack.slice(0, -1) })}>Previous</Button>
            <Button variant="outline" disabled={!page.nextCursor} onClick={() => page.nextCursor && setPager({ sig, stack: [...stack, page.nextCursor] })}>Next</Button>
          </nav>
        </>
      ) : null}
    </ZonePage>
  );
}

export function LoadingRows({ label = 'Loading expenses…' }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: 5 }, (_, i) => <div key={i} aria-hidden="true" className="h-12 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}
    </div>
  );
}
