import { Alert, AlertDescription, Button, Field, Input, Select, SectionHeader } from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BusinessProfileData, SettingsClient } from '../../api/settings';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { countryName, countryOptions } from './intl';
import { Facts } from './parts';
import { useSave } from './save';

export interface SettingsPageEnv {
  client: SettingsClient;
  slug: string;
  /** business:manage: presentation only; the API checks it again on every write. */
  canManage: boolean;
  markDraft: (key: string, dirty: boolean) => void;
  onSessionEnded: () => void;
  /** The name shown across the shell changed, so the shell should refresh its business context. */
  onSaved: () => void;
}

type Values = { name: string; legalName: string; tradingName: string; contactEmail: string; contactPhone: string; website: string; line1: string; line2: string; city: string; region: string; postalCode: string; addressCountry: string };

const valuesOf = (p: BusinessProfileData): Values => ({
  name: p.name, legalName: p.legalName ?? '', tradingName: p.tradingName ?? '', contactEmail: p.contactEmail ?? '', contactPhone: p.contactPhone ?? '', website: p.website ?? '',
  line1: p.address.line1 ?? '', line2: p.address.line2 ?? '', city: p.address.city ?? '', region: p.address.region ?? '', postalCode: p.address.postalCode ?? '', addressCountry: p.address.countryCode ?? '',
});

/** Only what changed, so an edit never rewrites fields the person did not touch. Blank means "clear". */
export function profilePatch(start: Values, now: Values, version: number): Record<string, unknown> {
  const patch: Record<string, unknown> = { version };
  const text = ['name', 'legalName', 'tradingName', 'contactEmail', 'contactPhone', 'website'] as const;
  for (const key of text) if (now[key].trim() !== start[key]) patch[key] = now[key];
  const address: Record<string, unknown> = {};
  for (const [field, key] of [['line1', 'line1'], ['line2', 'line2'], ['city', 'city'], ['region', 'region'], ['postalCode', 'postalCode']] as const) {
    if (now[field].trim() !== start[field]) address[key] = now[field];
  }
  if (now.addressCountry !== start.addressCountry) address.countryCode = now.addressCountry === '' ? null : now.addressCountry;
  if (Object.keys(address).length > 0) patch.address = address;
  return patch;
}

/** Business › Business profile: identity, contact details and address. Fixed facts (URL name, data region) are shown, never editable. */
export function BusinessProfilePage({ env }: { env: SettingsPageEnv }) {
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState(false);
  const load = useLoad(`settings-profile|${env.slug}|${generation}`, (signal) => env.client.businessProfile(env.slug, signal));
  // While a reload after saving is in flight, keep the form on screen (same business, same record).
  const current = load.state.status === 'done' ? load.state.outcome : load.previous;
  const reload = () => setGeneration((g) => g + 1);
  const title = 'Business profile';
  const description = 'Your business’s name, contact details and address.';
  if (!current) return <ZonePage title={title} description={description} state={{ kind: 'loading', label: 'Loading the business profile…' }} />;
  if (current.kind !== 'ok') {
    return <ZonePage title={title} description={description}><Problem outcome={current} what="The business profile" onRetry={load.reload} onSessionEnded={env.onSessionEnded} /></ZonePage>;
  }
  const profile = current.data;
  return (
    <ZonePage title={title} description={description}>
      {saved ? <Alert tone="success"><AlertDescription>Business profile saved.</AlertDescription></Alert> : null}
      {env.canManage ? (
        <ProfileForm key={profile.version} env={env} profile={profile} onEdit={() => setSaved(false)} onReload={reload}
          onSaved={() => { setSaved(true); reload(); env.onSaved(); }} />
      ) : (
        <ProfileFacts profile={profile} />
      )}
      <FixedFacts profile={profile} />
    </ZonePage>
  );
}

function ProfileFacts({ profile }: { profile: BusinessProfileData }) {
  const a = profile.address;
  const address = [a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(' '), a.region, countryName(a.countryCode)].filter(Boolean).join(', ');
  return (
    <section aria-labelledby="profile-facts" className="space-y-3">
      <SectionHeader variant="ruled" as="h2" title={<span id="profile-facts">Details</span>} meta="Only owners and admins can change these" />
      <Facts items={[
        { label: 'Business name', value: profile.name },
        { label: 'Legal name', value: profile.legalName },
        { label: 'Trading name', value: profile.tradingName },
        { label: 'Contact email', value: profile.contactEmail },
        { label: 'Contact phone', value: profile.contactPhone },
        { label: 'Website', value: profile.website },
        { label: 'Address', value: address },
      ]} />
    </section>
  );
}

