import type { FinanceDocumentKind } from '@business-os/contracts';
import {
  Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, FormSection, Input, Select, Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow, Textarea,
} from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { FinanceSettingsData, NumberSeriesData, TaxRateOption } from '../../api/finance';
import { ZonePage, type ZonePageTab } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { BrandingSettings } from './branding-settings';
import { Categories } from './categories';
import { useFinance, type SettingsTab } from './env';
import { KIND_LABEL, LoadingRows, useSubmit, WRAP } from './shared';

const TABS: readonly (ZonePageTab & { id: SettingsTab })[] = [
  { id: 'business', label: 'Business details' }, { id: 'numbering', label: 'Numbering' }, { id: 'tax-rates', label: 'Tax rates' }, { id: 'categories', label: 'Expense categories' },
  { id: 'documents', label: 'Documents' },
];

/**
 * Finance settings that the backend already supports: seller details and document defaults, numbering
 * series, tax rates and expense categories. Changing them needs finance:manage; everyone with
 * finance:read sees them read-only. The retention policy and legal hold are shown but not editable here.
 */
export function FinanceSettingsPage({ tab = 'business', onChanged }: { tab?: SettingsTab; onChanged: () => void }) {
  const env = useFinance();
  const onTab = (id: string) => env.go({ name: 'settings', tab: id as SettingsTab });
  if (tab === 'categories') {
    return <Categories client={env.client} slug={env.slug} canManage={env.can.manage} tabs={TABS} onTab={onTab} onChanged={onChanged} onSessionEnded={env.onSessionEnded} />;
  }
  const copy = {
    business: { title: 'Business details', description: 'Your details as they appear on quotes, invoices and credit notes, and the defaults for new documents.' },
    numbering: { title: 'Numbering', description: 'Each kind of document is numbered in its own gapless sequence. Numbers are assigned only when a document is issued.' },
    'tax-rates': { title: 'Tax rates', description: 'Rates your documents and expenses can use. A rate’s percentage never changes once created: add a new rate instead.' },
    documents: { title: 'Documents', description: 'How quote and invoice PDFs look: logo, colour, titles, terms and footer. PDFs already kept never change.' },
  }[tab];
  const canChange = tab === 'documents' ? env.can.branding : env.can.manage;
  return (
    <ZonePage title={copy.title} description={copy.description} eyebrow="Finance · Settings" tabs={TABS} currentTab={tab} onTab={onTab}>
      {!canChange ? <Alert tone="info"><AlertDescription>You can view these settings. Only owners and admins can change them.</AlertDescription></Alert> : null}
      {tab === 'business' ? <BusinessSettings onChanged={onChanged} /> : null}
      {tab === 'numbering' ? <Numbering /> : null}
      {tab === 'tax-rates' ? <TaxRates onChanged={onChanged} /> : null}
      {tab === 'documents' ? <BrandingSettings /> : null}
    </ZonePage>
  );
}

type Values = {
  sellerLegalName: string; sellerAddress: string; sellerEmail: string; sellerPhone: string; paymentInstructions: string;
  identifiers: { label: string; value: string }[]; defaultPaymentTermsDays: string; defaultQuoteValidityDays: string; defaultTaxRateId: string;
};
const valuesOf = (s: FinanceSettingsData): Values => ({
  sellerLegalName: s.sellerLegalName ?? '', sellerAddress: s.sellerAddress ?? '', sellerEmail: s.sellerEmail ?? '', sellerPhone: s.sellerPhone ?? '',
  paymentInstructions: s.paymentInstructions ?? '', identifiers: s.sellerIdentifiers.map((x) => ({ ...x })),
  defaultPaymentTermsDays: s.defaultPaymentTermsDays === null ? '' : String(s.defaultPaymentTermsDays),
  defaultQuoteValidityDays: s.defaultQuoteValidityDays === null ? '' : String(s.defaultQuoteValidityDays), defaultTaxRateId: s.defaultTaxRateId ?? '',
});

function BusinessSettings({ onChanged }: { onChanged: () => void }) {
  const env = useFinance();
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState(false);
  const settings = useLoad(`settings|${env.slug}|${generation}`, (signal) => env.client.settings(env.slug, signal));
  const rates = useLoad(`settings-rates|${env.slug}`, (signal) => env.client.taxRates(env.slug, signal));
  // While a reload after saving is in flight, keep the form on screen (same business, same record).
  const current = settings.state.status === 'done' ? settings.state.outcome : settings.previous;
  if (!current || rates.state.status === 'loading') return <LoadingRows label="Loading settings…" />;
  if (current.kind !== 'ok') return <Problem outcome={current} what="Finance settings" onRetry={settings.reload} onSessionEnded={env.onSessionEnded} />;
  if (rates.state.outcome.kind !== 'ok') return <Problem outcome={rates.state.outcome} what="Tax rates" onRetry={rates.reload} onSessionEnded={env.onSessionEnded} />;
  const s = current.data;
  return (
    <>
      {saved ? <Alert tone="success" role="status"><AlertDescription>Settings saved. Documents issued from now on use them; issued documents keep the details they were issued with.</AlertDescription></Alert> : null}
      <SettingsForm key={s.version} settings={s} rates={rates.state.outcome.data} onEdit={() => setSaved(false)}
        onSaved={() => { setSaved(true); setGeneration((g) => g + 1); onChanged(); }} onReload={() => setGeneration((g) => g + 1)} />
    </>
  );
}

