import type { FinanceDocumentKind, FinanceDocumentStatus } from '@business-os/contracts';
import {
  Alert, AlertDescription, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Textarea, type BadgeTone,
} from '@business-os/ui';
import { useRef, useState, type ReactNode } from 'react';
import type { Outcome } from '../../api/tenancy';

// Pieces shared by the F4 Finance screens: words for states and server errors, confirmation dialogs,
// submit handling (one request at a time, every failure in words) and idempotency keys.

export const WRAP = '[overflow-wrap:anywhere]';

export const KIND_LABEL: Record<FinanceDocumentKind, string> = { QUOTE: 'Quote', INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note' };
export const DOC_STATUS_LABEL: Record<FinanceDocumentStatus, string> = {
  DRAFT: 'Draft', ISSUED: 'Issued', ACCEPTED: 'Accepted', DECLINED: 'Declined', EXPIRED: 'Expired', VOID: 'Void',
};
export const DOC_STATUS_TONE: Record<FinanceDocumentStatus, BadgeTone> = {
  DRAFT: 'neutral', ISSUED: 'brand', ACCEPTED: 'success', DECLINED: 'warning', EXPIRED: 'neutral', VOID: 'danger',
};
export const SETTLEMENT_LABEL = { UNPAID: 'Unpaid', PARTIALLY_PAID: 'Partly paid', PAID: 'Paid' } as const;
export const SETTLEMENT_TONE: Record<keyof typeof SETTLEMENT_LABEL, BadgeTone> = { UNPAID: 'warning', PARTIALLY_PAID: 'info', PAID: 'success' };

export function DocumentBadges({ status, settlement, overdue }: { status: FinanceDocumentStatus; settlement?: keyof typeof SETTLEMENT_LABEL | null; overdue?: boolean }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge tone={DOC_STATUS_TONE[status]}>{DOC_STATUS_LABEL[status]}</Badge>
      {settlement ? <Badge tone={SETTLEMENT_TONE[settlement]}>{SETTLEMENT_LABEL[settlement]}</Badge> : null}
      {overdue ? <Badge tone="danger">Overdue</Badge> : null}
    </span>
  );
}

/** Issued, not fully settled and due before the business's today: the same rule as the server. */
export function isOverdue(d: { status: FinanceDocumentStatus; kind: FinanceDocumentKind; settlementState: string | null; dueDate: string | null }, today: string) {
  return d.kind === 'INVOICE' && d.status === 'ISSUED' && d.settlementState !== 'PAID' && d.dueDate !== null && d.dueDate < today;
}

