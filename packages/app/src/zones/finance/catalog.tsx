import { CATALOG_UNITS, type CatalogItem, type CatalogTaxMode, type CatalogUnit } from '@business-os/contracts';
import {
  Alert, AlertDescription, Badge, Button, Field, FormSection, Input, Select, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
  Textarea,
} from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CatalogQuery, TaxRateOption } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { useFinance } from './env';
import { LoadingRows } from './expense-list';
import { uncertainMessage } from './shared';

// Finance F7-A (docs/finance-catalog-f7a.md): the products and services catalog. Reading is
// finance:read; every change is finance:catalog. Controls follow the server's keys for presentation
// only; the API enforces every rule again. Quotes and invoices do not read the catalog in F7-A, and the
// screens say so: changing an item never changes a document.

const WRAP = '[overflow-wrap:anywhere]';
const PAGE_SIZE = 25;

export const UNIT_LABEL: Record<CatalogUnit, string> = {
  each: 'Each', hour: 'Hour', minute: 'Minute', day: 'Day', week: 'Week', month: 'Month', year: 'Year', job: 'Job', visit: 'Visit', session: 'Session',
  licence: 'Licence', user: 'User', pack: 'Pack', box: 'Box', set: 'Set', pair: 'Pair', kg: 'Kilogram (kg)', g: 'Gram (g)', tonne: 'Tonne',
  l: 'Litre (L)', ml: 'Millilitre (mL)', m: 'Metre (m)', cm: 'Centimetre (cm)', km: 'Kilometre (km)', m2: 'Square metre (m²)', m3: 'Cubic metre (m³)',
};
export const TAX_MODE_LABEL: Record<CatalogTaxMode, string> = { BUSINESS_DEFAULT: 'Business default rate', RATE: 'A specific tax rate', NONE: 'No tax' };
const TYPE_LABEL = { PRODUCT: 'Product', SERVICE: 'Service' } as const;

/** A unit price exactly as stored (up to 6 decimals), in the item's currency, never rounded for display. */
export function formatUnitPrice(amount: string | null, currency: string, locale?: string): string {
  if (amount === null) return 'No default price';
  try {
    const min = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().minimumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: min, maximumFractionDigits: 6 }).format(amount as unknown as number);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** The tax an item starts a line with, in words. */
export function taxLabel(item: Pick<CatalogItem, 'taxMode' | 'taxRate'>): string {
  if (item.taxMode === 'NONE') return 'No tax';
  if (item.taxMode === 'BUSINESS_DEFAULT') return 'Business default rate';
  if (!item.taxRate) return 'Tax rate';
  return `${item.taxRate.name} (${item.taxRate.ratePercent}%)${item.taxRate.archived ? ', archived' : ''}`;
}

export function catalogProblem(code: string | undefined): string {
  switch (code) {
    case 'stale': return 'Someone else changed this item. Reload it and try again.';
    case 'duplicate_code': return 'Another item already uses that code (codes are unique, ignoring capitals, and archived items keep theirs).';
    case 'archived_reference': return 'That tax rate has been archived. Choose an active one.';
    case 'archived': return 'This item is archived. Restore it before changing it.';
    case 'not_archived': return 'This item is not archived.';
    default: return 'That change could not be made. Reload and try again.';
  }
}

interface Filters { q: string; type: '' | 'PRODUCT' | 'SERVICE'; status: CatalogQuery['status'] }
const DEFAULT_FILTERS: Filters = { q: '', type: '', status: 'current' };

