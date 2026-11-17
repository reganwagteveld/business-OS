import 'server-only';
// Quotes, invoices and credit notes (docs/finance-data-model.md §2.2–2.3, §4.1, §6; ADR 0007). Runs
// inside one tenant unit of work per request: the change and its audit entry, nothing else.
//
// Every write to a document first locks it (lockDocuments: FOR NO KEY UPDATE, the documented lock
// order) and then makes a change conditional on the state and version it read, so two people acting
// at once can never both edit, issue or void the same document from a stale view. The database guard
// triggers hold every rule again, independently of this code: numbering, sealing, immutability,
// totals, transitions and links.
import { randomUUID } from 'node:crypto';
import type { FinanceDocument as DocumentDto, FinanceDocumentListItem as ListItemDto } from '@business-os/contracts';
import { authorize, type Principal } from '@/modules/access';
import { recordAudit, recordSystemAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { checkCurrency, currencyScale, documentTotals, formatAmount, formatPlain, lineAmounts, toAmount, type LineAmounts } from './money';
import { resolveCatalogLines, type DraftLineInput } from './catalog';
import { ensureSeries, loadSettings, sellerSnapshot } from './settings';
import {
  addDays, BUMP, businessProfile, changedFields, dateOf, dayOf, lockDocuments, lockIdempotencyKey, requestHash, todayIn,
  type Kind, type Status,
} from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- rows and DTOs -------------------------------------------------------------------------------

export type Row = {
  id: string; kind: Kind; status: Status; number: string | null; customerId: string; contactId: string | null; opportunityId: string | null;
  projectId: string | null; sourceQuoteId: string | null; creditedInvoiceId: string | null; currencyCode: string; currencyScale: number;
  taxMode: string; issueDate: Date | null; dueDate: Date | null; validUntil: Date | null; subtotal: Decimal; taxTotal: Decimal; total: Decimal;
  allocatedTotal: Decimal; creditAppliedTotal: Decimal; notes: string | null; sellerSnapshot: unknown; billToSnapshot: unknown; contentSha256: string | null;
  idempotencyKey: string | null; requestHash: string | null;
  issuedAt: Date | null; statusChangedAt: Date | null; voidedAt: Date | null; voidReason: string | null; version: number;
  createdById: string | null; updatedById: string | null; issuedById: string | null; statusChangedById: string | null; voidedById: string | null;
  createdAt: Date; updatedAt: Date;
};
const select = {
  id: true, kind: true, status: true, number: true, customerId: true, contactId: true, opportunityId: true, projectId: true, sourceQuoteId: true,
  creditedInvoiceId: true, currencyCode: true, currencyScale: true, taxMode: true, issueDate: true, dueDate: true, validUntil: true, subtotal: true,
  taxTotal: true, total: true, allocatedTotal: true, creditAppliedTotal: true, notes: true, sellerSnapshot: true, billToSnapshot: true, contentSha256: true,
  idempotencyKey: true, requestHash: true, issuedAt: true, statusChangedAt: true, voidedAt: true, voidReason: true, version: true,
  createdById: true, updatedById: true, issuedById: true, statusChangedById: true, voidedById: true, createdAt: true, updatedAt: true,
} as const;

export type LineRow = {
  id: string; position: number; description: string; quantity: Decimal; unitPrice: Decimal; discountAmount: Decimal; taxRateId: string | null;
  taxName: string | null; taxRatePercent: Decimal; lineNet: Decimal; lineTax: Decimal;
};
const lineSelect = {
  id: true, position: true, description: true, quantity: true, unitPrice: true, discountAmount: true, taxRateId: true, taxName: true,
  taxRatePercent: true, lineNet: true, lineTax: true,
} as const;

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Derived settlement of an ISSUED invoice (docs/finance-data-model.md §4.2, F2): payments and applied
 * credit together against the total. Never stored. Null for every other document.
 */
export function settlementStateOf(r: { kind: Kind; status: Status; total: Decimal; allocatedTotal: Decimal; creditAppliedTotal: Decimal }) {
  if (r.kind !== 'INVOICE' || r.status !== 'ISSUED') return null;
  const settled = r.allocatedTotal.add(r.creditAppliedTotal);
  if (settled.isZero()) return 'UNPAID' as const;
  return settled.gte(r.total) ? ('PAID' as const) : ('PARTIALLY_PAID' as const);
}

function headerDto(r: Row): ListItemDto {
  const s = r.currencyScale;
  return {
    id: r.id, kind: r.kind, status: r.status, number: r.number, customerId: r.customerId, contactId: r.contactId, opportunityId: r.opportunityId,
    projectId: r.projectId, sourceQuoteId: r.sourceQuoteId, creditedInvoiceId: r.creditedInvoiceId, currencyCode: r.currencyCode,
    currencyScale: s, taxMode: r.taxMode, issueDate: dayOf(r.issueDate), dueDate: dayOf(r.dueDate), validUntil: dayOf(r.validUntil),
    subtotal: formatAmount(r.subtotal, s), taxTotal: formatAmount(r.taxTotal, s), total: formatAmount(r.total, s),
    allocatedTotal: formatAmount(r.allocatedTotal, s), creditAppliedTotal: formatAmount(r.creditAppliedTotal, s), settlementState: settlementStateOf(r),
    notes: r.notes,
    sellerSnapshot: (r.sellerSnapshot ?? null) as ListItemDto['sellerSnapshot'], billToSnapshot: (r.billToSnapshot ?? null) as ListItemDto['billToSnapshot'],
    contentSha256: r.contentSha256, issuedAt: iso(r.issuedAt), statusChangedAt: iso(r.statusChangedAt), voidedAt: iso(r.voidedAt),
    voidReason: r.voidReason, version: r.version, createdById: r.createdById, updatedById: r.updatedById, issuedById: r.issuedById,
    statusChangedById: r.statusChangedById, voidedById: r.voidedById, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

const lineDto = (l: LineRow, scale: number) => ({
  id: l.id, position: l.position, description: l.description, quantity: formatPlain(l.quantity), unitPrice: formatPlain(l.unitPrice),
  discountAmount: formatAmount(l.discountAmount, scale), taxRateId: l.taxRateId, taxName: l.taxName, taxRatePercent: formatPlain(l.taxRatePercent),
  lineNet: formatAmount(l.lineNet, scale), lineTax: formatAmount(l.lineTax, scale),
});

export async function linesOf(db: AppTenantDb, documentId: string): Promise<LineRow[]> {
  return (await db.financeDocumentLine.findMany({ where: { documentId }, select: lineSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] })) as LineRow[];
}

async function dto(db: AppTenantDb, row: Row): Promise<DocumentDto> {
  const lines = await linesOf(db, row.id);
  return { ...headerDto(row), lines: lines.map((l) => lineDto(l, row.currencyScale)) };
}

/** A document of this kind in this business. Another kind, or another business's id, is 404 (never 403). */
export async function load(db: AppTenantDb, kind: Kind, id: string): Promise<Row> {
  const row = (await db.financeDocument.findFirst({ where: { id, kind }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** Locks the document (lock order: the document first), then reads it. */
async function lockAndLoad(db: AppTenantDb, kind: Kind, id: string): Promise<Row> {
  await lockDocuments(db, [id]);
  return load(db, kind, id);
}

export async function getDocument(db: AppTenantDb, kind: Kind, id: string) {
  return dto(db, await load(db, kind, id));
}

// ---- validation ----------------------------------------------------------------------------------

/** FD-T1: tax-exclusive prices only. Any other mode is refused explicitly, never computed as exclusive. */
function checkTaxMode(mode: string | undefined) {
  if (mode !== undefined && mode !== 'EXCLUSIVE') {
    throw new RuleViolationError('unsupported_tax_mode', 'Only tax-exclusive prices (EXCLUSIVE) are supported.');
  }
}

export async function checkCustomer(db: AppTenantDb, customerId: string) {
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
  if (!customer) throw new RuleViolationError('invalid_customer', 'Choose a customer of this business.');
  if (customer.archivedAt) throw new StateConflictError('archived_reference');
}

/**
 * Links (docs/finance-data-model.md §2.1, §8). The composite FKs guarantee each link is in this
 * business; these checks give clear errors and the service rules the FKs cannot express: a newly
 * linked record must be active, the contact must be one of the customer's, the opportunity for it.
 */
export async function checkLinks(
  db: AppTenantDb,
  next: { customerId: string; contactId: string | null; opportunityId: string | null; projectId: string | null },
  changed: { customer: boolean; contact: boolean; opportunity: boolean; project: boolean },
) {
  if (changed.customer) await checkCustomer(db, next.customerId);
  if (next.contactId && (changed.contact || changed.customer)) {
    const contact = await db.contact.findFirst({ where: { id: next.contactId }, select: { customerId: true, archivedAt: true } });
    if (!contact) throw new RuleViolationError('invalid_contact', 'Choose a contact of this business.');
    if (changed.contact && contact.archivedAt) throw new StateConflictError('archived_reference');
    if (contact.customerId !== next.customerId) {
      throw new RuleViolationError('contact_customer_mismatch', 'This contact belongs to a different customer. Choose one of this customer\'s contacts or clear the contact.');
    }
  }
  if (next.opportunityId && (changed.opportunity || changed.customer)) {
    const opp = await db.opportunity.findFirst({ where: { id: next.opportunityId }, select: { customerId: true, archivedAt: true } });
    if (!opp) throw new RuleViolationError('invalid_opportunity', 'Choose an opportunity of this business.');
    if (changed.opportunity && opp.archivedAt) throw new StateConflictError('archived_reference');
    if (opp.customerId !== null && opp.customerId !== next.customerId) {
      throw new RuleViolationError('opportunity_customer_mismatch', 'This opportunity is for a different customer.');
    }
  }
  if (next.projectId && (changed.project || changed.customer)) {
    const project = await db.project.findFirst({ where: { id: next.projectId }, select: { archivedAt: true, customerId: true } });
    if (!project) throw new RuleViolationError('invalid_project', 'Choose a project of this business.');
    if (changed.project && project.archivedAt) throw new StateConflictError('archived_reference');
    checkProjectCustomer(project.customerId, next.customerId);
  }
}

/**
 * W1 invariant I1 (docs/cross-zone-workflows-wf1.md §5.3, W1-D6): a record with a customer links only a
 * project of the same customer. A customerless project cannot carry a document, which always has a
 * customer. The composite FK (business_id, project_id, customer_id) holds the same rule in the database;
 * this gives the clear error first. Checked whenever the project or the customer changes.
 */
export function checkProjectCustomer(projectCustomerId: string | null, recordCustomerId: string | null) {
  if (recordCustomerId !== null && projectCustomerId !== recordCustomerId) {
    throw new RuleViolationError('project_customer_mismatch', 'This project is for a different customer. Choose one of this customer\'s projects or clear the project.');
  }
}

/**
 * D-WF1-11 (docs/cross-zone-workflows-wf1.md §6.1, §7): naming an opportunity or a project on a Finance
 * record also needs that Zone's read key, so finance access alone never reaches into Sales or Projects.
 * Default roles with finance:write already hold both; this is defence in depth for custom roles. Applies
 * when the request carries the field at all (setting or clearing it).
 */
export function authorizeFinanceLinks(principal: Principal, input: { opportunityId?: string | null; projectId?: string | null }) {
  if (input.opportunityId !== undefined) authorize(principal, 'sales:read');
  if (input.projectId !== undefined) authorize(principal, 'projects:read');
}

export type LineInput = { description: string; quantity: string; unitPrice: string; discountAmount?: string; taxRateId?: string | null };

/**
 * Validates and prices a complete line list for a draft (FD-T1, FD-T2). Tax comes only from a tax
 * rate of this business; a newly used rate must be active, while a rate the draft already used stays
 * usable after it is archived. Amounts are computed with exact decimals; the database recomputes them.
 */
export async function priceLines(db: AppTenantDb, lines: LineInput[], currency: string, scale: number, alreadyUsed: Set<string>) {
  const rateIds = [...new Set(lines.map((l) => l.taxRateId).filter((v): v is string => !!v))];
  const rates = rateIds.length
    ? await db.financeTaxRate.findMany({ where: { id: { in: rateIds } }, select: { id: true, ratePercent: true, archivedAt: true } })
    : [];
  const byId = new Map(rates.map((r) => [r.id, r]));
  for (const id of rateIds) {
    const rate = byId.get(id);
    if (!rate) throw new RuleViolationError('invalid_tax_rate', 'Choose a tax rate of this business.');
    if (rate.archivedAt && !alreadyUsed.has(id)) throw new StateConflictError('archived_reference');
  }
  return lines.map((l, i) => {
    const quantity = new Decimal(l.quantity);
    if (quantity.lte(0)) throw new RuleViolationError('invalid_amount', 'A quantity must be greater than zero.');
    const unitPrice = new Decimal(l.unitPrice);
    const discount = toAmount(l.discountAmount ?? '0', scale, currency, 'discount');
    const percent = l.taxRateId ? (byId.get(l.taxRateId)!.ratePercent as Decimal) : new Decimal(0);
    const amounts = lineAmounts(quantity, unitPrice, discount, percent, scale);
    return {
      position: (i + 1) * 1000, description: l.description, quantity, unitPrice, discountAmount: discount, taxRateId: l.taxRateId ?? null,
      amounts,
    };
  });
}

type Priced = Awaited<ReturnType<typeof priceLines>>;

/** Replaces all lines of a locked draft (delete, then insert in the order given). Lock order: document, then lines. */
async function replaceLines(db: AppTenantDb, documentId: string, priced: Priced) {
  await db.financeDocumentLine.deleteMany({ where: { documentId } });
  if (priced.length === 0) return;
  await db.financeDocumentLine.createMany({
    data: priced.map((l) => ({
      id: randomUUID(), documentId, position: l.position, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
      discountAmount: l.discountAmount, taxRateId: l.taxRateId, lineNet: l.amounts.net, lineTax: l.amounts.tax,
    })) as never,
  });
}

/** Credit notes credit what an invoice billed; they never start lines from the catalog (D-F7B-5). */
function noCatalogLines(lines: DraftLineInput[]) {
  if (lines.some((l) => l.catalogItemId !== undefined)) {
    throw new RuleViolationError('invalid_input', 'A credit note line cannot be added from the catalog.');
  }
}

export function totalsOf(priced: { amounts: LineAmounts }[]) {
  return documentTotals(priced.map((p) => p.amounts));
}

// ---- create --------------------------------------------------------------------------------------

type DraftCommon = { contactId?: string | null; opportunityId?: string | null; projectId?: string | null; notes?: string | null; taxMode?: string; lines?: DraftLineInput[] };
export type QuoteInput = DraftCommon & { customerId: string; currencyCode?: string; validUntil?: string | null };
export type InvoiceInput = DraftCommon & { customerId: string; currencyCode?: string; dueDate?: string | null };

type NewDraft = {
  kind: Kind; customerId: string; contactId: string | null; opportunityId: string | null; projectId: string | null; currencyCode: string;
  dueDate: string | null; validUntil: string | null; notes: string | null; lines: DraftLineInput[]; sourceQuoteId?: string; creditedInvoiceId?: string;
  alreadyUsedRates?: Set<string>;
};

/**
 * Idempotent creates: with an Idempotency-Key, a repeat of the same request returns the draft the
 * first one created (200); the same key with a different request is 409 idempotency_conflict. A
 * transaction-scoped advisory lock on the key serialises racing duplicates, so exactly one inserts.
 */
async function replay(db: AppTenantDb, key: string | null, hash: string): Promise<{ status: 200; document: DocumentDto } | null> {
  if (!key) return null;
  await lockIdempotencyKey(db, key);
  const existing = (await db.financeDocument.findFirst({ where: { idempotencyKey: key }, select })) as Row | null;
  if (!existing) return null;
  if (existing.requestHash !== hash) throw new StateConflictError('idempotency_conflict');
  return { status: 200, document: await dto(db, existing) };
}

/**
 * The author of a draft: a signed-in member, or (F6, D-F6-2) the billing worker, which has no session
 * user. A system-created draft has no created_by_id and its audit entry is a finance.system.* event
 * that names the recurring schedule and period it came from.
 */
export type DraftAuthor = { userId: string } | { system: 'recurring'; templateId: string; periodIndex: number };

async function insertDraft(db: AppTenantDb, author: string | DraftAuthor, d: NewDraft, idem: { key: string | null; hash: string }) {
  const who: DraftAuthor = typeof author === 'string' ? { userId: author } : author;
  const actorUserId = 'userId' in who ? who.userId : null;
  const currency = checkCurrency(d.currencyCode);
  const scale = currencyScale(currency);
  // F7-B: lines that name a catalog item become ordinary lines first (the item id is not stored).
  // Quotes and invoices only (D-F7B-5); the credit note contract has no catalogItemId either.
  if (d.kind === 'CREDIT_NOTE') noCatalogLines(d.lines);
  const { lines, catalogLines } = await resolveCatalogLines(db, d.lines, currency);
  const priced = await priceLines(db, lines, currency, scale, d.alreadyUsedRates ?? new Set());
  const totals = totalsOf(priced);
  if (d.dueDate && d.kind !== 'INVOICE') throw new RuleViolationError('invalid_dates', 'Only invoices have a due date.');
  const id = randomUUID();
  await db.financeDocument.create({
    data: {
      id, kind: d.kind, customerId: d.customerId, contactId: d.contactId, opportunityId: d.opportunityId, projectId: d.projectId,
      sourceQuoteId: d.sourceQuoteId ?? null, creditedInvoiceId: d.creditedInvoiceId ?? null, currencyCode: currency, currencyScale: scale,
      taxMode: 'EXCLUSIVE', dueDate: d.dueDate ? dateOf(d.dueDate) : null, validUntil: d.validUntil ? dateOf(d.validUntil) : null, notes: d.notes,
      subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total, idempotencyKey: idem.key, requestHash: idem.key ? idem.hash : null,
      createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  await replaceLines(db, id, priced);
  const row = await load(db, d.kind, id);
  // Structured facts only: never notes, descriptions or addresses.
  const facts = {
    kind: d.kind, currencyCode: currency, customerId: d.customerId, projectId: d.projectId, sourceQuoteId: d.sourceQuoteId ?? null,
    creditedInvoiceId: d.creditedInvoiceId ?? null, lineCount: String(priced.length), total: formatAmount(totals.total, scale),
    ...(catalogLines > 0 ? { catalogLineCount: String(catalogLines) } : {}),
  };
  if ('system' in who) {
    await recordSystemAudit(db, 'finance.system.document.created', { type: 'finance_document', id }, {
      ...facts, recurringTemplateId: who.templateId, periodIndex: String(who.periodIndex),
    });
  } else {
    await recordAudit(db, who.userId, 'finance.document.created', { type: 'finance_document', id }, facts);
  }
  return { status: 201 as const, document: await dto(db, row) };
}

export async function createQuote(db: AppTenantDb, actorUserId: string, input: QuoteInput, key: string | null) {
  const hash = requestHash('quote.create', input);
  const repeated = await replay(db, key, hash);
  if (repeated) return repeated;
  checkTaxMode(input.taxMode);
  const next = { customerId: input.customerId, contactId: input.contactId ?? null, opportunityId: input.opportunityId ?? null, projectId: input.projectId ?? null };
  await checkLinks(db, next, { customer: true, contact: true, opportunity: true, project: true });
  const business = await businessProfile(db);
  return insertDraft(db, actorUserId, {
    kind: 'QUOTE', ...next, currencyCode: input.currencyCode ?? business.currency, dueDate: null, validUntil: input.validUntil ?? null,
    notes: input.notes ?? null, lines: input.lines ?? [],
  }, { key, hash });
}

export async function createInvoice(db: AppTenantDb, actorUserId: string | DraftAuthor, input: InvoiceInput, key: string | null) {
  const hash = requestHash('invoice.create', input);
  const repeated = await replay(db, key, hash);
  if (repeated) return repeated;
  checkTaxMode(input.taxMode);
  const next = { customerId: input.customerId, contactId: input.contactId ?? null, opportunityId: input.opportunityId ?? null, projectId: input.projectId ?? null };
  await checkLinks(db, next, { customer: true, contact: true, opportunity: true, project: true });
  const business = await businessProfile(db);
  return insertDraft(db, actorUserId, {
    kind: 'INVOICE', ...next, currencyCode: input.currencyCode ?? business.currency, dueDate: input.dueDate ?? null, validUntil: null,
    notes: input.notes ?? null, lines: input.lines ?? [],
  }, { key, hash });
}

const linesAsInput = (lines: LineRow[], scale: number): LineInput[] =>
  lines.map((l) => ({
    description: l.description, quantity: formatPlain(l.quantity), unitPrice: formatPlain(l.unitPrice),
    discountAmount: formatAmount(l.discountAmount, scale), taxRateId: l.taxRateId,
  }));

/**
 * Quote → draft invoice: copies the customer, links, currency, notes and lines, and records the
 * source quote. It never issues the invoice and never changes the quote. Eligible quotes are ISSUED
 * or ACCEPTED (FD-P3 is open: this is the recommended provisional rule; there is no limit on how much
 * of a quote may be invoiced). The quote's tax rates stay usable even if archived since.
 */
export async function convertQuote(db: AppTenantDb, actorUserId: string, quoteId: string, input: { dueDate?: string | null; notes?: string | null }, key: string | null) {
  const hash = requestHash(`quote.convert:${quoteId}`, input);
  const repeated = await replay(db, key, hash);
  if (repeated) return repeated;
  const quote = await load(db, 'QUOTE', quoteId);
  if (quote.status !== 'ISSUED' && quote.status !== 'ACCEPTED') throw new StateConflictError('quote_not_convertible');
  const lines = await linesOf(db, quoteId);
  // D-WF1-10 (docs/cross-zone-workflows-wf1.md §6.5): a quote associated with a project after issue
  // (projects.source_quote_id, its own project_id frozen and NULL) puts that project on the draft. Same
  // customer by construction (the source-quote FK includes it). Read without a lock (§6.10 P8): a link
  // committed after this read leaves the draft without a project, which the person can set on the draft.
  const projectId = quote.projectId
    ?? (await db.project.findFirst({ where: { sourceQuoteId: quoteId }, select: { id: true } }))?.id
    ?? null;
  // The quote's customer may have been archived since; converting an issued quote is still allowed.
  return insertDraft(db, actorUserId, {
    kind: 'INVOICE', customerId: quote.customerId, contactId: quote.contactId, opportunityId: quote.opportunityId, projectId,
    currencyCode: quote.currencyCode, dueDate: input.dueDate ?? null, validUntil: null, notes: input.notes !== undefined ? input.notes : quote.notes,
    lines: linesAsInput(lines, quote.currencyScale), sourceQuoteId: quoteId,
    alreadyUsedRates: new Set(lines.map((l) => l.taxRateId).filter((v): v is string => !!v)),
  }, { key, hash });
}

/**
 * A draft credit note for an issued invoice: same customer and currency (the composite FK enforces
 * both). It does not settle the invoice: applying credit to an invoice's balance is F2 (FD-A2).
 */
export async function createCreditNote(
  db: AppTenantDb, actorUserId: string, invoiceId: string,
  input: { notes?: string | null; lines?: LineInput[]; copyInvoiceLines?: boolean }, key: string | null,
) {
  const hash = requestHash(`invoice.credit:${invoiceId}`, input);
  const repeated = await replay(db, key, hash);
  if (repeated) return repeated;
  const invoice = await load(db, 'INVOICE', invoiceId);
  if (invoice.status !== 'ISSUED') throw new StateConflictError('invoice_not_open');
  const invoiceLines = input.lines === undefined && input.copyInvoiceLines ? await linesOf(db, invoiceId) : [];
  return insertDraft(db, actorUserId, {
    kind: 'CREDIT_NOTE', customerId: invoice.customerId, contactId: invoice.contactId, opportunityId: invoice.opportunityId, projectId: invoice.projectId,
    currencyCode: invoice.currencyCode, dueDate: null, validUntil: null, notes: input.notes ?? null,
    lines: input.lines ?? linesAsInput(invoiceLines, invoice.currencyScale), creditedInvoiceId: invoiceId,
    alreadyUsedRates: new Set(invoiceLines.map((l) => l.taxRateId).filter((v): v is string => !!v)),
  }, { key, hash });
}

// ---- list ----------------------------------------------------------------------------------------

export type ListQuery = {
  status: 'draft' | 'issued' | 'accepted' | 'declined' | 'expired' | 'void' | 'all'; customerId?: string; projectId?: string;
  /** WF-1 §6.6: documents linked to this opportunity (the route also requires sales:read). */
  opportunityId?: string;
  from?: string; to?: string; cursor?: string; limit: number; overdue?: 'true' | 'false'; invoiceId?: string;
  settlement?: 'unpaid' | 'partially_paid' | 'paid' | 'open';
  /** Invoices only. Omitted means created_desc. */
  sort?: 'created_desc' | 'due_asc';
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Keyset-paginated. Default: newest first on (created_at desc, id desc). Invoices with sort=due_asc:
 * oldest due date first, undated last, ties by id, on (due_date asc nulls last, id asc). Each order has
 * its own cursor list, so a cursor from one order is refused by the other.
 */
export async function listDocuments(db: AppTenantDb, kind: Kind, query: ListQuery) {
  const where: Record<string, unknown>[] = [{ kind }];
  if (query.status !== 'all') where.push({ status: query.status.toUpperCase() });
  if (query.customerId) where.push({ customerId: query.customerId });
  if (query.projectId) where.push({ projectId: query.projectId });
  if (query.opportunityId) where.push({ opportunityId: query.opportunityId });
  if (query.invoiceId) where.push({ creditedInvoiceId: query.invoiceId });
  if (query.from) where.push({ issueDate: { gte: dateOf(query.from) } });
  if (query.to) where.push({ issueDate: { lt: dateOf(query.to) } });
  if (kind === 'INVOICE' && (query.overdue === 'true' || query.settlement)) {
    // Derived, never stored (§4.2, F2): settlement compares payments plus applied credit with the total,
    // which Prisma cannot express, so the matching ids come from one SQL predicate (issued invoices only).
    const today = query.overdue === 'true' ? todayIn((await businessProfile(db)).timeZone) : null;
    const settlement = query.overdue === 'true' && !query.settlement ? 'open' : query.settlement!;
    const ids = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM finance_documents
      WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid AND kind = 'INVOICE' AND status = 'ISSUED'
        AND CASE ${settlement}::text
              WHEN 'unpaid' THEN allocated_total + credit_applied_total = 0
              WHEN 'partially_paid' THEN allocated_total + credit_applied_total > 0 AND allocated_total + credit_applied_total < total
              WHEN 'paid' THEN allocated_total + credit_applied_total = total
              ELSE allocated_total + credit_applied_total < total END
        AND (${today}::date IS NULL OR due_date < ${today}::date)`;
    where.push({ id: { in: ids.map((r) => r.id) } });
  }
  let orderBy: Record<string, unknown>[];
  let cursorOf: (r: Row) => Record<string, string>;
  let list: string;
  if (kind === 'INVOICE' && query.sort === 'due_asc') {
    list = `finance:${kind}:due_asc`;
    const after = decodeCursor(query.cursor, list, ['d', 'i'] as const);
    if (after) {
      if (!UUID.test(after.i) || (after.d !== 'none' && !DAY.test(after.d))) invalidCursor();
      if (after.d === 'none') where.push({ dueDate: null, id: { gt: after.i } });
      else {
        // Strict calendar round-trip: Date normalises regex-shaped impossible days (2026-02-31 becomes 3 March).
        const d = dateOf(after.d);
        if (Number.isNaN(d.getTime()) || dayOf(d) !== after.d) invalidCursor();
        where.push({ OR: [{ dueDate: { gt: d } }, { dueDate: d, id: { gt: after.i } }, { dueDate: null }] });
      }
    }
    orderBy = [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
    cursorOf = (r) => ({ d: dayOf(r.dueDate) ?? 'none', i: r.id });
  } else {
    // The default list keeps its original cursor list name, so cursors issued before sort existed still work.
    list = `finance:${kind}`;
    const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
    if (after) {
      const t = new Date(after.t);
      if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
      where.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
    }
    orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    cursorOf = (r) => ({ t: r.createdAt.toISOString(), i: r.id });
  }
  const rows = (await db.financeDocument.findMany({ where: { AND: where }, select, orderBy, take: query.limit + 1 })) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    documents: page.map(headerDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, cursorOf(last)) : null,
  };
}

// ---- edit drafts ---------------------------------------------------------------------------------

export type DraftPatch = DraftCommon & { customerId?: string; dueDate?: string | null; validUntil?: string | null; version: number };

/**
 * Edits a draft's header and, when `lines` is given, replaces its whole line list (add, replace,
 * reorder and remove in one change). Optimistic concurrency on `version`; the document is locked
 * first, so an edit racing an issue either commits before it (and is sealed into it) or sees the
 * issued document and is refused.
 */
export async function updateDraft(db: AppTenantDb, actorUserId: string, kind: Kind, id: string, patch: DraftPatch) {
  const before = await lockAndLoad(db, kind, id);
  if (before.status !== 'DRAFT') throw new StateConflictError('immutable');
  if (before.version !== patch.version) throw new StateConflictError('stale');
  checkTaxMode(patch.taxMode);
  if (patch.customerId !== undefined && kind === 'CREDIT_NOTE') throw new RuleViolationError('invalid_input', 'A credit note is for its invoice\'s customer.');
  // A converted invoice stays with its source quote's customer (and currency, which never changes); the
  // composite FK on (source_quote_id, currency_code, customer_id) enforces the same in the database.
  // To bill someone else, create a new invoice instead of re-pointing the conversion.
  if (patch.customerId !== undefined && patch.customerId !== before.customerId && before.sourceQuoteId) {
    throw new RuleViolationError('source_quote_customer', 'An invoice converted from a quote stays with the quote\'s customer. Create a new invoice to bill another customer.');
  }

  const data: Record<string, unknown> = {};
  if (patch.notes !== undefined) data.notes = patch.notes;
  if (patch.dueDate !== undefined) data.dueDate = patch.dueDate ? dateOf(patch.dueDate) : null;
  if (patch.validUntil !== undefined) data.validUntil = patch.validUntil ? dateOf(patch.validUntil) : null;
  const next = {
    customerId: patch.customerId ?? before.customerId,
    contactId: patch.contactId !== undefined ? patch.contactId : before.contactId,
    opportunityId: patch.opportunityId !== undefined ? patch.opportunityId : before.opportunityId,
    projectId: patch.projectId !== undefined ? patch.projectId : before.projectId,
  };
  const changed = {
    customer: next.customerId !== before.customerId, contact: next.contactId !== before.contactId,
    opportunity: next.opportunityId !== before.opportunityId, project: next.projectId !== before.projectId,
  };
  await checkLinks(db, next, changed);
  if (changed.customer) data.customerId = next.customerId;
  if (changed.contact) data.contactId = next.contactId;
  if (changed.opportunity) data.opportunityId = next.opportunityId;
  if (changed.project) data.projectId = next.projectId;

  let fields = changedFields(before as unknown as Record<string, unknown>, data);
  let catalogLines = 0;
  if (patch.lines !== undefined) {
    const used = new Set((await linesOf(db, id)).map((l) => l.taxRateId).filter((v): v is string => !!v));
    // F7-B: after the document lock (lock order: document, then catalog items).
    if (kind === 'CREDIT_NOTE') noCatalogLines(patch.lines);
    const resolved = await resolveCatalogLines(db, patch.lines, before.currencyCode);
    catalogLines = resolved.catalogLines;
    const priced = await priceLines(db, resolved.lines, before.currencyCode, before.currencyScale, used);
    const totals = totalsOf(priced);
    await replaceLines(db, id, priced);
    Object.assign(data, { subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total });
    fields = [...new Set([...fields, 'lines'])].sort();
  }
  if (fields.length === 0) return dto(db, before);
  const result = await db.financeDocument.updateMany({
    where: { id, kind, status: 'DRAFT', version: patch.version },
    data: { ...data, ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale'); // unreachable while the row is locked
  await recordAudit(db, actorUserId, 'finance.document.updated', { type: 'finance_document', id }, {
    kind, fields, ...(catalogLines > 0 ? { catalogLineCount: String(catalogLines) } : {}),
  });
  return dto(db, await load(db, kind, id));
}

// ---- issue ---------------------------------------------------------------------------------------

export async function billToSnapshot(db: AppTenantDb, customerId: string, contactId: string | null) {
  const c = await db.customer.findFirstOrThrow({
    where: { id: customerId },
    select: {
      displayName: true, legalName: true, email: true, phone: true, addressLine1: true, addressLine2: true, city: true, region: true,
      postalCode: true, countryCode: true, taxNumber: true, taxNumberType: true,
    },
  });
  const contact = contactId ? await db.contact.findFirst({ where: { id: contactId }, select: { displayName: true, email: true } }) : null;
  return {
    customerId, name: c.legalName ?? c.displayName, legalName: c.legalName, email: c.email, phone: c.phone, addressLine1: c.addressLine1,
    addressLine2: c.addressLine2, city: c.city, region: c.region, postalCode: c.postalCode, countryCode: c.countryCode, taxNumber: c.taxNumber,
    taxNumberType: c.taxNumberType, contact: contact && contactId ? { contactId, name: contact.displayName, email: contact.email } : null,
  };
}

export type IssueInput = { version: number; issueDate?: string; dueDate?: string; validUntil?: string };

/**
 * DRAFT → ISSUED in one conditional UPDATE after locking the draft. The service prices the lines again
 * and writes the snapshots and dates; the database checks the arithmetic, takes the next number of
 * the series in this transaction (gapless, FD-L1), stamps issued_at and computes the content hash. A
 * failure anywhere rolls back the whole unit of work, number included.
 */
export async function issueDocument(db: AppTenantDb, actorUserId: string, kind: Kind, id: string, input: IssueInput) {
  await ensureSeries(db, kind); // before the document lock: the series row stays last in the lock order
  const before = await lockAndLoad(db, kind, id);
  if (before.status !== 'DRAFT') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  checkTaxMode(before.taxMode);

  const lines = await linesOf(db, id);
  if (lines.length === 0) throw new RuleViolationError('no_lines', 'Add at least one line before issuing.');
  const totals = documentTotals(lines.map((l) => lineAmounts(l.quantity, l.unitPrice, l.discountAmount, l.taxRatePercent, before.currencyScale)));

  const [business, settings] = await Promise.all([businessProfile(db), loadSettings(db)]);
  const issueDate = input.issueDate ?? todayIn(business.timeZone);
  let dueDate: string | null = null;
  let validUntil: string | null = null;
  if (kind === 'INVOICE') {
    dueDate = input.dueDate ?? dayOf(before.dueDate) ?? (settings.defaultPaymentTermsDays !== null ? addDays(issueDate, settings.defaultPaymentTermsDays) : null);
    if (!dueDate) throw new RuleViolationError('due_date_required', 'Set a due date, or default payment terms in the finance settings.');
    if (dueDate < issueDate) throw new RuleViolationError('invalid_dates', 'The due date cannot be before the issue date.');
  } else if (input.dueDate) {
    throw new RuleViolationError('invalid_dates', 'Only invoices have a due date.');
  }
  if (kind === 'QUOTE') {
    validUntil = input.validUntil ?? dayOf(before.validUntil) ?? (settings.defaultQuoteValidityDays !== null ? addDays(issueDate, settings.defaultQuoteValidityDays) : null);
    if (validUntil && validUntil < issueDate) throw new RuleViolationError('invalid_dates', 'A quote cannot expire before its issue date.');
  } else if (input.validUntil) {
    throw new RuleViolationError('invalid_dates', 'Only quotes have a validity date.');
  }

  if (kind === 'CREDIT_NOTE') {
    // Service check for a clear error; the issue guard repeats it under a lock on the invoice.
    const invoice = await load(db, 'INVOICE', before.creditedInvoiceId!);
    if (invoice.status !== 'ISSUED') throw new StateConflictError('invoice_not_open');
    const issued = await db.financeDocument.findMany({ where: { kind: 'CREDIT_NOTE', creditedInvoiceId: invoice.id, status: 'ISSUED' }, select: { total: true } });
    const credited = issued.reduce((s, c) => s.add(c.total as Decimal), new Decimal(0));
    if (credited.add(totals.total).gt(invoice.total)) throw new StateConflictError('credit_exceeds_invoice');
  }

  const [seller, billTo] = await Promise.all([sellerSnapshot(db), billToSnapshot(db, before.customerId, before.contactId)]);
  const result = await db.financeDocument.updateMany({
    where: { id, kind, status: 'DRAFT', version: input.version },
    data: {
      status: 'ISSUED', issueDate: dateOf(issueDate), dueDate: dueDate ? dateOf(dueDate) : null, validUntil: validUntil ? dateOf(validUntil) : null,
      sellerSnapshot: seller, billToSnapshot: billTo, subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total,
      issuedById: actorUserId, statusChangedById: actorUserId, updatedById: actorUserId, ...BUMP,
    } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale'); // unreachable while the row is locked
  const after = await load(db, kind, id);
  await recordAudit(db, actorUserId, 'finance.document.issued', { type: 'finance_document', id }, {
    kind, number: after.number, currencyCode: after.currencyCode, subtotal: formatAmount(after.subtotal, after.currencyScale),
    taxTotal: formatAmount(after.taxTotal, after.currencyScale), total: formatAmount(after.total, after.currencyScale),
    contentSha256: after.contentSha256, issueDate, creditedInvoiceId: after.creditedInvoiceId, sourceQuoteId: after.sourceQuoteId,
  });
  return dto(db, after);
}

// ---- transitions ---------------------------------------------------------------------------------

const ACTION: Record<'ACCEPTED' | 'DECLINED' | 'EXPIRED', string> = { ACCEPTED: 'accepted', DECLINED: 'declined', EXPIRED: 'expired' };

/** Accept, decline or expire an issued quote. Acceptance records a business decision; it is not a payment. */
export async function transitionQuote(db: AppTenantDb, actorUserId: string, id: string, to: 'ACCEPTED' | 'DECLINED' | 'EXPIRED', input: { version: number }) {
  const before = await lockAndLoad(db, 'QUOTE', id);
  if (before.status !== 'ISSUED') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const result = await db.financeDocument.updateMany({
    where: { id, kind: 'QUOTE', status: 'ISSUED', version: input.version },
    data: { status: to, statusChangedById: actorUserId, updatedById: actorUserId, ...BUMP } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, `finance.document.${ACTION[to]}`, { type: 'finance_document', id }, { kind: 'QUOTE', number: before.number, hasReason: 'false' });
  return dto(db, await load(db, 'QUOTE', id));
}

/**
 * Voids an issued document (FD-L2). It keeps its number, lines, snapshots and amounts; the number
 * stays in the sequence; the database stamps voided_at; VOID is final. An invoice can be voided only
 * while it has no payment allocations and no live (non-void) credit notes. Quotes may be voided when
 * issued or accepted. Jurisdiction-specific rules that require a credit note instead are not
 * implemented (a per-business setting can be added later).
 */
export async function voidDocument(db: AppTenantDb, actorUserId: string, kind: Kind, id: string, input: { version: number; reason: string }) {
  const before = await lockAndLoad(db, kind, id);
  const voidable = before.status === 'ISSUED' || (kind === 'QUOTE' && before.status === 'ACCEPTED');
  if (!voidable) throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  // F2: applied credit (on an invoice, or applied from a credit note) must be reversed first.
  if (!before.creditAppliedTotal.isZero()) throw new StateConflictError('has_credit_applications');
  if (kind === 'INVOICE') {
    if (!before.allocatedTotal.isZero()) throw new StateConflictError('invoice_has_payments');
    const live = await db.financeDocument.count({ where: { kind: 'CREDIT_NOTE', creditedInvoiceId: id, status: { not: 'VOID' } } });
    if (live > 0) throw new StateConflictError('invoice_credited');
  }
  const result = await db.financeDocument.updateMany({
    where: { id, kind, status: before.status, version: input.version },
    data: { status: 'VOID', voidReason: input.reason, voidedById: actorUserId, statusChangedById: actorUserId, updatedById: actorUserId, ...BUMP } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.document.voided', { type: 'finance_document', id }, { kind, number: before.number, fromStatus: before.status, hasReason: 'true' });
  return dto(db, await load(db, kind, id));
}

/** Discards a draft: VOID without ever being numbered (a draft is not yet a financial record). */
export async function discardDraft(db: AppTenantDb, actorUserId: string, kind: Kind, id: string, input: { version: number; reason?: string | null }) {
  const before = await lockAndLoad(db, kind, id);
  if (before.status !== 'DRAFT') throw new StateConflictError('invalid_state');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const result = await db.financeDocument.updateMany({
    where: { id, kind, status: 'DRAFT', version: input.version },
    data: { status: 'VOID', voidReason: input.reason ?? null, voidedById: actorUserId, statusChangedById: actorUserId, updatedById: actorUserId, ...BUMP } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'finance.document.discarded', { type: 'finance_document', id }, { kind, hasReason: input.reason ? 'true' : 'false' });
  return dto(db, await load(db, kind, id));
}