export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Server error codes of the F1–F3 finance endpoints, in words a person can act on. */
export function financeMessage(code: string | undefined): string {
  switch (code) {
    case 'stale': return 'Someone else changed this record since you opened it. Reload it to see the latest version, then try again.';
    case 'immutable': return 'This record has been issued or recorded, so it can no longer be edited.';
    case 'invalid_state': return 'This record is no longer in a state that allows that. Reload it to see where it is now.';
    case 'archived_reference': return 'The customer, product or service, tax rate, category or project you chose has been archived. Choose an active one.';
    case 'catalog_item_inactive': return 'A product or service on this draft has been marked inactive. Remove that line or keep it as a manual line.';
    case 'idempotency_conflict': return 'That request was already used for different details. Nothing was recorded twice. Close this form and start again.';
    case 'invoice_not_open': return 'That invoice is not open for settlement (it is a draft, void or already settled).';
    case 'payment_not_open': return 'That payment has been reversed, so it can no longer be allocated.';
    case 'credit_note_not_open': return 'That credit note is not issued, so its credit cannot be applied.';
    case 'over_settlement': return 'That is more than the invoice has left to settle.';
    case 'over_allocation': return 'That is more than the payment has left to allocate.';
    case 'over_application': return 'That is more than the credit note has left to apply.';
    case 'over_payment': return 'That is more than the expense has left to pay.';
    case 'already_allocated': return 'This payment is already allocated to that invoice. Reverse the existing allocation first to change it.';
    case 'already_applied': return 'This credit note is already applied to that invoice. Reverse the existing application first to change it.';
    case 'already_reversed': return 'That has already been reversed.';
    case 'invoice_has_payments': return 'Payments are allocated to this invoice. Reverse those allocations first (the payments stay recorded), then void it.';
    case 'has_credit_applications': return 'Credit is applied to or from this document. Reverse those applications first.';
    case 'invoice_credited': return 'A credit note has been issued against this invoice, so it cannot be voided. Void the credit note first, or keep both.';
    case 'credit_exceeds_invoice': return 'Issued credit notes for this invoice would add up to more than its total.';
    case 'quote_not_convertible': return 'Only an issued or accepted quote can be turned into an invoice.';
    case 'series_in_use': return 'This numbering series has already issued a number, so its starting value is fixed.';
    case 'duplicate_name': return 'An active record already has that name.';
    case 'has_payments': return 'Payments are linked to this expense. Reverse those payment links first (the payments stay recorded), then void it.';
    case 'expense_not_open': return 'That expense is not recorded and open, so it cannot be paid.';
    case 'totals_mismatch': return 'The totals no longer match the lines. Reload the draft and try again.';
    case 'not_eligible': return 'A PDF can only be kept for a numbered quote or invoice. Drafts have a preview only.';
    case 'not_draft': return 'This is no longer a draft. Reload to see its stored PDFs.';
    case 'no_original': return 'This document was issued before PDFs were kept, so it has no original PDF to add versions to.';
    case 'version_limit': return 'This document already has the maximum number of PDF versions.';
    case 'document_too_large': return 'This document is too large to make into a PDF. Shorten its notes or lines.';
    case 'branding_logo_invalid': return 'The logo could not be used. Upload it again in Finance settings, Documents.';
    default: return 'That change could not be made. Reload and try again.';
  }
}

export type SubmitResult = { kind: string; code?: string; message?: string; fields?: Record<string, string> };

/**
 * How a request that got no answer should be described. `idempotent`: the request carried an
 * Idempotency-Key, so repeating exactly the same request is safe. `versioned`: a change based on a
 * version, which a repeat would refuse as stale if the first attempt went through, so the person should
 * reload and check first. Either way the server may already have done it: never say "nothing changed".
 */
export type Uncertainty = 'idempotent' | 'versioned';

/**
 * One request at a time, and every failure in words. `stale` is set when the server says the record
 * changed underneath (409 stale), so the screen can offer a reload instead of a blind retry. A call that
 * rejects (a bug, an aborted fetch) is handled like a request that got no answer: shown, never thrown.
 */
export function useSubmit(onSessionEnded: () => void, uncertainty: Uncertainty = 'versioned') {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  async function run<T extends SubmitResult>(call: () => Promise<T>, onOk: (out: Extract<T, { kind: 'ok' }>) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setFields({});
    setStale(false);
    let out: SubmitResult;
    try {
      out = await call();
    } catch {
      out = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (out.kind === 'ok') return onOk(out as Extract<T, { kind: 'ok' }>);
    setError(describeFailure(out, uncertainty));
    if (out.kind === 'unauthenticated') onSessionEnded();
    if (out.kind === 'conflict' && out.code === 'stale') setStale(true);
    if (out.kind === 'invalid_input') setFields(out.fields ?? {});
  }
  return { busy, error, fields, stale, run, reset: () => { setError(null); setFields({}); setStale(false); } };
}

/** No answer from the server: it may or may not have done it. */
export function uncertainMessage(uncertainty: Uncertainty): string {
  return uncertainty === 'idempotent'
    ? 'The connection dropped before Business OS answered, so this may already have been recorded. Trying again with the same details is safe: it will not be recorded twice.'
    : 'The connection dropped before Business OS answered, so this change may already have been saved. Reload to check before trying again.';
}

export function describeFailure(out: SubmitResult, uncertainty: Uncertainty = 'versioned'): string {
  switch (out.kind) {
    case 'unauthenticated': return 'Your session has ended. Please sign in again.';
    case 'conflict': return financeMessage(out.code);
    case 'invalid_input': return out.message ?? 'Please check the details.';
    case 'forbidden': return 'Your role in this business does not allow this.';
    case 'not_found': return 'That record could not be found in this business. It may have been removed.';
    case 'unreachable': return uncertainMessage(uncertainty);
    case 'rate_limited': return 'Too many requests. Wait a moment and try again.';
    case 'failed':
      // 503: the work could not finish (for example the PDF of a quote or invoice being issued) and was rolled back.
      if ((out as { status?: number }).status === 503) return 'Business OS could not finish this just now, so nothing was changed. Try again in a moment.';
      return 'Business OS could not complete this. Reload to see the current state before trying again.';
    default: return 'Business OS could not complete this. Reload to see the current state before trying again.';
  }
}

/**
 * An Idempotency-Key per distinct request: retrying exactly the same request (after a timeout, or a
 * double click) reuses its key, so the server records it once; changing any detail makes a new key.
 */
export function useIdempotencyKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (input: unknown): string => {
    const body = JSON.stringify(input);
    if (last.current?.body === body) return last.current.key;
    const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    last.current = { body, key };
    return key;
  };
}

