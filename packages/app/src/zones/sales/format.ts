import type { OpportunityStatus } from '@business-os/contracts';

/**
 * Money from the API's exact decimal string. Intl formats a numeric string without turning it into a
 * binary float first, so "99999999999999.99" prints exactly. No currency is assumed: the record's own
 * code is always used.
 */
export function formatMoney(amount: string | null, currency: string, locale?: string): string {
  if (amount === null) return '—';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount as unknown as number);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** A calendar date (YYYY-MM-DD) shown as that same date everywhere, whatever the viewer's time zone. */
export function formatDate(day: string | null, locale?: string): string {
  if (!day) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  } catch {
    return day;
  }
}

export function formatWhen(iso: string, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export const STATUS_LABEL: Record<OpportunityStatus, string> = { OPEN: 'Open', WON: 'Won', LOST: 'Lost' };

/** ISO 4217 codes the runtime knows, named in the viewer's language, the business currency first. */
export function currencyOptions(first: string, locale?: string): { code: string; name: string }[] {
  let codes: string[] = [];
  try {
    codes = Intl.supportedValuesOf('currency');
  } catch {
    codes = [first];
  }
  const names = (() => {
    try {
      return new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'currency' });
    } catch {
      return null;
    }
  })();
  const all = codes.map((code) => ({ code, name: `${code} · ${names?.of(code) ?? code}` }));
  const head = all.filter((c) => c.code === first);
  return [...(head.length ? head : [{ code: first, name: first }]), ...all.filter((c) => c.code !== first)];
}

/** The same rule as the contract: up to 14 whole digits and 4 decimals, no sign, no exponent, no grouping. */
export const AMOUNT = /^\d{1,14}(\.\d{1,4})?$/;