function SettingsForm({ settings, rates, onSaved, onEdit, onReload }: { settings: FinanceSettingsData; rates: TaxRateOption[]; onSaved: () => void; onEdit: () => void; onReload: () => void }) {
  const env = useFinance();
  const start = useMemo(() => valuesOf(settings), [settings]);
  const [v, setV] = useState(start);
  const submit = useSubmit(env.onSessionEnded);
  const dirty = JSON.stringify(v) !== JSON.stringify(start);
  const { markDirty } = env;
  useEffect(() => markDirty('settings', dirty), [dirty, markDirty]);
  useEffect(() => () => markDirty('settings', false), [markDirty]);
  const set = (patch: Partial<Values>) => { onEdit(); setV((x) => ({ ...x, ...patch })); };
  const ro = !env.can.manage;
  const days = (x: string) => (x.trim() === '' ? null : /^\d+$/.test(x.trim()) ? Number(x.trim()) : Number.NaN);

  async function save(event: FormEvent) {
    event.preventDefault();
    const body = {
      version: settings.version, sellerLegalName: v.sellerLegalName, sellerAddress: v.sellerAddress, sellerEmail: v.sellerEmail.trim() || null, sellerPhone: v.sellerPhone,
      paymentInstructions: v.paymentInstructions, sellerIdentifiers: v.identifiers.filter((x) => x.label.trim() || x.value.trim()),
      defaultPaymentTermsDays: days(v.defaultPaymentTermsDays), defaultQuoteValidityDays: days(v.defaultQuoteValidityDays), defaultTaxRateId: v.defaultTaxRateId || null,
    };
    await submit.run(() => env.client.updateSettings(env.slug, body), () => {
      markDirty('settings', false);
      onSaved();
    });
  }
  return (
    <form onSubmit={save} noValidate className="space-y-8">
      {submit.error ? (
        <Alert tone="danger" role="alert"><AlertDescription>{submit.error}{submit.stale ? <> <button type="button" className="font-medium underline" onClick={onReload}>Reload</button></> : null}</AlertDescription></Alert>
      ) : null}
      <FormSection title="Seller details" description="Copied onto each document when it is issued.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name" error={submit.fields.sellerLegalName}>{(c) => <Input {...c} readOnly={ro} maxLength={200} value={v.sellerLegalName} onChange={(e) => set({ sellerLegalName: e.target.value })} />}</Field>
          <Field label="Email" error={submit.fields.sellerEmail}>{(c) => <Input {...c} readOnly={ro} type="email" maxLength={254} value={v.sellerEmail} onChange={(e) => set({ sellerEmail: e.target.value })} />}</Field>
          <Field label="Phone">{(c) => <Input {...c} readOnly={ro} maxLength={50} value={v.sellerPhone} onChange={(e) => set({ sellerPhone: e.target.value })} />}</Field>
          <Field label="Address" className="sm:col-span-2">{(c) => <Textarea {...c} readOnly={ro} rows={3} maxLength={1000} value={v.sellerAddress} onChange={(e) => set({ sellerAddress: e.target.value })} />}</Field>
          <Field label="Payment instructions" hint="For example bank details for transfers. Printed on invoices." className="sm:col-span-2">{(c) => (
            <Textarea {...c} readOnly={ro} rows={3} maxLength={2000} value={v.paymentInstructions} onChange={(e) => set({ paymentInstructions: e.target.value })} />
          )}</Field>
        </div>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Business identifiers</legend>
          <p className="text-xs text-muted-foreground">For example a company or tax registration number, as you want it printed. Business OS does not check these against any register.</p>
          <ul className="mt-2 space-y-2">
            {v.identifiers.map((x, i) => (
              <li key={i} className="flex flex-wrap items-end gap-2">
                <Field label="Label" className="w-40">{(c) => <Input {...c} readOnly={ro} maxLength={50} value={x.label} onChange={(e) => set({ identifiers: v.identifiers.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} />}</Field>
                <Field label="Value" className="min-w-48 flex-1">{(c) => <Input {...c} readOnly={ro} maxLength={100} value={x.value} onChange={(e) => set({ identifiers: v.identifiers.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) })} />}</Field>
                {ro ? null : <Button variant="outline" onClick={() => set({ identifiers: v.identifiers.filter((_, j) => j !== i) })} aria-label={`Remove identifier ${i + 1}`}>Remove</Button>}
              </li>
            ))}
          </ul>
          {ro ? (v.identifiers.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">None.</p> : null) : (
            <Button variant="outline" className="mt-2" disabled={v.identifiers.length >= 10} onClick={() => set({ identifiers: [...v.identifiers, { label: '', value: '' }] })}>Add identifier</Button>
          )}
        </fieldset>
      </FormSection>
      <FormSection title="Document defaults">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Payment terms (days)" hint="Due date of an invoice issued without one. Empty: none." error={submit.fields.defaultPaymentTermsDays}>{(c) => (
            <Input {...c} readOnly={ro} inputMode="numeric" value={v.defaultPaymentTermsDays} onChange={(e) => set({ defaultPaymentTermsDays: e.target.value })} />
          )}</Field>
          <Field label="Quote validity (days)" hint="Valid-until date of a quote issued without one." error={submit.fields.defaultQuoteValidityDays}>{(c) => (
            <Input {...c} readOnly={ro} inputMode="numeric" value={v.defaultQuoteValidityDays} onChange={(e) => set({ defaultQuoteValidityDays: e.target.value })} />
          )}</Field>
          <Field label="Default tax rate" hint="Preselected on new lines.">{(c) => (
            <Select {...c} disabled={ro} value={v.defaultTaxRateId} onChange={(e) => set({ defaultTaxRateId: e.target.value })}>
              <option value="">None</option>
              {rates.filter((r) => !r.archivedAt || r.id === v.defaultTaxRateId).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.ratePercent}%)</option>)}
            </Select>
          )}</Field>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">Default currency: {settings.defaultCurrency} (the business’s currency).</p>
      </FormSection>
      <Card>
        <CardHeader><CardTitle>Record keeping</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Retention policy: {settings.retentionYears} years{settings.legalHold ? ' · legal hold is on' : ''}.</p>
          <p className="text-muted-foreground">
            Finance records are never deleted by Business OS, whatever this policy says. The retention period and legal hold are not changed from this screen
            because they affect what may happen to records later; ask the business owner to arrange a change.
            {settings.hasRetainedRecords ? ' This business already has finance records, so it cannot be deleted.' : ''}
          </p>
        </CardContent>
      </Card>
      {ro ? null : (
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={submit.busy} disabled={!dirty}>Save settings</Button>
          <Button variant="outline" disabled={!dirty || submit.busy} onClick={() => setV(start)}>Undo changes</Button>
        </div>
      )}
    </form>
  );
}

