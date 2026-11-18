import type { FinanceDocument } from '@business-os/contracts';
import {
  Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@business-os/ui';
import { useState } from 'react';
import { KIND_PATH, type DocumentPath } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { ApplyCreditDialog } from './credit';
import { isPositive } from './decimal';
import { DocumentPdfCard } from './document-pdf';
import { PATH_KIND, useFinance } from './env';
import { RelatedChip } from './link-fields';
import { formatDate, formatMoney, formatWhen } from './format';
import { ConfirmDialog, DocumentBadges, isOverdue, Item, KIND_LABEL, LoadingRows, okData, Row, useIdempotencyKey, useSubmit, WRAP } from './shared';

type Action = null | 'issue' | 'void' | 'discard' | 'accept' | 'decline' | 'expire' | 'convert' | 'credit-note' | 'apply';

/**
 * One quote, invoice or credit note. Issued documents are read-only: every figure is the server's, the
 * bill-to and seller details are the snapshots sealed at issue, and corrections are voids or credit
 * notes. For invoices, payments and credit applied are listed (live and reversed) with what is still
 * open; for credit notes, where their credit has been applied. Credit is never shown as cash received.
 */
export function DocumentDetail({ path, id }: { path: DocumentPath; id: string }) {
  const env = useFinance();
  const { client, slug, locale, timeZone, today, can } = env;
  const kind = PATH_KIND[path];
  const { state, reload, previous } = useLoad(`doc|${slug}|${path}|${id}`, (signal) => client.document(slug, path, id, signal));
  const [action, setAction] = useState<Action>(null);
  const [refresh, setRefresh] = useState(0);
  const back = <Button variant="outline" onClick={() => env.go({ name: 'documents', path })}>All {path === 'credit-notes' ? 'credit notes' : path}</Button>;
  const shown = state.status === 'done' ? (state.outcome.kind === 'ok' ? state.outcome.data : null) : previous?.kind === 'ok' ? previous.data : null;
  if (!shown) {
    return (
      <ZonePage title={KIND_LABEL[kind]} eyebrow="Finance" secondaryActions={back}>
        {state.status === 'loading' ? <LoadingRows label="Loading…" /> : (
          <Problem outcome={state.status === 'done' ? state.outcome : { kind: 'unreachable' }} what={`This ${KIND_LABEL[kind].toLowerCase()}`} onRetry={reload} onSessionEnded={env.onSessionEnded} />
        )}
      </ZonePage>
    );
  }
  const d = shown;
  const money = (v: string) => formatMoney(v, d.currencyCode, locale);
  const customerName = d.billToSnapshot?.name ?? env.names.get(d.customerId) ?? 'Customer';
  const done = (message: string, next?: () => void) => {
    setAction(null);
    if (next) return next();
    reload();
    setRefresh((r) => r + 1);
    env.go({ name: 'document', path, id: d.id }, message);
  };
  const draft = d.status === 'DRAFT';
  const issued = d.status === 'ISSUED';
  const actions = (
    <>
      {draft && can.write ? <Button variant="outline" onClick={() => env.go({ name: 'document-edit', path, id: d.id })}>Edit draft</Button> : null}
      {draft && can.write ? <Button variant="outline" onClick={() => setAction('discard')}>Discard draft</Button> : null}
      {kind === 'QUOTE' && (issued || d.status === 'ACCEPTED') && can.write ? <Button variant="outline" onClick={() => setAction('convert')}>Convert to invoice</Button> : null}
      {kind === 'QUOTE' && issued && can.issue ? (
        <>
          <Button variant="outline" onClick={() => setAction('decline')}>Mark declined</Button>
          <Button variant="outline" onClick={() => setAction('expire')}>Mark expired</Button>
          <Button variant="outline" onClick={() => setAction('accept')}>Mark accepted</Button>
        </>
      ) : null}
      {kind === 'INVOICE' && issued && can.write ? <Button variant="outline" onClick={() => setAction('credit-note')}>Create credit note</Button> : null}
      {(issued || d.status === 'ACCEPTED') && can.issue ? <Button variant="outline" onClick={() => setAction('void')}>Void</Button> : null}
      {kind === 'INVOICE' && issued && d.settlementState !== 'PAID' && can.payments ? (
        <Button onClick={() => env.go({ name: 'payment-new', prefill: { customerId: d.customerId, currencyCode: d.currencyCode, invoiceId: d.id } })}>Record payment</Button>
      ) : null}
      {draft && can.issue ? <Button onClick={() => setAction('issue')}>Issue {KIND_LABEL[kind].toLowerCase()}</Button> : null}
    </>
  );

  return (
    <ZonePage
      title={d.number ?? `Draft ${KIND_LABEL[kind].toLowerCase()}`} eyebrow={`Finance · ${KIND_LABEL[kind]}`}
      description={<span className="flex flex-wrap items-center gap-2"><DocumentBadges status={d.status} settlement={d.settlementState} overdue={isOverdue(d, today)} /><span>{customerName} · {d.currencyCode}</span></span>}
      secondaryActions={back} primaryActions={actions}
    >
      {d.status === 'VOID' ? (
        <Alert tone="warning"><AlertDescription>{d.number ? `Voided${d.voidedAt ? ` ${formatWhen(d.voidedAt, timeZone, locale)}` : ''}: ${d.voidReason ?? 'no reason recorded'}. The number stays in the sequence.` : 'This draft was discarded. It was never numbered.'}</AlertDescription></Alert>
      ) : null}
      {draft ? <Alert tone="info"><AlertDescription>This is a draft: it has no number yet and is not part of your records until it is issued.</AlertDescription></Alert> : null}
      {d.status === 'ACCEPTED' ? <Alert tone="info"><AlertDescription>The customer accepted this quote. Acceptance is a recorded decision, not a payment; invoice it to bill the customer.</AlertDescription></Alert> : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Item label="Customer">
                {env.onOpenCustomer ? (
                  <button type="button" className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.leave(() => env.onOpenCustomer!(d.customerId))}>{customerName}</button>
                ) : customerName}
              </Item>
              {d.opportunityId && env.sales ? (
                <Item label="Opportunity"><RelatedChip kind="opportunity" slug={slug} id={d.opportunityId} sales={env.sales} projects={null} onOpen={env.onOpenOpportunity ? (oid) => env.leave(() => env.onOpenOpportunity!(oid)) : undefined} /></Item>
              ) : null}
              {d.projectId && env.projects ? (
                <Item label="Project"><RelatedChip kind="project" slug={slug} id={d.projectId} sales={null} projects={env.projects} onOpen={env.onOpenProject ? (pid) => env.leave(() => env.onOpenProject!(pid)) : undefined} /></Item>
              ) : null}
              <Item label="Issue date">{formatDate(d.issueDate, locale)}</Item>
              {kind === 'QUOTE' ? <Item label="Valid until">{formatDate(d.validUntil, locale)}</Item> : null}
              {kind === 'INVOICE' ? <Item label="Due date">{formatDate(d.dueDate, locale)}</Item> : null}
              {d.sourceQuoteId ? (
                <Item label="From quote"><LinkButton onClick={() => env.go({ name: 'document', path: 'quotes', id: d.sourceQuoteId! })}>Open the quote</LinkButton></Item>
              ) : null}
              {d.creditedInvoiceId ? (
                <Item label="Credits invoice"><LinkButton onClick={() => env.go({ name: 'document', path: 'invoices', id: d.creditedInvoiceId! })}>Open the invoice</LinkButton></Item>
              ) : null}
              {d.issuedAt ? <Item label="Issued">{formatWhen(d.issuedAt, timeZone, locale)}</Item> : null}
              {d.notes ? <Item label="Notes" wide>{d.notes}</Item> : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Amount</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm tabular-nums">
              <Row label="Subtotal">{money(d.subtotal)}</Row>
              <Row label="Tax">{money(d.taxTotal)}</Row>
              <Row label="Total" strong>{money(d.total)}</Row>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">Prices exclude tax. Calculated by the server{d.status === 'DRAFT' ? ' when the draft was last saved' : ' and sealed at issue'}.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
        <CardContent>
          {d.lines.length === 0 ? <p className="text-sm text-muted-foreground">No lines yet. Add at least one before issuing.</p> : (
            <Table aria-label="Lines">
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="hidden text-right sm:table-cell">Unit price</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Discount</TableHead><TableHead className="hidden md:table-cell">Tax</TableHead><TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className={`${WRAP} whitespace-pre-line`}>{l.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{money(l.unitPrice)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">{isPositive(l.discountAmount) ? money(l.discountAmount) : '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{l.taxName ? `${l.taxName} ${l.taxRatePercent}% · ${money(l.lineTax)}` : 'No tax'}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(l.lineNet)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {d.billToSnapshot || d.sellerSnapshot ? (
        <div className="grid gap-6 md:grid-cols-2">
          {d.billToSnapshot ? (
            <Card>
              <CardHeader><CardTitle>Bill to (as issued)</CardTitle></CardHeader>
              <CardContent className={`text-sm ${WRAP}`}>
                <p className="font-medium">{d.billToSnapshot.legalName ?? d.billToSnapshot.name}</p>
                {[d.billToSnapshot.addressLine1, d.billToSnapshot.addressLine2, [d.billToSnapshot.city, d.billToSnapshot.region, d.billToSnapshot.postalCode].filter(Boolean).join(' '), d.billToSnapshot.countryCode]
                  .filter(Boolean).map((line, i) => <p key={i} className="text-muted-foreground">{line}</p>)}
                {d.billToSnapshot.taxNumber ? <p className="mt-1 text-muted-foreground">{d.billToSnapshot.taxNumberType ?? 'Tax number'}: {d.billToSnapshot.taxNumber}</p> : null}
                {d.billToSnapshot.contact ? <p className="mt-1">Attention: {d.billToSnapshot.contact.name}</p> : null}
              </CardContent>
            </Card>
          ) : null}
          {d.sellerSnapshot ? (
            <Card>
              <CardHeader><CardTitle>From (as issued)</CardTitle></CardHeader>
              <CardContent className={`text-sm ${WRAP}`}>
                <p className="font-medium">{d.sellerSnapshot.legalName}</p>
                {d.sellerSnapshot.address ? <p className="whitespace-pre-line text-muted-foreground">{d.sellerSnapshot.address}</p> : null}
                {d.sellerSnapshot.identifiers.map((x) => <p key={x.label} className="text-muted-foreground">{x.label}: {x.value}</p>)}
                {d.sellerSnapshot.paymentInstructions ? <p className="mt-2 whitespace-pre-line">{d.sellerSnapshot.paymentInstructions}</p> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      <DocumentPdfCard doc={d} />

      {kind === 'INVOICE' && d.status !== 'DRAFT' ? <InvoiceSettlementCard invoiceId={d.id} refresh={refresh} /> : null}
      {kind === 'INVOICE' && d.status !== 'DRAFT' ? <InvoiceCreditNotes invoiceId={d.id} refresh={refresh} /> : null}
      {kind === 'CREDIT_NOTE' && d.status !== 'DRAFT' ? (
        <CreditCard creditNoteId={d.id} refresh={refresh} onApply={issued && can.payments ? () => setAction('apply') : undefined} onChanged={(m) => done(m)} />
      ) : null}

      {action === 'issue' ? <IssueDialog doc={d} onClose={() => setAction(null)} onDone={() => done(`${KIND_LABEL[kind]} issued.`)} onReload={() => { setAction(null); reload(); }} /> : null}
      {action === 'void' || action === 'discard' ? <VoidDialog doc={d} discard={action === 'discard'} onClose={() => setAction(null)} onDone={(m) => done(m)} onReload={() => { setAction(null); reload(); }} /> : null}
      {action === 'accept' || action === 'decline' || action === 'expire' ? (
        <QuoteDialog doc={d} action={action} onClose={() => setAction(null)} onDone={(m) => done(m)} onReload={() => { setAction(null); reload(); }} />
      ) : null}
      {action === 'convert' ? <ConvertDialog doc={d} onClose={() => setAction(null)} /> : null}
      {action === 'credit-note' ? <CreditNoteDialog doc={d} onClose={() => setAction(null)} /> : null}
      {action === 'apply' ? <ApplyCreditDialog creditNote={d} onClose={() => setAction(null)} onDone={(m) => done(m)} /> : null}
    </ZonePage>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: string }) {
  return <button type="button" className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={onClick}>{children}</button>;
}

function IssueDialog({ doc, onClose, onDone, onReload }: { doc: FinanceDocument; onClose: () => void; onDone: () => void; onReload: () => void }) {
  const env = useFinance();
  const path = KIND_PATH[doc.kind];
  const [issueDate, setIssueDate] = useState(env.today);
  const [due, setDue] = useState((doc.kind === 'INVOICE' ? doc.dueDate : doc.kind === 'QUOTE' ? doc.validUntil : null) ?? '');
  const submit = useSubmit(env.onSessionEnded);
  const series = useLoad(`series|${env.slug}`, (signal) => env.client.numberSeries(env.slug, signal));
  const next = okData(series.state)?.find((s) => s.kind === doc.kind)?.nextNumber;
  const money = formatMoney(doc.total, doc.currencyCode, env.locale);
  return (
    <ConfirmDialog
      title={`Issue this ${KIND_LABEL[doc.kind].toLowerCase()}?`} confirmLabel={`Issue ${KIND_LABEL[doc.kind].toLowerCase()}`}
      description={`Issuing ${money} gives it the next number${next ? ` (${next})` : ''} and seals its lines, totals, customer and seller details.${doc.kind === 'CREDIT_NOTE' ? '' : ' Its original PDF is made and kept at the same time, with your current document branding.'} It cannot be edited afterwards: corrections are a void${doc.kind === 'INVOICE' ? ' or a credit note' : ''}.`}
      busy={submit.busy} error={submit.error} stale={submit.stale} onReload={onReload} onClose={onClose} disabled={doc.lines.length === 0}
      onConfirm={() => void submit.run(() => env.client.issueDocument(env.slug, path, doc.id, {
        version: doc.version, issueDate, ...(due ? (doc.kind === 'QUOTE' ? { validUntil: due } : doc.kind === 'INVOICE' ? { dueDate: due } : {}) : {}),
      }), onDone)}
    >
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Issue date">{(c) => <Input {...c} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}</Field>
        {doc.kind !== 'CREDIT_NOTE' ? (
          <Field label={doc.kind === 'QUOTE' ? 'Valid until' : 'Due date'} hint={due ? undefined : doc.kind === 'QUOTE' ? 'Empty: your default validity is used.' : 'Empty: your default payment terms are used.'}>
            {(c) => <Input {...c} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
          </Field>
        ) : null}
      </div>
      {doc.lines.length === 0 ? <p className="mt-3 text-sm font-medium text-destructive">Add at least one line before issuing.</p> : null}
    </ConfirmDialog>
  );
}

function VoidDialog({ doc, discard, onClose, onDone, onReload }: { doc: FinanceDocument; discard: boolean; onClose: () => void; onDone: (m: string) => void; onReload: () => void }) {
  const env = useFinance();
  const path = KIND_PATH[doc.kind];
  const submit = useSubmit(env.onSessionEnded);
  const label = KIND_LABEL[doc.kind].toLowerCase();
  const settled = doc.kind === 'INVOICE' && (isPositive(doc.allocatedTotal) || isPositive(doc.creditAppliedTotal));
  return (
    <ConfirmDialog
      title={discard ? 'Discard this draft?' : `Void ${doc.number ?? `this ${label}`}?`} confirmLabel={discard ? 'Discard draft' : `Void ${label}`} destructive
      description={discard
        ? 'The draft is kept in the history but no longer counts. It was never numbered.'
        : `Voiding keeps the ${label} and its number in your records, marked void. It cannot be undone.`}
      reason={discard ? 'optional' : 'required'} busy={submit.busy} error={submit.error} stale={submit.stale} onReload={onReload} onClose={onClose}
      disabled={!discard && settled}
      onConfirm={(reason) => void submit.run(
        () => (discard ? env.client.discardDocument(env.slug, path, doc.id, { version: doc.version, reason: reason || null })
          : env.client.voidDocument(env.slug, path, doc.id, { version: doc.version, reason })),
        () => onDone(discard ? 'Draft discarded.' : `${KIND_LABEL[doc.kind]} voided.`),
      )}
    >
      {!discard && settled ? (
        <Alert tone="warning" className="mt-4"><AlertDescription>Payments or credit are applied to this invoice. Reverse them first (the payments stay recorded), then void it.</AlertDescription></Alert>
      ) : null}
    </ConfirmDialog>
  );
}

const QUOTE_COPY = {
  accept: { title: 'Mark this quote accepted?', body: 'Records that the customer accepted it. This is a decision, not a payment, and it creates no invoice.', done: 'Quote marked accepted.' },
  decline: { title: 'Mark this quote declined?', body: 'Records that the customer declined it. It cannot be accepted afterwards.', done: 'Quote marked declined.' },
  expire: { title: 'Mark this quote expired?', body: 'Records that the offer has lapsed. It cannot be accepted afterwards.', done: 'Quote marked expired.' },
} as const;

function QuoteDialog({ doc, action, onClose, onDone, onReload }: { doc: FinanceDocument; action: 'accept' | 'decline' | 'expire'; onClose: () => void; onDone: (m: string) => void; onReload: () => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded);
  const copy = QUOTE_COPY[action];
  return (
    <ConfirmDialog title={copy.title} description={copy.body} confirmLabel={copy.title.replace('?', '').replace('this quote ', '')}
      busy={submit.busy} error={submit.error} stale={submit.stale} onReload={onReload} onClose={onClose}
      onConfirm={() => void submit.run(() => env.client.quoteTransition(env.slug, doc.id, action, { version: doc.version }), () => onDone(copy.done))} />
  );
}

function ConvertDialog({ doc, onClose }: { doc: FinanceDocument; onClose: () => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded, 'idempotent');
  const keyFor = useIdempotencyKey();
  const [due, setDue] = useState('');
  return (
    <ConfirmDialog
      title="Create an invoice from this quote?" confirmLabel="Create draft invoice"
      description="A draft invoice is created with this quote's customer, currency and lines. The quote itself does not change, and nothing is billed until the invoice is issued."
      busy={submit.busy} error={submit.error} onClose={onClose}
      onConfirm={() => {
        const body = due ? { dueDate: due } : {};
        void submit.run(() => env.client.convertQuote(env.slug, doc.id, body, keyFor({ quote: doc.id, ...body })), (out) => {
          onClose();
          env.go({ name: 'document', path: 'invoices', id: out.data.id }, 'Draft invoice created from the quote. Review it, then issue it.');
        });
      }}
    >
      <Field label="Due date (optional)" className="mt-4" hint="Can be set later, before issuing.">{(c) => <Input {...c} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

function CreditNoteDialog({ doc, onClose }: { doc: FinanceDocument; onClose: () => void }) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded, 'idempotent');
  const keyFor = useIdempotencyKey();
  const [copy, setCopy] = useState(false);
  return (
    <ConfirmDialog
      title={`Create a credit note for ${doc.number ?? 'this invoice'}?`} confirmLabel="Create draft credit note"
      description="A draft credit note is created for this invoice's customer and currency. Issuing it records the credit; applying it to an invoice is a separate step. Credit is not a refund or cash."
      busy={submit.busy} error={submit.error} onClose={onClose}
      onConfirm={() => {
        const body = { copyInvoiceLines: copy };
        void submit.run(() => env.client.createCreditNote(env.slug, doc.id, body, keyFor({ invoice: doc.id, ...body })), (out) => {
          onClose();
          env.go({ name: 'document-edit', path: 'credit-notes', id: out.data.id }, 'Draft credit note created. Adjust its lines, then save.');
        });
      }}
    >
      <label className="mt-4 flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" className="size-4" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> Start from a copy of the invoice's lines
      </label>
    </ConfirmDialog>
  );
}

/** What an issued invoice has received: payment allocations and applied credit, live and reversed, and what is still open. */
function InvoiceSettlementCard({ invoiceId, refresh }: { invoiceId: string; refresh: number }) {
  const env = useFinance();
  const { state, reload } = useLoad(`settlement|${env.slug}|${invoiceId}|${refresh}`, (signal) => env.client.settlement(env.slug, invoiceId, signal));
  return (
    <Card>
      <CardHeader><CardTitle>Payments and credit</CardTitle></CardHeader>
      <CardContent>
        {state.status === 'loading' ? <LoadingRows label="Loading payments…" rows={2} /> : state.outcome.kind !== 'ok' ? (
          <Problem outcome={state.outcome} what="Payments for this invoice" onRetry={reload} onSessionEnded={env.onSessionEnded} />
        ) : (() => {
          const s = state.outcome.data;
          const money = (v: string) => formatMoney(v, s.currencyCode, env.locale);
          return (
            <div className="grid gap-6 md:grid-cols-3">
              <dl className="space-y-2 text-sm tabular-nums">
                <Row label="Invoice total">{money(s.total)}</Row>
                <Row label="Payments allocated">{money(s.allocatedTotal)}</Row>
                <Row label="Credit applied">{money(s.creditAppliedTotal)}</Row>
                <Row label="Still open" strong>{money(s.outstanding)}</Row>
                {s.overdue ? <p className="text-xs font-medium text-destructive">Overdue: due {formatDate(s.dueDate, env.locale)}.</p> : null}
                <p className="text-xs text-muted-foreground">Applied credit settles the invoice but is not cash received.</p>
              </dl>
              <div className="md:col-span-2">
                <h3 className="text-sm font-semibold">Payment allocations</h3>
                {s.allocations.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">None.</p> : (
                  <ul className="mt-1 divide-y text-sm">
                    {s.allocations.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'payment', id: a.paymentId })}>
                          Payment allocated {formatWhen(a.createdAt, env.timeZone, env.locale)}{a.reversedAt ? ' · reversed' : ''}
                        </button>
                        <span className={a.reversedAt ? 'text-muted-foreground line-through tabular-nums' : 'tabular-nums'}>{money(a.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <h3 className="mt-4 text-sm font-semibold">Credit applied</h3>
                {s.creditApplications.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">None.</p> : (
                  <ul className="mt-1 divide-y text-sm">
                    {s.creditApplications.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'document', path: 'credit-notes', id: a.creditNoteId })}>
                          Credit note {a.creditNoteNumber ?? ''}{a.reversedAt ? ' · reversed' : ''}
                        </button>
                        <span className={a.reversedAt ? 'text-muted-foreground line-through tabular-nums' : 'tabular-nums'}>{money(a.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}

function InvoiceCreditNotes({ invoiceId, refresh }: { invoiceId: string; refresh: number }) {
  const env = useFinance();
  const { state, reload } = useLoad(`invoice-cns|${env.slug}|${invoiceId}|${refresh}`, (signal) => env.client.documents(env.slug, 'credit-notes', { status: 'all', invoiceId, limit: 25 }, signal));
  if (state.status === 'done' && state.outcome.kind === 'ok' && state.outcome.data.documents.length === 0) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Credit notes for this invoice</CardTitle></CardHeader>
      <CardContent>
        {state.status === 'loading' ? <LoadingRows label="Loading credit notes…" rows={1} /> : state.outcome.kind !== 'ok' ? (
          <Problem outcome={state.outcome} what="Credit notes" onRetry={reload} onSessionEnded={env.onSessionEnded} />
        ) : (
          <ul className="divide-y text-sm">
            {state.outcome.data.documents.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <button type="button" className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'document', path: 'credit-notes', id: c.id })}>{c.number ?? 'Draft credit note'}</button>
                <span className="flex items-center gap-2"><DocumentBadges status={c.status} /><span className="tabular-nums">{formatMoney(c.total, c.currencyCode, env.locale)}</span></span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Where an issued credit note's credit went: applied (live and reversed) and still available. */
function CreditCard({ creditNoteId, refresh, onApply, onChanged }: { creditNoteId: string; refresh: number; onApply?: () => void; onChanged: (m: string) => void }) {
  const env = useFinance();
  const { state, reload } = useLoad(`credit|${env.slug}|${creditNoteId}|${refresh}`, (signal) => env.client.credit(env.slug, creditNoteId, signal));
  const [reversing, setReversing] = useState<string | null>(null);
  const submit = useSubmit(env.onSessionEnded);
  const credit = okData(state);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Credit</CardTitle>
        {onApply && credit && isPositive(credit.available) ? <Button size="sm" onClick={onApply}>Apply credit to an invoice</Button> : null}
      </CardHeader>
      <CardContent>
        {state.status === 'loading' ? <LoadingRows label="Loading credit…" rows={2} /> : state.outcome.kind !== 'ok' ? (
          <Problem outcome={state.outcome} what="This credit note's credit" onRetry={reload} onSessionEnded={env.onSessionEnded} />
        ) : (() => {
          const c = state.outcome.data;
          const money = (v: string) => formatMoney(v, c.currencyCode, env.locale);
          return (
            <div className="grid gap-6 md:grid-cols-3">
              <dl className="space-y-2 text-sm tabular-nums">
                <Row label="Credit note total">{money(c.total)}</Row>
                <Row label="Applied to invoices">{money(c.appliedTotal)}</Row>
                <Row label="Still available" strong>{money(c.available)}</Row>
                <p className="text-xs text-muted-foreground">Issuing a credit note settles nothing by itself. Refunds are not supported.</p>
              </dl>
              <div className="md:col-span-2">
                {c.applications.length === 0 ? <p className="text-sm text-muted-foreground">Not applied to any invoice yet.</p> : (
                  <ul className="divide-y text-sm">
                    {c.applications.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'document', path: 'invoices', id: a.invoiceId })}>
                          Invoice {a.invoiceNumber ?? ''} · {formatWhen(a.createdAt, env.timeZone, env.locale)}{a.reversedAt ? ' · reversed' : ''}
                        </button>
                        <span className="flex items-center gap-2">
                          <span className={a.reversedAt ? 'text-muted-foreground line-through tabular-nums' : 'tabular-nums'}>{money(a.amount)}</span>
                          {!a.reversedAt && env.can.payments ? <Button size="sm" variant="outline" onClick={() => setReversing(a.id)}>Reverse</Button> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })()}
      </CardContent>
      {reversing ? (
        <ConfirmDialog
          title="Reverse this credit application?" confirmLabel="Reverse application" destructive
          description="The credit goes back to the credit note and the invoice's open amount increases again. The application stays in the history as reversed."
          busy={submit.busy} error={submit.error} onClose={() => setReversing(null)}
          onConfirm={() => void submit.run(() => env.client.reverseCreditApplication(env.slug, creditNoteId, reversing), () => { setReversing(null); onChanged('Credit application reversed.'); })}
        />
      ) : null}
    </Card>
  );
}

