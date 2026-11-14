// Public API of the finance module (docs/finance-data-model.md, ADR 0007). Routes import only from here.
// F1: quotes, invoices, credit notes and their settings. Payments and allocations (F2) and expenses
// (F3) have tables and database guards but no services yet.
export {
  convertQuote, createCreditNote, createInvoice, createQuote, discardDraft, getDocument, issueDocument, listDocuments, transitionQuote, updateDraft,
  voidDocument,
} from './server/documents';
export type { DraftPatch, InvoiceInput, IssueInput, LineInput, ListQuery, QuoteInput } from './server/documents';
export { createTaxRate, getSettings, hasRetainedRecords, listSeries, listTaxRates, updateSeries, updateSettings, updateTaxRate } from './server/settings';
export { idempotencyKeyOf } from './server/shared';
export type { Kind as FinanceKind } from './server/shared';