function Numbering() {
  const env = useFinance();
  const { state, reload } = useLoad(`series-settings|${env.slug}`, (signal) => env.client.numberSeries(env.slug, signal));
  if (state.status === 'loading') return <LoadingRows label="Loading numbering…" rows={3} />;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="Numbering" onRetry={reload} onSessionEnded={env.onSessionEnded} />;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {state.outcome.data.map((s) => <SeriesCard key={`${s.kind}|${s.version}`} series={s} onSaved={reload} />)}
    </div>
  );
}

function SeriesCard({ series, onSaved }: { series: NumberSeriesData; onSaved: () => void }) {
  const env = useFinance();
  const [prefix, setPrefix] = useState(series.prefix);
  const [digits, setDigits] = useState(String(series.minDigits));
  const [startAt, setStartAt] = useState(String(series.startingValue));
  const submit = useSubmit(env.onSessionEnded);
  const dirty = prefix !== series.prefix || digits !== String(series.minDigits) || (!series.used && startAt !== String(series.startingValue));
  const { markDirty } = env;
  const key = `series-${series.kind}`;
  useEffect(() => markDirty(key, dirty), [dirty, markDirty, key]);
  useEffect(() => () => markDirty(key, false), [markDirty, key]);
  const ro = !env.can.manage;
  const kind: FinanceDocumentKind = series.kind;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = {
      version: series.version, ...(prefix !== series.prefix ? { prefix } : {}), ...(digits !== String(series.minDigits) ? { minDigits: Number(digits) } : {}),
      ...(!series.used && startAt !== String(series.startingValue) ? { startingValue: /^\d+$/.test(startAt) ? Number(startAt) : Number.NaN } : {}),
    };
    void submit.run(() => env.client.updateNumberSeries(env.slug, kind, body), () => { markDirty(key, false); onSaved(); });
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{KIND_LABEL[kind]}s</CardTitle>
        {series.used ? <Badge tone="info">In use</Badge> : <Badge>Not used yet</Badge>}
      </CardHeader>
      <CardContent>
        <p className="text-sm">Next number: <span className={`font-semibold tabular-nums ${WRAP}`}>{series.nextNumber}</span></p>
        <form onSubmit={save} className="mt-4 space-y-3" noValidate>
          <Field label="Prefix" hint="Applies to numbers issued from now on.">{(c) => <Input {...c} readOnly={ro} maxLength={20} value={prefix} onChange={(e) => setPrefix(e.target.value)} />}</Field>
          <Field label="Minimum digits" hint="Shorter numbers are padded with zeros.">{(c) => <Input {...c} readOnly={ro} inputMode="numeric" value={digits} onChange={(e) => setDigits(e.target.value)} />}</Field>
          <Field label="Starting number" hint={series.used ? 'Locked: this series has issued a number, so the sequence cannot move.' : 'Can be set until the first number is issued; then it is locked.'}>
            {(c) => <Input {...c} readOnly={ro || series.used} inputMode="numeric" value={startAt} onChange={(e) => setStartAt(e.target.value)} />}
          </Field>
          {submit.error ? <p role="alert" className="text-sm font-medium text-destructive">{submit.error}</p> : null}
          {ro ? null : <Button type="submit" size="sm" loading={submit.busy} disabled={!dirty}>Save</Button>}
        </form>
      </CardContent>
    </Card>
  );
}

