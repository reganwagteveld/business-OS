// Public API of the finance module (docs/finance-data-model.md, ADR 0007). Routes import only from here.
// F1: quotes, invoices, credit notes and their settings. F2: payments, allocations, reversals, credit
// applications, settlement projections and reconciliation. F3: expense categories, expenses and payments made against expenses (direction PAID in the same payments ledger).
// F6-1: recurring invoice schedules and the billing worker's steps (plan, claim, execute, fail).
// F6-2: customer statements and accounts-receivable ageing as of a date.
// F6-3: payment reminder policies, holds, the reminder worker's steps (plan, claim, check, fail) and the C2-C outbox boundary.
// F7-A: the products and services catalog, and lineDefaultsOf for future pickers that copy an item into a draft line.
export {
  convertQuote, createCreditNote, createInvoice, createQuote, discardDraft, getDocument, issueDocument, listDocuments, transitionQuote, updateDraft,
  voidDocument,
} from './server/documents';
export type { DraftPatch, InvoiceInput, IssueInput, LineInput, ListQuery, QuoteInput } from './server/documents';
// WF-1B-1 (docs/cross-zone-workflows-wf1.md §6.1, §6.6.1): D-WF1-11 link keys and the project financial summary.
export { authorizeFinanceLinks } from './server/documents';
export { projectFinanceSummary } from './server/project-summary';
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
export { issuedDocumentDetails, issuedDocumentTotals, receivedPaymentDetails, receivedPaymentTotals, recordedExpenseDetails, recordedExpenseTotals } from './server/reporting';
export type {
  FinanceDetailQuery, FinancePeriodQuery, FinancePeriodRow, IssuedDocumentDetail, ReceivedPaymentDetail, RecordedExpenseDetail, ReportingUnit as FinanceReportingUnit,
} from './server/reporting';
// F5: generated documents (docs/finance-documents-f5.md): document branding, draft previews and immutable PDF versions.
// F6-2: customer statements and receivables ageing as of a date (docs/finance-billing-f6.md §4). Read-only; statement PDFs are never stored.
export { getReceivablesAgeing, getReceivablesAgeingDetail, getStatement, statementPdf } from './server/statements';
export { currentLogo, getBranding, updateBranding, uploadLogo } from './server/branding';
export type { BrandingInput } from './server/branding';
export { contentDisposition, createPdfVersion, draftPreview, getPdfVersion, issueWithOriginal, listPdfVersions, pdfVersionFile } from './server/document-pdfs';
export type { CreateVersionInput, PdfFile, PdfKind, PdfReason } from './server/document-pdfs';
export {
  cancelRecurringInvoice, claimRecurringRun, createRecurringInvoice, executeRecurringRun, failRecurringRun, generateNextPeriod, getRecurringInvoice,
  listRecurringInvoices, listRecurringRuns, MAX_PERIODS_PER_PASS, pauseRecurringInvoice, planDueRuns, previewRecurringInvoice, resumeRecurringInvoice,
  retryRecurringRun, skipRecurringRun, TEMPLATES_PER_PLAN_BATCH, updateRecurringInvoice,
} from './server/recurring';
export type { ClaimedRun, RecurringInput, RecurringPatch, RunOutcome } from './server/recurring';
export {
  archiveReminderPolicy, claimReminder, confirmReminderBeforeSend, createReminderHold, createReminderPolicy, dismissReminder, executeReminder,
  failReminder, getCustomerReminderSettings, getInvoiceReminders, getReminderPolicy, INVOICES_PER_PLAN_BATCH, listReminderHolds, listReminderPolicies,
  listReminders, markRemindersPlanned, outstandingOf, planDueReminders, recordReminderOutboundState, releaseReminderHold, reminderOutboundKey,
  updateCustomerReminderSettings, updateReminderPolicy,
} from './server/reminders';
export type { ClaimedReminder, ReminderOutcome } from './server/reminders';
export { configuredReminderOutbox } from './server/reminder-outbox';
export type { BeforeSendResult, EnqueueResult, ReminderDispatchRequest, ReminderOutbox, ReminderRecipient } from './server/reminder-outbox';
export {
  archiveCatalogItem, createCatalogItem, getCatalogItem, lineDefaultsOf, listCatalogItems, restoreCatalogItem, updateCatalogItem,
} from './server/catalog';
export type { CatalogItemInput, CatalogItemPatch, CatalogLineDefaults, ListCatalogQuery } from './server/catalog';
// Global search GS1-A (docs/global-search-gs1.md §6.2).
export {
  catalogItemSearchProvider, creditNoteSearchProvider, FINANCE_SEARCH_INDEXES, invoiceSearchProvider, quoteSearchProvider,
} from './server/search';
