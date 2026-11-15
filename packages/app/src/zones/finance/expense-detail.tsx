import type { FinanceExpense } from '@business-os/contracts';
import {
  Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle,
  Field, Input, Select, Textarea,
} from '@business-os/ui';
import { useState, type ReactNode } from 'react';
import type { FinanceClient } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { LoadingRows } from './expense-list';
import { useSubmit } from './shared';
import {
  conflictMessage, formatDate, formatMoney, formatWhen, METHOD_LABEL, PAYMENT_LABEL, PAYMENT_TONE, STATUS_LABEL, STATUS_TONE, TREATMENT_LABEL,
} from './format';

type Action = null | 'record' | 'void';
const WRAP = '[overflow-wrap:anywhere]';

/**
 * One expense: its amounts and tax split as the server computed them, and its payments (live and reversed,
 * never hidden). Receipt attachments are deferred (FD-P6). Drafts can be edited, recorded or discarded; a recorded
 * expense can only be voided, and only once its payments are reversed.
 */
export function ExpenseDetail({ client, slug, id, locale, timeZone, today, categoryName, canWrite, canPay, onBack, onEdit, onPay, onOpenPayment, onChanged, onSessionEnded }: {
  client: FinanceClient; slug: string; id: string; locale?: string; timeZone: string; today: string; categoryName: (id: string) => string;
  canWrite: boolean; canPay: boolean; onBack: () => void; onEdit: (e: FinanceExpense) => void;
  /** F4: record a supplier payment against this expense (finance:payments). */
  onPay?: (e: FinanceExpense) => void;
  /** F4: open the payment made behind an allocation. */
  onOpenPayment?: (paymentId: string) => void;
  onChanged: (message: string) => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`expense|${slug}|${id}`, (signal) => client.expense(slug, id, signal));
  const [action, setAction] = useState<Action>(null);
  const back = <Button variant="outline" onClick={onBack}>All expenses</Button>;
  if (state.status === 'loading') return <ZonePage title="Expense" eyebrow="Finance" secondaryActions={back}><LoadingRows label="Loading expense…" /></ZonePage>;
  if (state.outcome.kind !== 'ok') {
    return (
      <ZonePage title="Expense" eyebrow="Finance" secondaryActions={back}>
        <Problem outcome={state.outcome} what="This expense" onRetry={reload} onSessionEnded={onSessionEnded} />
      </ZonePage>
    );
  }
  const e = state.outcome.data;
  const money = (v: string) => formatMoney(v, e.currencyCode, locale);
  const payable = e.status === 'RECORDED' && e.paymentState !== 'PAID' && onPay;
  const actions = canWrite || payable ? (
    <>
      {canWrite && e.status === 'DRAFT' ? <Button variant="outline" onClick={() => onEdit(e)}>Edit</Button> : null}
      {canWrite && e.status === 'DRAFT' ? <Button variant="outline" onClick={() => setAction('void')}>Discard draft</Button> : null}
      {canWrite && e.status === 'RECORDED' ? <Button variant="outline" onClick={() => setAction('void')}>Void</Button> : null}
      {canWrite && e.status === 'DRAFT' ? <Button onClick={() => setAction('record')}>Record expense</Button> : null}
      {payable ? <Button onClick={() => onPay(e)}>Record payment</Button> : null}
    </>
  ) : null;
  const done = (message: string) => {
    setAction(null);
    reload();
    onChanged(message);
  };

  return (
    <ZonePage
      title={e.supplierName ?? e.description} eyebrow="Finance · Expense"
      description={<span className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
        {e.paymentState ? <Badge tone={PAYMENT_TONE[e.paymentState]}>{PAYMENT_LABEL[e.paymentState]}</Badge> : null}
        {e.overdue ? <Badge tone="danger">Overdue</Badge> : null}
      </span>}
      secondaryActions={back} primaryActions={actions}
    >
      {e.status === 'VOID' && e.voidReason ? <Alert tone="warning"><AlertDescription>Voided: {e.voidReason}</AlertDescription></Alert> : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Item label="Description">{e.description}</Item>
              <Item label="Supplier">{e.supplierName ?? '—'}</Item>
              <Item label="Reference">{e.referenceNumber ?? '—'}</Item>
              <Item label="Category">{e.categoryName ?? categoryName(e.categoryId)}</Item>
              <Item label="Date">{formatDate(e.incurredOn, locale)}</Item>
              <Item label="Due">{formatDate(e.dueDate, locale)}</Item>
              {e.notes ? <Item label="Notes" wide>{e.notes}</Item> : null}
              {e.recordedAt ? <Item label="Recorded">{formatWhen(e.recordedAt, timeZone, locale)}</Item> : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Amount</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm tabular-nums">
              <Row label="Subtotal">{money(e.subtotal)}</Row>
              <Row label={e.taxName ? `${e.taxName} (${e.taxRatePercent}%)` : 'Tax'}>{money(e.taxAmount)}</Row>
              <Row label="Total" strong>{money(e.total)}</Row>
              {e.status === 'RECORDED' ? <><Row label="Paid">{money(e.paidTotal)}</Row><Row label="Left to pay" strong>{money(e.outstanding)}</Row></> : null}
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{TREATMENT_LABEL[e.taxTreatment]}. {e.currencyCode}.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
        <CardContent>
          {e.allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{e.status === 'RECORDED' ? 'No payments recorded against this expense.' : 'Payments can be recorded once the expense is recorded.'}</p>
          ) : (
            <ul className="divide-y text-sm">
              {e.allocations.map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
                  {onOpenPayment ? (
                    <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onOpenPayment(a.paymentId)}>
                      {formatDate(a.paidOn, locale)} · {METHOD_LABEL[a.method]}{a.reversedAt ? ' · reversed' : ''}
                    </button>
                  ) : <span>{formatDate(a.paidOn, locale)} · {METHOD_LABEL[a.method]}{a.reversedAt ? ' · reversed' : ''}</span>}
                  <span className={a.reversedAt ? 'text-muted-foreground line-through tabular-nums' : 'tabular-nums'}>{money(a.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {action === 'record' ? (
        <RecordDialog client={client} slug={slug} expense={e} today={today} canPay={canPay} money={money}
          onClose={() => setAction(null)} onDone={done} onSessionEnded={onSessionEnded} />
      ) : null}
      {action === 'void' ? (
        <VoidDialog client={client} slug={slug} expense={e} money={money} onClose={() => setAction(null)} onDone={done} onSessionEnded={onSessionEnded} />
      ) : null}
    </ZonePage>
  );
}

function Item({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-sm ${WRAP} whitespace-pre-line`}>{children}</dd>
    </div>
  );
}
function Row({ label, strong, children }: { label: string; strong?: boolean; children: ReactNode }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? 'font-semibold' : ''}`}>
      <dt className={strong ? undefined : 'text-muted-foreground'}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function RecordDialog({ client, slug, expense, today, canPay, money, onClose, onDone, onSessionEnded }: {
  client: FinanceClient; slug: string; expense: FinanceExpense; today: string; canPay: boolean; money: (v: string) => string;
  onClose: () => void; onDone: (message: string) => void; onSessionEnded: () => void;
}) {
  const [paid, setPaid] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<keyof typeof METHOD_LABEL>('BANK_TRANSFER');
  const { busy, error, run } = useSubmit(onSessionEnded);
  const submit = () => run(
    () => client.recordExpense(slug, expense.id, { version: expense.version, ...(paid ? { paidInFull: { paidOn, method } } : {}) }),
    () => onDone(paid ? 'Expense recorded and marked as paid.' : 'Expense recorded.'),
  );
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogTitle>Record this expense?</DialogTitle>
        <DialogDescription>
          Recording {money(expense.total)} fixes its amounts, tax and category. After that it can only be voided, not edited.
        </DialogDescription>
        {canPay ? (
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="size-4" /> It has already been paid in full
            </label>
            {paid ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Paid on">{(c) => <Input {...c} type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
                <Field label="Method">{(c) => (
                  <Select {...c} value={method} onChange={(e) => setMethod(e.target.value as keyof typeof METHOD_LABEL)}>
                    {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                )}</Field>
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-4 text-sm font-medium text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy}>Record expense</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoidDialog({ client, slug, expense, money, onClose, onDone, onSessionEnded }: {
  client: FinanceClient; slug: string; expense: FinanceExpense; money: (v: string) => string; onClose: () => void; onDone: (message: string) => void; onSessionEnded: () => void;
}) {
  const draft = expense.status === 'DRAFT';
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(onSessionEnded);
  // Exact string check (no float): any non-zero digit in the paid total means live payments.
  const blocked = !draft && /[1-9]/.test(expense.paidTotal);
  const submit = () => run(
    () => client.voidExpense(slug, expense.id, { version: expense.version, reason: reason.trim() || null }),
    () => onDone(draft ? 'Draft discarded.' : 'Expense voided.'),
  );
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogTitle>{draft ? 'Discard this draft?' : 'Void this expense?'}</DialogTitle>
        <DialogDescription>
          {draft
            ? 'The draft is kept in the history but no longer counts.'
            : `Voiding ${money(expense.total)} removes it from payables and reports. It stays in the history and cannot be undone.`}
        </DialogDescription>
        {blocked ? (
          <Alert tone="warning" className="mt-4"><AlertDescription>{conflictMessage('has_payments')}</AlertDescription></Alert>
        ) : (
          <Field label={draft ? 'Reason (optional)' : 'Reason'} className="mt-4">
            {(c) => <Textarea {...c} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        )}
        {error ? <p role="alert" className="mt-4 text-sm font-medium text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          {blocked ? null : (
            <Button variant="destructive" onClick={submit} loading={busy} disabled={!draft && reason.trim() === ''}>{draft ? 'Discard draft' : 'Void expense'}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
