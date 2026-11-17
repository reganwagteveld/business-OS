/** Ids of a list response, for set-membership assertions (never substring checks against random UUIDs). */
export const ids = (items: { id: string }[]): string[] => items.map((i) => i.id);

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Two days ago in UTC: in the past in every time zone, so "not in the future" rules always pass, whenever this runs. */
export const PAST = day(-2);
/** Thirty days ahead: an invoice due then is not overdue today in any time zone. */
export const DUE = day(30);

export const line = (overrides: Record<string, unknown> = {}) => ({ description: 'Consulting', quantity: '2', unitPrice: '150.00', ...overrides });

/** Decimal strings from PostgreSQL NUMERIC(18,4) compared with the API's scaled strings. */
export const money = (value: string | number): number => Math.round(Number(value) * 10_000) / 10_000;
