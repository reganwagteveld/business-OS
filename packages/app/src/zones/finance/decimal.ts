// Exact decimal arithmetic on the API's amount strings, for the few places the screen needs it (how much
// of a payment a set of allocations would use, whether something is still open). Integers only (BigInt
// at a fixed scale): never a binary float. Totals, taxes and balances always come from the server; this
// only compares and adds amounts of ONE currency that the person is about to send.

const SHAPE = /^-?\d+(\.\d+)?$/;

/** A decimal string as an integer number of 10^-scale units, or null when it is not a plain decimal. */
export function toUnits(value: string, scale: number): bigint | null {
  const v = value.trim();
  if (!SHAPE.test(v)) return null;
  const negative = v.startsWith('-');
  const [whole, fraction = ''] = (negative ? v.slice(1) : v).split('.') as [string, string?];
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return null; // more precision than the currency has
  const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction.slice(0, scale) || '0').padEnd(scale, '0'));
  return negative ? -units : units;
}

/** Integer units back to a decimal string with exactly `scale` places. */
export function fromUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const text = abs.toString().padStart(scale + 1, '0');
  const out = scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
  return negative ? `-${out}` : out;
}

/** Sum of amounts of one currency; null if any is not a valid amount at that scale. */
export function sum(values: readonly string[], scale: number): string | null {
  let total = 0n;
  for (const v of values) {
    const u = toUnits(v, scale);
    if (u === null) return null;
    total += u;
  }
  return fromUnits(total, scale);
}

/** a − b, exactly; null if either is not a valid amount. */
export function subtract(a: string, b: string, scale: number): string | null {
  const x = toUnits(a, scale);
  const y = toUnits(b, scale);
  return x === null || y === null ? null : fromUnits(x - y, scale);
}

/** −1, 0 or 1; null if either is not a valid amount. */
export function compare(a: string, b: string, scale: number): -1 | 0 | 1 | null {
  const x = toUnits(a, scale);
  const y = toUnits(b, scale);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** True when the amount is above zero (any non-zero digit and no minus sign), without parsing to a float. */
export function isPositive(value: string): boolean {
  return !value.trim().startsWith('-') && /[1-9]/.test(value);
}

/** The smaller of two amounts (for "allocate up to what is left"). */
export function min(a: string, b: string, scale: number): string | null {
  const c = compare(a, b, scale);
  return c === null ? null : c <= 0 ? fromUnits(toUnits(a, scale)!, scale) : fromUnits(toUnits(b, scale)!, scale);
}

/** Decimal places of a currency as the runtime knows them (the server's own scale wins when it is known). */
export function currencyScale(code: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
