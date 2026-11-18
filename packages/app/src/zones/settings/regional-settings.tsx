import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Input, Select, SectionHeader } from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BusinessProfileData } from '../../api/settings';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import type { SettingsPageEnv } from './business-profile';
import { countryName, countryOptions, currencyOptions, fiscalYearLabel, isLocaleTag, localeLabel, monthName, timeZoneOptions } from './intl';
import { Facts } from './parts';
import { useSave } from './save';

type Values = { countryCode: string; timeZone: string; locale: string; currency: string; fiscalYearStartMonth: string };

const valuesOf = (p: BusinessProfileData): Values => ({
  countryCode: p.countryCode, timeZone: p.timeZone, locale: p.locale, currency: p.currency, fiscalYearStartMonth: p.fiscalYearStartMonth === null ? '' : String(p.fiscalYearStartMonth),
});

/** The settings whose change needs an explicit confirmation: they decide "today", formats and defaults for new records. */
const CONFIRMED = [
  { key: 'countryCode', label: 'Country', show: (v: string) => `${countryName(v)} (${v})` },
  { key: 'timeZone', label: 'Time zone', show: (v: string) => v },
  { key: 'locale', label: 'Language and region', show: (v: string) => localeLabel(v) },
  { key: 'currency', label: 'Default currency', show: (v: string) => v },
] as const;

export function changedRegional(start: Values, now: Values) {
  return CONFIRMED.filter((c) => start[c.key] !== now[c.key]).map((c) => ({ label: c.label, from: c.show(start[c.key]), to: c.show(now[c.key]) }));
}

/** Only what changed, plus the version the edit was based on. */
export function regionalPatch(start: Values, now: Values, version: number): Record<string, unknown> {
  const patch: Record<string, unknown> = { version };
  for (const c of CONFIRMED) if (start[c.key] !== now[c.key]) patch[c.key] = now[c.key];
  if (start.fiscalYearStartMonth !== now.fiscalYearStartMonth) patch.fiscalYearStartMonth = now.fiscalYearStartMonth === '' ? null : Number(now.fiscalYearStartMonth);
  return patch;
}

/**
 * Business › Regional settings. Country, time zone, language, currency and the financial year start
 * decide "today" and the defaults for NEW records only: nothing already stored is rewritten. Changing the
 * first four needs a confirmation that says exactly what changes and what does not.
 */
export function RegionalSettingsPage({ env }: { env: SettingsPageEnv }) {
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState(false);
  const load = useLoad(`settings-regional|${env.slug}|${generation}`, (signal) => env.client.businessProfile(env.slug, signal));
  const current = load.state.status === 'done' ? load.state.outcome : load.previous;
  const reload = () => setGeneration((g) => g + 1);
  const title = 'Regional settings';
  const description = 'Country, time zone, language, currency and when your financial year starts. They apply to new records from now on.';
  if (!current) return <ZonePage title={title} description={description} state={{ kind: 'loading', label: 'Loading regional settings…' }} />;
  if (current.kind !== 'ok') {
    return <ZonePage title={title} description={description}><Problem outcome={current} what="Regional settings" onRetry={load.reload} onSessionEnded={env.onSessionEnded} /></ZonePage>;
  }
  const profile = current.data;
  return (
    <ZonePage title={title} description={description}>
      {saved ? <Alert tone="success"><AlertDescription>Regional settings saved. New records use them from now on; records already saved are unchanged.</AlertDescription></Alert> : null}
      {env.canManage ? (
        <RegionalForm key={profile.version} env={env} profile={profile} onEdit={() => setSaved(false)} onReload={reload}
          onSaved={() => { setSaved(true); reload(); env.onSaved(); }} />
      ) : (
        <section aria-labelledby="regional-facts" className="space-y-3">
          <SectionHeader variant="ruled" as="h2" title={<span id="regional-facts">Current settings</span>} meta="Only owners and admins can change these" />
          <Facts items={[
            { label: 'Country', value: `${countryName(profile.countryCode)} (${profile.countryCode})` },
            { label: 'Time zone', value: profile.timeZone },
            { label: 'Language and region', value: localeLabel(profile.locale) },
            { label: 'Default currency', value: profile.currency, hint: 'For new records. Every record keeps its own currency.' },
            { label: 'Financial year', value: fiscalYearLabel(profile.fiscalYearStartMonth) },
          ]} />
        </section>
      )}
    </ZonePage>
  );
}

