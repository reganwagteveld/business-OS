import type { FinancePayment } from '@business-os/contracts';
import {
  Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Field, FormSection, Input, Select, Table, TableBody, TableCaption, TableCell,
  TableHead, TableHeader, TableRow,
} from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { PaymentQuery } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { CustomerPicker } from '../customer-picker';
import { Problem } from '../problem';
import { currencyOptions } from '../sales/format';
import { useLoad } from '../use-load';
import { allocationsValid, InvoiceAllocator, type Allocation } from './credit';
import { currencyScale, isPositive, toUnits } from './decimal';
import { useFinance, useRequestNames, type PaymentPrefill } from './env';
import { formatDate, formatMoney, formatWhen, METHOD_LABEL } from './format';
import { ConfirmDialog, EmptyBox, Item, LoadingRows, okData, Pager, Row, useIdempotencyKey, usePager, useSubmit, WRAP } from './shared';

const PAGE_SIZE = 25;
type Method = keyof typeof METHOD_LABEL;

const RECORD_NOTE = 'A record of money received outside Business OS (bank transfer, cash, card or cheque). Nothing is charged, and no bank account is read or matched.';

interface Filters { status: PaymentQuery['status']; customerId: string; customerName: string | null; unallocated: '' | 'true' | 'false'; from: string; to: string }
const DEFAULTS: Filters = { status: 'all', customerId: '', customerName: null, unallocated: '', from: '', to: '' };

