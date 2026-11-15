import type { ExpensePayment, FinanceExpense, FinanceExpenseListItem } from '@business-os/contracts';
import {
  Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Field, FormSection, Input, Select, Table, TableBody, TableCaption, TableCell,
  TableHead, TableHeader, TableRow,
} from '@business-os/ui';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ExpensePaymentQuery } from '../../api/finance';
import { ZonePage, type ZonePageTab } from '../../shell/zone-page';
import { Problem } from '../problem';
import { currencyOptions } from '../sales/format';
import { useLoad } from '../use-load';
import { compare, currencyScale, isPositive, min, subtract, sum, toUnits } from './decimal';
import { useFinance } from './env';
import { formatDate, formatMoney, formatWhen, METHOD_LABEL } from './format';
import { ConfirmDialog, EmptyBox, Item, LoadingRows, okData, Pager, Row, useIdempotencyKey, usePager, useSubmit, WRAP } from './shared';

type Method = keyof typeof METHOD_LABEL;
type Allocation = { expenseId: string; amount: string };
const NOTE = 'Records of money paid to suppliers outside Business OS, matched to recorded expenses. Nothing is paid from here and no bank account is read.';

/** Payments made to suppliers (F3, direction PAID), filtered and paged on the server. */
export function ExpensePaymentList({ tabs, onTab }: { tabs: readonly ZonePageTab[]; onTab: (id: string) => void }) {
  const env = useFinance();
  const [status, setStatus] = useState<ExpensePaymentQuery['status']>('all');
  const pager = usePager(status);
  const { state, reload } = useLoad(`expense-payments|${env.slug}|${status}|${pager.cursor ?? ''}`, (signal) =>
    env.client.expensePayments(env.slug, { status, cursor: pager.cursor, limit: 25 }, signal));
  const page = okData(state);
  const add = env.can.payments ? <Button onClick={() => env.go({ name: 'expense-payment-new' })}>Record supplier payment</Button> : undefined;
  return (
    <ZonePage title="Payments made" eyebrow="Finance" description={NOTE} primaryActions={add} tabs={tabs} currentTab="payments-made" onTab={onTab}>
      <div className="max-w-xs">
        <Field label="Status">{(c) => (
          <Select {...c} value={status} onChange={(e) => setStatus(e.target.value as ExpensePaymentQuery['status'])}>
            <option value="all">All</option><option value="recorded">Recorded</option><option value="reversed">Reversed</option>
          </Select>
        )}</Field>
      </div>
      {state.status === 'loading' ? <LoadingRows label="Loading payments made…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Payments made" onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {page && page.payments.length === 0 ? (
        <EmptyBox title={status === 'all' ? 'No supplier payments recorded yet' : 'No payments match'} body={env.can.payments ? 'Record a payment to a supplier and match it to the expenses it pays.' : 'Supplier payments recorded by your team will appear here.'} action={status === 'all' ? add : undefined} />
      ) : null}
      {page && page.payments.length > 0 ? (
        <>
          <Table aria-label="Payments made">
            <TableCaption>Most recent first. Amounts are in each payment's own currency.</TableCaption>
            <TableHeader><TableRow><TableHead>Paid</TableHead><TableHead>Payee</TableHead><TableHead className="hidden md:table-cell">Method</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
            <TableBody>
              {page.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap">
                    <button type="button" className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'expense-payment', id: p.id })}>{formatDate(p.paidOn, env.locale)}<span className="sr-only">, open payment</span></button>
                    {p.status === 'REVERSED' ? <p className="text-xs font-medium text-destructive">Reversed</p> : null}
                  </TableCell>
                  <TableCell className={WRAP}>{p.payeeName ?? 'Supplier'}{p.reference ? <p className="text-xs text-muted-foreground">{p.reference}</p> : null}</TableCell>
                  <TableCell className="hidden md:table-cell">{METHOD_LABEL[p.method]}</TableCell>
                  <TableCell className={`text-right whitespace-nowrap tabular-nums ${p.status === 'REVERSED' ? 'text-muted-foreground line-through' : ''}`}>{formatMoney(p.amount, p.currencyCode, env.locale)}</TableCell>
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

/** Choose recorded, not fully paid expenses of one currency and how much of each this payment covers. */
function ExpenseAllocator({ currencyCode, scale, available, preselect, value, onChange }: {
  currencyCode: string; scale: number; available: string | null; preselect?: string; value: Allocation[]; onChange: (v: Allocation[]) => void;
}) {
  const env = useFinance();
  const preselected = useRef(false);
  const { state, reload } = useLoad(`open-expenses|${env.slug}|${currencyCode}`, async (signal) => {
    const out = await env.client.expenses(env.slug, { status: 'recorded', payment: 'open', limit: 100 }, signal);
    if (out.kind === 'ok' && preselect && !preselected.current && !signal.aborted) {
      preselected.current = true;
      const e = out.data.expenses.find((x) => x.id === preselect && x.currencyCode === currencyCode);
      if (e && value.length === 0) onChange([{ expenseId: e.id, amount: e.outstanding }]);
    }
    return out;
  });
  const open = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data.expenses.filter((e) => e.currencyCode === currencyCode) : null;
  const money = (v: string) => formatMoney(v, currencyCode, env.locale);
  const total = sum(value.map((a) => a.amount || '0'), scale);
  const left = available !== null && total !== null ? subtract(available, total, scale) : null;
  const over = left?.startsWith('-') ?? false;
  const toggle = (e: FinanceExpenseListItem, on: boolean) => onChange(on
    ? [...value, { expenseId: e.id, amount: left && isPositive(left) ? min(e.outstanding, left, scale) ?? e.outstanding : e.outstanding }]
    : value.filter((a) => a.expenseId !== e.id));
  return (
    <div className="mt-4">
      {state.status === 'loading' ? <LoadingRows label="Loading unpaid expenses…" rows={2} /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Unpaid expenses" onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {open && open.length === 0 ? <p className="text-sm text-muted-foreground">No recorded, unpaid {currencyCode} expenses.</p> : null}
      {open && open.length > 0 ? (
        <Table aria-label="Unpaid expenses">
          <TableHeader><TableRow><TableHead>Expense</TableHead><TableHead className="text-right">Left to pay</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
          <TableBody>
            {open.map((e) => {
              const chosen = value.find((a) => a.expenseId === e.id);
              const tooMuch = chosen ? compare(chosen.amount || '0', e.outstanding, scale) === 1 : false;
              return (
                <TableRow key={e.id}>
                  <TableCell className={WRAP}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="size-4" checked={Boolean(chosen)} onChange={(ev) => toggle(e, ev.target.checked)} />
                      <span><span className="font-medium">{e.supplierName ?? e.description}</span> <span className="text-xs text-muted-foreground">{formatDate(e.incurredOn, env.locale)}</span></span>
                    </label>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(e.outstanding)}</TableCell>
                  <TableCell className="text-right">
                    {chosen ? (
                      <>
                        <Input aria-label={`Amount for ${e.supplierName ?? e.description}`} inputMode="decimal" className="ml-auto w-32 text-right" value={chosen.amount} aria-invalid={tooMuch || undefined}
                          onChange={(ev) => onChange(value.map((a) => (a.expenseId === e.id ? { ...a, amount: ev.target.value } : a)))} />
                        {tooMuch ? <p className="mt-1 text-xs text-destructive">More than is left to pay</p> : null}
                      </>
                    ) : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
      {value.length > 0 && total !== null ? (
        <p className={`mt-2 text-sm ${over ? 'font-medium text-destructive' : 'text-muted-foreground'}`} aria-live="polite">
          Paying {money(total)}{left !== null ? (over ? ` — ${money(left.slice(1))} more than the payment.` : `, leaving ${money(left)} unallocated.`) : '.'}
        </p>
      ) : null}
    </div>
  );
}

const valid = (value: Allocation[], available: string | null, scale: number) => {
  if (value.some((a) => !isPositive(a.amount) || toUnits(a.amount, scale) === null)) return false;
  const total = sum(value.map((a) => a.amount), scale);
  return total !== null && (available === null || compare(total, available, scale) !== 1);
};

/** Record a payment made to a supplier, optionally matched to unpaid expenses in the same step (Idempotency-Key). */
export function ExpensePaymentForm({ expenseId, onDone, onCancel }: { expenseId?: string; onDone: (p: ExpensePayment) => void; onCancel: () => void }) {
  const env = useFinance();
  const { currency, locale, today, markDirty } = env;
  const start = useMemo(() => ({ payeeName: '', currencyCode: currency, amount: '', paidOn: today, method: 'BANK_TRANSFER' as Method, reference: '' }), [currency, today]);
  const [v, setV] = useState(start);
  const [seeded, setSeeded] = useState(!expenseId);
  // Starting from an expense ("Record payment" on it): the payee, currency and amount left to pay are filled in once.
  const pre = useLoad<FinanceExpense | null>(`expense-prefill|${env.slug}|${expenseId ?? ''}`, async (signal) => {
    if (!expenseId) return { kind: 'ok' as const, data: null };
    const out = await env.client.expense(env.slug, expenseId, signal);
    if (out.kind === 'ok' && !signal.aborted) {
      setV((x) => ({ ...x, payeeName: out.data.supplierName ?? '', currencyCode: out.data.currencyCode, amount: out.data.outstanding }));
      setSeeded(true);
    }
    return out;
  });
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const submit = useSubmit(env.onSessionEnded);
  const keyFor = useIdempotencyKey();
  const dirty = (JSON.stringify(v) !== JSON.stringify(start) && !expenseId) || allocations.length > 0;
  useEffect(() => markDirty('form', dirty), [dirty, markDirty]);
  useEffect(() => () => markDirty('form', false), [markDirty]);
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const scale = currencyScale(v.currencyCode);
  const amountOk = isPositive(v.amount) && toUnits(v.amount, scale) !== null;
  const currencies = useMemo(() => currencyOptions(currency, locale), [currency, locale]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const body = {
      payeeName: v.payeeName, currencyCode: v.currencyCode, amount: v.amount.trim(), paidOn: v.paidOn, method: v.method, reference: v.reference,
      ...(allocations.length > 0 ? { allocations: allocations.map((a) => ({ expenseId: a.expenseId, amount: a.amount.trim() })) } : {}),
    };
    await submit.run(() => env.client.recordExpensePayment(env.slug, body, keyFor(body)), (out) => {
      markDirty('form', false);
      onDone(out.data);
    });
  }
  if (!seeded) {
    return (
      <ZonePage title="Record supplier payment" eyebrow="Finance · Payments made">
        {pre.state.status === 'done' && pre.state.outcome.kind !== 'ok'
          ? <Problem outcome={pre.state.outcome} what="The expense" onRetry={pre.reload} onSessionEnded={env.onSessionEnded} />
          : <LoadingRows label="Loading the expense…" />}
      </ZonePage>
    );
  }
  return (
    <ZonePage title="Record supplier payment" eyebrow="Finance · Payments made" description={NOTE}>
      <form onSubmit={save} noValidate className="space-y-8">
        {submit.error ? <Alert tone="danger" role="alert"><AlertDescription>{submit.error}</AlertDescription></Alert> : null}
        <FormSection title="Payment">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Paid to (optional)" hint="The supplier's name, as free text.">{(c) => <Input {...c} maxLength={200} value={v.payeeName} onChange={(e) => set({ payeeName: e.target.value })} />}</Field>
            <Field label="Amount" error={submit.fields.amount}>{(c) => <Input {...c} inputMode="decimal" value={v.amount} onChange={(e) => set({ amount: e.target.value })} />}</Field>
            <Field label="Currency">{(c) => (
              <Select {...c} value={v.currencyCode} onChange={(e) => { set({ currencyCode: e.target.value }); setAllocations([]); }}>
                {currencies.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
              </Select>
            )}</Field>
            <Field label="Paid on" hint="Not in the future.">{(c) => <Input {...c} type="date" max={today} value={v.paidOn} onChange={(e) => set({ paidOn: e.target.value })} />}</Field>
            <Field label="Method">{(c) => (
              <Select {...c} value={v.method} onChange={(e) => set({ method: e.target.value as Method })}>
                {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            )}</Field>
            <Field label="Reference (optional)">{(c) => <Input {...c} maxLength={200} value={v.reference} onChange={(e) => set({ reference: e.target.value })} />}</Field>
          </div>
        </FormSection>
        <FormSection title="Expenses it pays" description="Optional. What is not matched stays on the payment, to match later.">
          <ExpenseAllocator currencyCode={v.currencyCode} scale={scale} available={amountOk ? v.amount.trim() : null} preselect={expenseId} value={allocations} onChange={setAllocations} />
        </FormSection>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={submit.busy} disabled={!amountOk || (allocations.length > 0 && !valid(allocations, v.amount.trim(), scale))}>
            Record {amountOk ? formatMoney(v.amount.trim(), v.currencyCode, locale) : 'payment'}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={submit.busy}>Cancel</Button>
        </div>
      </form>
    </ZonePage>
  );
}

/** One payment made: the expenses it pays (live and reversed), what is unmatched, and its reversal. */
export function ExpensePaymentDetail({ id }: { id: string }) {
  const env = useFinance();
  const { state, reload, previous } = useLoad(`expense-payment|${env.slug}|${id}`, (signal) => env.client.expensePayment(env.slug, id, signal));
  const [action, setAction] = useState<null | 'allocate' | 'reverse' | { unallocate: string }>(null);
  const submit = useSubmit(env.onSessionEnded);
  const [value, setValue] = useState<Allocation[]>([]);
  const shown = state.status === 'done' ? (state.outcome.kind === 'ok' ? state.outcome.data : null) : previous?.kind === 'ok' ? previous.data : null;
  const back = <Button variant="outline" onClick={() => env.go({ name: 'expense-payments' })}>All payments made</Button>;
  if (!shown) {
    return (
      <ZonePage title="Payment made" eyebrow="Finance" secondaryActions={back}>
        {state.status === 'loading' ? <LoadingRows label="Loading payment…" /> : (
          <Problem outcome={state.status === 'done' ? state.outcome : { kind: 'unreachable' }} what="This payment" onRetry={reload} onSessionEnded={env.onSessionEnded} />
        )}
      </ZonePage>
    );
  }
  const p = shown;
  const money = (x: string) => formatMoney(x, p.currencyCode, env.locale);
  const recorded = p.status === 'RECORDED';
  const done = (m: string) => {
    setAction(null);
    setValue([]);
    reload();
    env.go({ name: 'expense-payment', id: p.id }, m);
  };
  const actions = recorded && env.can.payments ? (
    <>
      <Button variant="outline" onClick={() => setAction('reverse')}>Reverse payment</Button>
      {isPositive(p.unallocatedAmount) ? <Button onClick={() => setAction('allocate')}>Match to expenses</Button> : null}
    </>
  ) : null;
  const unallocating = action && typeof action === 'object' ? p.allocations.find((a) => a.id === action.unallocate) : undefined;
  return (
    <ZonePage title={`${money(p.amount)} to ${p.payeeName ?? 'a supplier'}`} eyebrow="Finance · Payment made" secondaryActions={back} primaryActions={actions}
      description={`${formatDate(p.paidOn, env.locale)} · ${METHOD_LABEL[p.method]}${p.reference ? ` · ${p.reference}` : ''}`}>
      {p.status === 'REVERSED' ? <Alert tone="warning"><AlertDescription>Reversed: {p.reversalReason}. Its expense links were reversed with it and are kept below.</AlertDescription></Alert> : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Amount</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm tabular-nums">
              <Row label="Paid">{money(p.amount)}</Row>
              <Row label="Matched to expenses">{money(p.allocatedTotal)}</Row>
              <Row label="Not matched" strong>{money(p.unallocatedAmount)}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Item label="Paid to">{p.payeeName ?? '—'}</Item>
              <Item label="Paid on">{formatDate(p.paidOn, env.locale)}</Item>
              <Item label="Method">{METHOD_LABEL[p.method]}</Item>
              <Item label="Reference">{p.reference ?? '—'}</Item>
              <Item label="Recorded">{formatWhen(p.createdAt, env.timeZone, env.locale)}</Item>
            </dl>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Expenses</CardTitle></CardHeader>
        <CardContent>
          {p.allocations.length === 0 ? <p className="text-sm text-muted-foreground">Not matched to any expense.</p> : (
            <ul className="divide-y text-sm">
              {p.allocations.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => env.go({ name: 'expense', id: a.expenseId })}>
                    Expense · {formatWhen(a.createdAt, env.timeZone, env.locale)}{a.reversedAt ? ' · reversed' : ''}
                  </button>
                  <span className="flex items-center gap-2">
                    <span className={a.reversedAt ? 'text-muted-foreground line-through tabular-nums' : 'tabular-nums'}>{money(a.amount)}</span>
                    {!a.reversedAt && recorded && env.can.payments ? <Button size="sm" variant="outline" onClick={() => setAction({ unallocate: a.id })}>Reverse</Button> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {action === 'allocate' ? (
        <ConfirmDialog title="Match this payment to expenses" confirmLabel="Match" description={`${money(p.unallocatedAmount)} of this payment is not matched yet.`}
          busy={submit.busy} error={submit.error} onClose={() => setAction(null)} disabled={value.length === 0 || !valid(value, p.unallocatedAmount, p.currencyScale)}
          onConfirm={() => void submit.run(() => env.client.allocateExpensePayment(env.slug, p.id, { allocations: value.map((a) => ({ expenseId: a.expenseId, amount: a.amount.trim() })) }), () => done('Payment matched.'))}>
          <ExpenseAllocator currencyCode={p.currencyCode} scale={p.currencyScale} available={p.unallocatedAmount} value={value} onChange={setValue} />
        </ConfirmDialog>
      ) : null}
      {action === 'reverse' ? (
        <ConfirmDialog title="Reverse this payment?" confirmLabel="Reverse payment" destructive reason="required"
          description="Use this when the payment did not go through or was recorded by mistake. Its expense links are reversed with it, so those expenses are unpaid again. The payment is kept, marked reversed. This cannot be undone."
          busy={submit.busy} error={submit.error} stale={submit.stale} onReload={() => { setAction(null); reload(); }} onClose={() => setAction(null)}
          onConfirm={(reason) => void submit.run(() => env.client.reverseExpensePayment(env.slug, p.id, { version: p.version, reason }), () => done('Payment reversed.'))} />
      ) : null}
      {unallocating ? (
        <ConfirmDialog title="Reverse this link?" confirmLabel="Reverse link" destructive
          description={`${money(unallocating.amount)} goes back to the payment as not matched, and the expense is unpaid by that much again. The payment stays recorded.`}
          busy={submit.busy} error={submit.error} onClose={() => setAction(null)}
          onConfirm={() => void submit.run(() => env.client.reverseExpenseAllocation(env.slug, p.id, unallocating.id), () => done('Link reversed. The payment stays recorded.'))} />
      ) : null}
    </ZonePage>
  );
}
