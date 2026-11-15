import { upcomingPeriodDates, type RecurringFrequency, type RecurringInvoice, type RecurringRun } from '@business-os/contracts';
import {
  Alert, AlertDescription, Badge, Button, Field, FormSection, Input, Select, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Textarea,
  type BadgeTone,
} from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { RecurringQuery, TaxRateOption } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { CustomerPicker } from '../customer-picker';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { currencyOptions } from '../sales/format';
import { useFinance, useRequestNames } from './env';
import { formatDate, formatMoney, formatWhen } from './format';
import { ConfirmDialog, EmptyBox, Item, LoadingRows, okData, Pager, usePager, useSubmit, WRAP } from './shared';

// Finance F6-1 (docs/finance-billing-f6.md §3): recurring invoice schedules. A schedule makes DRAFT
// invoices only. Generated, issued and sent are shown as three separate facts: a draft made from a
// schedule still has to be issued by a person, and nothing in Business OS sends it.

const FREQUENCY_LABEL: Record<RecurringFrequency, [string, string]> = {
  WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], QUARTERLY: ['quarter', 'quarters'], ANNUAL: ['year', 'years'],
};
export function cadence(frequency: RecurringFrequency, interval: number): string {
  const [one, many] = FREQUENCY_LABEL[frequency];
  return interval === 1 ? `Every ${one}` : `Every ${interval} ${many}`;
}
const STATUS: Record<RecurringInvoice['status'], [string, BadgeTone]> = {
  ACTIVE: ['Active', 'success'], PAUSED: ['Paused', 'warning'], CANCELLED: ['Cancelled', 'neutral'], ENDED: ['Ended', 'neutral'],
};
const RUN_STATUS: Record<RecurringRun['status'], [string, BadgeTone]> = {
  PENDING: ['Waiting', 'neutral'], RUNNING: ['Generating', 'info'], GENERATED: ['Draft generated', 'success'], FAILED: ['Failed', 'danger'], SKIPPED: ['Skipped', 'neutral'],
};
const DOC_STATE: Record<string, string> = { DRAFT: 'Draft, not issued', ISSUED: 'Issued', VOID: 'Void' };

/** Stable failure codes of a run, in words a person can act on. */
export function runProblem(code: string | null): string | null {
  switch (code) {
    case null: return null;
    case 'archived_reference': return 'The customer, contact, project or a tax rate on this schedule has been archived. Fix the schedule, then retry.';
    case 'invalid_tax_rate': return 'A tax rate on this schedule no longer exists in this business. Fix the lines, then retry.';
    case 'invalid_customer': case 'invalid_contact': case 'contact_customer_mismatch': return 'The customer or contact of this schedule is no longer valid. Fix the schedule, then retry.';
    case 'invalid_amount': return 'A line amount is not valid for this currency. Fix the lines, then retry.';
    case 'template_cancelled': return 'The schedule was cancelled before this period was generated.';
    case 'template_paused': return 'The schedule was paused before this period was generated, so it was not billed.';
    case 'template_not_active': return 'The schedule was not active when this period came up.';
    case 'skipped_by_user': return 'Skipped by a person. This period will not be billed.';
    case 'lease_expired': return 'Generation was interrupted too many times. Retry it.';
    case 'internal_error': return 'Business OS could not generate this draft. It will retry automatically.';
    default: return 'This period could not be generated. Check the schedule, then retry.';
  }
}

