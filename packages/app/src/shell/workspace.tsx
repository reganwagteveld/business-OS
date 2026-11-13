import { CreateBusinessRequest, type CurrentUser } from '@business-os/contracts';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { WorkspaceClient } from '../api/workspace';
import { ZoneHome } from './zone-home';

type Business = z.infer<typeof import('@business-os/contracts').BusinessSummary>;
type Context = z.infer<typeof import('@business-os/contracts').BusinessContextResponse>;
type View =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; status: number }
  | { kind: 'choose'; businesses: Business[] }
  | { kind: 'new' }
  | { kind: 'home'; context: Context; businesses: Business[] };

const inputClass = 'w-full rounded-xl border border-input bg-background px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const actionClass = 'rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const secondaryClass = 'rounded-xl border border-border px-4 py-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Frame({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12 text-foreground">
      <div className="w-full max-w-xl">
        <div className="mb-10 flex items-center gap-3">
          <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-xl bg-foreground text-xl font-bold text-background">B</span>
          <div><p className="text-sm font-extrabold tracking-tight">BUSINESS OS</p><p className="text-[10px] tracking-[.18em] text-muted-foreground">POWERED BY PIXAKOVA</p></div>
        </div>
        <div className="rounded-3xl border border-border bg-card p-7 shadow-sm sm:p-10">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-3 mb-8 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
          {children}
        </div>
      </div>
    </main>
  );
}
export function Startup({ label = 'Opening your workspace…' }: { label?: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-foreground" role="status" aria-live="polite">
      <div aria-hidden="true" className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-foreground text-4xl font-bold text-background">B</div>
      <h1 className="text-3xl font-semibold tracking-tight">Business OS</h1>
      <p className="mt-2 text-xs font-medium uppercase tracking-[.22em] text-muted-foreground">Powered by Pixakova</p>
      <div className="mt-12 h-1 w-20 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/2 animate-pulse rounded-full bg-foreground motion-reduce:animate-none" /></div>
      <p className="mt-4 text-sm text-muted-foreground">{label}</p>
    </main>
  );
}

const slugify = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '');

function BusinessSetup({ onCreate, onBack }: {
  onCreate: (data: z.infer<typeof CreateBusinessRequest>) => Promise<{ ok: boolean; message?: string }>;
  onBack: () => void;
}) {
  const localeDefault = typeof navigator !== 'undefined' ? navigator.language : 'en-AU';
  const locale = new Intl.Locale(localeDefault);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [countryCode, setCountryCode] = useState(locale.region ?? '');
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  const [language, setLanguage] = useState(localeDefault);
  const [currency, setCurrency] = useState(locale.region === 'AU' ? 'AUD' : locale.region === 'NZ' ? 'NZD' : locale.region === 'US' ? 'USD' : locale.region === 'GB' ? 'GBP' : locale.region === 'DE' ? 'EUR' : '');
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const handleName = (value: string) => { setName(value); if (!slugEdited) setSlug(slugify(value)); };
  const draft = { name: name.trim(), slug, countryCode: countryCode.toUpperCase().trim(), timeZone: timeZone.trim(), locale: language.trim(), currency: currency.toUpperCase().trim() };
  const advance = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (step === 1) {
      if (!draft.name || !/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(draft.slug)) {
        setError('Enter a business name and a valid workspace address (3–48 characters).'); return;
      }
      setStep(2);
    } else if (step === 2) {
      const parsed = CreateBusinessRequest.safeParse(draft);
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check your details.'); return; }
      setStep(3);
    }
  };
  const submit = async () => {
    if (submitting.current) return;
    const parsed = CreateBusinessRequest.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check your details.'); return; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await onCreate(parsed.data);
      if (!result.ok) setError(result.message ?? 'Could not create your business.');
    } catch { setError('Cannot reach Business OS. Please retry.'); }
    finally { submitting.current = false; setBusy(false); }
  };
  return (
    <Frame title="Make it yours." subtitle="Create the workspace where your business will run. You can invite your team later.">
      <p className="mb-6 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Step {step} of 3</p>
      {step === 3 ? (
        <div className="space-y-5">
          <div className="rounded-xl bg-muted p-5 text-sm">
            <p className="mb-3 text-lg font-semibold">{draft.name}</p>
            <dl className="grid grid-cols-2 gap-y-3 text-muted-foreground">
              <dt>Workspace</dt><dd className="text-foreground">{draft.slug}</dd>
              <dt>Country</dt><dd className="text-foreground">{draft.countryCode}</dd>
              <dt>Time zone</dt><dd className="break-all text-foreground">{draft.timeZone}</dd>
              <dt>Locale</dt><dd className="text-foreground">{draft.locale}</dd>
              <dt>Currency</dt><dd className="text-foreground">{draft.currency}</dd>
            </dl>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-3"><button className={secondaryClass} type="button" disabled={busy} onClick={() => setStep(2)}>Back</button><button className={actionClass} type="button" disabled={busy} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create workspace'}</button></div>
        </div>
      ) : (
        <form onSubmit={advance} className="space-y-5">
          {step === 1 ? (
            <>
              <label className="block text-sm font-medium">Business name<input required maxLength={200} autoFocus className={`${inputClass} mt-2`} placeholder="e.g. Pixakova" value={name} onChange={(e) => handleName(e.target.value)} /></label>
              <label className="block text-sm font-medium">Workspace address<input required className={`${inputClass} mt-2`} value={slug} onChange={(e) => {setSlugEdited(true); setSlug(e.target.value.toLowerCase());}} aria-describedby="slug-hint" /></label>
              <p id="slug-hint" className="text-xs text-muted-foreground">3–48 characters. Lowercase letters, numbers and hyphens. This identifies your workspace securely on the server.</p>
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Country code (ISO 2)<input required maxLength={2} className={`${inputClass} mt-2`} value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} placeholder="AU" /></label>
              <label className="text-sm font-medium">Currency (ISO 4217)<input required maxLength={3} className={`${inputClass} mt-2`} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="AUD" /></label>
              <label className="text-sm font-medium sm:col-span-2">Time zone (IANA)<input required className={`${inputClass} mt-2`} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Australia/Perth" /></label>
              <label className="text-sm font-medium sm:col-span-2">Locale (BCP 47)<input required className={`${inputClass} mt-2`} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en-AU" /></label>
            </div>
          )}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-3">{step === 1 ? <button type="button" className={secondaryClass} onClick={onBack}>Back</button> : <button type="button" className={secondaryClass} onClick={() => {setError(null); setStep(1);}}>Back</button>}<button type="submit" className={actionClass}>Continue</button></div>
        </form>
      )}
    </Frame>
  );
}

