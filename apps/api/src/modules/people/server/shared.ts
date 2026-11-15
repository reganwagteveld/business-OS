import 'server-only';
// Shared by the people services (docs/people-data-model.md).
import { can, type Principal } from '@/modules/access';
import type { AppTenantDb } from '@/core/db';
import { RuleViolationError } from '@/core/http/errors';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every change bumps the version, so a write based on an older version can be detected. */
export const BUMP = { version: { increment: 1 } };

export const dateOf = (v: string) => new Date(`${v}T00:00:00Z`);
export const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** What the caller may see besides the directory. Decided once per request from permission keys. */
export interface Viewer {
  /** Personal details and the reason text on status history (people:read_sensitive). */
  canReadSensitive: boolean;
}
export const viewerOf = (principal: Principal): Viewer => ({ canReadSensitive: can(principal, 'people:read_sensitive') });

/** Today's calendar date in the business's own time zone (effective dates are business dates). */
export async function businessToday(db: AppTenantDb): Promise<string> {
  const business = await db.business.findFirst({ select: { timeZone: true } });
  const timeZone = business?.timeZone ?? 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Effective dates default to today and are never in the future: P1 has no scheduled changes. */
export async function effectiveDateOf(db: AppTenantDb, requested: string | undefined): Promise<string> {
  const today = await businessToday(db);
  const date = requested ?? today;
  if (date > today) throw new RuleViolationError('future_effective_date', 'The effective date cannot be in the future.');
  return date;
}

export const orderViolation = () =>
  new RuleViolationError('effective_date_order', 'The effective date cannot be before the current record it replaces.');

/**
 * Serialises reporting-line changes and terminations within this business (a transaction-scoped
 * advisory lock in the database, released at commit). Taken before any row lock, always in that order.
 */
export async function lockReportingLines(db: AppTenantDb): Promise<void> {
  await db.$queryRaw`SELECT people_lock_reporting() AS locked`;
}

/** Field names whose value differs between a row and the update about to be written (sorted). */
export const changedFields = (before: Record<string, unknown>, data: Record<string, unknown>) =>
  Object.keys(data).filter((k) => {
    const a = before[k];
    const b = data[k];
    if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime() !== (b as Date | null)?.getTime();
    return a !== b;
  }).sort();

export const displayName = (e: { givenName: string; familyName: string; preferredName: string | null }) =>
  `${e.preferredName ?? e.givenName} ${e.familyName}`;
