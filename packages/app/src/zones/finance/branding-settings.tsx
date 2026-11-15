import {
  Alert, AlertDescription, Button, Field, FormSection, Input, Textarea,
} from '@business-os/ui';
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import type { DocumentBranding } from '../../api/finance';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { useBlobSource } from './document-pdf';
import { useFinance } from './env';
import { LoadingRows, useSubmit } from './shared';

// Finance F5 (docs/finance-documents-f5.md §5): how generated quote and invoice PDFs look. One fixed
// template; these are its only settings. Changes apply to PDFs made from now on. Kept PDFs never change.
// Seller details, identifiers and payment instructions stay on the Business details tab.

const LOGO_MAX_BYTES = 512 * 1024;

type Values = { accentColor: string; footerText: string; invoiceTitle: string; invoiceTerms: string; quoteTitle: string; quoteTerms: string };
const valuesOf = (b: DocumentBranding): Values => ({
  accentColor: b.accentColor, footerText: b.footerText ?? '', invoiceTitle: b.invoiceTitle ?? '', invoiceTerms: b.invoiceTerms ?? '',
  quoteTitle: b.quoteTitle ?? '', quoteTerms: b.quoteTerms ?? '',
});

export function BrandingSettings() {
  const env = useFinance();
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const branding = useLoad(`branding|${env.slug}|${generation}`, (signal) => env.client.branding(env.slug, signal));
  const current = branding.state.status === 'done' ? branding.state.outcome : branding.previous;
  if (!current) return <LoadingRows label="Loading document settings…" />;
  if (current.kind !== 'ok') return <Problem outcome={current} what="Document settings" onRetry={branding.reload} onSessionEnded={env.onSessionEnded} />;
  const b = current.data;
  const refresh = (message: string) => { setSaved(message); setGeneration((g) => g + 1); };
  return (
    <>
      {saved ? <Alert tone="success" role="status"><AlertDescription>{saved}</AlertDescription></Alert> : null}
      <LogoSection branding={b} onChanged={refresh} onEdit={() => setSaved(null)} onReload={() => setGeneration((g) => g + 1)} />
      <BrandingForm key={b.version} branding={b} onEdit={() => setSaved(null)} onReload={() => setGeneration((g) => g + 1)}
        onSaved={() => refresh('Document settings saved. PDFs made from now on use them. PDFs already kept do not change.')} />
    </>
  );
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function LogoSection({ branding, onChanged, onEdit, onReload }: { branding: DocumentBranding; onChanged: (m: string) => void; onEdit: () => void; onReload: () => void }) {
  const env = useFinance();
  const ro = !env.can.branding;
  const submit = useSubmit(env.onSessionEnded);
  const [localError, setLocalError] = useState<string | null>(null);
  const logo = branding.logo;
  const image = useLoad(`branding-logo|${env.slug}|${logo?.id ?? 'none'}`, async (signal) => (logo ? env.client.logo(env.slug, signal) : { kind: 'not_found' as const }));
  const blob = image.state.status === 'done' && image.state.outcome.kind === 'ok' ? image.state.outcome.data.blob : null;
  const img = useBlobSource<HTMLImageElement>(blob);

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    onEdit();
    setLocalError(null);
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') return setLocalError('Choose a PNG or JPEG image.');
    if (file.size > LOGO_MAX_BYTES) return setLocalError('That image is larger than 512 KB. Choose a smaller one.');
    const dataBase64 = await toBase64(file);
    await submit.run(() => env.client.uploadLogo(env.slug, { version: branding.version, contentType: file.type, dataBase64 }), () => onChanged('Logo uploaded. PDFs made from now on show it.'));
  }
  const remove = () => {
    onEdit();
    void submit.run(() => env.client.updateBranding(env.slug, { version: branding.version, logoAssetId: null }), () => onChanged('Logo removed. PDFs already kept still show the logo they were made with.'));
  };
  const error = localError ?? submit.error;
  return (
    <FormSection title="Logo" description="Shown at the top of quotes and invoices. PNG or JPEG, up to 512 KB and 2000 × 2000 pixels.">
      {error ? (
        <Alert tone="danger" role="alert"><AlertDescription>{error}{submit.stale ? <> <button type="button" className="font-medium underline" onClick={onReload}>Reload</button></> : null}</AlertDescription></Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-48 items-center justify-center overflow-hidden rounded-lg border bg-muted p-2">
          {logo ? (blob ? <img ref={img} alt="Current logo" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted-foreground">{image.state.status === 'loading' ? 'Loading…' : 'The logo could not be shown.'}</span>)
            : <span className="text-xs text-muted-foreground">No logo. Your business name is shown instead.</span>}
        </div>
        {ro ? null : (
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex">
              <span className="sr-only">Choose a logo image</span>
              <input type="file" accept="image/png,image/jpeg" disabled={submit.busy} onChange={(e) => void pick(e)}
                className="text-sm file:mr-3 file:h-10 file:rounded-lg file:border file:border-input file:bg-transparent file:px-4 file:text-sm file:font-medium" />
            </label>
            {logo ? <Button variant="outline" onClick={remove} disabled={submit.busy}>Remove logo</Button> : null}
          </div>
        )}
      </div>
      {logo ? <p className="mt-2 text-xs text-muted-foreground">{logo.width} × {logo.height} pixels · {Math.max(1, Math.round(logo.byteSize / 1024))} KB</p> : null}
    </FormSection>
  );
}

function BrandingForm({ branding, onSaved, onEdit, onReload }: { branding: DocumentBranding; onSaved: () => void; onEdit: () => void; onReload: () => void }) {
  const env = useFinance();
  const start = useMemo(() => valuesOf(branding), [branding]);
  const [v, setV] = useState(start);
  const submit = useSubmit(env.onSessionEnded);
  const dirty = JSON.stringify(v) !== JSON.stringify(start);
  const { markDirty } = env;
  useEffect(() => markDirty('branding', dirty), [dirty, markDirty]);
  useEffect(() => () => markDirty('branding', false), [markDirty]);
  const set = (patch: Partial<Values>) => { onEdit(); setV((x) => ({ ...x, ...patch })); };
  const ro = !env.can.branding;
  const colourOk = /^#[0-9A-Fa-f]{6}$/.test(v.accentColor.trim());

  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { version: branding.version, accentColor: v.accentColor.trim().toUpperCase(), footerText: v.footerText, invoiceTitle: v.invoiceTitle, invoiceTerms: v.invoiceTerms, quoteTitle: v.quoteTitle, quoteTerms: v.quoteTerms };
    await submit.run(() => env.client.updateBranding(env.slug, body), () => {
      markDirty('branding', false);
      onSaved();
    });
  }
  return (
    <form onSubmit={save} noValidate className="space-y-8">
      {submit.error ? (
        <Alert tone="danger" role="alert"><AlertDescription>{submit.error}{submit.stale ? <> <button type="button" className="font-medium underline" onClick={onReload}>Reload</button></> : null}</AlertDescription></Alert>
      ) : null}
      <FormSection title="Look" description="One standard A4 template. Your seller details and payment instructions come from Business details.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Accent colour" hint="Used for the title and headings: a six-digit hex code starting with #." error={submit.fields.accentColor ?? (colourOk ? undefined : 'Use a six-digit hex code starting with #')}>
            {(c) => (
              <div className="flex items-center gap-2">
                <span aria-hidden className="size-10 shrink-0 rounded-lg border" style={{ backgroundColor: colourOk ? v.accentColor : 'transparent' }} />
                <Input {...c} readOnly={ro} maxLength={7} value={v.accentColor} onChange={(e) => set({ accentColor: e.target.value })} />
              </div>
            )}
          </Field>
          <Field label="Footer" hint="Printed at the bottom of every page, for example your website or registered office." error={submit.fields.footerText} className="sm:col-span-2">
            {(c) => <Textarea {...c} readOnly={ro} rows={2} maxLength={500} value={v.footerText} onChange={(e) => set({ footerText: e.target.value })} />}
          </Field>
        </div>
      </FormSection>
      <FormSection title="Invoices">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" hint={`Empty: “${branding.defaultTitles.INVOICE}”. For example “Tax invoice”.`} error={submit.fields.invoiceTitle}>
            {(c) => <Input {...c} readOnly={ro} maxLength={60} value={v.invoiceTitle} onChange={(e) => set({ invoiceTitle: e.target.value })} />}
          </Field>
          <Field label="Terms" hint="Printed under the totals on every invoice." error={submit.fields.invoiceTerms} className="sm:col-span-2">
            {(c) => <Textarea {...c} readOnly={ro} rows={3} maxLength={2000} value={v.invoiceTerms} onChange={(e) => set({ invoiceTerms: e.target.value })} />}
          </Field>
        </div>
      </FormSection>
      <FormSection title="Quotes">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" hint={`Empty: “${branding.defaultTitles.QUOTE}”. For example “Estimate”.`} error={submit.fields.quoteTitle}>
            {(c) => <Input {...c} readOnly={ro} maxLength={60} value={v.quoteTitle} onChange={(e) => set({ quoteTitle: e.target.value })} />}
          </Field>
          <Field label="Terms" hint="Printed under the totals on every quote." error={submit.fields.quoteTerms} className="sm:col-span-2">
            {(c) => <Textarea {...c} readOnly={ro} rows={3} maxLength={2000} value={v.quoteTerms} onChange={(e) => set({ quoteTerms: e.target.value })} />}
          </Field>
        </div>
      </FormSection>
      {ro ? null : (
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={submit.busy} disabled={!dirty || !colourOk}>Save document settings</Button>
          <Button variant="outline" disabled={!dirty || submit.busy} onClick={() => setV(start)}>Undo changes</Button>
        </div>
      )}
    </form>
  );
}
