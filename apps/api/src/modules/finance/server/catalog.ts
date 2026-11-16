import 'server-only';
// Finance F7-A: the products and services catalog (docs/finance-catalog-f7a.md). Runs inside one
// tenant unit of work per request: the change and its audit entry, nothing else.
//
// Every change is conditional on the version the caller read (optimistic concurrency, as for expense
// categories): `UPDATE … WHERE id = ? AND version = ?`, so two people editing the same item at once can
// never both win, and the loser gets 409 stale. The database holds every rule again (migration
// 20261130000000_finance_catalog): the shapes, the code uniqueness, the tax link, the type and identity
// being fixed, archived items being read-only, the version advancing by one, and RLS.
//
// Tax and money are not re-implemented here. An item points to one of the business's tax rates (the
// same rates documents use) and never stores a percentage; prices are exact decimal strings with a
// document line's precision. `lineDefaultsOf` is the one place a future picker (quotes, invoices,
// recurring templates, POS) turns an item into the values it COPIES into a draft line.
import { createHash, randomUUID } from 'node:crypto';
import type { CatalogItem as ItemDto, CatalogItemStatus, CatalogItemType, CatalogTaxMode, CatalogUnit } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { isUniqueViolation, RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { checkCurrency, formatPlain } from './money';
import { activeTaxRate } from './settings';
import { businessProfile } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null) => d?.toISOString() ?? null;

type ItemRow = {
  id: string; type: CatalogItemType; name: string; description: string | null; code: string | null; unit: CatalogUnit; unitPrice: Decimal | null;
  currencyCode: string; taxMode: CatalogTaxMode; taxRateId: string | null; status: CatalogItemStatus; archivedAt: Date | null; version: number;
  createdById: string | null; updatedById: string | null; createdAt: Date; updatedAt: Date;
  taxRate: { id: string; name: string; ratePercent: Decimal; archivedAt: Date | null } | null;
};
const itemSelect = {
  id: true, type: true, name: true, description: true, code: true, unit: true, unitPrice: true, currencyCode: true, taxMode: true, taxRateId: true,
  status: true, archivedAt: true, version: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true,
  taxRate: { select: { id: true, name: true, ratePercent: true, archivedAt: true } },
} as const;

