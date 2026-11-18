import type { CatalogItem, Customer, FinanceDocument, Opportunity } from '@business-os/contracts';
import { Alert, AlertDescription, Button, Field, FormSection, Input, Select, Textarea } from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { DocumentPath, TaxRateOption } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { CustomerPicker } from '../customer-picker';
import { useLoad } from '../use-load';
import { Problem } from '../problem';
import { currencyOptions } from '../sales/format';
import { CatalogLinePicker, catalogLineStart, catalogPriceNote } from './catalog-picker';
import { PATH_KIND, useFinance, useRequestNames } from './env';
import { formatMoney } from './format';
import { fitsCustomer, OpportunityField, ProjectField, type LinkRef } from './link-fields';
import { KIND_LABEL, LoadingRows, Row, useIdempotencyKey, useSubmit } from './shared';

type Line = {
  key: string; description: string; quantity: string; unitPrice: string; discountAmount: string; taxRateId: string;
  /** F7-B: the catalog item this unsaved line was started from. Sent once with the line, never stored. */
  catalog?: { item: CatalogItem; priceFilled: boolean; taxNote: string | null };
};
type Values = {
  customerId: string; customerName: string | null; currencyCode: string; date: string; notes: string; lines: Line[];
  /** LC-2: the customer's contact (only ever from a prefill or the saved draft) and the optional links. */
  contactId: string | null; opportunity: LinkRef | null; project: LinkRef | null;
};
/** LC-2: a new quote started from an opportunity. Customer, contact, currency and the opportunity come from it. */
export interface DocumentPrefill { customerId: string; customerName: string | null; contactId: string | null; currencyCode: string; opportunity: LinkRef }

let seq = 0;
const lineKey = () => `l${++seq}`;
const blankLine = (taxRateId: string): Line => ({ key: lineKey(), description: '', quantity: '1', unitPrice: '', discountAmount: '', taxRateId });