export function CatalogList() {
  const { client, slug, locale, can, go, onSessionEnded } = useFinance();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [text, setText] = useState('');
  const [pager, setPager] = useState<{ sig: string; stack: string[] }>({ sig: '', stack: [] });
  useEffect(() => {
    if (text.trim() === filters.q) return;
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: text.trim() })), 300);
    return () => clearTimeout(timer);
  }, [text, filters.q]);
  const sig = JSON.stringify(filters);
  const stack = pager.sig === sig ? pager.stack : [];
  const cursor = stack[stack.length - 1];
  const { state, reload } = useLoad(`catalog|${slug}|${sig}|${cursor ?? ''}`, (signal) => client.catalogItems(slug, {
    q: filters.q || undefined, type: filters.type || undefined, status: filters.status, cursor, limit: PAGE_SIZE,
  }, signal));
  const page = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
  const filtered = sig !== JSON.stringify(DEFAULT_FILTERS);
  const add = can.catalog ? <Button onClick={() => go({ name: 'catalog-new' })}>New item</Button> : undefined;

  return (
    <ZonePage
      title="Products & services" eyebrow="Finance" primaryActions={add}
      description="What the business sells, with a default price and tax. Quotes and invoices keep their own copy of every line, so changing an item never changes a document."
    >
      <div role="search" aria-label="Filter products and services" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search" className="sm:col-span-2">{(c) => <Input {...c} type="search" value={text} placeholder="Name, code or description" onChange={(e) => setText(e.target.value)} />}</Field>
        <Field label="Type">{(c) => (
          <Select {...c} value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value as Filters['type'] })}>
            <option value="">Products and services</option><option value="PRODUCT">Products</option><option value="SERVICE">Services</option>
          </Select>
        )}</Field>
        <Field label="Status">{(c) => (
          <Select {...c} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters['status'] })}>
            <option value="current">Active and inactive</option><option value="active">Active</option><option value="inactive">Inactive</option>
            <option value="archived">Archived</option><option value="all">All, including archived</option>
          </Select>
        )}</Field>
      </div>

      {state.status === 'loading' ? <LoadingRows label="Loading products and services…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Products and services" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {page && page.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-10 text-center">
          <p className="font-semibold">{filtered ? 'Nothing matches these filters' : 'No products or services yet'}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered ? 'Try a different search or clear the filters.' : can.catalog ? 'Add what you sell to reuse its price and tax.' : 'Items added by an owner or admin will appear here.'}
          </p>
          <div className="mt-4 flex justify-center gap-3">
            {filtered ? <Button variant="outline" onClick={() => { setText(''); setFilters(DEFAULT_FILTERS); }}>Clear filters</Button> : add}
          </div>
        </div>
      ) : null}
      {page && page.items.length > 0 ? (
        <>
          <Table aria-label="Products and services">
            <TableCaption>{filtered ? 'Filtered items, by name.' : 'Items, by name.'}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead><TableHead className="hidden md:table-cell">Type</TableHead><TableHead className="hidden lg:table-cell">Tax</TableHead>
                <TableHead>Status</TableHead><TableHead className="text-right">Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className={WRAP}>
                    <button type="button" className="text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => go({ name: 'catalog-item', id: item.id })}>
                      {item.name}
                    </button>
                    {item.code ? <p className="text-xs text-muted-foreground">{item.code}</p> : null}
                    <p className="text-xs text-muted-foreground md:hidden">{TYPE_LABEL[item.type]}</p>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{TYPE_LABEL[item.type]}</TableCell>
                  <TableCell className={`hidden lg:table-cell ${WRAP}`}>{taxLabel(item)}</TableCell>
                  <TableCell><StatusBadges item={item} /></TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatUnitPrice(item.unitPrice, item.currencyCode, locale)}
                    {item.unitPrice !== null ? <span className="block text-xs text-muted-foreground">{item.unit === 'each' ? 'each' : `per ${UNIT_LABEL[item.unit].toLowerCase()}`}</span> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav aria-label="Pages" className="flex justify-between gap-3">
            <Button variant="outline" disabled={stack.length === 0} onClick={() => setPager({ sig, stack: stack.slice(0, -1) })}>Previous</Button>
            <Button variant="outline" disabled={!page.nextCursor} onClick={() => page.nextCursor && setPager({ sig, stack: [...stack, page.nextCursor] })}>Next</Button>
          </nav>
        </>
      ) : null}
    </ZonePage>
  );
}

