import type { FinanceDocument, FinanceDocumentListItem } from '@business-os/contracts';
import { Alert, AlertDescription, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useRef, useState } from 'react';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { compare, isPositive, min, subtract, sum } from './decimal';
import { openAmount } from './document-list';
import { useFinance } from './env';
import { formatDate, formatMoney } from './format';
import { ConfirmDialog, LoadingRows, useSubmit } from './shared';

export type Allocation = { invoiceId: string; amount: string };

/**
 * Choose issued, not fully settled invoices of one customer and currency and how much to settle on each.
 * The amounts are exact decimal strings; the running total and what would be left are computed with
 * integer arithmetic. The server and database check every limit again (over-settlement, over-allocation).
 */
export function InvoiceAllocator({ customerId, currencyCode, scale, available, preselect, value, onChange, onPreselect, label = 'Allocate to invoices' }: {
  customerId: string; currencyCode: string; scale: number;
  /** What there is to spread (payment amount, unallocated rest or available credit); null when not known yet. */
  available: string | null;
  /** The invoice this was started from. It is loaded on its own, so it is found however long the open list is. */
  preselect?: string; value: Allocation[]; onChange: (next: Allocation[]) => void;
  /**
   * Receives the preselected allocation (or none, when the invoice is not open) instead of `onChange`, so the
   * caller can treat it as the form's starting point rather than as a change the person made.
   */
  onPreselect?: (next: Allocation[]) => void;
  label?: string;
}) {
  const env = useFinance();
  const preselected = useRef(false);
  const [notOpen, setNotOpen] = useState<string | null>(null);
  const { state, reload } = useLoad(`open-invoices|${env.slug}|${customerId}`, async (signal) => {
    const out = await env.client.documents(env.slug, 'invoices', { status: 'all', settlement: 'open', customerId, limit: 100 }, signal);
    if (out.kind !== 'ok' || !preselect || preselected.current || signal.aborted) return out;
    // The invoice this was started from may be beyond the first page of open invoices: load it directly.
    let target: FinanceDocumentListItem | null = out.data.documents.find((d) => d.id === preselect) ?? null;
    let documents = out.data.documents;
    if (!target) {
      const one = await env.client.document(env.slug, 'invoices', preselect, signal);
      if (signal.aborted) return out;
      if (one.kind !== 'ok') return one;
      target = one.data;
      documents = [one.data, ...documents];
    }
    preselected.current = true;
    const open = openAmount(target);
    const eligible = target.status === 'ISSUED' && target.settlementState !== 'PAID' && target.customerId === customerId && target.currencyCode === currencyCode && open !== null && isPositive(open);
    const next = eligible && value.length === 0 ? [{ invoiceId: target.id, amount: available && isPositive(available) ? min(open!, available, scale) ?? open! : open! }] : [];
    if (!eligible) setNotOpen(`${target.number ?? 'That invoice'} is not open for settlement (it is a draft, void or already paid), so it is not selected.`);
    (onPreselect ?? onChange)(next);
    return { kind: 'ok', data: { ...out.data, documents: eligible ? documents : out.data.documents } };
  });
  const invoices = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data.documents.filter((d) => d.currencyCode === currencyCode) : null;

  const money = (v: string) => formatMoney(v, currencyCode, env.locale);
  const total = sum(value.map((a) => a.amount || '0'), scale);
  const left = available !== null && total !== null ? subtract(available, total, scale) : null;
  const over = left !== null && left.startsWith('-');
  const get = (id: string) => value.find((a) => a.invoiceId === id);
  const toggle = (id: string, open: string, on: boolean) => onChange(on
    ? [...value, { invoiceId: id, amount: left && isPositive(left) ? min(open, left, scale) ?? open : open }]
    : value.filter((a) => a.invoiceId !== id));
  const setAmount = (id: string, amount: string) => onChange(value.map((a) => (a.invoiceId === id ? { ...a, amount } : a)));

  return (
    <fieldset className="mt-4">
      <legend className="text-sm font-medium">{label}</legend>
      {notOpen ? <p role="status" className="mt-1 text-sm text-warning">{notOpen}</p> : null}
      {state.status === 'loading' ? <LoadingRows label="Loading open invoices…" rows={2} /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Open invoices" onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {invoices && invoices.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">This customer has no open {currencyCode} invoices.</p> : null}
      {invoices && invoices.length > 0 ? (
        <>
          <Table aria-label="Open invoices">
            <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead className="hidden sm:table-cell">Due</TableHead><TableHead className="text-right">Open</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
            <TableBody>
              {invoices.map((d) => {
                const open = openAmount(d) ?? d.total;
                const chosen = get(d.id);
                const tooMuch = chosen ? compare(chosen.amount || '0', open, scale) === 1 : false;
                return (
                  <TableRow key={d.id}>
                    <TableCell>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" className="size-4" checked={Boolean(chosen)} onChange={(e) => toggle(d.id, open, e.target.checked)} />
                        <span className="font-medium">{d.number}</span>
                      </label>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{formatDate(d.dueDate, env.locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(open)}</TableCell>
                    <TableCell className="text-right">
                      {chosen ? (
                        <>
                          <Input aria-label={`Amount for ${d.number}`} inputMode="decimal" className="ml-auto w-32 text-right" value={chosen.amount} aria-invalid={tooMuch || undefined}
                            onChange={(e) => setAmount(d.id, e.target.value)} />
                          {tooMuch ? <p className="mt-1 text-xs text-destructive">More than is open</p> : null}
                        </>
                      ) : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {state.status === 'done' && state.outcome.kind === 'ok' && state.outcome.data.nextCursor ? (
            <p className="mt-2 text-xs text-muted-foreground">Showing the 100 most recent open invoices.</p>
          ) : null}
        </>
      ) : null}
      {value.length > 0 ? (
        <p className={`mt-2 text-sm ${over ? 'font-medium text-destructive' : 'text-muted-foreground'}`} aria-live="polite">
          {total === null ? 'Enter amounts such as 120 or 120.50.' : `Settling ${money(total)}${left !== null ? (over ? ` — ${money(left.slice(1))} more than is available.` : `, leaving ${money(left)} unallocated.`) : '.'}`}
        </p>
      ) : null}
    </fieldset>
  );
}

/** True when every chosen amount is a valid, positive amount and together they fit in what is available. */
export function allocationsValid(value: Allocation[], available: string | null, scale: number): boolean {
  if (value.length === 0) return false;
  if (value.some((a) => !isPositive(a.amount) || sum([a.amount], scale) === null)) return false;
  const total = sum(value.map((a) => a.amount), scale);
  return total !== null && (available === null || compare(total, available, scale) !== 1);
}

/** Apply an issued credit note's available credit to open invoices of the same customer and currency. */
export function ApplyCreditDialog({ creditNote, onClose, onDone }: { creditNote: FinanceDocument; onClose: () => void; onDone: (m: string) => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded);
  const credit = useLoad(`credit-apply|${env.slug}|${creditNote.id}`, (signal) => env.client.credit(env.slug, creditNote.id, signal));
  const available = credit.state.status === 'done' && credit.state.outcome.kind === 'ok' ? credit.state.outcome.data.available : null;
  const [value, setValue] = useState<Allocation[]>([]);
  const money = (v: string) => formatMoney(v, creditNote.currencyCode, env.locale);
  return (
    <ConfirmDialog
      title={`Apply credit from ${creditNote.number}?`} confirmLabel="Apply credit"
      description={`Applying credit settles part of an invoice without any money changing hands. It is not cash received and not a refund. ${available ? `${money(available)} is available.` : ''}`}
      busy={submit.busy} error={submit.error} onClose={onClose} disabled={!allocationsValid(value, available, creditNote.currencyScale)}
      onConfirm={() => void submit.run(() => env.client.applyCredit(env.slug, creditNote.id, { applications: value.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.trim() })) }),
        () => onDone('Credit applied.'))}
    >
      {credit.state.status === 'done' && credit.state.outcome.kind !== 'ok' ? (
        <Alert tone="danger" className="mt-4"><AlertDescription>The available credit could not be loaded. Close this and try again.</AlertDescription></Alert>
      ) : null}
      <InvoiceAllocator customerId={creditNote.customerId} currencyCode={creditNote.currencyCode} scale={creditNote.currencyScale} available={available}
        preselect={creditNote.creditedInvoiceId ?? undefined} value={value} onChange={setValue} label="Apply to invoices" />
    </ConfirmDialog>
  );
}