export function Workspace({ user, client, onSignOut }: {
  user: CurrentUser; client: WorkspaceClient; onSignOut: () => void;
}) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [createError, setCreateError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setView({ kind: 'loading' });
    const result = await client.list();
    if (!result.ok) { setView({ kind: 'error', message: result.message, status: result.status }); return; }
    if (result.data.businesses.length === 0) { setView({ kind: 'new' }); return; }
    if (result.data.businesses.length === 1) {
      const only = result.data.businesses[0];
      if (only) {
        const context = await client.context(only.slug);
        setView(context.ok ? { kind: 'home', context: context.data, businesses: result.data.businesses } : { kind: 'error', message: context.message, status: context.status });
      }
      return;
    }
    setView({ kind: 'choose', businesses: result.data.businesses });
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  const select = async (businesses: Business[], slug: string) => {
    setView({ kind: 'loading' });
    const result = await client.context(slug);
    setView(result.ok ? { kind: 'home', context: result.data, businesses } : { kind: 'error', message: result.message, status: result.status });
  };
  const create = async (data: z.infer<typeof CreateBusinessRequest>) => {
    const result = await client.create(data);
    if (!result.ok) {
      if (result.status === 0) {
        // An uncertain network result may have committed on the server: re-read before retrying.
        const check = await client.list();
        if (check.ok && check.data.businesses.some((b) => b.slug === data.slug)) {
          await select(check.data.businesses, data.slug);
          return { ok: true };
        }
      }
      return { ok: false, message: result.message };
    }
    await load();
    return { ok: true };
  };
  if (view.kind === 'loading') return <Startup label="Finding your businesses…" />;
  if (view.kind === 'error') return <Frame title={view.status === 401 ? 'Session expired' : 'Unable to open your workspace'} subtitle={view.message}><div className="flex gap-3"><button className={actionClass} type="button" onClick={() => void load()}>Try again</button><button className={secondaryClass} type="button" onClick={onSignOut}>Sign out</button></div></Frame>;
  if (view.kind === 'home') return <ZoneHome business={view.context.business.name} user={user} role={view.context.membership.role} onSwitch={() => setView({ kind: 'choose', businesses: view.businesses })} onSignOut={onSignOut} />;
  if (view.kind === 'new') return <BusinessSetup onBack={() => void load()} onCreate={create} />;
  return (
    <Frame title="Choose your workspace" subtitle="Select a business to continue, or create a new one. Your access is always verified by the server.">
      <div className="space-y-3">{view.businesses.map((business) => (
        <button key={business.slug} type="button" className="flex w-full items-center justify-between rounded-xl border border-border p-4 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => void select(view.businesses, business.slug)}>
          <span><strong className="block">{business.name}</strong><span className="text-xs text-muted-foreground">{business.slug}</span></span>
          <span className="text-xs text-muted-foreground">{business.role.toLowerCase()} →</span>
        </button>
      ))}</div>
      {createError ? <p role="alert" className="text-sm text-destructive">{createError}</p> : null}
      <div className="mt-6 flex gap-3"><button type="button" className={secondaryClass} onClick={() => {setCreateError(null); setView({ kind: 'new' });}}>Create another business</button><button type="button" className={secondaryClass} onClick={onSignOut}>Sign out</button></div>
    </Frame>
  );
}
