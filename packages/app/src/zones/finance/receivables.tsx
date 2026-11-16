import type { AgeingBuckets, AgeingPosition, StatementEntryType } from '@business-os/contracts';
import {
  Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Table, TableBody, TableCaption, TableCell, TableHead,
  TableHeader, TableRow,
} from '@business-os/ui';
import { useMemo, useRef, useState } from 'react';
import { ZonePage } from '../../shell/zone-page';
import { CustomerPicker } from '../customer-picker';
import { Problem } from '../problem';
import { currencyOptions } from '../sales/format';
import { useLoad } from '../use-load';
import { isPositive } from './decimal';
import { fileFailure, saveFile } from './document-pdf';
import type { StatementParams } from '../../api/finance';
import { useFinance, useRequestNames } from './env';
import { formatDate, formatMoney } from './format';
import { EmptyBox, LoadingRows, okData, Pager, usePager } from './shared';

// Finance F6-2 (docs/finance-billing-f6.md §4): accounts-receivable ageing and customer statements as of
// a date. Every figure comes from the server, per currency, never converted or added across currencies.
// Credit (unallocated payments and unapplied credit notes) is always shown beside the open invoices,
// never subtracted from an age bucket. Nothing here sends a statement or a reminder.

const PAGE_SIZE = 25;
const BUCKET_COLUMNS: [keyof AgeingBuckets, string][] = [
  ['current', 'Current'], ['days1To30', '1–30 days'], ['days31To60', '31–60 days'], ['days61To90', '61–90 days'], ['days90Plus', 'Over 90 days'], ['noDueDate', 'No due date'],
];
const BUCKET_LABEL: Record<string, string> = {
  CURRENT: 'Current', DAYS_1_30: '1–30 days', DAYS_31_60: '31–60 days', DAYS_61_90: '61–90 days', DAYS_90_PLUS: 'Over 90 days', NO_DUE_DATE: 'No due date',
};
export const ENTRY_LABEL: Record<StatementEntryType, string> = {
  INVOICE: 'Invoice', INVOICE_VOID: 'Invoice voided', CREDIT_NOTE: 'Credit note', CREDIT_NOTE_VOID: 'Credit note voided', PAYMENT: 'Payment received',
  PAYMENT_REVERSAL: 'Payment reversed',
};
const AS_OF_NOTE = 'Balances on the chosen date, from the dates on your records. Allocations, credit and voids count from the day they were made.';

/** A credit figure: unallocated payments plus unapplied credit notes (shown as credit, never as cash). */
const creditOf = (p: Pick<AgeingPosition, 'unallocatedPayments' | 'unappliedCredit'>, scale: number) =>
  (Number(p.unallocatedPayments) + Number(p.unappliedCredit)).toFixed(scale);

/** The first day of the month three months before `day` (a statement's default start). */
export function defaultFrom(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - 3, 1));
  return d.toISOString().slice(0, 10);
}

/** Accounts-receivable ageing as of a date, per customer and currency, with drill-down and statements. */
export function ReceivablesAgeingPage() {
  const env = useFinance();
  const { locale, today, currency } = env;
  const [asOf, setAsOf] = useState(today);
  const [currencyCode, setCurrencyCode] = useState('');
  const currencies = useMemo(() => currencyOptions(currency, locale), [currency, locale]);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(asOf) && asOf <= today;
  return (
    <ZonePage title="Receivables ageing" eyebrow="Finance" description="What customers owe on issued invoices, by how long it is past due. Credit is shown separately.">
      <div role="search" aria-label="Ageing date and currency" className="grid gap-3 sm:grid-cols-3">
        <Field label="As of" hint={asOf > today ? 'Choose today or an earlier date.' : undefined}>{(c) => (
          <Input {...c} type="date" max={today} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        )}</Field>
        <Field label="Currency">{(c) => (
          <Select {...c} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
            <option value="">All currencies</option>
            {currencies.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.name}</option>)}
          </Select>
        )}</Field>
      </div>
      <p className="text-xs text-muted-foreground">{AS_OF_NOTE}</p>
      {!validDate ? <Alert tone="warning"><AlertDescription>Choose a date on or before today.</AlertDescription></Alert> : null}
      {validDate ? <AgeingBody asOf={asOf} currencyCode={currencyCode} /> : null}
    </ZonePage>
  );
}

