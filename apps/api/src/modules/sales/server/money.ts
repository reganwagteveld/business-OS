import 'server-only';
// Money rules (docs/sales-data-model.md §3). Amounts are exact decimals end to end: a string in the
// API, Decimal in code, numeric(18,4) in PostgreSQL. No binary floating point, no assumed
// currency: every amount carries an ISO 4217 code, and its decimals are checked against that
// currency's minor unit.
import { Decimal } from '@/core/db';
import { RuleViolationError } from '@/core/http/errors';

const KNOWN = new Set<string>(Intl.supportedValuesOf('currency'));

/** Decimal places the currency uses (JPY 0, AUD 2, KWD 3). */
export function minorDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function checkCurrency(code: string): string {
  if (!KNOWN.has(code)) throw new RuleViolationError('invalid_currency', `${code} is not a recognised ISO 4217 currency.`);
  return code;
}

/** Parses a contract-valid amount string for a currency, rejecting more decimals than the currency has. */
export function toAmount(value: string, currency: string): Decimal {
  const digits = minorDigits(currency);
  const decimals = value.includes('.') ? value.split('.')[1]!.replace(/0+$/, '').length : 0;
  if (decimals > digits) {
    throw new RuleViolationError('invalid_amount', digits === 0 ? `${currency} amounts have no decimal places.` : `${currency} amounts have at most ${digits} decimal places.`);
  }
  return new Decimal(value);
}

/** The stored amount as an exact string with the currency's decimals ("1250.50", "1250" for JPY). */
export function formatAmount(amount: Decimal | null, currency: string): string | null {
  return amount === null ? null : amount.toFixed(minorDigits(currency));
}
