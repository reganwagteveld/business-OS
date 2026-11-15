import type { FinanceDocument } from '@business-os/contracts';
import { Alert, AlertDescription, Button, Field, FormSection, Input, Select, Textarea } from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { DocumentPath, TaxRateOption } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { CustomerPicker } from '../customer-picker';
import { currencyOptions } from '../sales/format';
import { PATH_KIND, useFinance } from './env';
import { formatMoney } from './format';
import { KIND_LABEL, Row, useIdempotencyKey, useSubmit } from './shared';

type Line = { key: string; description: string; quantity: string; unitPrice: string; discountAmount: string; taxRateId: string };
type Values = { customerId: string; customerName: string | null; currencyCode: string; date: string; notes: string; lines: Line[] };

let seq = 0;
const lineKey = () => `l${++seq}`;
const blankLine = (taxRateId: string): Line => ({ key: lineKey(), description: '', quantity: '1', unitPrice: '', discountAmount: '', taxRateId });

function initial(doc: FinanceDocument | undefined, currency: string, defaultTax: string, customerId?: string, customerName?: string | null): Values {
  if (!doc) return { customerId: customerId ?? '', customerName: customerName ?? null, currencyCode: currency, date: '', notes: '', lines: [blankLine(defaultTax)] };
  return {
    customerId: doc.customerId, customerName: doc.billToSnapshot?.name ?? null, currencyCode: doc.currencyCode,
    date: (doc.kind === 'QUOTE' ? doc.validUntil : doc.kind === 'INVOICE' ? doc.dueDate : null) ?? '', notes: doc.notes ?? '',
    lines: doc.lines.map((l) => ({
      key: lineKey(), description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
      discountAmount: /[1-9]/.test(l.discountAmount) ? l.discountAmount : '', taxRateId: l.taxRateId ?? '',
    })),
  };
}

/**
 * Create or edit a draft quote, invoice or credit note. Lines are sent as the complete, ordered list.
 * The browser never computes money: the server calculates every line amount, the tax and the totals
 * (and the database checks them again at issue), and the saved figures are shown after each save.
 * Numbers are assigned only when a document is issued.
 */