function StatusBadge({ status }: { status: RecurringInvoice['status'] }) {
  const [label, tone] = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

const PAGE = 25;

/** Every schedule of the business, newest first. */
export function RecurringList() {
  const env = useFinance();
  const { client, slug, locale, can } = env;
  const [status, setStatus] = useState<RecurringQuery['status']>('all');
  const pager = usePager(status);
  const { state, reload } = useLoad(`recurring|${slug}|${status}|${pager.cursor ?? ''}`, (signal) => client.recurringInvoices(slug, { status, cursor: pager.cursor, limit: PAGE }, signal));
  const page = okData(state);
  useRequestNames(page?.recurringInvoices.map((t) => t.customerId) ?? []);
  const add = can.billing ? <Button onClick={() => env.go({ name: 'recurring-new' })}>New recurring invoice</Button> : undefined;
  const back = <Button variant="outline" onClick={() => env.go({ name: 'documents', path: 'invoices' })}>All invoices</Button>;
  return (
    <ZonePage title="Recurring invoices" eyebrow="Finance · Invoices" primaryActions={add} secondaryActions={back}
      description="Schedules that prepare draft invoices on a regular cycle. Every draft still needs to be checked and issued by a person; nothing is sent automatically.">
      <div role="search" aria-label="Filter recurring invoices" className="grid gap-3 sm:grid-cols-3">
        <Field label="Status">{(c) => (
          <Select {...c} value={status} onChange={(e) => setStatus(e.target.value as RecurringQuery['status'])}>
            <option value="all">All</option><option value="active">Active</option><option value="paused">Paused</option>
            <option value="ended">Ended</option><option value="cancelled">Cancelled</option>
          </Select>
        )}</Field>
      </div>
      {state.status === 'loading' ? <LoadingRows label="Loading recurring invoices…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Recurring invoices" onRetry={reload} onSessionEnded={env.onSessionEnded} /> : null}
      {page && page.recurringInvoices.length === 0 ? (
        <EmptyBox title={status === 'all' ? 'No recurring invoices yet' : 'No recurring invoices match this filter'}
          body={can.billing ? 'Set up a schedule for a customer you bill regularly. It prepares drafts; you issue them.' : 'Schedules set up by an owner or admin will appear here.'} action={status === 'all' ? add : undefined} />
      ) : null}
      {page && page.recurringInvoices.length > 0 ? (
        <>
          <Table aria-label="Recurring invoices">
            <TableCaption>Recurring invoice schedules, most recent first. Amounts are calculated when each draft is generated.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead><TableHead>Customer</TableHead><TableHead className="hidden md:table-cell">Cycle</TableHead>
                <TableHead>Next draft</TableHead><TableHead>Status</TableHead><TableHead className="hidden text-right sm:table-cell">Drafts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.recurringInvoices.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className={WRAP}>
                    <button type="button" className="text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => env.go({ name: 'recurring', id: t.id })}>
                      {t.name}<span className="sr-only">, open schedule</span>
                    </button>
                  </TableCell>
                  <TableCell className={WRAP}>{env.names.get(t.customerId) ?? 'Customer'}</TableCell>
                  <TableCell className="hidden whitespace-nowrap md:table-cell">{cadence(t.frequency, t.intervalCount)}</TableCell>
                  <TableCell className="whitespace-nowrap">{t.nextRunOn ? formatDate(t.nextRunOn, locale) : '—'}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1"><StatusBadge status={t.status} />{t.failedCount > 0 ? <Badge tone="danger">{t.failedCount} failed</Badge> : null}</span>
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{t.generatedCount}</TableCell>
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

type Action = 'pause' | 'resume' | 'cancel' | 'generate';

/** One schedule: its terms, the next periods, actions and the full generation history. */
export function RecurringDetail({ id }: { id: string }) {
  const env = useFinance();
  const { client, slug, locale, timeZone, can } = env;
  const [generation, setGeneration] = useState(0);
  const loaded = useLoad(`recurring-one|${slug}|${id}|${generation}`, (signal) => client.recurringInvoice(slug, id, signal));
  const preview = useLoad(`recurring-preview|${slug}|${id}|${generation}`, (signal) => client.recurringPreview(slug, id, 6, signal));
  const pager = usePager(`${id}|${generation}`);
  const runs = useLoad(`recurring-runs|${slug}|${id}|${generation}|${pager.cursor ?? ''}`, (signal) => client.recurringRuns(slug, id, { cursor: pager.cursor, limit: PAGE }, signal));
  const [action, setAction] = useState<Action | null>(null);
  const submit = useSubmit(env.onSessionEnded);
  const t = okData(loaded.state);
  useRequestNames(t ? [t.customerId] : []);
  if (loaded.state.status === 'loading') return <LoadingRows label="Loading the schedule…" />;
  if (!t) return loaded.state.outcome.kind !== 'ok' ? <Problem outcome={loaded.state.outcome} what="This recurring invoice" onRetry={loaded.reload} onSessionEnded={env.onSessionEnded} /> : null;

  const live = t.status === 'ACTIVE' || t.status === 'PAUSED';
  const refresh = (message: string) => {
    setAction(null);
    setGeneration((g) => g + 1);
    env.go({ name: 'recurring', id }, message);
  };
  const confirm = async (reason: string) => {
    if (!action) return;
    if (action === 'generate') {
      await submit.run(() => client.generateRecurringInvoice(slug, id, { version: t.version }), (out) => {
        setAction(null);
        env.go({ name: 'document', path: 'invoices', id: out.data.run.documentId! }, 'Draft invoice generated from the schedule. Check it, then issue it when it is final.');
      });
      return;
    }
    const input = action === 'cancel' ? { version: t.version, reason: reason || null } : { version: t.version };
    await submit.run(() => client.recurringTransition(slug, id, action, input), () => refresh(
      action === 'pause' ? 'Schedule paused. No drafts are generated while it is paused.'
        : action === 'resume' ? 'Schedule resumed. Periods that fell inside the pause are not billed.' : 'Schedule cancelled. Drafts already generated are unchanged.',
    ));
  };
  const runAction = async (run: RecurringRun, kind: 'retry' | 'skip') => {
    await submit.run(() => client.recurringRunAction(slug, id, run.id, kind), () => refresh(kind === 'retry' ? 'The period is queued and will be generated shortly.' : 'The period was skipped and will not be billed.'));
  };
  const pv = okData(preview.state);
  const primary = can.billing && live ? (
    <>
      <Button onClick={() => { submit.reset(); setAction('generate'); }}>Generate next draft now</Button>
      <Button variant="outline" onClick={() => env.go({ name: 'recurring-edit', id })}>Edit</Button>
    </>
  ) : undefined;
  const secondary = (
    <>
      {can.billing && t.status === 'ACTIVE' ? <Button variant="outline" onClick={() => { submit.reset(); setAction('pause'); }}>Pause</Button> : null}
      {can.billing && t.status === 'PAUSED' ? <Button variant="outline" onClick={() => { submit.reset(); setAction('resume'); }}>Resume</Button> : null}
      {can.billing && live ? <Button variant="outline" onClick={() => { submit.reset(); setAction('cancel'); }}>Cancel schedule</Button> : null}
      <Button variant="ghost" onClick={() => env.go({ name: 'recurring-list' })}>All recurring invoices</Button>
    </>
  );
  const page = okData(runs.state);

  return (
    <ZonePage title={t.name} eyebrow="Finance · Recurring invoice" primaryActions={primary} secondaryActions={secondary}
      description="This schedule prepares draft invoices only. Each draft is numbered when a person issues it, and nothing is sent automatically.">
      {submit.error && !action ? <Alert tone="danger" role="alert"><AlertDescription>{submit.error}</AlertDescription></Alert> : null}
      <section aria-label="Schedule" className="rounded-xl border p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2"><StatusBadge status={t.status} />{t.failedCount > 0 ? <Badge tone="danger">{t.failedCount} failed period{t.failedCount === 1 ? '' : 's'}</Badge> : null}</div>
        <dl className="grid gap-4 sm:grid-cols-3">
          <Item label="Customer">{env.names.get(t.customerId) ?? 'Customer'}</Item>
          <Item label="Cycle">{cadence(t.frequency, t.intervalCount)}</Item>
          <Item label="Currency">{t.currencyCode}</Item>
          <Item label="Starts">{formatDate(t.startDate, locale)}</Item>
          <Item label="Ends">{t.endDate ? formatDate(t.endDate, locale) : 'No end date'}</Item>
          <Item label="Next draft">{t.nextRunOn ? formatDate(t.nextRunOn, locale) : '—'}</Item>
          <Item label="Payment terms">{t.paymentTermsDays === null ? 'Business default' : `${t.paymentTermsDays} days after the period date`}</Item>
          <Item label="Time zone">{t.timeZone}</Item>
          <Item label="Drafts generated">{String(t.generatedCount)}</Item>
          {t.notes ? <Item label="Notes" wide>{t.notes}</Item> : null}
        </dl>
      </section>

      {live ? (
        <section aria-label="Upcoming drafts" className="space-y-3">
          <h2 className="text-base font-semibold">Upcoming drafts</h2>
          {pv?.problem ? <Alert tone="warning"><AlertDescription>{runProblem(pv.problem)}</AlertDescription></Alert> : null}
          {pv && !pv.problem ? <p className="text-sm text-muted-foreground">Each draft would total {formatMoney(pv.total, pv.currencyCode, locale)} with today&apos;s tax rates ({formatMoney(pv.subtotal, pv.currencyCode, locale)} plus {formatMoney(pv.taxTotal, pv.currencyCode, locale)} tax).</p> : null}
          {t.status === 'PAUSED' ? <p className="text-sm text-muted-foreground">Paused: these dates apply only if the schedule is resumed before them.</p> : null}
          {pv && pv.periods.length > 0 ? (
            <Table aria-label="Upcoming drafts">
              <TableHeader><TableRow><TableHead>Period date</TableHead><TableHead>Due date</TableHead></TableRow></TableHeader>
              <TableBody>
                {pv.periods.map((p) => (
                  <TableRow key={p.periodIndex}><TableCell>{formatDate(p.periodDate, locale)}</TableCell><TableCell>{p.dueDate ? formatDate(p.dueDate, locale) : 'Set when issued'}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Generation history" className="space-y-3">
        <h2 className="text-base font-semibold">Generation history</h2>
        {runs.state.status === 'loading' ? <LoadingRows label="Loading the history…" rows={3} /> : null}
        {runs.state.status === 'done' && runs.state.outcome.kind !== 'ok' ? <Problem outcome={runs.state.outcome} what="The history" onRetry={runs.reload} onSessionEnded={env.onSessionEnded} /> : null}
        {page && page.runs.length === 0 ? <p className="text-sm text-muted-foreground">No period has come up yet.</p> : null}
        {page && page.runs.length > 0 ? (
          <>
            <Table aria-label="Generation history">
              <TableCaption>One row per period, newest first. A generated draft must still be issued by a person.</TableCaption>
              <TableHeader>
                <TableRow><TableHead>Period</TableHead><TableHead>Result</TableHead><TableHead>Invoice</TableHead><TableHead className="hidden md:table-cell">When</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {page.runs.map((r) => {
                  const [label, tone] = RUN_STATUS[r.status];
                  const problem = r.status === 'GENERATED' ? null : runProblem(r.errorCode);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{formatDate(r.periodDate, locale)}{r.trigger === 'MANUAL' ? <p className="text-xs text-muted-foreground">Generated on request</p> : null}</TableCell>
                      <TableCell className={WRAP}><Badge tone={tone}>{label}</Badge>{problem ? <p className="mt-1 text-xs text-muted-foreground">{problem}</p> : null}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.documentId ? (
                          <button type="button" className="text-left font-medium hover:underline" onClick={() => env.go({ name: 'document', path: 'invoices', id: r.documentId! })}>
                            {r.documentNumber ?? 'Draft'}<span className="block text-xs font-normal text-muted-foreground">{DOC_STATE[r.documentStatus ?? ''] ?? r.documentStatus}</span>
                          </button>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">{formatWhen(r.finishedAt ?? r.createdAt, timeZone, locale)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {can.billing && r.status === 'FAILED' ? <Button size="sm" variant="outline" disabled={submit.busy} onClick={() => runAction(r, 'retry')}>Retry</Button> : null}
                        {can.billing && (r.status === 'FAILED' || r.status === 'PENDING') ? <Button size="sm" variant="ghost" disabled={submit.busy} onClick={() => runAction(r, 'skip')}>Skip</Button> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pager pager={pager} nextCursor={page.nextCursor} />
          </>
        ) : null}
      </section>

      {action ? (
        <ConfirmDialog
          title={action === 'generate' ? 'Generate the next draft now?' : action === 'pause' ? 'Pause this schedule?' : action === 'resume' ? 'Resume this schedule?' : 'Cancel this schedule?'}
          description={action === 'generate'
            ? `A draft invoice for the period of ${t.nextRunOn ? formatDate(t.nextRunOn, locale) : 'the next period'} is created now, under your name. It is not issued or sent. The schedule then moves on to the following period.`
            : action === 'pause' ? 'No drafts are generated while the schedule is paused. When you resume it, periods that fell inside the pause are not billed.'
              : action === 'resume' ? 'Drafts are generated again from the first period on or after today.'
                : 'No more drafts will be generated. Drafts already generated, and any invoices issued from them, are not changed. This cannot be undone.'}
          confirmLabel={action === 'generate' ? 'Generate draft' : action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : 'Cancel schedule'}
          destructive={action === 'cancel'} reason={action === 'cancel' ? 'optional' : undefined}
          busy={submit.busy} error={submit.error} stale={submit.stale} onReload={() => refresh('Reloaded.')}
          onConfirm={confirm} onClose={() => setAction(null)}
        />
      ) : null}
    </ZonePage>
  );
}

type Line = { key: string; description: string; quantity: string; unitPrice: string; discountAmount: string; taxRateId: string };
type Values = {
  name: string; customerId: string; customerName: string | null; currencyCode: string; frequency: RecurringFrequency; intervalCount: string;
  startDate: string; endDate: string; terms: string; notes: string; lines: Line[];
};
let seq = 0;
const lineKey = () => `r${++seq}`;
const blankLine = (taxRateId: string): Line => ({ key: lineKey(), description: '', quantity: '1', unitPrice: '', discountAmount: '', taxRateId });

/** Create or edit a schedule. Edits apply to drafts generated afterwards; drafts already generated never change. */
export function RecurringForm({ recurring, taxRates, defaultTaxRateId, onSaved, onCancel }: {
  recurring?: RecurringInvoice; taxRates: TaxRateOption[]; defaultTaxRateId: string | null;
  onSaved: (saved: RecurringInvoice) => void; onCancel: () => void;
}) {
  const env = useFinance();
  const { client, slug, locale, currency, today, markDirty } = env;
  const live = (rid: string) => taxRates.some((r) => r.id === rid && !r.archivedAt);
  const defaultTax = defaultTaxRateId && live(defaultTaxRateId) ? defaultTaxRateId : '';
  const fixed = Boolean(recurring && (recurring.generatedCount > 0 || recurring.nextPeriodIndex > 0));
  const start = useMemo<Values>(() => recurring ? {
    name: recurring.name, customerId: recurring.customerId, customerName: env.names.get(recurring.customerId) ?? null, currencyCode: recurring.currencyCode,
    frequency: recurring.frequency, intervalCount: String(recurring.intervalCount), startDate: recurring.startDate, endDate: recurring.endDate ?? '',
    terms: recurring.paymentTermsDays === null ? '' : String(recurring.paymentTermsDays), notes: recurring.notes ?? '',
    lines: recurring.lines.map((l) => ({ key: lineKey(), description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: /[1-9]/.test(l.discountAmount) ? l.discountAmount : '', taxRateId: l.taxRateId ?? '' })),
  } : {
    name: '', customerId: '', customerName: null, currencyCode: currency, frequency: 'MONTHLY', intervalCount: '1', startDate: today, endDate: '', terms: '', notes: '', lines: [blankLine(defaultTax)],
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Values>(start);
  const strip = (v: Values) => JSON.stringify({ ...v, customerName: null, lines: v.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.discountAmount, l.taxRateId]) });
  const dirty = strip(values) !== strip(start);
  useEffect(() => markDirty('form', dirty), [dirty, markDirty]);
  useEffect(() => () => markDirty('form', false), [markDirty]);
  const submit = useSubmit(env.onSessionEnded);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));
  const setLine = (key: string, patch: Partial<Line>) => setValues((v) => ({ ...v, lines: v.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const currencies = useMemo(() => currencyOptions(currency, locale), [currency, locale]);
  const rates = taxRates.filter((r) => !r.archivedAt);
  const interval = Number.parseInt(values.intervalCount, 10);
  const dates = /^\d{4}-\d{2}-\d{2}$/.test(values.startDate) && interval >= 1 && interval <= 12
    ? upcomingPeriodDates({ startDate: values.startDate, frequency: values.frequency, intervalCount: interval, endDate: values.endDate || null }, recurring?.nextPeriodIndex ?? 0, 4)
    : [];

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (!values.customerId) return setProblem('Choose the customer.');
    const lines = values.lines.map((l) => ({
      description: l.description, quantity: l.quantity.trim(), unitPrice: l.unitPrice.trim(),
      ...(l.discountAmount.trim() ? { discountAmount: l.discountAmount.trim() } : {}), taxRateId: l.taxRateId || null,
    }));
    const terms = values.terms.trim() === '' ? null : Number.parseInt(values.terms, 10);
    const body = {
      name: values.name, notes: values.notes, lines, endDate: values.endDate || null, paymentTermsDays: terms,
      ...(fixed ? {} : { customerId: values.customerId, frequency: values.frequency, intervalCount: interval, startDate: values.startDate, ...(recurring ? {} : { currencyCode: values.currencyCode }) }),
    };
    await submit.run(
      () => (recurring ? client.updateRecurringInvoice(slug, recurring.id, { version: recurring.version, ...body }) : client.createRecurringInvoice(slug, body)),
      (out) => { markDirty('form', false); onSaved(out.data); },
    );
  }

  return (
    <ZonePage title={recurring ? `Edit ${recurring.name}` : 'New recurring invoice'} eyebrow="Finance · Recurring invoices"
      description="The schedule prepares a draft invoice for each period. Drafts are not numbered or sent; a person issues each one.">
      <form onSubmit={save} noValidate className="space-y-8">
        {submit.error || problem ? <Alert tone="danger" role="alert"><AlertDescription>{problem ?? submit.error}</AlertDescription></Alert> : null}
        <FormSection title="Schedule">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="For you, for example 'Monthly support retainer'. Not printed." error={submit.fields.name}>{(c) => (
              <Input {...c} maxLength={200} value={values.name} onChange={(e) => set({ name: e.target.value })} />
            )}</Field>
            {env.customers && !fixed ? (
              <CustomerPicker id="recurring-customer" customers={env.customers} slug={slug} selectedId={values.customerId}
                selectedName={values.customerName ?? env.names.get(values.customerId) ?? null} error={submit.fields.customerId} hint="Required."
                onPick={(c) => set({ customerId: c?.id ?? '', customerName: c?.displayName ?? null })} onSessionEnded={env.onSessionEnded} />
            ) : (
              <Field label="Customer" hint={fixed ? 'Fixed once a period has been generated.' : 'Choosing a customer needs access to the Customers Zone.'}>{(c) => (
                <Input {...c} readOnly value={values.customerName ?? env.names.get(values.customerId) ?? (values.customerId ? 'Customer' : '')} />
              )}</Field>
            )}
            <Field label="Currency" hint={recurring ? 'Fixed for this schedule.' : 'Fixed once the schedule is saved.'}>{(c) => (
              <Select {...c} value={values.currencyCode} disabled={Boolean(recurring)} onChange={(e) => set({ currencyCode: e.target.value })}>
                {currencies.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
              </Select>
            )}</Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Every" error={submit.fields.intervalCount}>{(c) => (
                <Input {...c} inputMode="numeric" disabled={fixed} value={values.intervalCount} onChange={(e) => set({ intervalCount: e.target.value })} />
              )}</Field>
              <Field label="Cycle">{(c) => (
                <Select {...c} disabled={fixed} value={values.frequency} onChange={(e) => set({ frequency: e.target.value as RecurringFrequency })}>
                  <option value="WEEKLY">Weeks</option><option value="MONTHLY">Months</option><option value="QUARTERLY">Quarters</option><option value="ANNUAL">Years</option>
                </Select>
              )}</Field>
            </div>
            <Field label="First period" hint={fixed ? 'Fixed once a period has been generated.' : 'Later periods keep this day of the month; in shorter months, the last day.'} error={submit.fields.startDate}>{(c) => (
              <Input {...c} type="date" disabled={fixed} value={values.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            )}</Field>
            <Field label="Last period on or before (optional)" error={submit.fields.endDate}>{(c) => (
              <Input {...c} type="date" value={values.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            )}</Field>
            <Field label="Payment terms in days (optional)" hint="Due date = period date plus these days. Empty uses your Finance default." error={submit.fields.paymentTermsDays}>{(c) => (
              <Input {...c} inputMode="numeric" value={values.terms} onChange={(e) => set({ terms: e.target.value })} />
            )}</Field>
          </div>
          {dates.length > 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Next periods: {dates.map((d) => formatDate(d.date, locale)).join(', ')}.</p>
          ) : null}
        </FormSection>

        <FormSection title="Lines" description="Prices exclude tax. Tax comes from your business's tax rates and is calculated when each draft is generated.">
          <ol className="space-y-4">
            {values.lines.map((l, i) => (
              <li key={l.key} className="rounded-xl border p-4">
                <fieldset>
                  <legend className="mb-3 text-sm font-medium">Line {i + 1}</legend>
                  <div className="grid gap-3 sm:grid-cols-6">
                    <Field label="Description" className="sm:col-span-6">{(c) => <Textarea {...c} rows={2} maxLength={1000} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />}</Field>
                    <Field label="Quantity" className="sm:col-span-1">{(c) => <Input {...c} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />}</Field>
                    <Field label={`Unit price (${values.currencyCode})`} className="sm:col-span-2">{(c) => <Input {...c} inputMode="decimal" placeholder="0.00" value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} />}</Field>
                    <Field label="Discount (optional)" className="sm:col-span-1">{(c) => <Input {...c} inputMode="decimal" placeholder="0.00" value={l.discountAmount} onChange={(e) => setLine(l.key, { discountAmount: e.target.value })} />}</Field>
                    <Field label="Tax" className="sm:col-span-2">{(c) => (
                      <Select {...c} value={l.taxRateId} onChange={(e) => setLine(l.key, { taxRateId: e.target.value })}>
                        <option value="">No tax</option>
                        {rates.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.ratePercent}%)</option>)}
                        {l.taxRateId && !rates.some((r) => r.id === l.taxRateId) ? <option value={l.taxRateId}>Archived rate (choose another)</option> : null}
                      </Select>
                    )}</Field>
                  </div>
                  <Button size="sm" variant="outline" className="mt-3" disabled={values.lines.length === 1} onClick={() => set({ lines: values.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove line ${i + 1}`}>Remove</Button>
                </fieldset>
              </li>
            ))}
          </ol>
          <Button variant="outline" className="mt-4" disabled={values.lines.length >= 200} onClick={() => set({ lines: [...values.lines, blankLine(defaultTax)] })}>Add line</Button>
        </FormSection>

        <FormSection title="Notes">
          <Field label="Notes (optional)" hint="Copied onto every generated draft.">{(c) => <Textarea {...c} rows={3} maxLength={5000} value={values.notes} onChange={(e) => set({ notes: e.target.value })} />}</Field>
        </FormSection>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={submit.busy}>{recurring ? 'Save changes' : 'Create schedule'}</Button>
          <Button variant="outline" onClick={onCancel} disabled={submit.busy}>Cancel</Button>
        </div>
      </form>
    </ZonePage>
  );
}