/** A confirmation for one consequential action, with an optional or required reason. Escape and Cancel are safe. */
export function ConfirmDialog({ title, description, confirmLabel, destructive, reason, busy, error, stale, onReload, onConfirm, onClose, children, disabled }: {
  title: string; description: ReactNode; confirmLabel: string; destructive?: boolean;
  /** Ask for a reason: required (void, reverse) or optional (discard). */
  reason?: 'required' | 'optional'; busy: boolean; error: string | null; stale?: boolean; onReload?: () => void;
  onConfirm: (reason: string) => void; onClose: () => void; children?: ReactNode; disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const missing = reason === 'required' && text.trim() === '';
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
        {reason ? (
          <Field label={reason === 'required' ? 'Reason' : 'Reason (optional)'} hint={reason === 'required' ? 'Kept with the record and its history.' : undefined} className="mt-4">
            {(c) => <Textarea {...c} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        ) : null}
        {error ? (
          <Alert tone="danger" className="mt-4" role="alert">
            <AlertDescription>
              {error}
              {stale && onReload ? <> <button type="button" className="font-medium underline underline-offset-2" onClick={onReload}>Reload</button></> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'primary'} onClick={() => onConfirm(text.trim())} loading={busy} disabled={missing || disabled}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Item({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-sm ${WRAP} whitespace-pre-line`}>{children}</dd>
    </div>
  );
}

export function Row({ label, strong, muted, children }: { label: ReactNode; strong?: boolean; muted?: boolean; children: ReactNode }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? 'font-semibold' : ''}`}>
      <dt className={strong ? undefined : 'text-muted-foreground'}>{label}</dt>
      <dd className={muted ? 'text-muted-foreground' : undefined}>{children}</dd>
    </div>
  );
}

export function okData<T>(state: { status: 'loading' } | { status: 'done'; outcome: Outcome<T> }): T | null {
  return state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
}

/** Previous / next over keyset cursors. The stack resets whenever the filters change (`sig`). */
export function usePager(sig: string) {
  const [pager, setPager] = useState<{ sig: string; stack: string[] }>({ sig: '', stack: [] });
  const stack = pager.sig === sig ? pager.stack : [];
  return {
    cursor: stack[stack.length - 1],
    page: stack.length,
    prev: () => setPager({ sig, stack: stack.slice(0, -1) }),
    next: (cursor: string) => setPager({ sig, stack: [...stack, cursor] }),
  };
}

export function Pager({ pager, nextCursor }: { pager: ReturnType<typeof usePager>; nextCursor: string | null }) {
  if (pager.page === 0 && !nextCursor) return null;
  return (
    <nav aria-label="Pages" className="flex justify-between gap-3">
      <Button variant="outline" disabled={pager.page === 0} onClick={pager.prev}>Previous</Button>
      <Button variant="outline" disabled={!nextCursor} onClick={() => nextCursor && pager.next(nextCursor)}>Next</Button>
    </nav>
  );
}

export function LoadingRows({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => <div key={i} aria-hidden="true" className="h-12 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}
    </div>
  );
}

export function EmptyBox({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed p-10 text-center">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-4 flex justify-center gap-3">{action}</div> : null}
    </div>
  );
}