function RegionalForm({ env, profile, onSaved, onEdit, onReload }: { env: SettingsPageEnv; profile: BusinessProfileData; onSaved: () => void; onEdit: () => void; onReload: () => void }) {
  const start = useMemo(() => valuesOf(profile), [profile]);
  const [v, setV] = useState(start);
  const [confirming, setConfirming] = useState(false);
  const [localeError, setLocaleError] = useState<string | null>(null);
  const save = useSave(env.onSessionEnded);
  const patch = regionalPatch(start, v, profile.version);
  const dirty = Object.keys(patch).length > 1;
  const changes = changedRegional(start, v);
  const { markDraft } = env;
  useEffect(() => markDraft('regional', dirty), [dirty, markDraft]);
  useEffect(() => () => markDraft('regional', false), [markDraft]);
  const set = (change: Partial<Values>) => { onEdit(); setLocaleError(null); setV((x) => ({ ...x, ...change })); };
  const countries = useMemo(() => countryOptions(start.countryCode), [start.countryCode]);
  const zones = useMemo(() => timeZoneOptions(start.timeZone), [start.timeZone]);
  const currencies = useMemo(() => currencyOptions(start.currency), [start.currency]);

  async function commit() {
    await save.run(() => env.client.updateBusinessProfile(env.slug, patch), () => {
      markDraft('regional', false);
      onSaved();
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    if (!isLocaleTag(v.locale)) return setLocaleError('Enter a language and region such as en-AU.');
    if (changes.length > 0) return setConfirming(true);
    void commit();
  }
  const hasError = save.error !== null;

  return (
    <>
      <form onSubmit={submit} noValidate className="space-y-8" aria-label="Regional settings">
        {hasError ? (
          <Alert tone="danger">
            <AlertDescription>
              {save.error}
              {save.stale || save.error?.includes('may already have been saved') ? <> <button type="button" className="font-medium underline" onClick={onReload}>Load the latest version</button></> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <section aria-labelledby="regional-place" className="space-y-4">
          <SectionHeader variant="ruled" as="h2" title={<span id="regional-place">Place and formats</span>} meta="Needs confirmation to change" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Country" error={save.fields.countryCode}>{(c) => (
              <Select {...c} value={v.countryCode} onChange={(e) => set({ countryCode: e.target.value })}>
                {countries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
              </Select>
            )}</Field>
            <Field label="Time zone" hint="Decides what “today” means for your business." error={save.fields.timeZone}>{(c) => (
              <Select {...c} value={v.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
                {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </Select>
            )}</Field>
            <Field label="Language and region" hint="For example en-AU or de-DE. Sets date and number formats." error={localeError ?? save.fields.locale}>{(c) => (
              <Input {...c} maxLength={35} value={v.locale} onChange={(e) => set({ locale: e.target.value.trim() })} />
            )}</Field>
            <Field label="Default currency" hint="For new records. Every record keeps its own currency." error={save.fields.currency}>{(c) => (
              <Select {...c} value={v.currency} onChange={(e) => set({ currency: e.target.value })}>
                {currencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.label}</option>)}
              </Select>
            )}</Field>
          </div>
        </section>
        <section aria-labelledby="regional-year" className="space-y-4">
          <SectionHeader variant="ruled" as="h2" title={<span id="regional-year">Financial year</span>} />
          <Field label="Financial year starts in" hint="Leave as “Not set” to use the calendar year." error={save.fields.fiscalYearStartMonth} className="max-w-sm">{(c) => (
            <Select {...c} value={v.fiscalYearStartMonth} onChange={(e) => set({ fiscalYearStartMonth: e.target.value })}>
              <option value="">Not set (calendar year)</option>
              {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{monthName(i + 1)}</option>)}
            </Select>
          )}</Field>
        </section>
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button type="submit" loading={save.busy && !confirming} disabled={!dirty}>Save changes</Button>
          <Button variant="outline" disabled={!dirty || save.busy} onClick={() => { setV(start); setLocaleError(null); save.reset(); }}>Revert changes</Button>
          <p role="status" className="text-small text-muted-foreground">{dirty ? 'You have unsaved changes.' : 'No changes to save.'}</p>
        </div>
      </form>
      <Dialog open={confirming} onOpenChange={(open) => { if (!open && !save.busy) setConfirming(false); }}>
        <DialogContent>
          <DialogTitle>Change regional settings?</DialogTitle>
          <DialogDescription>These settings decide how Pixa OS works out today’s date and what new records start with.</DialogDescription>
          <ul className="mt-4 space-y-2 border-t border-line pt-3 text-small">
            {changes.map((change) => (
              <li key={change.label}><span className="font-medium">{change.label}:</span> {change.from} → {change.to}</li>
            ))}
          </ul>
          <div className="mt-4 space-y-3 text-small">
            <p><span className="font-medium">Changes from now on:</span> what “today” means and where day boundaries fall, reporting periods, date checks in Finance, and the currency and formats new records start with.</p>
            <p><span className="font-medium">Does not change:</span> amounts and currencies already stored, documents already issued, or the time zones of existing recurring schedules.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={save.busy} onClick={() => setConfirming(false)}>Keep editing</Button>
            <Button loading={save.busy} onClick={async () => { await commit(); setConfirming(false); }}>Change settings</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
