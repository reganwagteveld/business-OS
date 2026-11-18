/** Lists for the regional pickers, from the platform's own data. The server validates every value again. */

function supported(key: 'timeZone' | 'currency'): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(key);
  } catch {
    return [];
  }
}

/** The list plus the current value, so a value the platform does not list (for example UTC) is never lost. */
const withCurrent = (list: readonly string[], current: string) => (list.includes(current) ? [...list] : [...list, current].sort());

export const timeZoneOptions = (current: string) => withCurrent(supported('timeZone'), current);

export function currencyOptions(current: string): { code: string; label: string }[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'currency' });
  } catch {
    names = null;
  }
  return withCurrent(supported('currency'), current).map((code) => ({ code, label: `${code} · ${nameOf(names, code)}` }));
}

let countries: { code: string; name: string }[] | null = null;

/** Every ISO region the platform can name, sorted by name. */
export function countryOptions(current?: string | null): { code: string; name: string }[] {
  if (!countries) {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      names = null;
    }
    const list: { code: string; name: string }[] = [];
    if (names) {
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const name = nameOf(names, code);
          if (name !== code) list.push({ code, name });
        }
      }
    }
    countries = list.sort((x, y) => x.name.localeCompare(y.name));
  }
  return current && !countries.some((c) => c.code === current) ? [...countries, { code: current, name: current }] : countries;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  return countryOptions().find((c) => c.code === code)?.name ?? code;
}

function nameOf(names: Intl.DisplayNames | null, code: string): string {
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
export const monthName = (month: number) => MONTHS[month - 1] ?? String(month);

export function fiscalYearLabel(month: number | null): string {
  return month === null ? 'Calendar year (not set)' : month === 1 ? 'Calendar year (starts in January)' : `Starts in ${monthName(month)}`;
}

/** Same pattern as the server and database: language, optional script, optional region. */
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;
export function isLocaleTag(value: string): boolean {
  try {
    return LOCALE.test(value) && Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}

export function localeLabel(tag: string): string {
  try {
    const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    return language && language !== tag ? `${language} (${tag})` : tag;
  } catch {
    return tag;
  }
}