const itemDto = (r: ItemRow): ItemDto => ({
  id: r.id, type: r.type, name: r.name, description: r.description, code: r.code, unit: r.unit,
  unitPrice: r.unitPrice === null ? null : formatPlain(r.unitPrice), currencyCode: r.currencyCode, taxMode: r.taxMode, taxRateId: r.taxRateId,
  taxRate: r.taxRate ? { id: r.taxRate.id, name: r.taxRate.name, ratePercent: formatPlain(r.taxRate.ratePercent), archived: r.taxRate.archivedAt !== null } : null,
  status: r.status, archivedAt: iso(r.archivedAt), version: r.version, createdById: r.createdById, updatedById: r.updatedById,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

/** An item of this business. Another business's id answers exactly like a missing one (404). */
async function load(db: AppTenantDb, id: string): Promise<ItemRow> {
  const row = (await db.financeCatalogItem.findFirst({ where: { id }, select: itemSelect })) as ItemRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export async function getCatalogItem(db: AppTenantDb, id: string) {
  return itemDto(await load(db, id));
}

// ---- validation ----------------------------------------------------------------------------------

/**
 * The tax link: RATE needs a rate of this business that is active when newly linked; the other modes
 * take none. An item whose rate was archived later keeps it (existing links stay valid, as for
 * documents and expenses) and the database refuses linking an archived rate again (FN017).
 */
async function checkTax(db: AppTenantDb, mode: CatalogTaxMode, taxRateId: string | null, previousRateId: string | null) {
  if (mode !== 'RATE') {
    if (taxRateId !== null) throw new RuleViolationError('invalid_tax_rate', 'Only the "specific tax rate" setting takes a tax rate.');
    return;
  }
  if (taxRateId === null) throw new RuleViolationError('invalid_tax_rate', 'Choose a tax rate of this business.');
  if (taxRateId !== previousRateId) await activeTaxRate(db, taxRateId);
}

const duplicateCode = (error: unknown) => isUniqueViolation(error, 'finance_catalog_items_code_key');

/** A code already used by another item of this business, archived items included (ignoring case). */
async function codeTaken(db: AppTenantDb, code: string, exceptId?: string) {
  const hit = await db.financeCatalogItem.findFirst({
    where: { code: { equals: code, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return hit !== null;
}

// ---- list ----------------------------------------------------------------------------------------

export interface ListCatalogQuery {
  q?: string; code?: string; type?: CatalogItemType; status: 'current' | 'active' | 'inactive' | 'archived' | 'all'; taxRateId?: string;
  currencyCode?: string; cursor?: string; limit: number;
}

/**
 * A digest of the filters that shape the result set, normalized the way the query applies them: an empty
 * search or code is no filter, codes and tax rate ids compare without case, currencies are upper case.
 */
function catalogFilterKey(query: ListCatalogQuery): string {
  const canonical = JSON.stringify([
    query.q || null, query.code ? query.code.toLowerCase() : null, query.type ?? null, query.status,
    query.taxRateId ? query.taxRateId.toLowerCase() : null, query.currencyCode ? query.currencyCode.toUpperCase() : null,
  ]);
  return createHash('sha256').update(canonical).digest('base64url');
}

/** Search, filter and page (keyset on name, then id; the cursor is bound to this list). */
export async function listCatalogItems(db: AppTenantDb, query: ListCatalogQuery) {
  const where: Record<string, unknown>[] = [];
  if (query.status === 'current') where.push({ archivedAt: null });
  if (query.status === 'active') where.push({ archivedAt: null, status: 'ACTIVE' });
  if (query.status === 'inactive') where.push({ archivedAt: null, status: 'INACTIVE' });
  if (query.status === 'archived') where.push({ archivedAt: { not: null } });
  if (query.type) where.push({ type: query.type });
  if (query.taxRateId) where.push({ taxRateId: query.taxRateId });
  if (query.currencyCode) where.push({ currencyCode: query.currencyCode });
  if (query.code) where.push({ code: { equals: query.code, mode: 'insensitive' } });
  if (query.q) {
    where.push({
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } }, { code: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }
  const list = 'finance:catalog-items';
  // The cursor is bound to the normalized filters (as the ageing list is), so a cursor issued for one
  // filter set is refused by another instead of silently skipping rows. The page size may change between
  // pages. Cursor keys avoid `k`, which the cursor format uses for the list name.
  const filters = catalogFilterKey(query);
  const after = decodeCursor(query.cursor, list, ['n', 'i', 'f'] as const);
  if (after) {
    if (!UUID.test(after.i) || after.f !== filters) invalidCursor();
    where.push({ OR: [{ name: { gt: after.n } }, { name: after.n, id: { gt: after.i } }] });
  }
  const rows = (await db.financeCatalogItem.findMany({
    where: { AND: where }, select: itemSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  })) as ItemRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(itemDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, { n: last.name, i: last.id, f: filters }) : null,
  };
}

// ---- create and edit -----------------------------------------------------------------------------

export interface CatalogItemInput {
  type: CatalogItemType; name: string; description?: string | null; code?: string | null; unit: CatalogUnit; unitPrice?: string | null;
  currencyCode?: string; taxMode: CatalogTaxMode; taxRateId?: string | null;
}

export async function createCatalogItem(db: AppTenantDb, actorUserId: string, input: CatalogItemInput) {
  const currencyCode = checkCurrency(input.currencyCode ?? (await businessProfile(db)).currency);
  const taxRateId = input.taxRateId ?? null;
  await checkTax(db, input.taxMode, taxRateId, null);
  const code = input.code ?? null;
  if (code !== null && (await codeTaken(db, code))) throw new StateConflictError('duplicate_code');
  const id = randomUUID();
  try {
    await db.financeCatalogItem.create({
      data: {
        id, type: input.type, name: input.name, description: input.description ?? null, code, unit: input.unit,
        unitPrice: input.unitPrice == null ? null : new Decimal(input.unitPrice), currencyCode, taxMode: input.taxMode, taxRateId,
        createdById: actorUserId, updatedById: actorUserId,
      } as never,
    });
  } catch (error) {
    if (duplicateCode(error)) throw new StateConflictError('duplicate_code'); // a concurrent create with the same code
    throw error;
  }
  // References only: no name, code, description or price (docs/finance-catalog-f7a.md §6).
  await recordAudit(db, actorUserId, 'finance.catalog.created', { type: 'finance_catalog_item', id }, { itemType: input.type });
  return getCatalogItem(db, id);
}

export interface CatalogItemPatch {
  version: number; name?: string; description?: string | null; code?: string | null; unit?: CatalogUnit; unitPrice?: string | null;
  currencyCode?: string; taxMode?: CatalogTaxMode; taxRateId?: string | null; status?: CatalogItemStatus;
}

const sameDecimal = (a: Decimal | null, b: string | null) => (a === null || b === null ? a === b : a.eq(b));

export async function updateCatalogItem(db: AppTenantDb, actorUserId: string, id: string, input: CatalogItemPatch) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== before.name) data.name = input.name;
  if (input.description !== undefined && input.description !== before.description) data.description = input.description;
  if (input.code !== undefined && input.code !== before.code) data.code = input.code;
  if (input.unit !== undefined && input.unit !== before.unit) data.unit = input.unit;
  if (input.unitPrice !== undefined && !sameDecimal(before.unitPrice, input.unitPrice)) data.unitPrice = input.unitPrice === null ? null : new Decimal(input.unitPrice);
  if (input.currencyCode !== undefined && input.currencyCode !== before.currencyCode) data.currencyCode = checkCurrency(input.currencyCode);
  if (input.status !== undefined && input.status !== before.status) data.status = input.status;
  // The tax pair is validated together: switching away from RATE clears the rate unless one is sent.
  const taxMode = input.taxMode ?? before.taxMode;
  const taxRateId = input.taxRateId !== undefined ? input.taxRateId : taxMode === 'RATE' ? before.taxRateId : null;
  if (taxMode !== before.taxMode || taxRateId !== before.taxRateId) {
    await checkTax(db, taxMode, taxRateId, before.taxRateId);
    if (taxMode !== before.taxMode) data.taxMode = taxMode;
    if (taxRateId !== before.taxRateId) data.taxRateId = taxRateId;
  }
  if (Object.keys(data).length === 0) return itemDto(before);
  if (typeof data.code === 'string' && (await codeTaken(db, data.code, id))) throw new StateConflictError('duplicate_code');
  let result;
  try {
    result = await db.financeCatalogItem.updateMany({
      where: { id, version: input.version, archivedAt: null }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never,
    });
  } catch (error) {
    if (duplicateCode(error)) throw new StateConflictError('duplicate_code');
    throw error;
  }
  // Someone else changed or archived it after it was read: nothing was written.
  if (result.count === 0) throw new StateConflictError('stale');
  const fields = Object.keys(data).sort();
  await recordAudit(db, actorUserId, 'finance.catalog.updated', { type: 'finance_catalog_item', id }, {
    itemType: before.type, fields,
    ...(data.status !== undefined ? { statusFrom: before.status, statusTo: data.status as string } : {}),
  });
  return getCatalogItem(db, id);
}

// ---- archive and restore -------------------------------------------------------------------------

export async function archiveCatalogItem(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await load(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (before.archivedAt) throw new StateConflictError('archived');
  // archived_at is stamped by the database (the value sent here is replaced by now()).
  const result = await db.financeCatalogItem.updateMany({
    where: { id, version: input.version, archivedAt: null }, data: { archivedAt: new Date(), version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.catalog.archived', { type: 'finance_catalog_item', id }, { itemType: before.type });
  return getCatalogItem(db, id);
}

export async function restoreCatalogItem(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await load(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (!before.archivedAt) throw new StateConflictError('not_archived');
  const result = await db.financeCatalogItem.updateMany({
    where: { id, version: input.version, archivedAt: { not: null } }, data: { archivedAt: null, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.catalog.restored', { type: 'finance_catalog_item', id }, { itemType: before.type });
  return getCatalogItem(db, id);
}

// ---- reuse by future pickers ---------------------------------------------------------------------

export interface CatalogLineDefaults {
  /** The item's name, then its description on the next line: what a draft line's description starts as. */
  description: string;
  /** The default price, only when the document is in the item's currency; never converted. */
  unitPrice: string | null;
  /** The tax rate the line should start with: the item's rate, the business default, or none. */
  taxRateId: string | null;
}

/**
 * What a picker COPIES into a draft document line (quotes, invoices, recurring templates; later POS).
 * Pure: it reads nothing and writes nothing. The copied values then belong to the line, and the
 * document's own rules (tax snapshot, rounding, sealing at issue) apply to them unchanged. A price in
 * another currency is left out rather than converted, and an archived or inactive item is refused, so
 * a picker never offers it for new work.
 */
export function lineDefaultsOf(
  item: Pick<ItemDto, 'name' | 'description' | 'unitPrice' | 'currencyCode' | 'taxMode' | 'taxRateId' | 'status' | 'archivedAt'>,
  document: { currencyCode: string; defaultTaxRateId: string | null },
): CatalogLineDefaults {
  if (item.archivedAt !== null || item.status !== 'ACTIVE') throw new StateConflictError('archived_reference');
  const description = (item.description ? `${item.name}\n${item.description}` : item.name).slice(0, 1000);
  return {
    description,
    unitPrice: item.currencyCode === document.currencyCode ? item.unitPrice : null,
    taxRateId: item.taxMode === 'RATE' ? item.taxRateId : item.taxMode === 'BUSINESS_DEFAULT' ? document.defaultTaxRateId : null,
  };
}
