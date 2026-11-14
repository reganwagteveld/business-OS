import 'server-only';
// Finance money rules (docs/finance-data-model.md §3, owner decisions FD-T1 and FD-T2).
//
// Exact decimal arithmetic end to end: strings in the API, Decimal in code, numeric in PostgreSQL. No
// JavaScript number ever holds an amount. Every amount carries an ISO 4217 currency whose minor-unit
// precision is snapshotted on the document. Line-level rounding, half away from zero, at that
// precision; the database recomputes the same formulas at issue and refuses any difference.
import { Decimal } from '@/core/db';
import { RuleViolationError } from '@/core/http/errors';

const KNOWN = new Set<string>(Intl.supportedValuesOf('currency'));

export function checkCurrency(code: string): string {
  if (!KNOWN.has(code)) throw new RuleViolationError('invalid_currency', `${code} is not a recognised ISO 4217 currency.`);
  return code;
}

/** Decimal places the currency uses (JPY 0, AUD 2, KWD 3), from ISO 4217 data via Intl. */
export function currencyScale(currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  if (digits < 0 || digits > 4) throw new RuleViolationError('invalid_currency', `${currency} is not supported.`);
  return digits;
}

/**
 * Half away from zero. Decimal.ROUND_HALF_UP rounds ties away from zero (decimal.js semantics), which
 * equals PostgreSQL round(numeric, int) for every value; F1 only rounds non-negative values.
 */
export const roundTo = (value: Decimal, scale: number): Decimal => value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);

const decimalsOf = (value: string) => (value.includes('.') ? value.split('.')[1]!.replace(/0+$/, '').length : 0);

/** A contract-valid amount string in a currency, rejecting more decimals than the currency has. */
export function toAmount(value: string, scale: number, currency: string, field = 'amount'): Decimal {
  if (decimalsOf(value) > scale) {
    throw new RuleViolationError('invalid_amount', scale === 0
      ? `${currency} amounts have no decimal places (${field}).`
      : `${currency} amounts have at most ${scale} decimal places (${field}).`);
  }
  return new Decimal(value);
}

/** Largest value numeric(18,4) holds. */
const AMOUNT_LIMIT = new Decimal('99999999999999.9999');

export interface LineAmounts { net: Decimal; tax: Decimal }

/**
 * FD-T1/FD-T2 line formulas for tax-exclusive prices:
 *   net = round(quantity × unitPrice, scale) − discount
 *   tax = round(net × taxPercent / 100, scale)
 */
export function lineAmounts(quantity: Decimal, unitPrice: Decimal, discount: Decimal, taxPercent: Decimal, scale: number): LineAmounts {
  const gross = roundTo(quantity.mul(unitPrice), scale);
  const net = gross.sub(discount);
  if (net.isNegative()) throw new RuleViolationError('invalid_amount', 'A discount cannot be larger than its line.');
  const tax = roundTo(net.mul(taxPercent).div(100), scale);
  if (net.gt(AMOUNT_LIMIT) || tax.gt(AMOUNT_LIMIT)) throw new RuleViolationError('invalid_amount', 'This line is too large.');
  return { net, tax };
}

export interface Totals { subtotal: Decimal; taxTotal: Decimal; total: Decimal }

export function documentTotals(lines: LineAmounts[]): Totals {
  const subtotal = lines.reduce((s, l) => s.add(l.net), new Decimal(0));
  const taxTotal = lines.reduce((s, l) => s.add(l.tax), new Decimal(0));
  const total = subtotal.add(taxTotal);
  if (total.gt(AMOUNT_LIMIT)) throw new RuleViolationError('invalid_amount', 'This document is too large.');
  return { subtotal, taxTotal, total };
}

/** An amount as an exact string with the document's decimals ("1250.50"; "1250" for JPY). */
export const formatAmount = (value: Decimal, scale: number): string => value.toFixed(scale);
/** Quantities, unit prices and percentages without trailing zeros ("2.5", "0.0125", "10"). */
export const formatPlain = (value: Decimal): string => value.toFixed();