function TaxRates({ onChanged }: { onChanged: () => void }) {
  const env = useFinance();
  const { state, reload } = useLoad(`rates-settings|${env.slug}`, (signal) => env.client.taxRates(env.slug, signal));
  const [name, setName] = useState('');
  const [percent, setPercent] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submit = useSubmit(env.onSessionEnded);
  const ro = !env.can.manage;
  const done = (m: string) => { setNotice(m); setEditing(null); reload(); onChanged(); };
  const add = (e: FormEvent) => {
    e.preventDefault();
    void submit.run(() => env.client.createTaxRate(env.slug, { name, ratePercent: percent }), () => { setName(''); setPercent(''); done('Tax rate added.'); });
  };
  return (
    <div className="space-y-6">
      {submit.error ? <p role="alert" className="text-sm font-medium text-destructive">{submit.error}</p> : notice ? <p role="status" className="text-sm">{notice}</p> : null}
      {ro ? null : (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3" noValidate>
          <Field label="Name" className="min-w-48 flex-1" error={submit.fields.name}>{(c) => <Input {...c} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GST" />}</Field>
          <Field label="Rate (%)" className="w-32" error={submit.fields.ratePercent}>{(c) => <Input {...c} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="10" />}</Field>
          <Button type="submit" loading={submit.busy} disabled={!name.trim() || !percent.trim()}>Add tax rate</Button>
        </form>
      )}
      {state.status === 'loading' ? <LoadingRows label="Loading tax rates…" rows={3} /> : state.outcome.kind !== 'ok' ? (
        <Problem outcome={state.outcome} what="Tax rates" onRetry={reload} onSessionEnded={env.onSessionEnded} />
      ) : state.outcome.data.length === 0 ? <p className="text-sm text-muted-foreground">No tax rates yet. Lines without a rate have no tax.</p> : (
        <Table aria-label="Tax rates">
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead className="text-right">Rate</TableHead><TableHead>Status</TableHead>{ro ? null : <TableHead className="text-right">Actions</TableHead>}</TableRow></TableHeader>
          <TableBody>
            {state.outcome.data.map((r) => (
              <TableRow key={r.id}>
                <TableCell className={WRAP}>
                  {editing?.id === r.id ? (
                    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void submit.run(() => env.client.updateTaxRate(env.slug, r.id, { name: editing.name }), () => done('Tax rate renamed.')); }}>
                      <Input aria-label={`New name for ${r.name}`} maxLength={100} value={editing.name} onChange={(e) => setEditing({ id: r.id, name: e.target.value })} className="max-w-xs" autoFocus />
                      <Button type="submit" size="sm" loading={submit.busy}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </form>
                  ) : r.name}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.ratePercent}%</TableCell>
                <TableCell>{r.archivedAt ? <Badge tone="warning">Archived</Badge> : <Badge tone="success">Active</Badge>}</TableCell>
                {ro ? null : (
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {r.archivedAt ? null : <Button size="sm" variant="outline" disabled={submit.busy} onClick={() => setEditing({ id: r.id, name: r.name })}>Rename</Button>}
                      <Button size="sm" variant="outline" disabled={submit.busy}
                        onClick={() => void submit.run(() => env.client.updateTaxRate(env.slug, r.id, { archived: !r.archivedAt }), () => done(r.archivedAt ? 'Tax rate restored.' : 'Tax rate archived. Existing lines keep it.'))}>
                        {r.archivedAt ? 'Restore' : 'Archive'}
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted-foreground">Archiving a rate keeps it on documents and expenses that already use it; it just cannot be chosen for new ones.</p>
    </div>
  );
}
