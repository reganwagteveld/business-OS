import { z } from 'zod';
import { UnitPrice } from './finance.ts';
import { CurrencyCode } from './sales.ts';

// Finance F7-A (docs/finance-catalog-f7a.md): the products and services catalog. Every path is under
// /api/v1/b/:slug/finance, so no request carries a business id; bodies are strict (an unknown field is
// rejected, never ignored); prices are exact decimal strings, never JSON numbers.
//
// The catalog is a source of defaults. Quotes and invoices never read it: a later picker copies an
// item's description, price and tax rate into a draft line, and an issued document keeps its own
// sealed lines, so changing or archiving an item never changes a document. Tax percentages are never
// stored here; an item points to one of the business's tax rates (or the business default, or none).
// No stock quantities, stock movements, purchasing or valuation (Inventory is a later module).

const Uuid = z.string().uuid();
const Version = { version: z.number().int().min(1) };
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();

export const CatalogItemType = z.enum(['PRODUCT', 'SERVICE']);
export type CatalogItemType = z.infer<typeof CatalogItemType>;
/** ACTIVE items are offered for new work; INACTIVE items stay in the catalog but are not offered. */
export const CatalogItemStatus = z.enum(['ACTIVE', 'INACTIVE']);
export type CatalogItemStatus = z.infer<typeof CatalogItemStatus>;
/**
 * BUSINESS_DEFAULT: the business's default tax rate at the time the item is used (none if it has none).
 * RATE: one of the business's tax rates (`taxRateId`). NONE: no tax. Prices are tax-exclusive (FD-T1).
 */
export const CatalogTaxMode = z.enum(['BUSINESS_DEFAULT', 'RATE', 'NONE']);
export type CatalogTaxMode = z.infer<typeof CatalogTaxMode>;

/**
 * Units of measure (codes). A fixed list so that future Inventory and Purchasing can rely on them;
 * adding one is a contract change only (the database checks the shape, not the list).
 */
export const CATALOG_UNITS = [
  'each', 'hour', 'minute', 'day', 'week', 'month', 'year', 'job', 'visit', 'session', 'licence', 'user',
  'pack', 'box', 'set', 'pair', 'kg', 'g', 'tonne', 'l', 'ml', 'm', 'cm', 'km', 'm2', 'm3',
] as const;
export const CatalogUnit = z.enum(CATALOG_UNITS);
export type CatalogUnit = z.infer<typeof CatalogUnit>;

export const CatalogItem = z
  .object({
    id: Uuid,
    type: CatalogItemType,
    name: z.string(),
    description: z.string().nullable(),
    /** Optional SKU or service code, unique in the business ignoring case (archived items included). */
    code: z.string().nullable(),
    unit: CatalogUnit,
    /** Default unit price before tax, in `currencyCode`; null when the item has no default price. */
    unitPrice: z.string().nullable(),
    currencyCode: z.string(),
    taxMode: CatalogTaxMode,
    taxRateId: Uuid.nullable(),
    /** The linked rate as it is now (for display only; documents snapshot their own tax). */
    taxRate: z.object({ id: Uuid, name: z.string(), ratePercent: z.string(), archived: z.boolean() }).strict().nullable(),
    status: CatalogItemStatus,
    /** Set while archived: the item is read-only and hidden from the default list until restored. */
    archivedAt: z.string().datetime().nullable(),
    version: z.number().int().min(1),
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CatalogItem = z.infer<typeof CatalogItem>;

/**
 * `status`: current = not archived (the default), active, inactive (both not archived), archived, all.
 * `q` searches name, code and description (contains, ignoring case); `code` matches one code exactly
 * (ignoring case), for scanners and imports. Ordered by name, then id; keyset cursors.
 */
export const ListCatalogItemsQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    code: z.string().trim().min(1).max(64).optional(),
    type: CatalogItemType.optional(),
    status: z.enum(['current', 'active', 'inactive', 'archived', 'all']).default('current'),
    taxRateId: Uuid.optional(),
    currencyCode: CurrencyCode.optional(),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();
export const ListCatalogItemsResponse = z.object({ items: z.array(CatalogItem), nextCursor: z.string().nullable() }).strict();
export const CatalogItemResponse = z.object({ item: CatalogItem }).strict();

const Name = z.string().trim().min(1, 'Enter a name').max(200);
const Description = z.string().trim().max(2000).transform((v) => (v === '' ? null : v)).nullable();
// eslint-disable-next-line no-control-regex
const Code = z.string().trim().max(64).regex(/^[^\x00-\x1f\x7f]*$/, 'A code cannot contain control characters').transform((v) => (v === '' ? null : v)).nullable();

const itemFields = {
  name: Name,
  description: Description.optional(),
  code: Code.optional(),
  unit: CatalogUnit,
  /** Up to 12 whole digits and 6 decimals, as a document line's unit price. Null: no default price. */
  unitPrice: UnitPrice.nullable().optional(),
  /** Defaults to the business currency. */
  currencyCode: CurrencyCode.optional(),
  taxMode: CatalogTaxMode,
  /** Required with RATE, refused otherwise. */
  taxRateId: Uuid.nullable().optional(),
};

export const CreateCatalogItemRequest = z.object({ type: CatalogItemType, ...itemFields }).strict();

/** Edit (optimistic `version`). The type is fixed once created. An archived item cannot be edited. */
export const UpdateCatalogItemRequest = z
  .object({
    ...Version,
    name: Name.optional(),
    description: Description.optional(),
    code: Code.optional(),
    unit: CatalogUnit.optional(),
    unitPrice: UnitPrice.nullable().optional(),
    currencyCode: CurrencyCode.optional(),
    taxMode: CatalogTaxMode.optional(),
    taxRateId: Uuid.nullable().optional(),
    status: CatalogItemStatus.optional(),
  })
  .strict();

/** Archive or restore (optimistic `version`). Nothing is ever deleted. */
export const CatalogItemLifecycleRequest = z.object(Version).strict();