function FixedFacts({ profile }: { profile: BusinessProfileData }) {
  return (
    <section aria-labelledby="profile-fixed" className="space-y-3">
      <SectionHeader variant="ruled" as="h2" title={<span id="profile-fixed">Fixed</span>} meta="Set when the business was created" />
      <Facts items={[
        { label: 'URL name', value: profile.slug, hint: 'Used in links to this business. It cannot be changed.' },
        { label: 'Data region', value: profile.homeRegion, hint: 'Where this business’s data is stored.' },
      ]} />
    </section>
  );
}

function ProfileForm({ env, profile, onSaved, onEdit, onReload }: { env: SettingsPageEnv; profile: BusinessProfileData; onSaved: () => void; onEdit: () => void; onReload: () => void }) {
  const start = useMemo(() => valuesOf(profile), [profile]);
  const [v, setV] = useState(start);
  const save = useSave(env.onSessionEnded);
  const patch = profilePatch(start, v, profile.version);
  const dirty = Object.keys(patch).length > 1;
  const { markDraft } = env;
  useEffect(() => markDraft('profile', dirty), [dirty, markDraft]);
  useEffect(() => () => markDraft('profile', false), [markDraft]);
  const set = (change: Partial<Values>) => { onEdit(); setV((x) => ({ ...x, ...change })); };
  const countries = useMemo(() => countryOptions(start.addressCountry || null), [start.addressCountry]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    await save.run(() => env.client.updateBusinessProfile(env.slug, patch), () => {
      markDraft('profile', false);
      onSaved();
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-8" aria-label="Business profile">
      {save.error ? (
        <Alert tone="danger">
          <AlertDescription>
            {save.error}
            {save.stale || save.error.includes('may already have been saved') ? <> <button type="button" className="font-medium underline" onClick={onReload}>Load the latest version</button></> : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <section aria-labelledby="profile-names" className="space-y-4">
        <SectionHeader variant="ruled" as="h2" title={<span id="profile-names">Names</span>} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" hint="Shown in the switcher and across Pixa OS." error={save.fields.name}>{(c) => <Input {...c} required maxLength={200} value={v.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
          <Field label="Legal name" error={save.fields.legalName}>{(c) => <Input {...c} maxLength={200} value={v.legalName} onChange={(e) => set({ legalName: e.target.value })} />}</Field>
          <Field label="Trading name" error={save.fields.tradingName}>{(c) => <Input {...c} maxLength={200} value={v.tradingName} onChange={(e) => set({ tradingName: e.target.value })} />}</Field>
        </div>
      </section>
      <section aria-labelledby="profile-contact" className="space-y-4">
        <SectionHeader variant="ruled" as="h2" title={<span id="profile-contact">Contact</span>} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact email" error={save.fields.contactEmail}>{(c) => <Input {...c} type="email" maxLength={254} value={v.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} />}</Field>
          <Field label="Contact phone" error={save.fields.contactPhone}>{(c) => <Input {...c} type="tel" maxLength={50} value={v.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} />}</Field>
          <Field label="Website" hint="A full address, for example https://example.com" error={save.fields.website} className="sm:col-span-2">{(c) => <Input {...c} type="url" maxLength={300} value={v.website} onChange={(e) => set({ website: e.target.value })} />}</Field>
        </div>
      </section>
      <section aria-labelledby="profile-address" className="space-y-4">
        <SectionHeader variant="ruled" as="h2" title={<span id="profile-address">Address</span>} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Address line 1" error={save.fields.address}>{(c) => <Input {...c} maxLength={200} value={v.line1} onChange={(e) => set({ line1: e.target.value })} />}</Field>
          <Field label="Address line 2">{(c) => <Input {...c} maxLength={200} value={v.line2} onChange={(e) => set({ line2: e.target.value })} />}</Field>
          <Field label="City or suburb">{(c) => <Input {...c} maxLength={100} value={v.city} onChange={(e) => set({ city: e.target.value })} />}</Field>
          <Field label="State or region">{(c) => <Input {...c} maxLength={100} value={v.region} onChange={(e) => set({ region: e.target.value })} />}</Field>
          <Field label="Postcode">{(c) => <Input {...c} maxLength={20} value={v.postalCode} onChange={(e) => set({ postalCode: e.target.value })} />}</Field>
          <Field label="Country">{(c) => (
            <Select {...c} value={v.addressCountry} onChange={(e) => set({ addressCountry: e.target.value })}>
              <option value="">Not set</option>
              {countries.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
            </Select>
          )}</Field>
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button type="submit" loading={save.busy} disabled={!dirty}>Save changes</Button>
        <Button variant="outline" disabled={!dirty || save.busy} onClick={() => { setV(start); save.reset(); }}>Revert changes</Button>
        <p role="status" className="text-small text-muted-foreground">{dirty ? 'You have unsaved changes.' : 'No changes to save.'}</p>
      </div>
    </form>
  );
}
