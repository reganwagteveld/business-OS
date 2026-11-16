import {
  AllocateExpensePaymentRequest, AllocatePaymentRequest, ApplyCreditRequest, ConvertQuoteRequest, CreateCreditNoteRequest, CreateExpenseCategoryRequest,
  CreateExpenseRequest, CreateInvoiceRequest, CreateQuoteRequest, CreateTaxRateRequest, CreditNoteCreditResponse, DiscardDraftRequest, endpointPath, endpoints,
  ExpenseCategoryResponse, ExpensePayablesResponse, ExpensePaymentResponse, FinanceDocumentResponse, FinanceExpenseResponse, FinancePaymentResponse,
  FinanceSettingsResponse, InvoiceReceivablesResponse, InvoiceSettlementResponse, IssueDocumentRequest, ListCustomerBalancesResponse,
  ListExpenseCategoriesResponse, ListExpensePaymentsResponse, ListExpensesResponse, ListFinanceDocumentsResponse, ListNumberSeriesResponse,
  ListPaymentsResponse, ListTaxRatesResponse, NumberSeriesResponse, QuoteTransitionRequest, RecordExpensePaymentRequest, RecordExpenseRequest,
  RecordPaymentRequest, ReverseAllocationRequest, ReverseExpensePaymentRequest, ReversePaymentRequest, TaxRateResponse, UpdateCreditNoteRequest, UpdateExpenseCategoryRequest,
  UpdateExpenseRequest, UpdateFinanceSettingsRequest, UpdateInvoiceRequest, UpdateNumberSeriesRequest, UpdatePaymentRequest, UpdateQuoteRequest,
  UpdateTaxRateRequest, VoidDocumentRequest, VoidExpenseRequest,
  CreateDocumentPdfVersionRequest, DocumentBrandingResponse, DocumentPdfVersionResponse, ListDocumentPdfVersionsResponse, UpdateDocumentBrandingRequest,
  UploadBrandingLogoRequest, type DocumentBranding, type DocumentPdfVersion,
  CancelRecurringInvoiceRequest, CreateRecurringInvoiceRequest, GenerateRecurringInvoiceResponse, ListRecurringInvoicesResponse, ListRecurringRunsResponse,
  RecurringInvoiceResponse, RecurringPreviewResponse, RecurringRunActionRequest, RecurringRunResponse, RecurringTransitionRequest, UpdateRecurringInvoiceRequest,
  type RecurringInvoice, type RecurringRun,
  ReceivablesAgeingDetailResponse, ReceivablesAgeingResponse, StatementResponse,
  type ReceivablesAgeing, type ReceivablesAgeingDetail, type Statement,
  type CreditNoteCredit, type CustomerBalance, type ExpenseCategory, type ExpensePayment, type FinanceDocument, type FinanceDocumentKind,
  type FinanceDocumentListItem, type FinanceExpense, type FinanceExpenseListItem, type FinancePayment, type InvoiceReceivables, type InvoiceSettlement,
  CatalogItemLifecycleRequest, CatalogItemResponse, CreateCatalogItemRequest, ListCatalogItemsResponse, UpdateCatalogItemRequest, type CatalogItem,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawFileResult, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export interface ExpenseQuery {
  q?: string; status: 'draft' | 'recorded' | 'void' | 'all'; payment?: 'unpaid' | 'partially_paid' | 'paid' | 'open' | 'overdue';
  categoryId?: string; from?: string; to?: string; supplier?: string; cursor?: string; limit?: number;
}
export interface ExpensePage { expenses: FinanceExpenseListItem[]; nextCursor: string | null }
export type TaxRateOption = { id: string; name: string; ratePercent: string; archivedAt: string | null };
export type Payables = z.infer<typeof ExpensePayablesResponse>['payables'];
export type FinanceSettingsData = z.infer<typeof FinanceSettingsResponse>['settings'];
export type NumberSeriesData = z.infer<typeof NumberSeriesResponse>['series'];
export type TaxRateData = z.infer<typeof TaxRateResponse>['taxRate'];
export type PaymentListItem = z.infer<typeof ListPaymentsResponse>['payments'][number];
export type ExpensePaymentListItem = z.infer<typeof ListExpensePaymentsResponse>['payments'][number];
export type RecurringPreview = z.infer<typeof RecurringPreviewResponse>['preview'];
export interface RecurringQuery { status: 'active' | 'paused' | 'cancelled' | 'ended' | 'all'; customerId?: string; cursor?: string; limit?: number }
export interface RecurringPage { recurringInvoices: RecurringInvoice[]; nextCursor: string | null }
export interface RecurringRunPage { runs: RecurringRun[]; nextCursor: string | null }
export type { RecurringInvoice, RecurringRun };
export type { ReceivablesAgeing, ReceivablesAgeingDetail, Statement };
export interface StatementParams { customerId: string; currencyCode: string; from: string; to: string }
export interface AgeingParams { asOf?: string; currencyCode?: string; customerId?: string; cursor?: string; limit?: number }
export type { CreditNoteCredit, CustomerBalance, ExpensePayment, FinanceDocument, FinanceDocumentListItem, FinancePayment, InvoiceReceivables, InvoiceSettlement };

/** The three document registers, as they appear in the API's paths. */
export type DocumentPath = 'quotes' | 'invoices' | 'credit-notes';
export const KIND_PATH: Record<FinanceDocumentKind, DocumentPath> = { QUOTE: 'quotes', INVOICE: 'invoices', CREDIT_NOTE: 'credit-notes' };
export interface DocumentQuery {
  status: 'draft' | 'issued' | 'accepted' | 'declined' | 'expired' | 'void' | 'all';
  customerId?: string; from?: string; to?: string; cursor?: string; limit?: number;
  /** Invoices only. */
  overdue?: boolean; settlement?: 'unpaid' | 'partially_paid' | 'paid' | 'open';
  /** Credit notes only. */
  invoiceId?: string;
}
export interface DocumentPage { documents: FinanceDocumentListItem[]; nextCursor: string | null }
export interface PaymentQuery {
  status: 'recorded' | 'reversed' | 'all'; customerId?: string; currencyCode?: string; from?: string; to?: string; unallocated?: boolean; invoiceId?: string;
  cursor?: string; limit?: number;
}
export interface PaymentPage { payments: PaymentListItem[]; nextCursor: string | null }
export interface ExpensePaymentQuery { status: 'recorded' | 'reversed' | 'all'; currencyCode?: string; from?: string; to?: string; expenseId?: string; cursor?: string; limit?: number }
export interface ExpensePaymentPage { payments: ExpensePaymentListItem[]; nextCursor: string | null }
export interface BalancePage { balances: CustomerBalance[]; asOf: string; nextCursor: string | null }
type QuoteAction = 'accept' | 'decline' | 'expire';

// ---- F7-A: the products and services catalog (docs/finance-catalog-f7a.md) -------------------------
export type { CatalogItem };
export interface CatalogQuery {
  q?: string; code?: string; type?: 'PRODUCT' | 'SERVICE'; status: 'current' | 'active' | 'inactive' | 'archived' | 'all'; taxRateId?: string;
  currencyCode?: string; cursor?: string; limit?: number;
}
export interface CatalogPage { items: CatalogItem[]; nextCursor: string | null }

// ---- F5: generated documents (docs/finance-documents-f5.md) ----------------------------------------
export type { DocumentBranding, DocumentPdfVersion };
export interface PdfVersionList { eligible: boolean; versions: DocumentPdfVersion[] }
/** A fetched file. `blob` is the exact bytes the server sent; `sha256` is its checksum header. */
export interface FetchedFile {
  blob: Blob; contentType: string; sha256: string | null;
  /** Draft previews only: some text used characters the PDF fonts cannot show (printed as a box). */
  unsupportedCharacters?: boolean;
}
export type PdfMode = 'preview' | 'download';

/**
 * Finance Zone calls for expenses and categories (docs/finance-data-model.md §19). The business is only
 * the `:slug` in the path. Every body is checked against the shared contract before it is sent, and
 * every response is parsed with it. Amounts stay exact decimal strings end to end.
 */
export interface FinanceClient {
  expenses(slug: string, query: ExpenseQuery, signal?: AbortSignal): Promise<Outcome<ExpensePage>>;
  expense(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  createExpense(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  /** `patch` must include the `version` the edit was based on; a stale one comes back as conflict `stale`. */
  updateExpense(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  recordExpense(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  voidExpense(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  payables(slug: string, signal?: AbortSignal): Promise<Outcome<Payables>>;
  categories(slug: string, archived: 'active' | 'archived' | 'all', signal?: AbortSignal): Promise<Outcome<ExpenseCategory[]>>;
  createCategory(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ExpenseCategory>>;
  updateCategory(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<ExpenseCategory>>;
  taxRates(slug: string, signal?: AbortSignal): Promise<Outcome<TaxRateOption[]>>;

  // ---- F7-A: products and services catalog (finance:read to read, finance:catalog to change) -----
  catalogItems(slug: string, query: CatalogQuery, signal?: AbortSignal): Promise<Outcome<CatalogPage>>;
  catalogItem(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<CatalogItem>>;
  createCatalogItem(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<CatalogItem>>;
  /** `patch` must include the `version` the edit was based on; a stale one comes back as conflict `stale`. */
  updateCatalogItem(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<CatalogItem>>;
  archiveCatalogItem(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<CatalogItem>>;
  restoreCatalogItem(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<CatalogItem>>;

  // ---- F4: documents (F1), settlement (F2), settings, payments made (F3) --------------------------
  documents(slug: string, path: DocumentPath, query: DocumentQuery, signal?: AbortSignal): Promise<Outcome<DocumentPage>>;
  document(slug: string, path: DocumentPath, id: string, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  /**
   * Creates a draft quote or invoice. `key` is sent as the Idempotency-Key: repeating the same request
   * with the same key returns the first draft instead of creating a second one.
   */
  createDocument(slug: string, path: 'quotes' | 'invoices', input: unknown, key: string, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  createCreditNote(slug: string, invoiceId: string, input: unknown, key: string, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  updateDocument(slug: string, path: DocumentPath, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  issueDocument(slug: string, path: DocumentPath, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  voidDocument(slug: string, path: DocumentPath, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  discardDocument(slug: string, path: DocumentPath, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  quoteTransition(slug: string, id: string, action: QuoteAction, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  convertQuote(slug: string, id: string, input: unknown, key: string, signal?: AbortSignal): Promise<Outcome<FinanceDocument>>;
  settlement(slug: string, invoiceId: string, signal?: AbortSignal): Promise<Outcome<InvoiceSettlement>>;
  credit(slug: string, creditNoteId: string, signal?: AbortSignal): Promise<Outcome<CreditNoteCredit>>;
  applyCredit(slug: string, creditNoteId: string, input: unknown, signal?: AbortSignal): Promise<Outcome<CreditNoteCredit>>;
  reverseCreditApplication(slug: string, creditNoteId: string, applicationId: string, signal?: AbortSignal): Promise<Outcome<CreditNoteCredit>>;
  payments(slug: string, query: PaymentQuery, signal?: AbortSignal): Promise<Outcome<PaymentPage>>;
  payment(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<FinancePayment>>;
  /** Records a payment received. `key` is the required Idempotency-Key: reuse it to retry the same request safely. */
  recordPayment(slug: string, input: unknown, key: string, signal?: AbortSignal): Promise<Outcome<FinancePayment>>;
  updatePayment(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<FinancePayment>>;
  allocatePayment(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinancePayment>>;
  reverseAllocation(slug: string, id: string, allocationId: string, signal?: AbortSignal): Promise<Outcome<FinancePayment>>;
  reversePayment(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinancePayment>>;
  balances(slug: string, query: { customerId?: string; currencyCode?: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<Outcome<BalancePage>>;
  receivables(slug: string, signal?: AbortSignal): Promise<Outcome<InvoiceReceivables>>;
  // ---- F6-2: statements and receivables ageing as of a date (read-only) --------------------------
  statement(slug: string, params: StatementParams, signal?: AbortSignal): Promise<Outcome<Statement>>;
  /** The statement as a PDF: rendered on demand, never stored, audited (finance:documents_download). */
  statementPdf(slug: string, params: StatementParams, signal?: AbortSignal): Promise<Outcome<FetchedFile>>;
  ageing(slug: string, params: AgeingParams, signal?: AbortSignal): Promise<Outcome<ReceivablesAgeing>>;
  ageingDetail(slug: string, params: { asOf?: string; customerId: string; currencyCode: string }, signal?: AbortSignal): Promise<Outcome<ReceivablesAgeingDetail>>;
  settings(slug: string, signal?: AbortSignal): Promise<Outcome<FinanceSettingsData>>;
  updateSettings(slug: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<FinanceSettingsData>>;
  numberSeries(slug: string, signal?: AbortSignal): Promise<Outcome<NumberSeriesData[]>>;
  updateNumberSeries(slug: string, kind: FinanceDocumentKind, patch: unknown, signal?: AbortSignal): Promise<Outcome<NumberSeriesData>>;
  createTaxRate(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<TaxRateData>>;
  updateTaxRate(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<TaxRateData>>;
  expensePayments(slug: string, query: ExpensePaymentQuery, signal?: AbortSignal): Promise<Outcome<ExpensePaymentPage>>;
  expensePayment(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<ExpensePayment>>;
  /** Records a payment made to a supplier. `key` is the required Idempotency-Key. */
  recordExpensePayment(slug: string, input: unknown, key: string, signal?: AbortSignal): Promise<Outcome<ExpensePayment>>;
  allocateExpensePayment(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ExpensePayment>>;
  reverseExpenseAllocation(slug: string, id: string, allocationId: string, signal?: AbortSignal): Promise<Outcome<ExpensePayment>>;
  reverseExpensePayment(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ExpensePayment>>;

  // ---- F5: generated PDFs and document branding. Nothing here sends a document anywhere. -----------
  pdfVersions(slug: string, path: 'quotes' | 'invoices', id: string, signal?: AbortSignal): Promise<Outcome<PdfVersionList>>;
  /** Adds a later version with a reason. The original (version 1) is made when the document is issued. */
  createPdfVersion(slug: string, path: 'quotes' | 'invoices', id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<DocumentPdfVersion>>;
  /** The stored bytes of one version: `preview` for inline viewing, `download` for saving (audited). */
  pdfFile(slug: string, path: 'quotes' | 'invoices', id: string, versionId: string, mode: PdfMode, signal?: AbortSignal): Promise<Outcome<FetchedFile>>;
  /** A watermarked, never-stored preview of a draft. */
  draftPdf(slug: string, path: 'quotes' | 'invoices', id: string, signal?: AbortSignal): Promise<Outcome<FetchedFile>>;
  branding(slug: string, signal?: AbortSignal): Promise<Outcome<DocumentBranding>>;
  updateBranding(slug: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<DocumentBranding>>;
  uploadLogo(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<DocumentBranding>>;
  logo(slug: string, signal?: AbortSignal): Promise<Outcome<FetchedFile>>;
  // ---- F6-1: recurring invoices (drafts only; nothing is issued or sent) --------------------------
  recurringInvoices(slug: string, query: RecurringQuery, signal?: AbortSignal): Promise<Outcome<RecurringPage>>;
  recurringInvoice(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<RecurringInvoice>>;
  createRecurringInvoice(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<RecurringInvoice>>;
  /** `patch` must include the `version` the edit was based on. */
  updateRecurringInvoice(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<RecurringInvoice>>;
  recurringTransition(slug: string, id: string, action: 'pause' | 'resume' | 'cancel', input: unknown, signal?: AbortSignal): Promise<Outcome<RecurringInvoice>>;
  generateRecurringInvoice(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<{ run: RecurringRun; recurringInvoice: RecurringInvoice }>>;
  recurringPreview(slug: string, id: string, count: number, signal?: AbortSignal): Promise<Outcome<RecurringPreview>>;
  recurringRuns(slug: string, id: string, query: { status?: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<Outcome<RecurringRunPage>>;
  recurringRunAction(slug: string, id: string, runId: string, action: 'retry' | 'skip', signal?: AbortSignal): Promise<Outcome<RecurringRun>>;
}

/** The reversal endpoints take an empty, strict body (the same schema for all three). */
const z0 = ReverseAllocationRequest;
const CREATE: Record<'quotes' | 'invoices', z.ZodType> = { quotes: CreateQuoteRequest, invoices: CreateInvoiceRequest };
const UPDATE: Record<DocumentPath, z.ZodType> = { quotes: UpdateQuoteRequest, invoices: UpdateInvoiceRequest, 'credit-notes': UpdateCreditNoteRequest };

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
const invalid = (error: z.ZodError): Outcome<never> => ({ kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the highlighted fields.', fields: fieldErrors(error) });

export function createFinanceClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): FinanceClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? (body?.error === 'invalid_cursor' ? 'That page is no longer valid. Start again from the first page.' : 'Please check the details and try again.') };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);
  const qs = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') params.set(k, String(v));
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const send = async <S extends z.ZodType>(method: 'POST' | 'PATCH', path: string, schema: z.ZodType, input: unknown, response: S, signal?: AbortSignal, key?: string) => {
    const checked = schema.safeParse(input);
    if (!checked.success) return invalid(checked.error);
    return settle(await http.request(method, path, checked.data, signal, key ? { 'idempotency-key': key } : undefined), response, (d) => d);
  };
  const get = async <S extends z.ZodType, T>(path: string, schema: S, pick: (d: z.infer<S>) => T, signal?: AbortSignal) =>
    settle(await http.request('GET', path, undefined, signal), schema, pick);
  const file = (raw: RawFileResult, expected: readonly string[]): Outcome<FetchedFile> => {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.kind === 'response') {
      if (raw.status === 503) return { kind: 'failed', status: 503 };
      return classify(raw.status, raw.json) ?? { kind: 'invalid' };
    }
    if (!expected.includes(raw.contentType)) return { kind: 'invalid' };
    return { kind: 'ok', data: { blob: raw.blob, contentType: raw.contentType, sha256: raw.sha256, ...(raw.unsupportedCharacters === null ? {} : { unsupportedCharacters: raw.unsupportedCharacters }) } };
  };
  const pick = <T, K extends string>(out: Outcome<Record<K, T>>, k: K): Outcome<T> => (out.kind === 'ok' ? { kind: 'ok', data: out.data[k] } : out);
  const base = (slug: string) => `/api/v1/b/${encodeURIComponent(slug)}/finance`;
  const doc = (slug: string, path: DocumentPath, id: string, tail = '') => `${base(slug)}/${path}/${encodeURIComponent(id)}${tail}`;
  const bool = (v: boolean | undefined) => (v === undefined ? undefined : String(v));
  const exp = (template: string, slug: string, expenseId: string) => p(template, { slug, expenseId });
  const rec = (slug: string, id: string, tail = '') => `${base(slug)}/recurring-invoices/${encodeURIComponent(id)}${tail}`;

  return {
    async expenses(slug, query, signal) {
      const raw = await http.request('GET', p(endpoints.listExpenses.path, { slug }) + qs({
        q: query.q?.trim(), status: query.status, payment: query.payment, categoryId: query.categoryId, from: query.from, to: query.to,
        supplier: query.supplier?.trim(), cursor: query.cursor, limit: query.limit,
      }), undefined, signal);
      return settle(raw, ListExpensesResponse, (d) => d);
    },
    async expense(slug, id, signal) {
      return settle(await http.request('GET', exp(endpoints.getExpense.path, slug, id), undefined, signal), FinanceExpenseResponse, (d) => d.expense);
    },
    async createExpense(slug, input, signal) {
      const out = await send('POST', p(endpoints.createExpense.path, { slug }), CreateExpenseRequest, input, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async updateExpense(slug, id, patch, signal) {
      const out = await send('PATCH', exp(endpoints.updateExpense.path, slug, id), UpdateExpenseRequest, patch, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async recordExpense(slug, id, input, signal) {
      const out = await send('POST', exp(endpoints.recordExpense.path, slug, id), RecordExpenseRequest, input, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async voidExpense(slug, id, input, signal) {
      const out = await send('POST', exp(endpoints.voidExpense.path, slug, id), VoidExpenseRequest, input, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async payables(slug, signal) {
      return settle(await http.request('GET', p(endpoints.getExpensePayables.path, { slug }), undefined, signal), ExpensePayablesResponse, (d) => d.payables);
    },
    async categories(slug, archived, signal) {
      const raw = await http.request('GET', p(endpoints.listExpenseCategories.path, { slug }) + qs({ archived }), undefined, signal);
      return settle(raw, ListExpenseCategoriesResponse, (d) => d.categories);
    },
    async createCategory(slug, input, signal) {
      const out = await send('POST', p(endpoints.createExpenseCategory.path, { slug }), CreateExpenseCategoryRequest, input, ExpenseCategoryResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.category } : out;
    },
    async updateCategory(slug, id, patch, signal) {
      const out = await send('PATCH', p(endpoints.updateExpenseCategory.path, { slug, categoryId: id }), UpdateExpenseCategoryRequest, patch, ExpenseCategoryResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.category } : out;
    },
    async taxRates(slug, signal) {
      const raw = await http.request('GET', p(endpoints.listTaxRates.path, { slug }) + qs({ archived: 'all' }), undefined, signal);
      return settle(raw, ListTaxRatesResponse, (d) => d.taxRates);
    },

    async catalogItems(slug, query, signal) {
      return get(p(endpoints.listCatalogItems.path, { slug }) + qs({
        q: query.q?.trim(), code: query.code?.trim(), type: query.type, status: query.status, taxRateId: query.taxRateId, currencyCode: query.currencyCode,
        cursor: query.cursor, limit: query.limit,
      }), ListCatalogItemsResponse, (d) => d, signal);
    },
    async catalogItem(slug, id, signal) {
      return get(p(endpoints.getCatalogItem.path, { slug, itemId: id }), CatalogItemResponse, (d) => d.item, signal);
    },
    async createCatalogItem(slug, input, signal) {
      return pick(await send('POST', p(endpoints.createCatalogItem.path, { slug }), CreateCatalogItemRequest, input, CatalogItemResponse, signal), 'item');
    },
    async updateCatalogItem(slug, id, patch, signal) {
      return pick(await send('PATCH', p(endpoints.updateCatalogItem.path, { slug, itemId: id }), UpdateCatalogItemRequest, patch, CatalogItemResponse, signal), 'item');
    },
    async archiveCatalogItem(slug, id, version, signal) {
      return pick(await send('POST', p(endpoints.archiveCatalogItem.path, { slug, itemId: id }), CatalogItemLifecycleRequest, { version }, CatalogItemResponse, signal), 'item');
    },
    async restoreCatalogItem(slug, id, version, signal) {
      return pick(await send('POST', p(endpoints.restoreCatalogItem.path, { slug, itemId: id }), CatalogItemLifecycleRequest, { version }, CatalogItemResponse, signal), 'item');
    },

    async documents(slug, path, query, signal) {
      return get(`${base(slug)}/${path}` + qs({
        status: query.status, customerId: query.customerId, from: query.from, to: query.to, cursor: query.cursor, limit: query.limit,
        overdue: path === 'invoices' ? bool(query.overdue) : undefined, settlement: path === 'invoices' ? query.settlement : undefined,
        invoiceId: path === 'credit-notes' ? query.invoiceId : undefined,
      }), ListFinanceDocumentsResponse, (d) => d, signal);
    },
    async document(slug, path, id, signal) {
      return get(doc(slug, path, id), FinanceDocumentResponse, (d) => d.document, signal);
    },
    async createDocument(slug, path, input, key, signal) {
      return pick(await send('POST', `${base(slug)}/${path}`, CREATE[path], input, FinanceDocumentResponse, signal, key), 'document');
    },
    async createCreditNote(slug, invoiceId, input, key, signal) {
      return pick(await send('POST', doc(slug, 'invoices', invoiceId, '/credit-notes'), CreateCreditNoteRequest, input, FinanceDocumentResponse, signal, key), 'document');
    },
    async updateDocument(slug, path, id, patch, signal) {
      return pick(await send('PATCH', doc(slug, path, id), UPDATE[path], patch, FinanceDocumentResponse, signal), 'document');
    },
    async issueDocument(slug, path, id, input, signal) {
      return pick(await send('POST', doc(slug, path, id, '/issue'), IssueDocumentRequest, input, FinanceDocumentResponse, signal), 'document');
    },
    async voidDocument(slug, path, id, input, signal) {
      return pick(await send('POST', doc(slug, path, id, '/void'), VoidDocumentRequest, input, FinanceDocumentResponse, signal), 'document');
    },
    async discardDocument(slug, path, id, input, signal) {
      return pick(await send('POST', doc(slug, path, id, '/discard'), DiscardDraftRequest, input, FinanceDocumentResponse, signal), 'document');
    },
    async quoteTransition(slug, id, action, input, signal) {
      return pick(await send('POST', doc(slug, 'quotes', id, `/${action}`), QuoteTransitionRequest, input, FinanceDocumentResponse, signal), 'document');
    },
    async convertQuote(slug, id, input, key, signal) {
      return pick(await send('POST', doc(slug, 'quotes', id, '/convert'), ConvertQuoteRequest, input, FinanceDocumentResponse, signal, key), 'document');
    },
    async settlement(slug, invoiceId, signal) {
      return get(doc(slug, 'invoices', invoiceId, '/settlement'), InvoiceSettlementResponse, (d) => d.settlement, signal);
    },
    async credit(slug, creditNoteId, signal) {
      return get(doc(slug, 'credit-notes', creditNoteId, '/applications'), CreditNoteCreditResponse, (d) => d.credit, signal);
    },
    async applyCredit(slug, creditNoteId, input, signal) {
      return pick(await send('POST', doc(slug, 'credit-notes', creditNoteId, '/applications'), ApplyCreditRequest, input, CreditNoteCreditResponse, signal), 'credit');
    },
    async reverseCreditApplication(slug, creditNoteId, applicationId, signal) {
      return pick(await send('POST', doc(slug, 'credit-notes', creditNoteId, `/applications/${encodeURIComponent(applicationId)}/reverse`), z0, {}, CreditNoteCreditResponse, signal), 'credit');
    },
    async payments(slug, query, signal) {
      return get(`${base(slug)}/payments` + qs({
        status: query.status, customerId: query.customerId, currencyCode: query.currencyCode, from: query.from, to: query.to,
        unallocated: bool(query.unallocated), invoiceId: query.invoiceId, cursor: query.cursor, limit: query.limit,
      }), ListPaymentsResponse, (d) => d, signal);
    },
    async payment(slug, id, signal) {
      return get(`${base(slug)}/payments/${encodeURIComponent(id)}`, FinancePaymentResponse, (d) => d.payment, signal);
    },
    async recordPayment(slug, input, key, signal) {
      return pick(await send('POST', `${base(slug)}/payments`, RecordPaymentRequest, input, FinancePaymentResponse, signal, key), 'payment');
    },
    async updatePayment(slug, id, patch, signal) {
      return pick(await send('PATCH', `${base(slug)}/payments/${encodeURIComponent(id)}`, UpdatePaymentRequest, patch, FinancePaymentResponse, signal), 'payment');
    },
    async allocatePayment(slug, id, input, signal) {
      return pick(await send('POST', `${base(slug)}/payments/${encodeURIComponent(id)}/allocations`, AllocatePaymentRequest, input, FinancePaymentResponse, signal), 'payment');
    },
    async reverseAllocation(slug, id, allocationId, signal) {
      return pick(await send('POST', `${base(slug)}/payments/${encodeURIComponent(id)}/allocations/${encodeURIComponent(allocationId)}/reverse`, z0, {}, FinancePaymentResponse, signal), 'payment');
    },
    async reversePayment(slug, id, input, signal) {
      return pick(await send('POST', `${base(slug)}/payments/${encodeURIComponent(id)}/reverse`, ReversePaymentRequest, input, FinancePaymentResponse, signal), 'payment');
    },
    async balances(slug, query, signal) {
      return get(`${base(slug)}/customer-balances` + qs({ customerId: query.customerId, currencyCode: query.currencyCode, cursor: query.cursor, limit: query.limit }),
        ListCustomerBalancesResponse, (d) => d, signal);
    },
    async receivables(slug, signal) {
      return get(`${base(slug)}/receivables`, InvoiceReceivablesResponse, (d) => d.receivables, signal);
    },
    async statement(slug, p, signal) {
      return get(`${base(slug)}/statements` + qs({ customerId: p.customerId, currencyCode: p.currencyCode, from: p.from, to: p.to }), StatementResponse, (d) => d.statement, signal);
    },
    async statementPdf(slug, p, signal) {
      const path = `${base(slug)}/statements/pdf` + qs({ customerId: p.customerId, currencyCode: p.currencyCode, from: p.from, to: p.to });
      return file(await http.requestFile(path, 'application/pdf', signal), ['application/pdf']);
    },
    async ageing(slug, p, signal) {
      return get(`${base(slug)}/receivables-ageing` + qs({ asOf: p.asOf, currencyCode: p.currencyCode, customerId: p.customerId, cursor: p.cursor, limit: p.limit }),
        ReceivablesAgeingResponse, (d) => d.ageing, signal);
    },
    async ageingDetail(slug, p, signal) {
      return get(`${base(slug)}/receivables-ageing/detail` + qs({ asOf: p.asOf, customerId: p.customerId, currencyCode: p.currencyCode }), ReceivablesAgeingDetailResponse, (d) => d.detail, signal);
    },
    async settings(slug, signal) {
      return get(`${base(slug)}/settings`, FinanceSettingsResponse, (d) => d.settings, signal);
    },
    async updateSettings(slug, patch, signal) {
      return pick(await send('PATCH', `${base(slug)}/settings`, UpdateFinanceSettingsRequest, patch, FinanceSettingsResponse, signal), 'settings');
    },
    async numberSeries(slug, signal) {
      return get(`${base(slug)}/number-series`, ListNumberSeriesResponse, (d) => d.series, signal);
    },
    async updateNumberSeries(slug, kind, patch, signal) {
      return pick(await send('PATCH', `${base(slug)}/number-series/${kind}`, UpdateNumberSeriesRequest, patch, NumberSeriesResponse, signal), 'series');
    },
    async createTaxRate(slug, input, signal) {
      return pick(await send('POST', `${base(slug)}/tax-rates`, CreateTaxRateRequest, input, TaxRateResponse, signal), 'taxRate');
    },
    async updateTaxRate(slug, id, patch, signal) {
      return pick(await send('PATCH', `${base(slug)}/tax-rates/${encodeURIComponent(id)}`, UpdateTaxRateRequest, patch, TaxRateResponse, signal), 'taxRate');
    },
    async expensePayments(slug, query, signal) {
      return get(`${base(slug)}/expense-payments` + qs({
        status: query.status, currencyCode: query.currencyCode, from: query.from, to: query.to, expenseId: query.expenseId, cursor: query.cursor, limit: query.limit,
      }), ListExpensePaymentsResponse, (d) => d, signal);
    },
    async expensePayment(slug, id, signal) {
      return get(`${base(slug)}/expense-payments/${encodeURIComponent(id)}`, ExpensePaymentResponse, (d) => d.payment, signal);
    },
    async recordExpensePayment(slug, input, key, signal) {
      return pick(await send('POST', `${base(slug)}/expense-payments`, RecordExpensePaymentRequest, input, ExpensePaymentResponse, signal, key), 'payment');
    },
    async allocateExpensePayment(slug, id, input, signal) {
      return pick(await send('POST', `${base(slug)}/expense-payments/${encodeURIComponent(id)}/allocations`, AllocateExpensePaymentRequest, input, ExpensePaymentResponse, signal), 'payment');
    },
    async reverseExpenseAllocation(slug, id, allocationId, signal) {
      return pick(await send('POST', `${base(slug)}/expense-payments/${encodeURIComponent(id)}/allocations/${encodeURIComponent(allocationId)}/reverse`, z0, {}, ExpensePaymentResponse, signal), 'payment');
    },
    async reverseExpensePayment(slug, id, input, signal) {
      return pick(await send('POST', `${base(slug)}/expense-payments/${encodeURIComponent(id)}/reverse`, ReverseExpensePaymentRequest, input, ExpensePaymentResponse, signal), 'payment');
    },

    async pdfVersions(slug, path, id, signal) {
      return get(doc(slug, path, id, '/pdf-versions'), ListDocumentPdfVersionsResponse, (d) => d, signal);
    },
    async createPdfVersion(slug, path, id, input, signal) {
      return pick(await send('POST', doc(slug, path, id, '/pdf-versions'), CreateDocumentPdfVersionRequest, input, DocumentPdfVersionResponse, signal), 'version');
    },
    async pdfFile(slug, path, id, versionId, mode, signal) {
      return file(await http.requestFile(doc(slug, path, id, `/pdf-versions/${encodeURIComponent(versionId)}/${mode}`), 'application/pdf', signal), ['application/pdf']);
    },
    async draftPdf(slug, path, id, signal) {
      return file(await http.requestFile(doc(slug, path, id, '/draft-pdf'), 'application/pdf', signal), ['application/pdf']);
    },
    async branding(slug, signal) {
      return get(`${base(slug)}/document-branding`, DocumentBrandingResponse, (d) => d.branding, signal);
    },
    async updateBranding(slug, patch, signal) {
      return pick(await send('PATCH', `${base(slug)}/document-branding`, UpdateDocumentBrandingRequest, patch, DocumentBrandingResponse, signal), 'branding');
    },
    async uploadLogo(slug, input, signal) {
      return pick(await send('POST', `${base(slug)}/document-branding/logo`, UploadBrandingLogoRequest, input, DocumentBrandingResponse, signal), 'branding');
    },
    async logo(slug, signal) {
      return file(await http.requestFile(`${base(slug)}/document-branding/logo`, 'image/png, image/jpeg', signal), ['image/png', 'image/jpeg']);
    },
    async recurringInvoices(slug, query, signal) {
      return get(`${base(slug)}/recurring-invoices` + qs({ status: query.status, customerId: query.customerId, cursor: query.cursor, limit: query.limit }),
        ListRecurringInvoicesResponse, (d) => d, signal);
    },
    async recurringInvoice(slug, id, signal) {
      return get(rec(slug, id), RecurringInvoiceResponse, (d) => d.recurringInvoice, signal);
    },
    async createRecurringInvoice(slug, input, signal) {
      return pick(await send('POST', `${base(slug)}/recurring-invoices`, CreateRecurringInvoiceRequest, input, RecurringInvoiceResponse, signal), 'recurringInvoice');
    },
    async updateRecurringInvoice(slug, id, patch, signal) {
      return pick(await send('PATCH', rec(slug, id), UpdateRecurringInvoiceRequest, patch, RecurringInvoiceResponse, signal), 'recurringInvoice');
    },
    async recurringTransition(slug, id, action, input, signal) {
      const schema = action === 'cancel' ? CancelRecurringInvoiceRequest : RecurringTransitionRequest;
      return pick(await send('POST', rec(slug, id, `/${action}`), schema, input, RecurringInvoiceResponse, signal), 'recurringInvoice');
    },
    async generateRecurringInvoice(slug, id, input, signal) {
      return send('POST', rec(slug, id, '/generate'), RecurringTransitionRequest, input, GenerateRecurringInvoiceResponse, signal);
    },
    async recurringPreview(slug, id, count, signal) {
      return get(rec(slug, id, '/preview') + qs({ count }), RecurringPreviewResponse, (d) => d.preview, signal);
    },
    async recurringRuns(slug, id, query, signal) {
      return get(rec(slug, id, '/runs') + qs({ status: query.status, cursor: query.cursor, limit: query.limit }), ListRecurringRunsResponse, (d) => d, signal);
    },
    async recurringRunAction(slug, id, runId, action, signal) {
      return pick(await send('POST', rec(slug, id, `/runs/${encodeURIComponent(runId)}/${action}`), RecurringRunActionRequest, {}, RecurringRunResponse, signal), 'run');
    },
  };
}