export function DocumentForm({ path, doc, taxRates, defaultTaxRateId, customerId, onSaved, onCancel }: {
  path: DocumentPath; doc?: FinanceDocument; taxRates: TaxRateOption[]; defaultTaxRateId: string | null;
  customerId?: string; onSaved: (saved: FinanceDocument, created: boolean) => void; onCancel: () => void;
}) {
  const env = useFinance();
  const { client, slug, locale, currency, markDirty } = env;
  const kind = PATH_KIND[path];
  const live = (id: string) => taxRates.some((r) => r.id === id && !r.archivedAt);
  const defaultTax = defaultTaxRateId && live(defaultTaxRateId) ? defaultTaxRateId : '';
  const start = useMemo(() => initial(doc, currency, defaultTax, customerId, customerId ? env.names.get(customerId) : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Values>(start);
  const strip = (v: Values) => JSON.stringify({ ...v, customerName: null, lines: v.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.discountAmount, l.taxRateId]) });
  const dirty = strip(values) !== strip(start);
  useEffect(() => markDirty('form', dirty), [dirty, markDirty]);
  useEffect(() => () => markDirty('form', false), [markDirty]);
  const submit = useSubmit(env.onSessionEnded, doc ? 'versioned' : 'idempotent');
  const keyFor = useIdempotencyKey();
  const [lineErrors, setLineErrors] = useState<string | null>(null);
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));
  const setLine = (key: string, patch: Partial<Line>) => setValues((v) => ({ ...v, lines: v.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const move = (index: number, by: -1 | 1) => setValues((v) => {
    const lines = [...v.lines];
    const target = index + by;
    if (target < 0 || target >= lines.length) return v;
    [lines[index], lines[target]] = [lines[target]!, lines[index]!];
    return { ...v, lines };
  });
  const rates = taxRates.filter((r) => !r.archivedAt || values.lines.some((l) => l.taxRateId === r.id));
  const label = KIND_LABEL[kind].toLowerCase();
  const isNew = !doc;
  const currencies = useMemo(() => currencyOptions(currency, locale), [currency, locale]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setLineErrors(null);
    if (kind !== 'CREDIT_NOTE' && !values.customerId) return setLineErrors('Choose the customer.');
    const lines = values.lines.map((l) => ({
      description: l.description, quantity: l.quantity.trim(), unitPrice: l.unitPrice.trim(),
      ...(l.discountAmount.trim() ? { discountAmount: l.discountAmount.trim() } : {}), taxRateId: l.taxRateId || null,
    }));
    const date = values.date || null;
    const common = kind === 'CREDIT_NOTE' ? { notes: values.notes, lines }
      : { customerId: values.customerId, notes: values.notes, lines, ...(kind === 'QUOTE' ? { validUntil: date } : { dueDate: date }) };
    await submit.run(async () => {
      if (doc) return client.updateDocument(slug, path, doc.id, { version: doc.version, ...common });
      const body = { ...common, currencyCode: values.currencyCode };
      return client.createDocument(slug, path as 'quotes' | 'invoices', body, keyFor(body));
    }, (out) => {
      markDirty('form', false);
      onSaved(out.data, isNew);
    });
  }

  const title = isNew ? `New ${label}` : `Edit draft ${label}`;
  return (
    <ZonePage title={title} eyebrow={`Finance · ${KIND_LABEL[kind]}`} description="Drafts are not numbered and can be changed freely. The number is assigned when the document is issued.">
      <form onSubmit={save} noValidate className="space-y-8">
        {submit.error || lineErrors ? (
          <Alert tone="danger" role="alert">
            <AlertDescription>
              {lineErrors ?? submit.error}
              {submit.stale ? <> <button type="button" className="font-medium underline underline-offset-2" onClick={onCancel}>Back to the latest version</button></> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {kind !== 'CREDIT_NOTE' ? (
          <FormSection title="Customer and dates">
            <div className="grid gap-4 sm:grid-cols-2">
              {env.customers ? (
                <CustomerPicker
                  id="doc-customer" customers={env.customers} slug={slug} selectedId={values.customerId} selectedName={values.customerName ?? env.names.get(values.customerId) ?? null}
                  error={submit.fields.customerId} hint="Required. Choose an active customer from the Customers Zone."
                  onPick={(c) => set({ customerId: c?.id ?? '', customerName: c?.displayName ?? null })} onSessionEnded={env.onSessionEnded}
                />
              ) : (
                <Alert tone="warning" className="sm:col-span-2">
                  <AlertDescription>
                    {values.customerId
                      ? 'You do not have access to the Customers Zone, so the customer of this draft cannot be changed here.'
                      : 'Choosing a customer needs access to the Customers Zone. Ask an owner or admin, or start the document from the customer instead.'}
                  </AlertDescription>
                </Alert>
              )}
              {isNew ? (
                <Field label="Currency" hint="Fixed once the draft is saved.">{(c) => (
                  <Select {...c} value={values.currencyCode} onChange={(e) => set({ currencyCode: e.target.value })}>
                    {currencies.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
                  </Select>
                )}</Field>
              ) : <Field label="Currency" hint="Fixed for this document.">{(c) => <Input {...c} value={values.currencyCode} readOnly />}</Field>}
              <Field label={kind === 'QUOTE' ? 'Valid until (optional)' : 'Due date (optional)'} error={submit.fields.validUntil ?? submit.fields.dueDate}
                hint={kind === 'QUOTE' ? 'Defaults from your quote validity setting when issued.' : 'If empty, your default payment terms are used when the invoice is issued.'}>
                {(c) => <Input {...c} type="date" value={values.date} onChange={(e) => set({ date: e.target.value })} />}
              </Field>
            </div>
          </FormSection>
        ) : null}

        <FormSection title="Lines" description="Prices exclude tax. Tax comes only from your business's tax rates and is calculated by the server.">
          <ol className="space-y-4">
            {values.lines.map((l, i) => (
              <li key={l.key} className="rounded-xl border p-4">
                <fieldset>
                  <legend className="mb-3 text-sm font-medium">Line {i + 1}</legend>
                  <div className="grid gap-3 sm:grid-cols-6">
                    <Field label="Description" className="sm:col-span-6">{(c) => (
                      <Textarea {...c} rows={2} maxLength={1000} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                    )}</Field>
                    <Field label="Quantity" className="sm:col-span-1">{(c) => <Input {...c} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />}</Field>
                    <Field label={`Unit price (${values.currencyCode})`} className="sm:col-span-2">{(c) => (
                      <Input {...c} inputMode="decimal" placeholder="0.00" value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} />
                    )}</Field>
                    <Field label="Discount (optional)" className="sm:col-span-1">{(c) => (
                      <Input {...c} inputMode="decimal" placeholder="0.00" value={l.discountAmount} onChange={(e) => setLine(l.key, { discountAmount: e.target.value })} />
                    )}</Field>
                    <Field label="Tax" className="sm:col-span-2">{(c) => (
                      <Select {...c} value={l.taxRateId} onChange={(e) => setLine(l.key, { taxRateId: e.target.value })}>
                        <option value="">No tax</option>
                        {rates.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.ratePercent}%){r.archivedAt ? ' — archived' : ''}</option>)}
                      </Select>
                    )}</Field>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move line ${i + 1} up`}>↑ Up</Button>
                    <Button size="sm" variant="ghost" disabled={i === values.lines.length - 1} onClick={() => move(i, 1)} aria-label={`Move line ${i + 1} down`}>↓ Down</Button>
                    <Button size="sm" variant="outline" onClick={() => set({ lines: values.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove line ${i + 1}`}>Remove</Button>
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          {values.lines.length === 0 ? <p className="text-sm text-muted-foreground">No lines yet. A document needs at least one line before it can be issued.</p> : null}
          <Button variant="outline" className="mt-4" disabled={values.lines.length >= 200} onClick={() => set({ lines: [...values.lines, blankLine(defaultTax)] })}>Add line</Button>
          {submit.fields.lines ? <p className="mt-2 text-xs font-medium text-destructive">{submit.fields.lines}</p> : null}
        </FormSection>

        <FormSection title="Notes">
          <Field label="Notes (optional)" hint="Printed on the document.">{(c) => <Textarea {...c} rows={3} maxLength={5000} value={values.notes} onChange={(e) => set({ notes: e.target.value })} />}</Field>
        </FormSection>

        {doc ? (
          <section aria-label="Saved totals" className="max-w-sm rounded-xl border p-4">
            <h2 className="text-sm font-semibold">Totals as last saved</h2>
            <dl className="mt-2 space-y-1 text-sm tabular-nums">
              <Row label="Subtotal">{formatMoney(doc.subtotal, doc.currencyCode, locale)}</Row>
              <Row label="Tax">{formatMoney(doc.taxTotal, doc.currencyCode, locale)}</Row>
              <Row label="Total" strong>{formatMoney(doc.total, doc.currencyCode, locale)}</Row>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">Recalculated by the server when you save.</p>
          </section>
        ) : <p className="text-sm text-muted-foreground">Totals are calculated by the server when you save the draft.</p>}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={submit.busy}>{isNew ? 'Save draft' : 'Save changes'}</Button>
          <Button variant="outline" onClick={onCancel} disabled={submit.busy}>Cancel</Button>
        </div>
      </form>
    </ZonePage>
  );
}

