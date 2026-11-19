import 'server-only';
// Finance settings, numbering series and tax rates (docs/finance-data-model.md §2.4, §2.5; owner
// decisions FD-L1 numbering and FD-L3 retention). Every change writes finance.settings.changed in the
// same unit of work, with field names and old and new numeric values (never free text).
import { randomUUID } from 'node:crypto';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { formatPlain } from './money';
import { businessProfile, changedFields, type Kind } from './shared';

// ---- settings ------------------------------------------------------------------------------------

type Identifier = { label: string; value: string };
const settingsSelect = {
  sellerLegalName: true, sellerAddress: true, sellerEmail: true, sellerPhone: true, sellerIdentifiers: true, paymentInstructions: true,
  defaultPaymentTermsDays: true, defaultQuoteValidityDays: true, defaultTaxRateId: true, retentionYears: true, legalHold: true,
  version: true, updatedAt: true,
} as const;
type SettingsRow = {
  sellerLegalName: string | null; sellerAddress: string | null; sellerEmail: string | null; sellerPhone: string | null;
  sellerIdentifiers: unknown; paymentInstructions: string | null; defaultPaymentTermsDays: number | null;
  defaultQuoteValidityDays: number | null; defaultTaxRateId: string | null; retentionYears: number; legalHold: boolean;
  version: number; updatedAt: Date | null;
};
const DEFAULT_SETTINGS: SettingsRow = {
  sellerLegalName: null, sellerAddress: null, sellerEmail: null, sellerPhone: null, sellerIdentifiers: [], paymentInstructions: null,
  defaultPaymentTermsDays: null, defaultQuoteValidityDays: null, defaultTaxRateId: null, retentionYears: 7, legalHold: false,
  version: 0, updatedAt: null,
};

const identifiersOf = (v: unknown): Identifier[] =>
  Array.isArray(v) ? v.filter((i): i is Identifier => !!i && typeof i.label === 'string' && typeof i.value === 'string') : [];

/** The saved settings, or the defaults (version 0) when they have never been saved. */
export async function loadSettings(db: AppTenantDb): Promise<SettingsRow> {
  return ((await db.financeSettings.findFirst({ select: settingsSelect })) as SettingsRow | null) ?? DEFAULT_SETTINGS;
}

/**
 * Whether the business holds any finance row. Every finance table references businesses ON DELETE
 * RESTRICT (FD-L3), so such a business cannot be deleted or purged: the deletion fails whole and the
 * finance tables are the reported blocker. Retention expiry never authorises deletion.
 */
export async function hasRetainedRecords(db: AppTenantDb): Promise<boolean> {
  // One query at a time (the unit of work has one connection), stopping at the first table with a row.
  const checks = [
    () => db.financeDocument.count({ take: 1 }), () => db.financePayment.count({ take: 1 }), () => db.financeExpense.count({ take: 1 }),
    () => db.financeNumberSeries.count({ take: 1 }), () => db.financeTaxRate.count({ take: 1 }), () => db.financeExpenseCategory.count({ take: 1 }),
    () => db.financeSettings.count({ take: 1 }),
  ];
  for (const check of checks) if (await check() > 0) return true;
  return false;
}

