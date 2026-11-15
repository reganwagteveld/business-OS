import type { FinanceDocumentListItem } from '@business-os/contracts';
import { Button, Field, Input, Select, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useState } from 'react';
import type { DocumentPath, DocumentQuery } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { CustomerPicker } from '../customer-picker';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { subtract } from './decimal';
import { useFinance, useRequestNames } from './env';
import { formatDate, formatMoney } from './format';
import { DocumentBadges, EmptyBox, isOverdue, LoadingRows, okData, Pager, usePager, WRAP } from './shared';

const PAGE_SIZE = 25;

const COPY: Record<DocumentPath, { title: string; one: string; description: string; empty: string; add?: string }> = {
  quotes: {
    title: 'Quotes', one: 'quote', add: 'New quote',
    description: 'Offers to customers. Accepting a quote records a decision; it is not a payment or an invoice.',
    empty: 'Draft a quote for a customer, then issue it when it is ready.',
  },
  invoices: {
    title: 'Invoices', one: 'invoice', add: 'New invoice',
    description: 'What customers have been billed and what is still open. Invoiced amounts are not cash received.',
    empty: 'Draft an invoice for a customer, or convert an issued quote.',
  },
  'credit-notes': {
    title: 'Credit notes', one: 'credit note',
    description: 'Credit given against issued invoices. Credit is not cash: it settles an invoice only when it is applied.',
    empty: 'Credit notes are started from an issued invoice.',
  },
};

interface Filters { status: DocumentQuery['status']; customerId: string; customerName: string | null; from: string; to: string; settlement: '' | NonNullable<DocumentQuery['settlement']>; overdue: boolean }
const DEFAULTS: Filters = { status: 'all', customerId: '', customerName: null, from: '', to: '', settlement: '', overdue: false };

/** The customer's name on a document: the issued snapshot (part of the record), else the live name when the person may read customers. */
export function useCustomerLabel() {
  const { names } = useFinance();
  return (d: Pick<FinanceDocumentListItem, 'customerId' | 'billToSnapshot'>) => d.billToSnapshot?.name ?? names.get(d.customerId) ?? 'Customer';
}

