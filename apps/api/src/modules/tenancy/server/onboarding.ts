import 'server-only';
// Business detail checks in the app (data-model §5.5 step 2): reject, never silently default. Used at
// onboarding and when the profile is edited (Administration A2-A). The database re-validates the same
// rules inside app_private.create_business and in the businesses checks and time-zone trigger.

const supported = (key: 'timeZone' | 'currency') => new Set(Intl.supportedValuesOf(key));
let zones: Set<string> | undefined;
let currencies: Set<string> | undefined;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** ISO 3166-1 user-assigned codes (AA, QM–QZ, XA–XZ, ZZ) are not countries even though CLDR names some. */
export function isCountryCode(code: string): boolean {
  return !/^(AA|Q[M-Z]|X[A-Z]|ZZ)$/.test(code) && Boolean(regionNames.of(code));
}

export function isTimeZone(zone: string): boolean {
  zones ??= supported('timeZone');
  return zones.has(zone) || zone === 'UTC';
}

export function isCurrency(code: string): boolean {
  currencies ??= supported('currency');
  return currencies.has(code);
}

export function isLocale(locale: string): boolean {
  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    return canonical === locale && /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/.test(locale);
  } catch {
    return false;
  }
}

export function validateNewBusiness(input: { countryCode: string; timeZone: string; locale: string; currency: string }): string | null {
  if (!isCountryCode(input.countryCode)) return 'countryCode';
  if (!isTimeZone(input.timeZone)) return 'timeZone';
  if (!isCurrency(input.currency)) return 'currency';
  if (!isLocale(input.locale)) return 'locale';
  return null;
}
