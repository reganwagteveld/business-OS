import { CreateBusinessRequest } from '@business-os/contracts';
import { useRef, useState, type FormEvent } from 'react';
import type { CreateBusinessInput, CreateResult } from '../workspace/use-workspace';
import { actionClass, Frame, inputClass, secondaryClass } from './frame';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/** "Acme Plumbing & Co." → "acme-plumbing-co": a preview the person can edit; the server decides if it is free. */
export const slugify = (value: string) =>
  value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '');

const supported = (key: 'timeZone' | 'currency'): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(key);
  } catch {
    return [];
  }
};
const TIME_ZONES = supported('timeZone');
const CURRENCIES = supported('currency');

/** Suggestions only: pre-filled from the device, always editable, and re-checked by the server. */
const CURRENCY_BY_REGION: Record<string, string> = { AU: 'AUD', NZ: 'NZD', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', CA: 'CAD' };

function deviceDefaults() {
  const languageTag = typeof navigator !== 'undefined' && navigator.language ? navigator.language : '';
  let region = '';
  try {
    region = languageTag ? (new Intl.Locale(languageTag).region ?? '') : '';
  } catch {
    /* unusable locale: leave the fields empty for the person to fill in */
  }
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    /* ignore */
  }
  return { languageTag, region, timeZone, currency: CURRENCY_BY_REGION[region] ?? '' };
}

/** Checks the details step against the same standards the server uses, with a message the person can act on. */
export function validateDetails(d: { countryCode: string; timeZone: string; locale: string; currency: string }): string | null {
  if (!/^[A-Z]{2}$/.test(d.countryCode)) return 'Enter a two-letter country code, for example AU.';
  if (TIME_ZONES.length > 0 && !TIME_ZONES.includes(d.timeZone) && d.timeZone !== 'UTC') return 'Choose a time zone from the list, for example Australia/Perth.';
  if (!/^[A-Z]{3}$/.test(d.currency) || (CURRENCIES.length > 0 && !CURRENCIES.includes(d.currency))) return 'Enter a valid three-letter currency code, for example AUD.';
  try {
    // Same pattern as the server and database: language, optional script, optional region.
    if (!LOCALE.test(d.locale) || Intl.getCanonicalLocales(d.locale)[0] !== d.locale) return 'Enter a locale such as en-AU.';
  } catch {
    return 'Enter a locale such as en-AU.';
  }
  return null;
}

/**
 * First-business wizard: name and address, then country and formats, then a review. Nothing is
 * created until the last step, the server validates again, and a slug conflict is reported as such.
 */
export function BusinessSetup({ onCreate, onBack }: { onCreate: (data: CreateBusinessInput) => Promise<CreateResult>; onBack?: () => void }) {
  const [defaults] = useState(deviceDefaults);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [countryCode, setCountryCode] = useState(defaults.region);
  const [timeZone, setTimeZone] = useState(defaults.timeZone);
  const [language, setLanguage] = useState(defaults.languageTag);
  const [currency, setCurrency] = useState(defaults.currency);
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  const handleName = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };
  const draft = { name: name.trim(), slug, countryCode: countryCode.toUpperCase().trim(), timeZone: timeZone.trim(), locale: language.trim(), currency: currency.toUpperCase().trim() };

  const advance = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (step === 1) {
      if (!draft.name || !SLUG.test(draft.slug)) {
        setError('Enter a business name and a valid workspace address (3–48 characters).');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      const problem = validateDetails(draft);
      if (problem) {
        setError(problem);
        return;
      }
      setStep(3);
    }
  };

  const submit = async () => {
    if (submitting.current) return; // a second click while the first is in flight does nothing
    const parsed = CreateBusinessRequest.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check your details.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await onCreate(parsed.data);
      if (!result.ok) {
        setError(result.message);
        if (/address is already taken/.test(result.message)) setStep(1); // fix the address, keep everything else
      }
    } catch {
      setError('Cannot reach Business OS. Please try again.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
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
          <div className="flex gap-3">
            <button className={secondaryClass} type="button" disabled={busy} onClick={() => setStep(2)}>Back</button>
            <button className={actionClass} type="button" disabled={busy} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create workspace'}</button>
          </div>
        </div>
      ) : (
        <form onSubmit={advance} className="space-y-5" noValidate>
          {step === 1 ? (
            <>
              <label className="block text-sm font-medium">Business name<input required maxLength={200} autoFocus className={`${inputClass} mt-2`} placeholder="e.g. Pixakova" value={name} onChange={(e) => handleName(e.target.value)} /></label>
              <label className="block text-sm font-medium">Workspace address<input required className={`${inputClass} mt-2`} value={slug} onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }} aria-describedby="slug-hint" /></label>
              <p id="slug-hint" className="text-xs text-muted-foreground">3–48 characters. Lowercase letters, numbers and hyphens. This identifies your workspace securely on the server.</p>
              <p className="text-xs text-muted-foreground">Were you invited to a business instead? Open the link in your invitation email to join it.</p>
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Country code (ISO 2)<input required maxLength={2} className={`${inputClass} mt-2`} value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} placeholder="AU" /></label>
              <label className="text-sm font-medium">Currency (ISO 4217)<input required maxLength={3} list="bos-currencies" className={`${inputClass} mt-2`} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="AUD" /></label>
              <label className="text-sm font-medium sm:col-span-2">Time zone (IANA)<input required list="bos-time-zones" className={`${inputClass} mt-2`} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Australia/Perth" /></label>
              <label className="text-sm font-medium sm:col-span-2">Locale (BCP 47)<input required className={`${inputClass} mt-2`} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en-AU" /></label>
              <datalist id="bos-time-zones">{TIME_ZONES.map((z) => <option key={z} value={z} />)}</datalist>
              <datalist id="bos-currencies">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
          )}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-3">
            {step === 2 ? <button type="button" className={secondaryClass} onClick={() => { setError(null); setStep(1); }}>Back</button> : onBack ? <button type="button" className={secondaryClass} onClick={onBack}>Back</button> : null}
            <button type="submit" className={actionClass}>Continue</button>
          </div>
        </form>
      )}
    </Frame>
  );
}