/** The ageing figures for a valid date (mounted only then, so nothing is requested for an invalid date). */
function AgeingBody({ asOf, currencyCode }: { asOf: string; currencyCode: string }) {
  const env = useFinance();
  const { client, slug, locale } = env;
  const [open, setOpen] = useState<string | null>(null);
  const sig = JSON.stringify({ asOf, currencyCode });
  const pager = usePager(sig);
  const { state, reload } = useLoad(`ageing|${slug}|${sig}|${pager.cursor ?? ''}`, (signal) =>
    client.ageing(slug, { asOf, currencyCode: currencyCode || undefined, cursor: pager.cursor, limit: PAGE_SIZE }, signal));
  const ageing = okData(state);
  useRequestNames(ageing?.rows.map((r) => r.customerId) ?? []);
  const money = (v: string, c: string) => formatMoney(v, c, locale);
  const name = (id: string) => env.names.get(id) ?? (env.customers ? 'Loading…' : 'Customer');
  return (
    <>
      {state.status === 'loading' ? <LoadingRows label="Loading receivables ageing…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Receivables ageing" onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {ageing ? (
        <>
          {ageing.totals.some((t) => !t.balanced) ? (
            <Alert tone="danger"><AlertDescription>These figures do not reconcile. Do not rely on them, and tell your administrator.</AlertDescription></Alert>
          ) : null}
          {ageing.totals.length === 0 ? <EmptyBox title="Nothing owed and no credit" body={`No customer had an open invoice or credit on ${formatDate(ageing.asOf, locale)}.`} /> : (
            <div className="grid gap-4 lg:grid-cols-2">
              {ageing.totals.map((t) => (
                <Card key={t.currencyCode} aria-label={`Totals in ${t.currencyCode}`}>
                  <CardHeader><CardTitle className="text-base">{t.currencyCode} on {formatDate(ageing.asOf, locale)}</CardTitle></CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                      {BUCKET_COLUMNS.map(([k, label]) => (
                        <div key={k} className="flex justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{money(t.buckets[k], t.currencyCode)}</dd></div>
                      ))}
                    </dl>
                    <dl className="mt-3 space-y-1 border-t pt-3 text-sm">
                      <div className="flex justify-between gap-2 font-semibold"><dt>Open on invoices ({t.openInvoiceCount})</dt><dd className="tabular-nums">{money(t.receivable, t.currencyCode)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Payments not yet allocated</dt><dd className="tabular-nums">{money(t.unallocatedPayments, t.currencyCode)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Credit notes not yet applied</dt><dd className="tabular-nums">{money(t.unappliedCredit, t.currencyCode)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Account balance</dt><dd className="tabular-nums">{money(t.accountBalance, t.currencyCode)}</dd></div>
                    </dl>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {ageing.rows.length > 0 ? (
            <Table aria-label="Receivables by customer">
              <TableCaption>Per customer and currency on {formatDate(ageing.asOf, locale)}. Credit is not subtracted from the age columns.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  {BUCKET_COLUMNS.map(([k, label]) => <TableHead key={k} className="hidden text-right lg:table-cell">{label}</TableHead>)}
                  <TableHead className="text-right">Open</TableHead><TableHead className="hidden text-right sm:table-cell">Credit</TableHead><TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ageing.rows.map((r) => {
                  const key = `${r.customerId}|${r.currencyCode}`;
                  return [
                    <TableRow key={key}>
                      <TableCell>
                        <span className="font-medium">{name(r.customerId)}</span> <span className="text-xs text-muted-foreground">{r.currencyCode}</span>
                        {isPositive(r.overdue) ? <span className="block text-xs text-destructive">{money(r.overdue, r.currencyCode)} overdue</span> : null}
                      </TableCell>
                      {BUCKET_COLUMNS.map(([k]) => <TableCell key={k} className="hidden text-right tabular-nums lg:table-cell">{isPositive(r.buckets[k]) ? money(r.buckets[k], r.currencyCode) : '—'}</TableCell>)}
                      <TableCell className="text-right font-semibold tabular-nums">{money(r.receivable, r.currencyCode)}</TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">{money(creditOf(r, r.currencyScale), r.currencyCode)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <Button size="sm" variant="ghost" aria-expanded={open === key} aria-label={`${open === key ? 'Hide details' : 'Details'} for ${name(r.customerId)} in ${r.currencyCode}`}
                          onClick={() => setOpen(open === key ? null : key)}>
                          {open === key ? 'Hide' : 'Details'}
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Statement for ${name(r.customerId)} in ${r.currencyCode}`}
                          onClick={() => env.go({ name: 'statement', customerId: r.customerId, currencyCode: r.currencyCode })}>
                          Statement
                        </Button>
                      </TableCell>
                    </TableRow>,
                    open === key ? (
                      <TableRow key={`${key}-detail`}>
                        <TableCell colSpan={BUCKET_COLUMNS.length + 4}><AgeingDetail asOf={ageing.asOf} customerId={r.customerId} currencyCode={r.currencyCode} /></TableCell>
                      </TableRow>
                    ) : null,
                  ];
                })}
              </TableBody>
            </Table>
          ) : null}
          <Pager pager={pager} nextCursor={ageing.nextCursor} />
        </>
      ) : null}
    </>
  );
}

/** One customer and currency: each open invoice in its bucket, then each credit on its own line. */
function AgeingDetail({ asOf, customerId, currencyCode }: { asOf: string; customerId: string; currencyCode: string }) {
  const env = useFinance();
  const { client, slug, locale } = env;
  const { state, reload } = useLoad(`ageing-detail|${slug}|${asOf}|${customerId}|${currencyCode}`, (signal) => client.ageingDetail(slug, { asOf, customerId, currencyCode }, signal));
  const d = okData(state);
  const money = (v: string) => formatMoney(v, currencyCode, locale);
  if (state.status === 'loading') return <LoadingRows label="Loading invoices…" rows={2} />;
  if (state.status === 'done' && state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="These invoices" onRetry={reload} onSessionEnded={env.onSessionEnded} />;
  if (!d) return null;
  return (
    <div className="space-y-4 py-2">
      {d.invoices.length > 0 ? (
        <Table aria-label="Open invoices">
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead><TableHead className="hidden sm:table-cell">Due</TableHead><TableHead>Age</TableHead>
              <TableHead className="hidden text-right md:table-cell">Total</TableHead><TableHead className="hidden text-right md:table-cell">Paid and credited</TableHead><TableHead className="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.invoices.map((i) => (
              <TableRow key={i.invoiceId}>
                <TableCell>
                  <button type="button" className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'document', path: 'invoices', id: i.invoiceId })}>
                    {i.number}<span className="sr-only">, open invoice</span>
                  </button>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{i.dueDate ? formatDate(i.dueDate, locale) : '—'}</TableCell>
                <TableCell>{BUCKET_LABEL[i.bucket]}{i.daysPastDue !== null && i.daysPastDue > 0 ? <span className="text-xs text-muted-foreground"> · {i.daysPastDue} days past due</span> : null}</TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">{money(i.total)}</TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">{money((Number(i.paid) + Number(i.credited)).toFixed(d.currencyScale))}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{money(i.outstanding)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <p className="text-sm text-muted-foreground">No open invoices on this date.</p>}
      {d.credits.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Credit on account</h3>
          <ul className="mt-1 divide-y text-sm">
            {d.credits.map((c) => (
              <li key={c.sourceId} className="flex justify-between gap-3 py-2">
                <button type="button" className="text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => env.go(c.kind === 'PAYMENT' ? { name: 'payment', id: c.sourceId } : { name: 'document', path: 'credit-notes', id: c.sourceId })}>
                  {c.kind === 'PAYMENT' ? `Payment received ${formatDate(c.date, locale)}${c.reference ? ` · ${c.reference}` : ''}, not yet allocated` : `Credit note ${c.reference ?? ''}, not yet applied`}
                </button>
                <span className="tabular-nums">{money(c.available)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A customer statement for one currency and a date range, with the aged position at its end. */
export function StatementPage({ customerId: initialCustomer, currencyCode: initialCurrency }: { customerId?: string; currencyCode?: string }) {
  const env = useFinance();
  const { slug, locale, today, currency } = env;
  const [customer, setCustomer] = useState<{ id: string; name: string | null }>({ id: initialCustomer ?? '', name: null });
  const [currencyCode, setCurrencyCode] = useState(initialCurrency ?? currency);
  const [from, setFrom] = useState(defaultFrom(today));
  const [to, setTo] = useState(today);
  const currencies = useMemo(() => currencyOptions(currency, locale), [currency, locale]);
  useRequestNames(customer.id ? [customer.id] : []);
  const dateOk = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const problem = !customer.id ? 'Choose a customer.' : !dateOk(from) || !dateOk(to) ? 'Choose both dates.' : to > today ? 'The end date cannot be after today.' : from > to ? 'The start date must be on or before the end date.' : null;
  const params = { customerId: customer.id, currencyCode, from, to };
  const customerName = customer.name ?? env.names.get(customer.id) ?? null;

  return (
    <ZonePage
      title={customerName ? `Statement for ${customerName}` : 'Customer statement'} eyebrow="Finance"
      description="Opening balance, dated activity and closing balance for one customer and currency. Nothing is sent from here."
      secondaryActions={<Button variant="outline" onClick={() => env.go({ name: 'receivables' })}>Receivables ageing</Button>}
    >
      <div role="search" aria-label="Statement for" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {env.customers ? (
          <div className="sm:col-span-2">
            <CustomerPicker id="statement-customer" customers={env.customers} slug={slug} selectedId={customer.id} selectedName={customerName} hint="The customer the statement is for."
              onPick={(c) => setCustomer({ id: c?.id ?? '', name: c?.displayName ?? null })} onSessionEnded={env.onSessionEnded} />
          </div>
        ) : null}
        <Field label="Currency">{(c) => (
          <Select {...c} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
            {currencies.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.name}</option>)}
          </Select>
        )}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">{(c) => <Input {...c} type="date" max={today} value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(c) => <Input {...c} type="date" max={today} value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
      </div>
      {problem && customer.id ? <Alert tone="warning"><AlertDescription>{problem}</AlertDescription></Alert> : null}
      {!customer.id ? <EmptyBox title="Choose a customer" body={env.customers ? 'Pick the customer and currency for the statement.' : 'Open a statement from the receivables ageing or a customer\'s page.'} /> : null}
      {!problem ? <StatementBody params={params} /> : null}
    </ZonePage>
  );
}

/** The statement for valid inputs (mounted only then), with the PDF download for finance:documents_download. */
function StatementBody({ params }: { params: StatementParams }) {
  const env = useFinance();
  const { client, slug, locale, can } = env;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const inFlight = useRef(false);
  const { state, reload } = useLoad(`statement|${slug}|${JSON.stringify(params)}`, (signal) => client.statement(slug, params, signal));
  const s = okData(state);
  const money = (v: string) => formatMoney(v, params.currencyCode, locale);

  async function download() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const out = await client.statementPdf(slug, params);
      if (out.kind !== 'ok') {
        if (out.kind === 'unauthenticated') env.onSessionEnded();
        setNotice({ tone: 'danger', text: fileFailure(out) });
        return;
      }
      const fileName = `statement-${params.currencyCode}-${params.from}-to-${params.to}.pdf`;
      saveFile(out.data, fileName);
      setNotice({ tone: 'success', text: `Downloaded ${fileName}. Nothing was sent to the customer.` });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {can.pdfDownload && s ? <div className="flex justify-end"><Button onClick={() => void download()} loading={busy} disabled={busy}>Download PDF</Button></div> : null}
      {notice ? <Alert tone={notice.tone}><AlertDescription>{notice.text}</AlertDescription></Alert> : null}
      {state.status === 'loading' ? <LoadingRows label="Loading statement…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="The statement" onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {s ? (
        <>
          {!s.position.balanced ? <Alert tone="danger"><AlertDescription>This statement does not reconcile. Do not send it, and tell your administrator.</AlertDescription></Alert> : null}
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border p-3"><dt className="text-xs text-muted-foreground">Opening balance on {formatDate(s.from, locale)}</dt><dd className="text-lg font-semibold tabular-nums">{money(s.openingBalance)}</dd></div>
            <div className="rounded-xl border p-3"><dt className="text-xs text-muted-foreground">Activity</dt><dd className="text-lg font-semibold tabular-nums">{s.entries.length} {s.entries.length === 1 ? 'entry' : 'entries'}</dd></div>
            <div className="rounded-xl border p-3"><dt className="text-xs text-muted-foreground">Closing balance on {formatDate(s.to, locale)}</dt><dd className="text-lg font-semibold tabular-nums">{money(s.closingBalance)}</dd></div>
          </dl>
          <Table aria-label="Statement activity">
            <TableCaption>Positive amounts add to what the customer owes; payments and credit notes reduce it. Allocations do not change the balance.</TableCaption>
            <TableHeader>
              <TableRow><TableHead>Date</TableHead><TableHead>Activity</TableHead><TableHead className="hidden sm:table-cell">Due</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Balance</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              <TableRow><TableCell>{formatDate(s.from, locale)}</TableCell><TableCell className="font-medium">Opening balance</TableCell><TableCell className="hidden sm:table-cell" /><TableCell /><TableCell className="text-right font-medium tabular-nums">{money(s.openingBalance)}</TableCell></TableRow>
              {s.entries.map((e, i) => (
                <TableRow key={`${e.sourceId}-${e.type}-${i}`}>
                  <TableCell className="whitespace-nowrap">{formatDate(e.date, locale)}</TableCell>
                  <TableCell>{ENTRY_LABEL[e.type]}{e.reference ? ` ${e.reference}` : ''}</TableCell>
                  <TableCell className="hidden sm:table-cell">{e.dueDate ? formatDate(e.dueDate, locale) : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(e.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(e.balance)}</TableCell>
                </TableRow>
              ))}
              <TableRow><TableCell>{formatDate(s.to, locale)}</TableCell><TableCell className="font-semibold">Closing balance</TableCell><TableCell className="hidden sm:table-cell" /><TableCell /><TableCell className="text-right font-semibold tabular-nums">{money(s.closingBalance)}</TableCell></TableRow>
            </TableBody>
          </Table>
          <Card>
            <CardHeader><CardTitle className="text-base">Position on {formatDate(s.to, locale)}</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {BUCKET_COLUMNS.filter(([k]) => isPositive(s.position.buckets[k])).map(([k, label]) => (
                  <div key={k} className="flex justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{money(s.position.buckets[k])}</dd></div>
                ))}
                <div className="flex justify-between gap-2 font-semibold"><dt>Open on invoices</dt><dd className="tabular-nums">{money(s.position.receivable)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Payments not yet allocated</dt><dd className="tabular-nums">{money(s.position.unallocatedPayments)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Credit notes not yet applied</dt><dd className="tabular-nums">{money(s.position.unappliedCredit)}</dd></div>
              </dl>
            </CardContent>
          </Card>
        </>
      ) : null}
    </>
  );
}
