import { z } from 'zod';
import { CalendarDate, CurrencyCode, Money } from './sales.ts';

// Finance Zone F1 (docs/finance-data-model.md): quotes, invoices, credit notes and their settings.
// Every path is under /api/v1/b/:slug/finance, so no request carries a business id. Bodies are strict:
// an unknown field (a number, a status, a total, a hash, an author, an issue time) is rejected, never
// ignored, because those belong to the server and the database.
//
// Amounts are exact decimal strings, never JSON numbers. Totals, line amounts, numbers, snapshots and
// hashes are computed by the server and checked again by the database at issue.
//
// This is a financial record engine, not a certified accounting, tax-filing or jurisdiction-compliant
// invoicing product: no country's invoicing or tax rules are implemented or implied.

const Uuid = z.string().uuid();
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

/** Quantity: up to 12 whole digits and 6 decimals (fractional units). Greater than zero. */
export const Quantity = z.string().trim().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Enter a quantity such as 1, 2.5 or 0.125');
/** Unit price: up to 12 whole digits and 6 decimals (sub-cent unit prices). Not negative. */
export const UnitPrice = z.string().trim().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Enter a price such as 120 or 0.0125');
/** A tax percentage between 0 and 100 with up to 4 decimals, e.g. "10" or "7.6250". */
export const TaxPercent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage such as 10 or 7.625')
  .refine((v) => Number.parseFloat(v) <= 100, 'A tax rate is at most 100%');