function StatusBadges({ item }: { item: CatalogItem }) {
  return (
    <div className="flex flex-wrap gap-1">
      {item.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
      <Badge tone={item.status === 'ACTIVE' ? 'success' : 'neutral'}>{item.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>
    </div>
  );
}

/** One item: its details, edits (finance:catalog, not archived) and lifecycle actions. */
export function CatalogItemPage({ id, taxRates, defaultTaxRateId }: { id: string; taxRates: TaxRateOption[]; defaultTaxRateId: string | null }) {
  const { client, slug, locale, can, go, leave, onSessionEnded } = useFinance();
  const [generation, setGeneration] = useState(0);
  const { state, reload } = useLoad(`catalog-item|${slug}|${id}|${generation}`, (signal) => client.catalogItem(slug, id, signal));
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (state.status === 'loading') return <LoadingRows label="Loading the item…" />;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="This item" onRetry={reload} onSessionEnded={onSessionEnded} />;
  const item = state.outcome.data;
  const editable = Boolean(can.catalog) && item.archivedAt === null;

  async function act(call: () => ReturnType<typeof client.archiveCatalogItem>, ok: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    let out: Awaited<ReturnType<typeof client.archiveCatalogItem>>;
    try {
      out = await call();
    } catch {
      out = { kind: 'unreachable' };
    }
    setBusy(false);
    if (out.kind === 'ok') {
      setMessage({ tone: 'ok', text: ok });
      setGeneration((g) => g + 1);
      return;
    }
    if (out.kind === 'unauthenticated') return onSessionEnded();
    setMessage({
      tone: 'error',
      text: out.kind === 'conflict' ? catalogProblem(out.code) : out.kind === 'forbidden' ? 'Only owners and admins can change products and services.'
        : out.kind === 'unreachable' ? uncertainMessage('versioned') : 'That change could not be saved. Nothing was changed.',
    });
    if (out.kind === 'conflict') setGeneration((g) => g + 1);
  }

  const actions = can.catalog ? (
    item.archivedAt === null ? (
      <>
        <Button variant="outline" disabled={busy} onClick={() => void act(() => client.updateCatalogItem(slug, item.id, { version: item.version, status: item.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
          item.status === 'ACTIVE' ? 'Marked inactive. It stays in the catalog but is not offered for new work.' : 'Marked active.')}>
          {item.status === 'ACTIVE' ? 'Mark inactive' : 'Mark active'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void act(() => client.archiveCatalogItem(slug, item.id, item.version), 'Archived. Restore it at any time.')}>Archive</Button>
      </>
    ) : <Button disabled={busy} onClick={() => void act(() => client.restoreCatalogItem(slug, item.id, item.version), 'Restored.')}>Restore</Button>
  ) : undefined;

  return (
    <ZonePage
      title={item.name} eyebrow={`Finance · ${TYPE_LABEL[item.type]}`} secondaryActions={actions}
      description={item.archivedAt ? 'Archived: read-only until it is restored. Documents that used it keep their own lines.' : 'Changes apply to new work only. Quotes and invoices keep their own copy of every line.'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadges item={item} />
        <Button variant="ghost" size="sm" onClick={() => leave(() => go({ name: 'catalog' }))}>Back to products & services</Button>
      </div>
      {message ? <Alert tone={message.tone === 'ok' ? 'success' : 'danger'} role={message.tone === 'ok' ? 'status' : 'alert'}><AlertDescription>{message.text}</AlertDescription></Alert> : null}
      {editable ? (
        <CatalogForm key={item.version} item={item} taxRates={taxRates} defaultTaxRateId={defaultTaxRateId}
          onSaved={() => { setMessage({ tone: 'ok', text: 'Changes saved.' }); setGeneration((g) => g + 1); }}
          onCancel={() => leave(() => go({ name: 'catalog' }))} />
      ) : (
        <dl className="grid gap-4 sm:grid-cols-2">
          <Detail label="Code">{item.code ?? '—'}</Detail>
          <Detail label="Unit">{UNIT_LABEL[item.unit]}</Detail>
          <Detail label="Default price">{formatUnitPrice(item.unitPrice, item.currencyCode, locale)}</Detail>
          <Detail label="Tax">{taxLabel(item)}</Detail>
          <Detail label="Description" wide>{item.description ?? '—'}</Detail>
        </dl>
      )}
    </ZonePage>
  );
}

function Detail({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`mt-1 whitespace-pre-line ${WRAP}`}>{children}</dd>
    </div>
  );
}

export function CatalogNew({ taxRates, defaultTaxRateId }: { taxRates: TaxRateOption[]; defaultTaxRateId: string | null }) {
  const { go, leave } = useFinance();
  return (
    <ZonePage title="New product or service" eyebrow="Finance" description="Its price and tax are defaults for new work. Documents keep their own copy.">
      <CatalogForm taxRates={taxRates} defaultTaxRateId={defaultTaxRateId}
        onSaved={(saved) => go({ name: 'catalog-item', id: saved.id }, `${saved.name} was added.`)} onCancel={() => leave(() => go({ name: 'catalog' }))} />
    </ZonePage>
  );
}

type Values = {
  type: 'PRODUCT' | 'SERVICE'; name: string; code: string; description: string; unit: CatalogUnit; unitPrice: string; currencyCode: string;
  taxMode: CatalogTaxMode; taxRateId: string;
};

function CatalogForm({ item, taxRates, defaultTaxRateId, onSaved, onCancel }: {
  item?: CatalogItem; taxRates: TaxRateOption[]; defaultTaxRateId: string | null; onSaved: (item: CatalogItem) => void; onCancel: () => void;
}) {
  const { client, slug, currency, markDirty, onSessionEnded } = useFinance();
  const start = useMemo<Values>(() => (item ? {
    type: item.type, name: item.name, code: item.code ?? '', description: item.description ?? '', unit: item.unit, unitPrice: item.unitPrice ?? '',
    currencyCode: item.currencyCode, taxMode: item.taxMode, taxRateId: item.taxRateId ?? '',
  } : {
    type: 'SERVICE', name: '', code: '', description: '', unit: 'each', unitPrice: '', currencyCode: currency, taxMode: defaultTaxRateId ? 'BUSINESS_DEFAULT' : 'NONE', taxRateId: '',
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Values>(start);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(start);
  useEffect(() => {
    markDirty('form', dirty);
    return () => markDirty('form', false);
  }, [dirty, markDirty]);
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));
  // Archived rates are offered only when the item already uses one (it keeps that link).
  const rates = taxRates.filter((r) => !r.archivedAt || r.id === item?.taxRateId);
  const defaultRate = taxRates.find((r) => r.id === defaultTaxRateId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setErrors({});
    const fields = {
      name: values.name, code: values.code, description: values.description, unit: values.unit, unitPrice: values.unitPrice.trim() || null,
      currencyCode: values.currencyCode.trim().toUpperCase(), taxMode: values.taxMode, taxRateId: values.taxMode === 'RATE' ? values.taxRateId || null : null,
    };
    let out: Awaited<ReturnType<typeof client.createCatalogItem>>;
    try {
      out = item ? await client.updateCatalogItem(slug, item.id, { version: item.version, ...fields }) : await client.createCatalogItem(slug, { type: values.type, ...fields });
    } catch {
      out = { kind: 'unreachable' };
    }
    setBusy(false);
    if (out.kind === 'ok') {
      markDirty('form', false);
      onSaved(out.data);
      return;
    }
    if (out.kind === 'unauthenticated') onSessionEnded();
    else if (out.kind === 'invalid_input') {
      setErrors(out.fields ?? {});
      setMessage(out.message);
    } else if (out.kind === 'conflict') setMessage(catalogProblem(out.code));
    else if (out.kind === 'forbidden') setMessage('Only owners and admins can change products and services.');
    else if (out.kind === 'unreachable') {
      setMessage(item ? uncertainMessage('versioned') : 'The connection dropped before Business OS answered, so this item may already have been added. Check the list before saving it again.');
    } else setMessage('The item could not be saved. Reload to see the current state before trying again.');
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-8">
      {message ? <Alert tone="danger" role="alert"><AlertDescription>{message}</AlertDescription></Alert> : null}
      <FormSection title="What it is">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" hint={item ? 'Fixed once created' : undefined} error={errors.type}>
            {(c) => (
              <Select {...c} disabled={!!item} value={values.type} onChange={(e) => set({ type: e.target.value as Values['type'] })}>
                <option value="SERVICE">Service</option><option value="PRODUCT">Product</option>
              </Select>
            )}
          </Field>
          <Field label="Code" hint="Optional SKU or service code. Unique in your business." error={errors.code}>
            {(c) => <Input {...c} maxLength={64} value={values.code} onChange={(e) => set({ code: e.target.value })} />}
          </Field>
          <Field label="Name" error={errors.name} className="sm:col-span-2">
            {(c) => <Input {...c} required maxLength={200} value={values.name} onChange={(e) => set({ name: e.target.value })} />}
          </Field>
          <Field label="Description" hint="Copied onto quote and invoice lines with the name" error={errors.description} className="sm:col-span-2">
            {(c) => <Textarea {...c} maxLength={2000} value={values.description} onChange={(e) => set({ description: e.target.value })} />}
          </Field>
        </div>
      </FormSection>
      <FormSection title="Price and tax" description="Prices are before tax. Nothing is converted between currencies.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Unit" error={errors.unit}>
            {(c) => (
              <Select {...c} value={values.unit} onChange={(e) => set({ unit: e.target.value as CatalogUnit })}>
                {CATALOG_UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="Default price" hint="Leave empty for no default" error={errors.unitPrice}>
              {(c) => <Input {...c} inputMode="decimal" placeholder="0.00" value={values.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} />}
            </Field>
            <Field label="Currency" error={errors.currencyCode}>
              {(c) => <Input {...c} maxLength={3} value={values.currencyCode} onChange={(e) => set({ currencyCode: e.target.value.toUpperCase() })} />}
            </Field>
          </div>
          <Field label="Tax" error={errors.taxMode}
            hint={values.taxMode === 'BUSINESS_DEFAULT' ? (defaultRate ? `Currently ${defaultRate.name} (${defaultRate.ratePercent}%), from Finance settings` : 'Your business has no default tax rate yet, so no tax applies') : undefined}>
            {(c) => (
              <Select {...c} value={values.taxMode} onChange={(e) => set({ taxMode: e.target.value as CatalogTaxMode })}>
                {(Object.keys(TAX_MODE_LABEL) as CatalogTaxMode[]).map((m) => <option key={m} value={m}>{TAX_MODE_LABEL[m]}</option>)}
              </Select>
            )}
          </Field>
          {values.taxMode === 'RATE' ? (
            <Field label="Tax rate" error={errors.taxRateId} hint={rates.length === 0 ? 'No tax rates yet. An owner or admin can add them in Finance settings.' : undefined}>
              {(c) => (
                <Select {...c} required value={values.taxRateId} onChange={(e) => set({ taxRateId: e.target.value })}>
                  <option value="">Choose a rate</option>
                  {rates.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.ratePercent}%){r.archivedAt ? ' (archived)' : ''}</option>)}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
      </FormSection>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy}>{item ? 'Save changes' : 'Add item'}</Button>
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}