/** A register of quotes, invoices or credit notes: filtered and paged on the server (keyset cursors). */
export function DocumentList({ path }: { path: DocumentPath }) {
  const env = useFinance();
  const { client, slug, locale, today, can } = env;
  const copy = COPY[path];
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const sig = JSON.stringify({ ...filters, customerName: null });
  const pager = usePager(sig);
  const settlement = path === 'invoices' && filters.settlement ? filters.settlement : undefined;
  const { state, reload } = useLoad(`docs|${slug}|${path}|${sig}|${pager.cursor ?? ''}`, (signal) => client.documents(slug, path, {
    // A settlement filter implies issued invoices (the API's rule), so the status is not sent with it.
    status: settlement ? 'all' : filters.status, customerId: filters.customerId || undefined, from: filters.from || undefined, to: filters.to || undefined,
    settlement, overdue: path === 'invoices' && filters.overdue ? true : undefined, cursor: pager.cursor, limit: PAGE_SIZE,
  }, signal));
  const page = okData(state);
  useRequestNames(page?.documents.filter((d) => !d.billToSnapshot).map((d) => d.customerId) ?? []);
  const label = useCustomerLabel();
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const filtered = sig !== JSON.stringify(DEFAULTS);
  const canAdd = path !== 'credit-notes' && can.write;
  const add = canAdd ? <Button onClick={() => env.go({ name: 'document-new', path: path as 'quotes' | 'invoices' })}>{copy.add}</Button> : undefined;
  const statuses: [DocumentQuery['status'], string][] = path === 'quotes'
    ? [['all', 'All'], ['draft', 'Draft'], ['issued', 'Issued'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['expired', 'Expired'], ['void', 'Void']]
    : [['all', 'All'], ['draft', 'Draft'], ['issued', 'Issued'], ['void', 'Void']];

  return (
    <ZonePage title={copy.title} description={copy.description} eyebrow="Finance" primaryActions={add}>
      <div role="search" aria-label={`Filter ${copy.title.toLowerCase()}`} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {env.customers ? (
          <div className="sm:col-span-2">
            <CustomerPicker
              id={`${path}-customer-filter`} customers={env.customers} slug={slug} selectedId={filters.customerId} selectedName={filters.customerName}
              onPick={(c) => set({ customerId: c?.id ?? '', customerName: c?.displayName ?? null })} onSessionEnded={env.onSessionEnded}
            />
          </div>
        ) : null}
        <Field label="Status">{(c) => (
          <Select {...c} value={settlement ? 'issued' : filters.status} disabled={Boolean(settlement)} onChange={(e) => set({ status: e.target.value as Filters['status'] })}>
            {statuses.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        )}</Field>
        {path === 'invoices' ? (
          <Field label="Payment">{(c) => (
            <Select {...c} value={filters.settlement} onChange={(e) => set({ settlement: e.target.value as Filters['settlement'] })}>
              <option value="">Any</option><option value="open">Not fully paid</option><option value="unpaid">Unpaid</option>
              <option value="partially_paid">Partly paid</option><option value="paid">Paid</option>
            </Select>
          )}</Field>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-2">
          <Field label="Issued from">{(c) => <Input {...c} type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
          <Field label="Issued before">{(c) => <Input {...c} type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />}</Field>
        </div>
        {path === 'invoices' ? (
          <label className="flex min-h-10 items-center gap-2 self-end text-sm font-medium">
            <input type="checkbox" className="size-4" checked={filters.overdue} onChange={(e) => set({ overdue: e.target.checked })} /> Overdue only
          </label>
        ) : null}
      </div>

      {state.status === 'loading' ? <LoadingRows label={`Loading ${copy.title.toLowerCase()}…`} /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what={copy.title} onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {page && page.documents.length === 0 ? (
        filtered
          ? <EmptyBox title={`No ${copy.title.toLowerCase()} match these filters`} body="Try different filters or clear them." action={<Button variant="outline" onClick={() => setFilters(DEFAULTS)}>Clear filters</Button>} />
          : <EmptyBox title={`No ${copy.title.toLowerCase()} yet`} body={canAdd || path === 'credit-notes' ? copy.empty : `${copy.title} prepared by your team will appear here.`} action={add} />
      ) : null}
      {page && page.documents.length > 0 ? (
        <>
          <Table aria-label={copy.title}>
            <TableCaption>{filtered ? `Filtered ${copy.title.toLowerCase()}, most recent first.` : `${copy.title}, most recent first. Amounts are in each document's own currency.`}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead><TableHead>Customer</TableHead><TableHead className="hidden md:table-cell">Issued</TableHead>
                <TableHead className="hidden lg:table-cell">{path === 'quotes' ? 'Valid until' : path === 'invoices' ? 'Due' : 'Invoice'}</TableHead>
                <TableHead>Status</TableHead><TableHead className="text-right">Total</TableHead>
                {path === 'invoices' ? <TableHead className="hidden text-right sm:table-cell">Open</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.documents.map((d) => {
                const open = d.status === 'ISSUED' && d.kind === 'INVOICE' ? openAmount(d) : null;
                return (
                  <TableRow key={d.id}>
                    <TableCell className="whitespace-nowrap">
                      <button type="button" className="text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'document', path, id: d.id })}>
                        {d.number ?? 'Draft'}<span className="sr-only">, open {copy.one}</span>
                      </button>
                    </TableCell>
                    <TableCell className={WRAP}>
                      {label(d)}
                      <p className="text-xs text-muted-foreground md:hidden">{d.issueDate ? formatDate(d.issueDate, locale) : 'Not issued'}</p>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap md:table-cell">{d.issueDate ? formatDate(d.issueDate, locale) : '—'}</TableCell>
                    <TableCell className="hidden whitespace-nowrap lg:table-cell">
                      {path === 'quotes' ? formatDate(d.validUntil, locale) : path === 'invoices' ? formatDate(d.dueDate, locale) : d.creditedInvoiceId ? 'Linked' : '—'}
                    </TableCell>
                    <TableCell><DocumentBadges status={d.status} settlement={d.settlementState} overdue={isOverdue(d, today)} /></TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoney(d.total, d.currencyCode, locale)}</TableCell>
                    {path === 'invoices' ? (
                      <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">{open === null ? '—' : formatMoney(open, d.currencyCode, locale)}</TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Pager pager={pager} nextCursor={page.nextCursor} />
        </>
      ) : null}
    </ZonePage>
  );
}

/** What an issued invoice still has open: total − payments allocated − credit applied (exact, one currency). */
export function openAmount(d: Pick<FinanceDocumentListItem, 'total' | 'allocatedTotal' | 'creditAppliedTotal' | 'currencyScale'>): string | null {
  const afterPayments = subtract(d.total, d.allocatedTotal, d.currencyScale);
  return afterPayments === null ? null : subtract(afterPayments, d.creditAppliedTotal, d.currencyScale);
}