export const FinanceDocumentKind = z.enum(['QUOTE', 'INVOICE', 'CREDIT_NOTE']);
export type FinanceDocumentKind = z.infer<typeof FinanceDocumentKind>;
export const FinanceDocumentStatus = z.enum(['DRAFT', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID']);
export type FinanceDocumentStatus = z.infer<typeof FinanceDocumentStatus>;
/**
 * Tax mode. F1 supports only tax-exclusive prices (owner decision FD-T1). Other values are accepted by
 * the schema so that the server can refuse them explicitly (400 unsupported_tax_mode) rather than
 * silently treating them as exclusive.
 */
export const TaxMode = z.string().trim().regex(/^[A-Z_]{1,30}$/, 'Use a tax mode such as EXCLUSIVE');

// ---- documents -----------------------------------------------------------------------------------

export const FinanceDocumentLine = z
  .object({
    id: Uuid,
    position: z.number().int(),
    description: z.string(),
    quantity: z.string(),
    unitPrice: z.string(),
    discountAmount: z.string(),
    taxRateId: Uuid.nullable(),
    /** The rate's name and percentage as the line uses them (copied by the database). */
    taxName: z.string().nullable(),
    taxRatePercent: z.string(),
    /** round(quantity × unitPrice, currency decimals) − discount. */
    lineNet: z.string(),
    /** round(lineNet × taxRatePercent / 100, currency decimals). */
    lineTax: z.string(),
  })
  .strict();
export type FinanceDocumentLine = z.infer<typeof FinanceDocumentLine>;

const Identifier = z.object({ label: z.string(), value: z.string() }).strict();

/** The seller as it was when the document was issued. */
export const SellerSnapshot = z
  .object({
    legalName: z.string(),
    address: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    countryCode: z.string().nullable(),
    identifiers: z.array(Identifier),
    paymentInstructions: z.string().nullable(),
  })
  .strict();

/** The customer (and contact) as they were when the document was issued. */
export const BillToSnapshot = z
  .object({
    customerId: Uuid,
    name: z.string(),
    legalName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postalCode: z.string().nullable(),
    countryCode: z.string().nullable(),
    taxNumber: z.string().nullable(),
    taxNumberType: z.string().nullable(),
    contact: z.object({ contactId: Uuid, name: z.string(), email: z.string().nullable() }).strict().nullable(),
  })
  .strict();

const documentFields = {
  id: Uuid,
  kind: FinanceDocumentKind,
  status: FinanceDocumentStatus,
  /** Assigned by the database at issue; null while a draft (and for a discarded draft). */
  number: z.string().nullable(),
  customerId: Uuid,
  contactId: Uuid.nullable(),
  opportunityId: Uuid.nullable(),
  projectId: Uuid.nullable(),
  /** For an invoice converted from a quote. */
  sourceQuoteId: Uuid.nullable(),
  /** For a credit note: the invoice it credits. */
  creditedInvoiceId: Uuid.nullable(),
  currencyCode: z.string(),
  /** Decimal places of the currency, fixed when the document was created. */
  currencyScale: z.number().int(),
  taxMode: z.string(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  subtotal: z.string(),
  taxTotal: z.string(),
  total: z.string(),
  /** Payments allocated to an invoice (F2). Always "0" in F1; a credit note does not settle an invoice. */
  allocatedTotal: z.string(),
  notes: z.string().nullable(),
  sellerSnapshot: SellerSnapshot.nullable(),
  billToSnapshot: BillToSnapshot.nullable(),
  /** SHA-256 of the issued content, computed by the database. */
  contentSha256: z.string().nullable(),
  issuedAt: z.string().datetime().nullable(),
  statusChangedAt: z.string().datetime().nullable(),
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string().nullable(),
  /** Increases with every change. Edits and transitions must send the version they were based on. */
  version: z.number().int().min(1),
  createdById: Uuid.nullable(),
  updatedById: Uuid.nullable(),
  issuedById: Uuid.nullable(),
  statusChangedById: Uuid.nullable(),
  voidedById: Uuid.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

export const FinanceDocument = z.object({ ...documentFields, lines: z.array(FinanceDocumentLine) }).strict();
export type FinanceDocument = z.infer<typeof FinanceDocument>;
/** List rows carry the header only; GET …/:id returns the lines. */
export const FinanceDocumentListItem = z.object(documentFields).strict();
export type FinanceDocumentListItem = z.infer<typeof FinanceDocumentListItem>;

/**
 * A line as a client sends it. Lines are always sent as the complete, ordered list: adding, replacing,
 * reordering and removing lines are all one PATCH. Tax comes only from a tax rate of this business.
 */
export const FinanceLineInput = z
  .object({
    description: z.string().trim().min(1, 'Describe the line').max(1000),
    quantity: Quantity,
    unitPrice: UnitPrice,
    /** An amount off this line, in the document's currency. */
    discountAmount: Money.optional(),
    taxRateId: Uuid.nullable().optional(),
  })
  .strict();
const Lines = z.array(FinanceLineInput).max(200, 'A document has at most 200 lines');

const linkFields = {
  contactId: Uuid.nullable().optional(),
  opportunityId: Uuid.nullable().optional(),
  projectId: Uuid.nullable().optional(),
  notes: optionalText(5000),
  taxMode: TaxMode.optional(),
  lines: Lines.optional(),
};

/** Currency defaults to the business's. The customer is required and must be active. */
export const CreateQuoteRequest = z
  .object({ customerId: Uuid, currencyCode: CurrencyCode.optional(), validUntil: CalendarDate.nullable().optional(), ...linkFields })
  .strict();
export const CreateInvoiceRequest = z
  .object({ customerId: Uuid, currencyCode: CurrencyCode.optional(), dueDate: CalendarDate.nullable().optional(), ...linkFields })
  .strict();
/** A credit note for an issued invoice: customer and currency are the invoice's. */
export const CreateCreditNoteRequest = z
  .object({
    notes: optionalText(5000),
    lines: Lines.optional(),
    /** Start from a copy of the invoice's lines (ignored when `lines` is given). */
    copyInvoiceLines: z.boolean().optional(),
  })
  .strict();
/** Creates a draft invoice from an issued or accepted quote. The quote itself never changes. */
export const ConvertQuoteRequest = z
  .object({ dueDate: CalendarDate.nullable().optional(), notes: optionalText(5000) })
  .strict();

const draftEdit = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .extend({
      /** Optimistic concurrency: the version the edit was based on (409 stale otherwise). */
      version: z.number().int().min(1),
    })
    .strict()
    .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');

/** Edits a draft. `lines`, when given, replaces the whole list in the order sent. Currency is fixed. */
export const UpdateQuoteRequest = draftEdit({ customerId: Uuid, validUntil: CalendarDate.nullable(), ...linkFields });
export const UpdateInvoiceRequest = draftEdit({ customerId: Uuid, dueDate: CalendarDate.nullable(), ...linkFields });
export const UpdateCreditNoteRequest = draftEdit({ notes: optionalText(5000), lines: Lines });

const Version = { version: z.number().int().min(1) };
/**
 * Issues a draft: the database assigns the next number of the series, seals the snapshots and lines
 * and computes the content hash. The issue date defaults to today in the business's time zone. An
 * invoice needs a due date (from the request, the draft or the business's default payment terms).
 */
export const IssueDocumentRequest = z
  .object({ ...Version, issueDate: CalendarDate.optional(), dueDate: CalendarDate.optional(), validUntil: CalendarDate.optional() })
  .strict();
/** Voids an issued document. The reason is required and kept; the number stays in the sequence. */
export const VoidDocumentRequest = z.object({ ...Version, reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
/** Discards a draft (never numbered). */
export const DiscardDraftRequest = z.object({ ...Version, reason: optionalText(500) }).strict();
/** Accept, decline or expire an issued quote. Acceptance is a recorded business decision, not a payment. */
export const QuoteTransitionRequest = z.object(Version).strict();

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();
const listFilters = {
  status: z.enum(['draft', 'issued', 'accepted', 'declined', 'expired', 'void', 'all']).default('all'),
  customerId: Uuid.optional(),
  projectId: Uuid.optional(),
  /** Issue date range, half-open [from, to). */
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  cursor: Cursor,
  limit: Limit,
};
export const ListQuotesQuery = z.object(listFilters).strict();
export const ListInvoicesQuery = z
  .object({
    ...listFilters,
    /** Issued, not fully paid, due before today in the business's time zone. */
    overdue: z.enum(['true', 'false']).optional(),
  })
  .strict();
export const ListCreditNotesQuery = z.object({ ...listFilters, invoiceId: Uuid.optional() }).strict();

export const FinanceDocumentResponse = z.object({ document: FinanceDocument }).strict();
export const ListFinanceDocumentsResponse = z.object({ documents: z.array(FinanceDocumentListItem), nextCursor: z.string().nullable() }).strict();

// ---- settings ------------------------------------------------------------------------------------

export const FinanceSettings = z
  .object({
    sellerLegalName: z.string().nullable(),
    sellerAddress: z.string().nullable(),
    sellerEmail: z.string().nullable(),
    sellerPhone: z.string().nullable(),
    sellerIdentifiers: z.array(Identifier),
    paymentInstructions: z.string().nullable(),
    defaultPaymentTermsDays: z.number().int().nullable(),
    defaultQuoteValidityDays: z.number().int().nullable(),
    defaultTaxRateId: Uuid.nullable(),
    /** The business's currency, the default for new documents. */
    defaultCurrency: z.string(),
    /** Retention policy (FD-L3): issued documents and their audit history are never deleted automatically. */
    retentionYears: z.number().int(),
    legalHold: z.boolean(),
    /** True once the business has any finance record: business deletion is then refused. */
    hasRetainedRecords: z.boolean(),
    /** 0 until the settings are first saved. */
    version: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export const FinanceSettingsResponse = z.object({ settings: FinanceSettings }).strict();

const IdentifierInput = z.object({ label: z.string().trim().min(1).max(50), value: z.string().trim().min(1).max(100) }).strict();
export const UpdateFinanceSettingsRequest = z
  .object({
    sellerLegalName: optionalText(200),
    sellerAddress: optionalText(1000),
    sellerEmail: z.string().trim().email().max(254).nullable().optional(),
    sellerPhone: optionalText(50),
    sellerIdentifiers: z.array(IdentifierInput).max(10).optional(),
    paymentInstructions: optionalText(2000),
    defaultPaymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
    defaultQuoteValidityDays: z.number().int().min(1).max(365).nullable().optional(),
    defaultTaxRateId: Uuid.nullable().optional(),
    /** At least 7 years (the provisional baseline); longer where a jurisdiction requires it. */
    retentionYears: z.number().int().min(7).max(100).optional(),
    legalHold: z.boolean().optional(),
    /** The version the edit was based on; 0 when the settings have never been saved. */
    version: z.number().int().min(0),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');

/** A gapless numbering series (FD-L1). */
export const NumberSeries = z
  .object({
    kind: FinanceDocumentKind,
    prefix: z.string(),
    minDigits: z.number().int(),
    startingValue: z.number().int(),
    /** The number the next issued document of this kind will get. */
    nextValue: z.number().int(),
    /** The next number as it will be printed, e.g. INV-0042. */
    nextNumber: z.string(),
    /** Once a number has been issued, the starting value is fixed and the counter never moves back. */
    used: z.boolean(),
    /** 0 until the series is first saved or used. */
    version: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export const ListNumberSeriesResponse = z.object({ series: z.array(NumberSeries) }).strict();
export const NumberSeriesResponse = z.object({ series: NumberSeries }).strict();
export const UpdateNumberSeriesRequest = z
  .object({
    prefix: z.string().max(20).regex(/^[^\p{Cc}]*$/u, 'No control characters').optional(),
    minDigits: z.number().int().min(1).max(12).optional(),
    /** Settable only before the series has issued its first number. */
    startingValue: z.number().int().min(1).max(999_999_999_999).optional(),
    version: z.number().int().min(0),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');

export const TaxRate = z
  .object({
    id: Uuid,
    name: z.string(),
    ratePercent: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export const ListTaxRatesQuery = z.object({ archived: z.enum(['active', 'archived', 'all']).default('active') }).strict();
export const ListTaxRatesResponse = z.object({ taxRates: z.array(TaxRate) }).strict();
export const TaxRateResponse = z.object({ taxRate: TaxRate }).strict();
export const CreateTaxRateRequest = z.object({ name: z.string().trim().min(1).max(100), ratePercent: TaxPercent }).strict();
/** A rate's percentage never changes: create a new rate instead. Archiving keeps it on existing lines. */
export const UpdateTaxRateRequest = z
  .object({ name: z.string().trim().min(1).max(100).optional(), archived: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
