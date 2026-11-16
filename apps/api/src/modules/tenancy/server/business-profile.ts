import 'server-only';
// Business profile (Administration A2-A, docs/administration-a2.md §3.2–3.3, §7). Reads and edits the
// current business's identity, contact details and regional settings. The tenant scope adds the
// business id and Row-Level Security binds every row to it again; the slug, data region and archive
// state are not editable (the database grants no UPDATE on them).
//
// History is never rewritten: every financial record stores its own currency and dates, issued
// documents seal a seller snapshot, and recurring schedules copied their time zone when created. So a
// new currency or time zone applies to records created afterwards and to "today" calculations only.
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { RuleViolationError, StateConflictError } from '@/core/http/errors';
import { lockActor } from './actor';
import type { Actor } from './members';
import { NotFoundError } from './members';
import { isCountryCode, isCurrency, isLocale, isTimeZone } from './onboarding';

const profileSelect = {
  id: true, slug: true, name: true, legalName: true, tradingName: true, contactEmail: true, contactPhone: true, website: true,
  addressLine1: true, addressLine2: true, addressCity: true, addressRegion: true, addressPostalCode: true, addressCountryCode: true,
  countryCode: true, timeZone: true, locale: true, currency: true, fiscalYearStartMonth: true, homeRegion: true, version: true, updatedAt: true,
} as const;

type ProfileRow = {
  id: string; slug: string; name: string; legalName: string | null; tradingName: string | null; contactEmail: string | null;
  contactPhone: string | null; website: string | null; addressLine1: string | null; addressLine2: string | null; addressCity: string | null;
  addressRegion: string | null; addressPostalCode: string | null; addressCountryCode: string | null; countryCode: string; timeZone: string;
  locale: string; currency: string; fiscalYearStartMonth: number | null; homeRegion: string; version: number; updatedAt: Date;
};

const toProfile = (r: ProfileRow) => ({
  slug: r.slug, name: r.name, legalName: r.legalName, tradingName: r.tradingName, contactEmail: r.contactEmail, contactPhone: r.contactPhone,
  website: r.website,
  address: {
    line1: r.addressLine1, line2: r.addressLine2, city: r.addressCity, region: r.addressRegion, postalCode: r.addressPostalCode,
    countryCode: r.addressCountryCode,
  },
  countryCode: r.countryCode, timeZone: r.timeZone, locale: r.locale, currency: r.currency, fiscalYearStartMonth: r.fiscalYearStartMonth,
  homeRegion: r.homeRegion, version: r.version, updatedAt: r.updatedAt.toISOString(),
});

async function load(db: AppTenantDb): Promise<ProfileRow> {
  const row = (await db.business.findFirst({ select: profileSelect })) as ProfileRow | null;
  if (!row) throw new NotFoundError();
  return row;
}

export async function getBusinessProfile(db: AppTenantDb) {
  return toProfile(await load(db));
}

type Text = string | null | undefined;
export interface BusinessProfileInput {
  name?: string; legalName?: Text; tradingName?: Text; contactEmail?: Text; contactPhone?: Text; website?: Text;
  address?: { line1?: Text; line2?: Text; city?: Text; region?: Text; postalCode?: Text; countryCode?: string | null };
  countryCode?: string; timeZone?: string; locale?: string; currency?: string; fiscalYearStartMonth?: number | null;
  version: number;
}

/** Regional settings: audited with old and new values (they are codes, never free text). */
const REGIONAL = ['countryCode', 'timeZone', 'locale', 'currency', 'fiscalYearStartMonth'] as const;

function check(input: BusinessProfileInput): void {
  if (input.countryCode !== undefined && !isCountryCode(input.countryCode)) throw new RuleViolationError('invalid_country', 'Choose a country from the list.');
  if (input.address?.countryCode != null && !isCountryCode(input.address.countryCode)) {
    throw new RuleViolationError('invalid_address_country', 'Choose the address country from the list.');
  }
  if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) throw new RuleViolationError('invalid_time_zone', 'Choose a time zone from the list.');
  if (input.currency !== undefined && !isCurrency(input.currency)) throw new RuleViolationError('invalid_currency', 'Choose a currency from the list.');
  if (input.locale !== undefined && !isLocale(input.locale)) throw new RuleViolationError('invalid_locale', 'Choose a language and region from the list.');
}

/**
 * Applies a partial edit. `version` must equal the stored version (409 stale otherwise), so two people
 * editing at once never silently overwrite each other. Unchanged fields are ignored; a request that
 * changes nothing returns the profile without writing or auditing.
 */
export async function updateBusinessProfile(db: AppTenantDb, actor: Actor, input: BusinessProfileInput) {
  const current = await lockActor(db, actor, 'business:manage');
  check(input);
  const before = await load(db);
  if (before.version !== input.version) throw new StateConflictError('stale');

  const next: Partial<Record<keyof ProfileRow, unknown>> = {
    name: input.name, legalName: input.legalName, tradingName: input.tradingName, contactEmail: input.contactEmail,
    contactPhone: input.contactPhone, website: input.website, addressLine1: input.address?.line1, addressLine2: input.address?.line2,
    addressCity: input.address?.city, addressRegion: input.address?.region, addressPostalCode: input.address?.postalCode,
    addressCountryCode: input.address?.countryCode, countryCode: input.countryCode, timeZone: input.timeZone, locale: input.locale,
    currency: input.currency, fiscalYearStartMonth: input.fiscalYearStartMonth,
  };
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== before[key as keyof ProfileRow]) data[key] = value;
  }
  const changed = Object.keys(data).sort();
  if (changed.length === 0) return toProfile(before);

  // Compare-and-set on the version: a concurrent edit that committed first makes this one stale.
  const result = await db.business.updateMany({ where: { version: input.version }, data: { ...data, version: { increment: 1 } } as never });
  if (result.count === 0) throw new StateConflictError('stale');

  const values: Record<string, string | null> = {};
  for (const key of REGIONAL) {
    if (key in data) {
      values[`${key}From`] = before[key] === null ? null : String(before[key]);
      values[`${key}To`] = data[key] === null ? null : String(data[key]);
    }
  }
  // Text fields are audited by name only (no free text in the security log).
  await recordAudit(db, current.userId, 'business.updated', { type: 'business', id: before.id }, { fields: changed, ...values });
  return toProfile(await load(db));
}
