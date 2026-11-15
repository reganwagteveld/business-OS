// Public API of the finance module (docs/finance-data-model.md, ADR 0007). Routes import only from here.
// F1: quotes, invoices, credit notes and their settings. F2: payments, allocations, reversals, credit
// applications, settlement projections and reconciliation. F3: expense categories, expenses and payments made against expenses (direction PAID in the same payments ledger).
export {
  convertQuote, createCreditNote, createInvoice, createQuote, discardDraft, getDocument, issueDocument, listDocuments, transitionQuote, updateDraft,
  voidDocument,
} from './server/documents';
export type { DraftPatch, InvoiceInput, IssueInput, LineInput, ListQuery, QuoteInput } from './server/documents';
export { createTaxRate, getSettings, hasRetainedRecords, listSeries, listTaxRates, updateSeries, updateSettings, updateTaxRate } from './server/settings';
export { idempotencyKeyOf } from './server/shared';
export type { Kind as FinanceKind } from './server/shared';
export { allocatePayment, getPayment, listPayments, recordPayment, reverseAllocation, reversePayment, updatePayment } from './server/payments';
export type { ListPaymentsQuery, RecordPaymentInput, SettlementItem } from './server/payments';
export { applyCreditNote, getCreditNoteCredit, getInvoiceSettlement, invoiceReceivables, listCustomerBalances, reverseCreditApplication } from './server/settlement';
export { runReconciliation } from './server/reconciliation';
export {
  createCategory, createExpense, DEFAULT_CATEGORIES, ensureDefaultCategories, expensePayables, getExpense, listCategories, listExpenses,
  recordExpense, updateCategory, updateExpense, voidExpense,
} from './server/expenses';
export type { ExpenseInput, ExpensePatch, ListExpensesQuery, PaidInFull } from './server/expenses';
export {
  allocateExpensePayment, getExpensePayment, listExpensePayments, payExpenseInFull, recordExpensePayment, reverseExpenseAllocation, reverseExpensePayment,
} from './server/expense-payments';
export type { ExpenseSettlementItem, ListExpensePaymentsQuery, RecordExpensePaymentInput } from './server/expense-payments';
// Reporting R1 (docs/reporting-r1.md §4): Finance's own reporting read model, used by the reporting module.
export { issuedDocumentDetails, issuedDocumentTotals, receivedPaymentDetails, receivedPaymentTotals } from './server/reporting';
export type {
  FinanceDetailQuery, FinancePeriodQuery, FinancePeriodRow, IssuedDocumentDetail, ReceivedPaymentDetail, ReportingUnit as FinanceReportingUnit,
} from './server/reporting';
// F5: generated documents (docs/finance-documents-f5.md): document branding, draft previews and immutable PDF versions.
export { currentLogo, getBranding, updateBranding, uploadLogo } from './server/branding';
export type { BrandingInput } from './server/branding';
export { contentDisposition, createPdfVersion, draftPreview, getPdfVersion, issueWithOriginal, listPdfVersions, pdfVersionFile } from './server/document-pdfs';
export type { CreateVersionInput, PdfFile, PdfKind, PdfReason } from './server/document-pdfs';