function initial(doc: FinanceDocument | undefined, currency: string, defaultTax: string, customerId?: string, customerName?: string | null, prefill?: DocumentPrefill): Values {
  if (prefill) {
    return {
      customerId: prefill.customerId, customerName: prefill.customerName, currencyCode: prefill.currencyCode, date: '', notes: '', lines: [blankLine(defaultTax)],
      contactId: prefill.contactId, opportunity: prefill.opportunity, project: null,
    };
  }
  if (!doc) return { customerId: customerId ?? '', customerName: customerName ?? null, currencyCode: currency, date: '', notes: '', lines: [blankLine(defaultTax)], contactId: null, opportunity: null, project: null };
  return {
    contactId: doc.contactId,
    opportunity: doc.opportunityId ? { id: doc.opportunityId, label: null, customerId: doc.customerId } : null,
    project: doc.projectId ? { id: doc.projectId, label: null, customerId: doc.customerId } : null,
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
export function DocumentForm({ path, doc, taxRates, defaultTaxRateId, customerId, prefill, onSaved, onCancel }: {
  path: DocumentPath; doc?: FinanceDocument; taxRates: TaxRateOption[]; defaultTaxRateId: string | null;
  customerId?: string; prefill?: DocumentPrefill; onSaved: (saved: FinanceDocument, created: boolean) => void; onCancel: () => void;
}) {
  const env = useFinance();
  const { client, slug, locale, currency, markDirty } = env;
  const kind = PATH_KIND[path];
  const live = (id: string) => taxRates.some((r) => r.id === id && !r.archivedAt);
  const defaultTax = defaultTaxRateId && live(defaultTaxRateId) ? defaultTaxRateId : '';
  const start = useMemo(() => initial(doc, currency, defaultTax, customerId, customerId ? env.names.get(customerId) : null, prefill), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Values>(start);
  const strip = (v: Values) => JSON.stringify({ ...v, customerName: null, opportunity: v.opportunity?.id ?? null, project: v.project?.id ?? null, lines: v.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.discountAmount, l.taxRateId, l.catalog?.item.id ?? null]) });
  const dirty = strip(values) !== strip(start);
  useEffect(() => markDirty('form', dirty), [dirty, markDirty]);
  useEffect(() => () => markDirty('form', false), [markDirty]);
  const submit = useSubmit(env.onSessionEnded, doc ? 'versioned' : 'idempotent');
  const keyFor = useIdempotencyKey();
  const [lineErrors, setLineErrors] = useState<string | null>(null);
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));
  // LC-2: choosing a different customer clears a project or opportunity that belongs to another one, and the
  // contact (a customer's own), before saving, and says so. Choosing the same customer again keeps them.
  const [cleared, setCleared] = useState<string | null>(null);
  function pickCustomer(c: Customer | null) {
    if (!c) return set({ customerId: '', customerName: null });
    const dropProject = !fitsCustomer(values.project, c.id, false);
    const dropOpportunity = !fitsCustomer(values.opportunity, c.id, true);
    const names = [dropProject ? 'project' : null, dropOpportunity ? 'opportunity' : null].filter(Boolean);
    setCleared(names.length ? `The ${names.join(' and ')} you had chosen belonged to a different customer, so ${names.length > 1 ? 'they were' : 'it was'} cleared. Choose again if you still want to link ${names.length > 1 ? 'them' : 'it'}.` : null);
    setValues((v) => ({
      ...v, customerId: c.id, customerName: c.displayName, contactId: c.id === v.customerId ? v.contactId : null,
      project: dropProject ? null : v.project, opportunity: dropOpportunity ? null : v.opportunity,
    }));
  }
  /** A name read for a linked record: fills the label without counting as a change. */
  const resolved = (key: 'opportunity' | 'project') => (ref: LinkRef) => setValues((v) => (v[key]?.id === ref.id ? { ...v, [key]: ref } : v));
  const setLine = (key: string, patch: Partial<Line>) => setValues((v) => ({ ...v, lines: v.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  // F7-B: start a new line from a catalog item (quotes and invoices only).
  const [picking, setPicking] = useState(false);
  const [announce, setAnnounce] = useState('');
  const fromCatalog = kind !== 'CREDIT_NOTE' && env.can.write;
  function addFromCatalog(item: CatalogItem) {
    const start = catalogLineStart(item, values.currencyCode, defaultTax, live);
    const line: Line = {
      key: lineKey(), description: start.description, quantity: '1', unitPrice: start.unitPrice, discountAmount: '', taxRateId: start.taxRateId,
      catalog: { item, priceFilled: start.unitPrice !== '', taxNote: start.taxNote },
    };
    setValues((v) => ({ ...v, lines: [...v.lines, line] }));
    setAnnounce(`Added ${item.name} as line ${values.lines.length + 1}.`);
    setPicking(false);
  }
  /** A new draft's currency can still change: a price copied from an item follows it (never converted). */
  function changeCurrency(code: string) {
    setValues((v) => ({
      ...v, currencyCode: code,
      lines: v.lines.map((l) => {
        if (!l.catalog || (l.unitPrice !== '' && !l.catalog.priceFilled)) return l;
        const fits = l.catalog.item.unitPrice !== null && l.catalog.item.currencyCode === code;
        return { ...l, unitPrice: fits ? l.catalog.item.unitPrice! : '', catalog: { ...l.catalog, priceFilled: fits } };
      }),
    }));
  }
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
      ...(l.catalog ? { catalogItemId: l.catalog.item.id } : {}),
      description: l.description, quantity: l.quantity.trim(), unitPrice: l.unitPrice.trim(),
      ...(l.discountAmount.trim() ? { discountAmount: l.discountAmount.trim() } : {}), taxRateId: l.taxRateId || null,
    }));
    const date = values.date || null;
    const common = kind === 'CREDIT_NOTE' ? { notes: values.notes, lines }
      : {
        customerId: values.customerId, notes: values.notes, lines, ...(kind === 'QUOTE' ? { validUntil: date } : { dueDate: date }),
        // A link is sent only when this person can read that Zone: otherwise it is left exactly as it was.
        ...(values.contactId !== (doc?.contactId ?? null) ? { contactId: values.contactId } : {}),
        ...(env.sales ? { opportunityId: values.opportunity?.id ?? null } : {}),
        ...(env.projects ? { projectId: values.project?.id ?? null } : {}),
      };
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
                  onPick={pickCustomer} onSessionEnded={env.onSessionEnded}
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
                  <Select {...c} value={values.currencyCode} onChange={(e) => changeCurrency(e.target.value)}>
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

        {kind !== 'CREDIT_NOTE' && (env.sales || env.projects) ? (
          <FormSection title="Links" description="Optional. Link this draft to the work it belongs to. Only records of the chosen customer are listed.">
            <div className="grid gap-4 sm:grid-cols-2">
              {env.sales ? (
                <OpportunityField sales={env.sales} slug={slug} customerId={values.customerId} value={values.opportunity} onChange={(opportunity) => { setCleared(null); set({ opportunity }); }}
                  onResolved={resolved('opportunity')} onSessionEnded={env.onSessionEnded} error={submit.fields.opportunityId} />
              ) : null}
              {env.projects ? (
                <ProjectField projects={env.projects} slug={slug} customerId={values.customerId} requireCustomer value={values.project} onChange={(project) => { setCleared(null); set({ project }); }}
                  onResolved={resolved('project')} onSessionEnded={env.onSessionEnded} error={submit.fields.projectId} />
              ) : null}
            </div>
            {cleared ? <p role="status" className="mt-3 text-sm text-muted-foreground">{cleared}</p> : null}
          </FormSection>
        ) : null}

        <FormSection title="Lines" description="Prices exclude tax. Tax comes only from your business's tax rates and is calculated by the server.">
          <ol className="space-y-4">
            {values.lines.map((l, i) => (
              <li key={l.key} className="rounded-xl border p-4">
                <fieldset>
                  <legend className="mb-3 text-sm font-medium">Line {i + 1}</legend>
                  {l.catalog ? (
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                        From catalog: {l.catalog.item.name}{l.catalog.item.code ? ` (${l.catalog.item.code})` : ''}
                      </span>
                      <button type="button" onClick={() => setLine(l.key, { catalog: undefined })} aria-label={`Keep line ${i + 1} as a manual line`}
                        className="rounded-md font-medium text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                        Keep as manual line
                      </button>
                    </div>
                  ) : null}
                  {l.catalog && !l.unitPrice && catalogPriceNote(l.catalog.item, values.currencyCode) ? (
                    <p className="mb-3 text-xs text-muted-foreground">{catalogPriceNote(l.catalog.item, values.currencyCode)}</p>
                  ) : null}
                  {l.catalog?.taxNote ? <p className="mb-3 text-xs text-muted-foreground">{l.catalog.taxNote}</p> : null}
                  <div className="grid gap-3 sm:grid-cols-6">
                    <Field label="Description" className="sm:col-span-6">{(c) => (
                      <Textarea {...c} rows={2} maxLength={1000} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                    )}</Field>
                    <Field label="Quantity" className="sm:col-span-1">{(c) => <Input {...c} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />}</Field>
                    <Field label={`Unit price (${values.currencyCode})`} className="sm:col-span-2">{(c) => (
                      <Input {...c} inputMode="decimal" placeholder="0.00" value={l.unitPrice}
                        onChange={(e) => setLine(l.key, { unitPrice: e.target.value, ...(l.catalog ? { catalog: { ...l.catalog, priceFilled: false } } : {}) })} />
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
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" disabled={values.lines.length >= 200} onClick={() => set({ lines: [...values.lines, blankLine(defaultTax)] })}>Add line</Button>
            {fromCatalog ? (
              <Button variant="outline" disabled={values.lines.length >= 200} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>Add from catalog</Button>
            ) : null}
          </div>
          {fromCatalog && picking ? (
            <CatalogLinePicker documentCurrency={values.currencyCode} disabled={values.lines.length >= 200} onPick={addFromCatalog} onClose={() => setPicking(false)} />
          ) : null}
          <p className="sr-only" aria-live="polite">{announce}</p>
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


/**
 * LC-2: a new quote started from an opportunity (the Sales Zone's "Create quote"). The opportunity is read
 * through the Sales API (which checks sales:read and the business again); customer, contact, currency and the
 * link come from it, and everything stays editable. An opportunity without a customer asks for one.
 */
export function DocumentFromOpportunity({ path, opportunityId, taxRates, defaultTaxRateId, onSaved, onCancel }: {
  path: DocumentPath; opportunityId: string; taxRates: TaxRateOption[]; defaultTaxRateId: string | null;
  onSaved: (saved: FinanceDocument, created: boolean) => void; onCancel: () => void;
}) {
  const env = useFinance();
  const { state, reload } = useLoad(`doc-from-opp|${env.slug}|${opportunityId}`, (signal) => (env.sales ? env.sales.get(env.slug, opportunityId, signal) : Promise.resolve({ kind: 'forbidden' as const })));
  const known = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
  useRequestNames(known?.customerId ? [known.customerId] : []);
  if (state.status === 'loading') return <LoadingRows label="Loading the opportunity…" />;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="This opportunity" onRetry={reload} onSessionEnded={env.onSessionEnded} />;
  const o: Opportunity = state.outcome.data;
  const prefill: DocumentPrefill = {
    customerId: o.customerId ?? '', customerName: o.customerId ? env.names.get(o.customerId) ?? null : null, contactId: o.customerId ? o.contactId : null,
    currencyCode: o.currencyCode, opportunity: { id: o.id, label: o.title, customerId: o.customerId },
  };
  return <DocumentForm path={path} taxRates={taxRates} defaultTaxRateId={defaultTaxRateId} prefill={prefill} onSaved={onSaved} onCancel={onCancel} />;
}
