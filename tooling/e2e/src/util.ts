/** Ids of a list response, for set-membership assertions (never substring checks against random UUIDs). */
export const ids = (items: { id: string }[]): string[] => items.map((i) => i.id);

/** A date in the past in every time zone, so "not in the future" rules always pass. */
export const PAST = '2026-11-01';

export const line = (overrides: Record<string, unknown> = {}) => ({ description: 'Consulting', quantity: '2', unitPrice: '150.00', ...overrides });

/** Decimal strings from PostgreSQL NUMERIC(18,4) compared with the API's scaled strings. */
export const money = (value: string | number): number => Math.round(Number(value) * 10_000) / 10_000;