async function settingsDto(db: AppTenantDb) {
  const row = await loadSettings(db);
  const business = await businessProfile(db);
  const retained = await hasRetainedRecords(db);
  return {
    sellerLegalName: row.sellerLegalName, sellerAddress: row.sellerAddress, sellerEmail: row.sellerEmail, sellerPhone: row.sellerPhone,
    sellerIdentifiers: identifiersOf(row.sellerIdentifiers), paymentInstructions: row.paymentInstructions,
    defaultPaymentTermsDays: row.defaultPaymentTermsDays, defaultQuoteValidityDays: row.defaultQuoteValidityDays,
    defaultTaxRateId: row.defaultTaxRateId, defaultCurrency: business.currency, retentionYears: row.retentionYears, legalHold: row.legalHold,
    hasRetainedRecords: retained, version: row.version, updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export const getSettings = settingsDto;

export type SettingsInput = {
  sellerLegalName?: string | null; sellerAddress?: string | null; sellerEmail?: string | null; sellerPhone?: string | null;
  sellerIdentifiers?: Identifier[]; paymentInstructions?: string | null; defaultPaymentTermsDays?: number | null;
  defaultQuoteValidityDays?: number | null; defaultTaxRateId?: string | null; retentionYears?: number; legalHold?: boolean; version: number;
};

export async function updateSettings(db: AppTenantDb, actorUserId: string, input: SettingsInput) {
  const before = await loadSettings(db);
  if (before.version !== input.version) throw new StateConflictError('stale');
  const { version, ...fields } = input;
  const data: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (data.defaultTaxRateId && data.defaultTaxRateId !== before.defaultTaxRateId) await activeTaxRate(db, data.defaultTaxRateId as string);
  const changed = changedFields(before as unknown as Record<string, unknown>, data);
  if (changed.length === 0) return settingsDto(db);
  if (version === 0) {
    // First save. INSERT … ON CONFLICT DO NOTHING: a concurrent first save waits for the winner's commit,
    // inserts nothing and answers 409 stale, without a unique violation aborting the unit of work.
    const created = await db.financeSettings.createMany({ data: [{ ...data, createdById: actorUserId, updatedById: actorUserId } as never], skipDuplicates: true });
    if (created.count === 0) throw new StateConflictError('stale');
  } else {
    const result = await db.financeSettings.updateMany({ where: { version }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never });
    if (result.count === 0) throw new StateConflictError('stale');
  }
  // Retention and defaults are audited with old and new values; seller details by field name only.
  const numeric = ['defaultPaymentTermsDays', 'defaultQuoteValidityDays', 'retentionYears', 'legalHold', 'defaultTaxRateId'] as const;
  const values: Record<string, string | null> = {};
  for (const k of numeric) {
    if (changed.includes(k)) {
      values[`${k}From`] = before[k] === null ? null : String(before[k]);
      values[`${k}To`] = data[k] === null ? null : String(data[k]);
    }
  }
  await recordAudit(db, actorUserId, 'finance.settings.changed', { type: 'finance_settings', id: await businessIdOf(db) }, { setting: 'settings', fields: changed, ...values });
  return settingsDto(db);
}

async function businessIdOf(db: AppTenantDb): Promise<string> {
  return (await db.business.findFirstOrThrow({ select: { id: true } })).id;
}

// ---- numbering series (FD-L1) --------------------------------------------------------------------

export const KINDS: readonly Kind[] = ['QUOTE', 'INVOICE', 'CREDIT_NOTE'];
const DEFAULT_PREFIX: Record<Kind, string> = { QUOTE: 'Q-', INVOICE: 'INV-', CREDIT_NOTE: 'CN-' };
const DEFAULT_DIGITS = 4;
const ONE = BigInt(1);

type SeriesRow = { kind: Kind; prefix: string; minDigits: number; startingValue: bigint; nextValue: bigint; version: number; updatedAt: Date | null };
const seriesSelect = { kind: true, prefix: true, minDigits: true, startingValue: true, nextValue: true, version: true, updatedAt: true } as const;

/** Same formatting as the issue guard: prefix + number, zero-padded to min_digits, never truncated. */
export const formatNumber = (prefix: string, minDigits: number, value: bigint) => prefix + value.toString().padStart(minDigits, '0');

const seriesDto = (r: SeriesRow) => ({
  kind: r.kind, prefix: r.prefix, minDigits: r.minDigits, startingValue: Number(r.startingValue), nextValue: Number(r.nextValue),
  nextNumber: formatNumber(r.prefix, r.minDigits, r.nextValue), used: r.nextValue !== r.startingValue, version: r.version,
  updatedAt: r.updatedAt?.toISOString() ?? null,
});
const virtualSeries = (kind: Kind): SeriesRow => ({ kind, prefix: DEFAULT_PREFIX[kind], minDigits: DEFAULT_DIGITS, startingValue: ONE, nextValue: ONE, version: 0, updatedAt: null });

export async function listSeries(db: AppTenantDb) {
  const rows = (await db.financeNumberSeries.findMany({ select: seriesSelect })) as SeriesRow[];
  return KINDS.map((kind) => seriesDto(rows.find((r) => r.kind === kind) ?? virtualSeries(kind)));
}

/**
 * Creates the series for a kind with its defaults if it does not exist yet (INSERT … ON CONFLICT DO
 * NOTHING, which never waits on an existing row). Called before an issue locks its document, so the
 * issue trigger always finds its series and the series row stays last in the lock order.
 */
export async function ensureSeries(db: AppTenantDb, kind: Kind) {
  const d = virtualSeries(kind);
  await db.financeNumberSeries.createMany({
    data: [{ id: randomUUID(), kind, prefix: d.prefix, minDigits: d.minDigits, startingValue: ONE, nextValue: ONE } as never],
    skipDuplicates: true,
  });
}

export type SeriesInput = { prefix?: string; minDigits?: number; startingValue?: number; version: number };

export async function updateSeries(db: AppTenantDb, actorUserId: string, kind: Kind, input: SeriesInput) {
  const existing = (await db.financeNumberSeries.findFirst({ where: { kind }, select: seriesSelect })) as SeriesRow | null;
  const before = existing ?? virtualSeries(kind);
  if (before.version !== input.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  if (input.prefix !== undefined) data.prefix = input.prefix;
  if (input.minDigits !== undefined) data.minDigits = input.minDigits;
  if (input.startingValue !== undefined) data.startingValue = BigInt(input.startingValue);
  const changed = changedFields({ ...before, startingValue: before.startingValue } as unknown as Record<string, unknown>, data);
  if (changed.length === 0) return seriesDto(before);
  // FD-L1: the starting number can be chosen only before the series issues its first document; after
  // that it is fixed and the counter can never be reset or moved back (the database refuses it too).
  if (changed.includes('startingValue') && before.nextValue !== before.startingValue) throw new StateConflictError('series_in_use');
  if (!existing) {
    // First save, as for the settings: a concurrent first save (or the first issue creating the series
    // with its defaults) wins on (business_id, kind); this one inserts nothing and answers 409 stale.
    const start = (data.startingValue as bigint | undefined) ?? ONE;
    const created = await db.financeNumberSeries.createMany({
      data: [{
        id: randomUUID(), kind, prefix: (data.prefix as string | undefined) ?? before.prefix, minDigits: (data.minDigits as number | undefined) ?? before.minDigits,
        startingValue: start, nextValue: start, createdById: actorUserId, updatedById: actorUserId,
      } as never],
      skipDuplicates: true,
    });
    if (created.count === 0) throw new StateConflictError('stale');
  } else {
    // Conditional on the version read above. An issue that commits a first number in between does not
    // change the version, but the database then refuses the starting-value change (FN008, 409 series_in_use).
    const result = await db.financeNumberSeries.updateMany({ where: { kind, version: input.version }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never });
    if (result.count === 0) throw new StateConflictError('stale');
  }
  const after = (await db.financeNumberSeries.findFirstOrThrow({ where: { kind }, select: seriesSelect })) as SeriesRow;
  const values: Record<string, string> = {};
  if (changed.includes('startingValue')) Object.assign(values, { startingValueFrom: before.startingValue.toString(), startingValueTo: after.startingValue.toString() });
  if (changed.includes('minDigits')) Object.assign(values, { minDigitsFrom: String(before.minDigits), minDigitsTo: String(after.minDigits) });
  await recordAudit(db, actorUserId, 'finance.settings.changed', { type: 'finance_number_series', id: await businessIdOf(db) }, {
    setting: 'number_series', kind, fields: changed, ...values,
  });
  return seriesDto(after);
}

// ---- tax rates -----------------------------------------------------------------------------------

type RateRow = { id: string; name: string; ratePercent: Decimal; createdAt: Date; updatedAt: Date; archivedAt: Date | null };
const rateSelect = { id: true, name: true, ratePercent: true, createdAt: true, updatedAt: true, archivedAt: true } as const;
const rateDto = (r: RateRow) => ({
  id: r.id, name: r.name, ratePercent: formatPlain(r.ratePercent), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});

/** A newly referenced tax rate must exist in this business and be active (existing references stay valid after archiving). */
export async function activeTaxRate(db: AppTenantDb, id: string) {
  const rate = await db.financeTaxRate.findFirst({ where: { id }, select: { archivedAt: true } });
  if (!rate) throw new RuleViolationError('invalid_tax_rate', 'Choose a tax rate of this business.');
  if (rate.archivedAt) throw new StateConflictError('archived_reference');
}

export async function listTaxRates(db: AppTenantDb, query: { archived: 'active' | 'archived' | 'all' }) {
  const where = query.archived === 'active' ? { archivedAt: null } : query.archived === 'archived' ? { archivedAt: { not: null } } : {};
  const rows = (await db.financeTaxRate.findMany({ where, select: rateSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }] })) as RateRow[];
  return rows.map(rateDto);
}

export async function createTaxRate(db: AppTenantDb, actorUserId: string, input: { name: string; ratePercent: string }) {
  const ratePercent = new Decimal(input.ratePercent);
  if (ratePercent.gt(100)) throw new RuleViolationError('invalid_tax_rate', 'A tax rate is at most 100%.');
  const id = randomUUID();
  const row = (await db.financeTaxRate.create({
    data: { id, name: input.name, ratePercent, createdById: actorUserId, updatedById: actorUserId } as never, select: rateSelect,
  })) as RateRow;
  await recordAudit(db, actorUserId, 'finance.settings.changed', { type: 'finance_tax_rate', id }, {
    setting: 'tax_rate', action: 'created', ratePercent: formatPlain(row.ratePercent),
  });
  return rateDto(row);
}

export async function updateTaxRate(db: AppTenantDb, actorUserId: string, id: string, input: { name?: string; archived?: boolean }) {
  const before = (await db.financeTaxRate.findFirst({ where: { id }, select: rateSelect })) as RateRow | null;
  if (!before) throw new RecordNotFoundError();
  const data: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== before.name) data.name = input.name;
  if (input.archived !== undefined && input.archived !== (before.archivedAt !== null)) data.archivedAt = input.archived ? new Date() : null;
  if (Object.keys(data).length === 0) return rateDto(before);
  const row = (await db.financeTaxRate.update({ where: { id }, data: { ...data, updatedById: actorUserId } as never, select: rateSelect })) as RateRow;
  await recordAudit(db, actorUserId, 'finance.settings.changed', { type: 'finance_tax_rate', id }, {
    setting: 'tax_rate', fields: Object.keys(data).sort(), ...(data.archivedAt !== undefined ? { archived: input.archived ? 'true' : 'false' } : {}),
  });
  return rateDto(row);
}

// ---- seller snapshot -----------------------------------------------------------------------------

/**
 * The seller as it is now, for the snapshot sealed into a document at issue. Legal and tax
 * identifiers are whatever the business configured: no jurisdiction's mandatory fields are checked
 * (FD-L6 is open), and nothing here makes a document compliant with any invoicing regime.
 */
export async function sellerSnapshot(db: AppTenantDb) {
  const s = await loadSettings(db);
  const business = await businessProfile(db);
  return {
    legalName: s.sellerLegalName ?? business.legalName ?? business.name,
    address: s.sellerAddress, email: s.sellerEmail, phone: s.sellerPhone, countryCode: business.countryCode,
    identifiers: identifiersOf(s.sellerIdentifiers), paymentInstructions: s.paymentInstructions,
  };
}
