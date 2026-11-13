import 'server-only';
// Onboarding input checks in the app (data-model §5.5 step 2): reject, never silently default.
// The database re-validates the same rules inside app_private.create_business.

const supported = (key: 'timeZone' | 'currency') => new Set(Intl.supportedValuesOf(key));
let zones: Set<string> | undefined;
let currencies: Set<string> | undefined;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

export function validateNewBusiness(input: { countryCode: string; timeZone: string; locale: string; currency: string }): string | null {
  zones ??= supported('timeZone');
  currencies ??= supported('currency');
  if (!regionNames.of(input.countryCode)) return 'countryCode';
  if (!zones.has(input.timeZone) && input.timeZone !== 'UTC') return 'timeZone';
  if (!currencies.has(input.currency)) return 'currency';
  try {
    const [canonical] = Intl.getCanonicalLocales(input.locale);
    if (canonical !== input.locale || !/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/.test(input.locale)) return 'locale';
  } catch {
    return 'locale';
  }
  return null;
}