/** Payments received, filtered and paged on the server. Each amount is in its own currency; nothing is added up here. */
export function PaymentList() {
  const env = useFinance();
  const { client, slug, locale, can } = env;
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const sig = JSON.stringify({ ...filters, customerName: null });
  const pager = usePager(sig);
  const { state, reload } = useLoad(`payments|${slug}|${sig}|${pager.cursor ?? ''}`, (signal) => client.payments(slug, {
    status: filters.status, customerId: filters.customerId || undefined, unallocated: filters.unallocated ? filters.unallocated === 'true' : undefined,
    from: filters.from || undefined, to: filters.to || undefined, cursor: pager.cursor, limit: PAGE_SIZE,
  }, signal));
  const page = okData(state);
  useRequestNames(page?.payments.map((p) => p.customerId) ?? []);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const filtered = sig !== JSON.stringify(DEFAULTS);
  const add = can.payments ? <Button onClick={() => env.go({ name: 'payment-new' })}>Record payment</Button> : undefined;
  return (
    <ZonePage title="Payments received" eyebrow="Finance" description={RECORD_NOTE} primaryActions={add}>
      <div role="search" aria-label="Filter payments" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {env.customers ? (
          <div className="sm:col-span-2">
            <CustomerPicker id="payments-customer-filter" customers={env.customers} slug={slug} selectedId={filters.customerId} selectedName={filters.customerName}
              onPick={(c) => set({ customerId: c?.id ?? '', customerName: c?.displayName ?? null })} onSessionEnded={env.onSessionEnded} />
          </div>
        ) : null}
        <Field label="Status">{(c) => (
          <Select {...c} value={filters.status} onChange={(e) => set({ status: e.target.value as Filters['status'] })}>
            <option value="all">All</option><option value="recorded">Recorded</option><option value="reversed">Reversed</option>
          </Select>
        )}</Field>
        <Field label="Allocation">{(c) => (
          <Select {...c} value={filters.unallocated} onChange={(e) => set({ unallocated: e.target.value as Filters['unallocated'] })}>
            <option value="">Any</option><option value="true">Has an unallocated amount</option><option value="false">Fully allocated</option>
          </Select>
        )}</Field>
        <div className="grid grid-cols-2 gap-2 sm:col-span-2">
          <Field label="Received from">{(c) => <Input {...c} type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
          <Field label="Received before">{(c) => <Input {...c} type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />}</Field>
        </div>
      </div>
      {state.status === 'loading' ? <LoadingRows label="Loading payments…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Payments" onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {page && page.payments.length === 0 ? (
        filtered ? <EmptyBox title="No payments match these filters" body="Try different filters or clear them." action={<Button variant="outline" onClick={() => setFilters(DEFAULTS)}>Clear filters</Button>} />
          : <EmptyBox title="No payments recorded yet" body={can.payments ? 'Record money a customer has paid you, and allocate it to their invoices.' : 'Payments recorded by your team will appear here.'} action={add} />
      ) : null}
      {page && page.payments.length > 0 ? (
        <>
          <Table aria-label="Payments received">
            <TableCaption>Most recent first. Amounts are in each payment's own currency.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead><TableHead>Customer</TableHead><TableHead className="hidden md:table-cell">Method</TableHead>
                <TableHead className="text-right">Amount</TableHead><TableHead className="hidden text-right sm:table-cell">Unallocated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap">
                    <button type="button" className="text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'payment', id: p.id })}>
                      {formatDate(p.receivedOn, locale)}<span className="sr-only">, open payment</span>
                    </button>
                    {p.status === 'REVERSED' ? <p className="text-xs font-medium text-destructive">Reversed</p> : null}
                  </TableCell>
                  <TableCell className={WRAP}>{env.names.get(p.customerId) ?? 'Customer'}{p.reference ? <p className="text-xs text-muted-foreground">{p.reference}</p> : null}</TableCell>
                  <TableCell className="hidden md:table-cell">{METHOD_LABEL[p.method]}</TableCell>
                  <TableCell className={`text-right whitespace-nowrap tabular-nums ${p.status === 'REVERSED' ? 'text-muted-foreground line-through' : ''}`}>{formatMoney(p.amount, p.currencyCode, locale)}</TableCell>
                  <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">{isPositive(p.unallocatedAmount) ? formatMoney(p.unallocatedAmount, p.currencyCode, locale) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager pager={pager} nextCursor={page.nextCursor} />
        </>
      ) : null}
    </ZonePage>
  );
}

/**
 * Record a payment received, optionally allocating it to the customer's open invoices in the same step
 * (all or nothing). The request carries an Idempotency-Key: a retry of the same details (after a lost
 * connection, a double click) returns the payment already recorded instead of recording it twice.
 */
export function PaymentForm({ prefill, onDone, onCancel }: { prefill?: PaymentPrefill; onDone: (p: FinancePayment) => void; onCancel: () => void }) {
  const env = useFinance();
  const { client, slug, locale, today, currency, markDirty } = env;
  const start = useMemo(() => ({
    customerId: prefill?.customerId ?? '', customerName: prefill?.customerId ? env.names.get(prefill.customerId) ?? null : null,
    currencyCode: prefill?.currencyCode ?? currency, amount: prefill?.amount ?? '', receivedOn: today, method: 'BANK_TRANSFER' as Method, reference: '',
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [v, setV] = useState(start);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [allocate, setAllocate] = useState(Boolean(prefill?.invoiceId));
  const submit = useSubmit(env.onSessionEnded);
  const keyFor = useIdempotencyKey();
  const dirty = JSON.stringify({ ...v, customerName: null }) !== JSON.stringify({ ...start, customerName: null }) || allocations.length > 0;
  useEffect(() => markDirty('form', dirty), [dirty, markDirty]);
  useEffect(() => () => markDirty('form', false), [markDirty]);
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const scale = currencyScale(v.currencyCode);
  const amountOk = toUnits(v.amount, scale) !== null && isPositive(v.amount);
  const currencies = useMemo(() => currencyOptions(currency, locale), [currency, locale]);
  const allocOk = !allocate || allocations.length === 0 || allocationsValid(allocations, amountOk ? v.amount.trim() : null, scale);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!v.customerId) return;
    const body = {
      customerId: v.customerId, currencyCode: v.currencyCode, amount: v.amount.trim(), receivedOn: v.receivedOn, method: v.method, reference: v.reference,
      ...(allocate && allocations.length > 0 ? { allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.trim() })) } : {}),
    };
    await submit.run(() => client.recordPayment(slug, body, keyFor(body)), (out) => {
      markDirty('form', false);
      onDone(out.data);
    });
  }

  return (
    <ZonePage title="Record payment" eyebrow="Finance · Payments" description={RECORD_NOTE}>
      <form onSubmit={save} noValidate className="space-y-8">
        {submit.error ? <Alert tone="danger" role="alert"><AlertDescription>{submit.error}</AlertDescription></Alert> : null}
        <FormSection title="Payment">
          <div className="grid gap-4 sm:grid-cols-2">
            {env.customers ? (
              <CustomerPicker id="payment-customer" customers={env.customers} slug={slug} selectedId={v.customerId} selectedName={v.customerName ?? env.names.get(v.customerId) ?? null}
                error={submit.fields.customerId} hint="Required. The customer who paid." locked={Boolean(prefill?.invoiceId)}
                onPick={(c) => { set({ customerId: c?.id ?? '', customerName: c?.displayName ?? null }); setAllocations([]); }} onSessionEnded={env.onSessionEnded} />
            ) : prefill?.customerId ? (
              <p className="text-sm sm:col-span-2">Customer: {env.names.get(prefill.customerId) ?? 'the invoice’s customer'}</p>
            ) : (
              <Alert tone="warning" className="sm:col-span-2"><AlertDescription>Choosing the customer needs access to the Customers Zone. Start from the invoice instead, or ask an owner or admin.</AlertDescription></Alert>
            )}
            <Field label="Amount" error={submit.fields.amount} hint="Exactly as received, e.g. 120 or 120.50.">{(c) => (
              <Input {...c} inputMode="decimal" value={v.amount} onChange={(e) => set({ amount: e.target.value })} />
            )}</Field>
            <Field label="Currency">{(c) => (
              <Select {...c} value={v.currencyCode} disabled={Boolean(prefill?.invoiceId)} onChange={(e) => { set({ currencyCode: e.target.value }); setAllocations([]); }}>
                {currencies.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
              </Select>
            )}</Field>
            <Field label="Received on" error={submit.fields.receivedOn} hint="Not in the future.">{(c) => (
              <Input {...c} type="date" max={today} value={v.receivedOn} onChange={(e) => set({ receivedOn: e.target.value })} />
            )}</Field>
            <Field label="Method">{(c) => (
              <Select {...c} value={v.method} onChange={(e) => set({ method: e.target.value as Method })}>
                {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            )}</Field>
            <Field label="Reference (optional)" hint="For example the bank transfer reference." className="sm:col-span-2">{(c) => (
              <Input {...c} maxLength={200} value={v.reference} onChange={(e) => set({ reference: e.target.value })} />
            )}</Field>
          </div>
        </FormSection>
        {v.customerId ? (
          <FormSection title="Allocation" description="Optional. What is not allocated stays on the payment as customer credit, to allocate later.">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="size-4" checked={allocate} onChange={(e) => { setAllocate(e.target.checked); if (!e.target.checked) setAllocations([]); }} />
              Allocate it to invoices now
            </label>
            {allocate ? (
              <InvoiceAllocator customerId={v.customerId} currencyCode={v.currencyCode} scale={scale} available={amountOk ? v.amount.trim() : null}
                preselect={prefill?.invoiceId} value={allocations}
                onChange={(next) => {
                  setAllocations(next);
                  // Started from an invoice with no amount typed yet: suggest its open amount as the payment.
                  if (prefill?.invoiceId && v.amount.trim() === '' && next.length === 1) set({ amount: next[0]!.amount });
                }} />
            ) : null}
          </FormSection>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={submit.busy} disabled={!v.customerId || !amountOk || !allocOk}>
            Record {amountOk ? formatMoney(v.amount.trim(), v.currencyCode, locale) : 'payment'}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={submit.busy}>Cancel</Button>
        </div>
      </form>
    </ZonePage>
  );
}

/** One payment received: where it went (live and reversed allocations), what is left, and its reversal. */
export function PaymentDetail({ id }: { id: string }) {
  const env = useFinance();
  const { client, slug, locale, timeZone, can } = env;
  const { state, reload, previous } = useLoad(`payment|${slug}|${id}`, (signal) => client.payment(slug, id, signal));
  const [action, setAction] = useState<null | 'allocate' | 'reverse' | { unallocate: string } | 'reference'>(null);
  const shown = state.status === 'done' ? (state.outcome.kind === 'ok' ? state.outcome.data : null) : previous?.kind === 'ok' ? previous.data : null;
  useRequestNames(shown ? [shown.customerId] : []);
  const back = <Button variant="outline" onClick={() => env.go({ name: 'payments' })}>All payments</Button>;
  if (!shown) {
    return (
      <ZonePage title="Payment" eyebrow="Finance" secondaryActions={back}>
        {state.status === 'loading' ? <LoadingRows label="Loading payment…" /> : (
          <Problem outcome={state.status === 'done' ? state.outcome : { kind: 'unreachable' }} what="This payment" onRetry={reload} onSessionEnded={env.onSessionEnded} />
        )}
      </ZonePage>
    );
  }
  const p = shown;
  const money = (v: string) => formatMoney(v, p.currencyCode, locale);
  const recorded = p.status === 'RECORDED';
  const done = (message: string) => {
    setAction(null);
    reload();
    env.go({ name: 'payment', id: p.id }, message);
  };
  const actions = recorded && can.payments ? (
    <>
      <Button variant="outline" onClick={() => setAction('reference')}>Edit reference</Button>
      <Button variant="outline" onClick={() => setAction('reverse')}>Reverse payment</Button>
      {isPositive(p.unallocatedAmount) ? <Button onClick={() => setAction('allocate')}>Allocate to invoices</Button> : null}
    </>
  ) : null;
  const customer = env.names.get(p.customerId) ?? 'Customer';
  return (
    <ZonePage title={`${money(p.amount)} from ${customer}`} eyebrow="Finance · Payment received" secondaryActions={back} primaryActions={actions}
      description={`${formatDate(p.receivedOn, locale)} · ${METHOD_LABEL[p.method]}${p.reference ? ` · ${p.reference}` : ''}`}>
      {p.status === 'REVERSED' ? (
        <Alert tone="warning"><AlertDescription>Reversed{p.reversedAt ? ` ${formatWhen(p.reversedAt, timeZone, locale)}` : ''}: {p.reversalReason}. Its allocations were reversed with it and are kept below as history.</AlertDescription></Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Amount</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm tabular-nums">
              <Row label="Received">{money(p.amount)}</Row>
              <Row label="Allocated to invoices">{money(p.allocatedTotal)}</Row>
              <Row label="Unallocated (customer credit)" strong>{money(p.unallocatedAmount)}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Item label="Customer">
                {env.onOpenCustomer ? <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => env.onOpenCustomer!(p.customerId)}>{customer}</button> : customer}
              </Item>
              <Item label="Received on">{formatDate(p.receivedOn, locale)}</Item>
              <Item label="Method">{METHOD_LABEL[p.method]}</Item>
              <Item label="Reference">{p.reference ?? '—'}</Item>
              <Item label="Recorded">{formatWhen(p.createdAt, timeZone, locale)}</Item>
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">A manual record of money received outside Business OS. It is not matched to any bank account.</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Allocations</CardTitle></CardHeader>
        <CardContent>
          {p.allocations.length === 0 ? <p className="text-sm text-muted-foreground">Not allocated to any invoice.</p> : (
            <ul className="divide-y text-sm">
              {p.allocations.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'document', path: 'invoices', id: a.invoiceId })}>
                    Invoice {a.invoiceNumber ?? ''} · {formatWhen(a.createdAt, timeZone, locale)}{a.reversedAt ? ` · reversed ${formatWhen(a.reversedAt, timeZone, locale)}` : ''}
                  </button>
                  <span className="flex items-center gap-2">
                    <span className={a.reversedAt ? 'text-muted-foreground line-through tabular-nums' : 'tabular-nums'}>{money(a.amount)}</span>
                    {!a.reversedAt && recorded && can.payments ? <Button size="sm" variant="outline" onClick={() => setAction({ unallocate: a.id })}>Reverse</Button> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {action === 'allocate' ? <AllocateDialog payment={p} onClose={() => setAction(null)} onDone={done} /> : null}
      {action === 'reverse' ? <ReversePaymentDialog payment={p} onClose={() => setAction(null)} onDone={done} onReload={() => { setAction(null); reload(); }} /> : null}
      {action === 'reference' ? <ReferenceDialog payment={p} onClose={() => setAction(null)} onDone={done} onReload={() => { setAction(null); reload(); }} /> : null}
      {action && typeof action === 'object' ? <UnallocateDialog payment={p} allocationId={action.unallocate} onClose={() => setAction(null)} onDone={done} /> : null}
    </ZonePage>
  );
}

function AllocateDialog({ payment, onClose, onDone }: { payment: FinancePayment; onClose: () => void; onDone: (m: string) => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded);
  const [value, setValue] = useState<Allocation[]>([]);
  return (
    <ConfirmDialog title="Allocate this payment" confirmLabel="Allocate"
      description={`${formatMoney(payment.unallocatedAmount, payment.currencyCode, env.locale)} of this payment is not allocated yet. Choose the invoices it pays.`}
      busy={submit.busy} error={submit.error} onClose={onClose} disabled={!allocationsValid(value, payment.unallocatedAmount, payment.currencyScale)}
      onConfirm={() => void submit.run(() => env.client.allocatePayment(env.slug, payment.id, { allocations: value.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.trim() })) }),
        () => onDone('Payment allocated.'))}>
      <InvoiceAllocator customerId={payment.customerId} currencyCode={payment.currencyCode} scale={payment.currencyScale} available={payment.unallocatedAmount} value={value} onChange={setValue} />
    </ConfirmDialog>
  );
}

function UnallocateDialog({ payment, allocationId, onClose, onDone }: { payment: FinancePayment; allocationId: string; onClose: () => void; onDone: (m: string) => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded);
  const a = payment.allocations.find((x) => x.id === allocationId);
  return (
    <ConfirmDialog title="Reverse this allocation?" confirmLabel="Reverse allocation" destructive
      description={`${a ? formatMoney(a.amount, payment.currencyCode, env.locale) : 'The amount'} goes back to the payment as unallocated, and invoice ${a?.invoiceNumber ?? ''} is open for it again. The payment stays recorded, and the allocation is kept as history.`}
      busy={submit.busy} error={submit.error} onClose={onClose}
      onConfirm={() => void submit.run(() => env.client.reverseAllocation(env.slug, payment.id, allocationId), () => onDone('Allocation reversed. The payment stays recorded.'))} />
  );
}

function ReversePaymentDialog({ payment, onClose, onDone, onReload }: { payment: FinancePayment; onClose: () => void; onDone: (m: string) => void; onReload: () => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded);
  const live = payment.allocations.filter((a) => !a.reversedAt).length;
  return (
    <ConfirmDialog title="Reverse this payment?" confirmLabel="Reverse payment" destructive reason="required"
      description={`Use this when the money did not arrive or was recorded by mistake (for example a bounced cheque). ${live > 0 ? `Its ${live} live allocation${live === 1 ? ' is' : 's are'} reversed with it, so those invoices are open again. ` : ''}The payment is kept, marked reversed. This cannot be undone.`}
      busy={submit.busy} error={submit.error} stale={submit.stale} onReload={onReload} onClose={onClose}
      onConfirm={(reason) => void submit.run(() => env.client.reversePayment(env.slug, payment.id, { version: payment.version, reason }), () => onDone('Payment reversed.'))} />
  );
}

function ReferenceDialog({ payment, onClose, onDone, onReload }: { payment: FinancePayment; onClose: () => void; onDone: (m: string) => void; onReload: () => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded);
  const [reference, setReference] = useState(payment.reference ?? '');
  return (
    <ConfirmDialog title="Edit the reference" confirmLabel="Save reference" description="The reference is the only detail of a recorded payment that can change."
      busy={submit.busy} error={submit.error} stale={submit.stale} onReload={onReload} onClose={onClose}
      onConfirm={() => void submit.run(() => env.client.updatePayment(env.slug, payment.id, { version: payment.version, reference }), () => onDone('Reference saved.'))}>
      <Field label="Reference" className="mt-4">{(c) => <Input {...c} maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}
