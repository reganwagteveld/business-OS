// API contracts: the single definition of every endpoint that clients (desktop, web) call.
// The API validates its responses against these schemas in tests, and clients parse every
// response with them, so a breaking change fails CI on both sides.
import { HealthResponse } from './health.ts';
import {
  DesktopTokenRequest, DesktopTokenResponse, MeResponse, RequestPasswordResetRequest, ResetPasswordRequest, SignInRequest, SignUpRequest,
} from './auth.ts';

export { HealthResponse } from './health.ts';
export * from './auth.ts';
export * from './tenancy.ts';
export * from './customers.ts';
export * from './sales.ts';
export * from './projects.ts';
export * from './finance.ts';
export * from './finance-expenses.ts';
export * from './finance-documents.ts';
export * from './people.ts';
export * from './scheduling.ts';
export * from './scheduling-time.ts';
export * from './communications.ts';
export * from './communications-connections.ts';
export * from './reporting.ts';
import {
  ConversationResponse, CreateConversationRequest, ImportMessagesRequest, ImportMessagesResponse, ListConversationsQuery, ListConversationsResponse,
  ListMessagesQuery, ListMessagesResponse, MessageResponse, RecordMessageRequest,
} from './communications.ts';
import {
  AuthorizeMailConnectionRequest, AuthorizeMailConnectionResponse, ListMailConnectionsQuery, ListMailConnectionsResponse, ListMailProvidersResponse,
  ListMailSyncJobsResponse, MailConnectionResponse, MailSyncJobResponse, RequestMailSyncRequest, UpdateMailConnectionRequest,
} from './communications-connections.ts';
import {
  CreateProjectRequest, CreateTaskRequest, ListProjectsQuery, ListProjectsResponse, ListTasksQuery, ListTasksResponse, ProjectResponse, ProjectSummaryResponse,
  MoveTaskRequest, TaskResponse, UpdateProjectRequest, UpdateTaskRequest,
} from './projects.ts';
import {
  CreateDocumentPdfVersionRequest, DocumentBrandingResponse, DocumentPdfVersionResponse, ListDocumentPdfVersionsResponse, UpdateDocumentBrandingRequest,
  UploadBrandingLogoRequest,
} from './finance-documents.ts';
import {
  ConvertQuoteRequest, CreateCreditNoteRequest, CreateInvoiceRequest, CreateQuoteRequest, CreateTaxRateRequest, DiscardDraftRequest, FinanceDocumentResponse,
  FinanceSettingsResponse, IssueDocumentRequest, ListCreditNotesQuery, ListFinanceDocumentsResponse, ListInvoicesQuery, ListNumberSeriesResponse,
  ListQuotesQuery, ListTaxRatesQuery, ListTaxRatesResponse, NumberSeriesResponse, QuoteTransitionRequest, TaxRateResponse, UpdateCreditNoteRequest,
  UpdateFinanceSettingsRequest, UpdateInvoiceRequest, UpdateNumberSeriesRequest, UpdateQuoteRequest, UpdateTaxRateRequest, VoidDocumentRequest,
  AllocatePaymentRequest, ApplyCreditRequest, CreditNoteCreditResponse, FinancePaymentResponse, InvoiceSettlementResponse, ListCustomerBalancesQuery,
  ListCustomerBalancesResponse, ListPaymentsQuery, ListPaymentsResponse, ReconciliationResponse, RecordPaymentRequest, ReverseAllocationRequest,
  ReverseCreditApplicationRequest, ReversePaymentRequest, UpdatePaymentRequest, InvoiceReceivablesResponse,
} from './finance.ts';
import {
  AllocateExpensePaymentRequest, CreateExpenseCategoryRequest, CreateExpenseRequest, ExpenseCategoryResponse, ExpensePayablesResponse, ExpensePaymentResponse,
  FinanceExpenseResponse, ListExpenseCategoriesQuery, ListExpenseCategoriesResponse, ListExpensePaymentsQuery, ListExpensePaymentsResponse, ListExpensesQuery,
  ListExpensesResponse, RecordExpensePaymentRequest, RecordExpenseRequest,
  ReverseExpenseAllocationRequest, ReverseExpensePaymentRequest, UpdateExpenseCategoryRequest, UpdateExpenseRequest, VoidExpenseRequest,
} from './finance-expenses.ts';
import {
  AvailabilityQuery, AvailabilityResponse, CalendarResponse, CalendarTransitionRequest, CreateCalendarRequest, CreateEventRequest, DefaultCalendarResponse,
  EventResponse, EventTransitionRequest, ListCalendarsQuery, ListCalendarsResponse, ListEventsQuery, ListEventsResponse, UpdateCalendarRequest,
  UpdateEventRequest,
} from './scheduling.ts';
import {
  CreateOpportunityRequest, CreatePipelineRequest, ListOpportunitiesQuery, ListOpportunitiesResponse, ListPipelinesResponse, ListStagesQuery,
  ListOutcomesResponse, ListStagesResponse, LoseOpportunityRequest, OpportunityResponse, PipelineResponse, ReopenOpportunityRequest, UpdateOpportunityRequest,
} from './sales.ts';
import {
  ActivityResponse, ContactResponse, CreateActivityRequest, CreateContactRequest, CreateCustomerRequest, CustomerResponse, CustomerSummaryResponse,
  ListActivitiesQuery, ListActivitiesResponse, UpdateNoteRequest, ListContactsQuery, ListContactsResponse, ListCustomersQuery, ListCustomersResponse,
  UpdateContactRequest, UpdateCustomerRequest,
} from './customers.ts';
import {
  AcceptInvitationRequest, AcceptInvitationResponse, BusinessContextResponse, ChangeRoleRequest, CreateBusinessRequest, CreateBusinessResponse,
  CreateInvitationRequest, InvitationResponse, InvitationsResponse, ListBusinessesResponse, MemberResponse, MembersResponse, OkResponse,
} from './tenancy.ts';

import {
  ChangeDepartmentRequest, ChangeEmploymentStatusRequest, ChangeManagerRequest, CreateDepartmentRequest, CreateEmployeeRequest, CreateLocationRequest,
  DepartmentResponse, EmployeeHistoryResponse, EmployeeResponse, ListDepartmentsResponse, ListEmployeesQuery, ListEmployeesResponse,
  ListLocationsResponse, ListOrgUnitsQuery, LocationResponse, PersonalDetailsResponse, UpdateDepartmentRequest, UpdateEmployeeRequest,
  UpdateLocationRequest, UpdatePersonalDetailsRequest,
} from './people.ts';
import {
  CreateSavedViewRequest, DeleteSavedViewResponse, ListSavedViewsQuery, ListSavedViewsResponse, ReportingCatalogResponse, ReportingDetailsRequest,
  ReportingDetailsResponse, ReportingQueryRequest, ReportingQueryResponse, RunSavedViewResponse, SavedViewResponse, UpdateSavedViewRequest,
} from './reporting.ts';

export const API_VERSION = 'v1' as const;

export const endpoints = {
  health: { method: 'GET', path: '/api/v1/health', response: HealthResponse },
  me: { method: 'GET', path: '/api/v1/me', response: MeResponse },
  desktopToken: { method: 'POST', path: '/api/v1/auth/desktop/token', request: DesktopTokenRequest, response: DesktopTokenResponse },
  listBusinesses: { method: 'GET', path: '/api/v1/businesses', response: ListBusinessesResponse },
  createBusiness: { method: 'POST', path: '/api/v1/businesses', request: CreateBusinessRequest, response: CreateBusinessResponse },
  acceptInvitation: { method: 'POST', path: '/api/v1/invitations/accept', request: AcceptInvitationRequest, response: AcceptInvitationResponse },
  businessContext: { method: 'GET', path: '/api/v1/b/:slug', response: BusinessContextResponse },
  listMembers: { method: 'GET', path: '/api/v1/b/:slug/members', response: MembersResponse },
  changeMemberRole: { method: 'PATCH', path: '/api/v1/b/:slug/members/:membershipId', request: ChangeRoleRequest, response: MemberResponse },
  removeMember: { method: 'DELETE', path: '/api/v1/b/:slug/members/:membershipId', response: OkResponse },
  listInvitations: { method: 'GET', path: '/api/v1/b/:slug/invitations', response: InvitationsResponse },
  createInvitation: { method: 'POST', path: '/api/v1/b/:slug/invitations', request: CreateInvitationRequest, response: InvitationResponse },
  revokeInvitation: { method: 'DELETE', path: '/api/v1/b/:slug/invitations/:invitationId', response: OkResponse },
  listCustomers: { method: 'GET', path: '/api/v1/b/:slug/customers', query: ListCustomersQuery, response: ListCustomersResponse },
  createCustomer: { method: 'POST', path: '/api/v1/b/:slug/customers', request: CreateCustomerRequest, response: CustomerResponse },
  customerSummary: { method: 'GET', path: '/api/v1/b/:slug/customers/summary', response: CustomerSummaryResponse },
  getCustomer: { method: 'GET', path: '/api/v1/b/:slug/customers/:customerId', response: CustomerResponse },
  updateCustomer: { method: 'PATCH', path: '/api/v1/b/:slug/customers/:customerId', request: UpdateCustomerRequest, response: CustomerResponse },
  archiveCustomer: { method: 'POST', path: '/api/v1/b/:slug/customers/:customerId/archive', response: CustomerResponse },
  restoreCustomer: { method: 'POST', path: '/api/v1/b/:slug/customers/:customerId/restore', response: CustomerResponse },
  listContacts: { method: 'GET', path: '/api/v1/b/:slug/contacts', query: ListContactsQuery, response: ListContactsResponse },
  createContact: { method: 'POST', path: '/api/v1/b/:slug/contacts', request: CreateContactRequest, response: ContactResponse },
  getContact: { method: 'GET', path: '/api/v1/b/:slug/contacts/:contactId', response: ContactResponse },
  updateContact: { method: 'PATCH', path: '/api/v1/b/:slug/contacts/:contactId', request: UpdateContactRequest, response: ContactResponse },
  archiveContact: { method: 'POST', path: '/api/v1/b/:slug/contacts/:contactId/archive', response: ContactResponse },
  restoreContact: { method: 'POST', path: '/api/v1/b/:slug/contacts/:contactId/restore', response: ContactResponse },
  listActivities: { method: 'GET', path: '/api/v1/b/:slug/activities', query: ListActivitiesQuery, response: ListActivitiesResponse },
  createActivity: { method: 'POST', path: '/api/v1/b/:slug/activities', request: CreateActivityRequest, response: ActivityResponse },
  // Communications C1 (docs/communications-c1.md)
  getActivity: { method: 'GET', path: '/api/v1/b/:slug/activities/:activityId', response: ActivityResponse },
  updateNote: { method: 'PATCH', path: '/api/v1/b/:slug/activities/:activityId', request: UpdateNoteRequest, response: ActivityResponse },
  removeActivity: { method: 'POST', path: '/api/v1/b/:slug/activities/:activityId/remove', response: ActivityResponse },
  listConversations: { method: 'GET', path: '/api/v1/b/:slug/conversations', query: ListConversationsQuery, response: ListConversationsResponse },
  createConversation: { method: 'POST', path: '/api/v1/b/:slug/conversations', request: CreateConversationRequest, response: ConversationResponse },
  getConversation: { method: 'GET', path: '/api/v1/b/:slug/conversations/:conversationId', response: ConversationResponse },
  listMessages: { method: 'GET', path: '/api/v1/b/:slug/conversations/:conversationId/messages', query: ListMessagesQuery, response: ListMessagesResponse },
  recordMessage: { method: 'POST', path: '/api/v1/b/:slug/conversations/:conversationId/messages', request: RecordMessageRequest, response: MessageResponse },
  importMessages: {
    method: 'POST', path: '/api/v1/b/:slug/conversations/:conversationId/messages/import', request: ImportMessagesRequest, response: ImportMessagesResponse,
  },
  // Communications C2-A (docs/communications-c2.md §10): connected mailboxes. The provider redirects
  // the browser to GET /api/v1/communications/oauth/callback, which answers with an HTML page.
  listMailProviders: { method: 'GET', path: '/api/v1/b/:slug/communications/providers', response: ListMailProvidersResponse },
  listMailConnections: { method: 'GET', path: '/api/v1/b/:slug/communications/connections', query: ListMailConnectionsQuery, response: ListMailConnectionsResponse },
  authorizeMailConnection: {
    method: 'POST', path: '/api/v1/b/:slug/communications/connections/authorize', request: AuthorizeMailConnectionRequest, response: AuthorizeMailConnectionResponse,
  },
  getMailConnection: { method: 'GET', path: '/api/v1/b/:slug/communications/connections/:connectionId', response: MailConnectionResponse },
  updateMailConnection: {
    method: 'PATCH', path: '/api/v1/b/:slug/communications/connections/:connectionId', request: UpdateMailConnectionRequest, response: MailConnectionResponse,
  },
  disconnectMailConnection: { method: 'POST', path: '/api/v1/b/:slug/communications/connections/:connectionId/disconnect', response: MailConnectionResponse },
  /** Idempotent: returns the queued or running job if there is one (200), else queues one (201). */
  requestMailSync: {
    method: 'POST', path: '/api/v1/b/:slug/communications/connections/:connectionId/sync', request: RequestMailSyncRequest, response: MailSyncJobResponse,
  },
  listMailSyncJobs: { method: 'GET', path: '/api/v1/b/:slug/communications/connections/:connectionId/sync-jobs', response: ListMailSyncJobsResponse },
  // Sales Zone (docs/sales-data-model.md)
  listPipelines: { method: 'GET', path: '/api/v1/b/:slug/sales/pipelines', response: ListPipelinesResponse },
  createPipeline: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines', request: CreatePipelineRequest, response: PipelineResponse },
  /** Idempotent: creates the default pipeline and standard stages if missing (201), else returns them (200). */
  initialiseDefaultPipeline: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines/default', response: PipelineResponse },
  listStages: { method: 'GET', path: '/api/v1/b/:slug/sales/stages', query: ListStagesQuery, response: ListStagesResponse },
  listOpportunities: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities', query: ListOpportunitiesQuery, response: ListOpportunitiesResponse },
  createOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities', request: CreateOpportunityRequest, response: OpportunityResponse },
  getOpportunity: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId', response: OpportunityResponse },
  updateOpportunity: { method: 'PATCH', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId', request: UpdateOpportunityRequest, response: OpportunityResponse },
  winOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/win', response: OpportunityResponse },
  loseOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/lose', request: LoseOpportunityRequest, response: OpportunityResponse },
  reopenOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/reopen', request: ReopenOpportunityRequest, response: OpportunityResponse },
  listOpportunityOutcomes: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/outcomes', response: ListOutcomesResponse },
  archiveOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/archive', response: OpportunityResponse },
  restoreOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/restore', response: OpportunityResponse },
  // Projects Zone (docs/projects-data-model.md)
  listProjects: { method: 'GET', path: '/api/v1/b/:slug/projects', query: ListProjectsQuery, response: ListProjectsResponse },
  createProject: { method: 'POST', path: '/api/v1/b/:slug/projects', request: CreateProjectRequest, response: ProjectResponse },
  projectSummary: { method: 'GET', path: '/api/v1/b/:slug/projects/summary', response: ProjectSummaryResponse },
  getProject: { method: 'GET', path: '/api/v1/b/:slug/projects/:projectId', response: ProjectResponse },
  updateProject: { method: 'PATCH', path: '/api/v1/b/:slug/projects/:projectId', request: UpdateProjectRequest, response: ProjectResponse },
  archiveProject: { method: 'POST', path: '/api/v1/b/:slug/projects/:projectId/archive', response: ProjectResponse },
  restoreProject: { method: 'POST', path: '/api/v1/b/:slug/projects/:projectId/restore', response: ProjectResponse },
  /** One customer's projects (needs customers:read as well as projects:read); same list as listProjects. */
  listCustomerProjects: { method: 'GET', path: '/api/v1/b/:slug/customers/:customerId/projects', query: ListProjectsQuery, response: ListProjectsResponse },
  listTasks: { method: 'GET', path: '/api/v1/b/:slug/projects/:projectId/tasks', query: ListTasksQuery, response: ListTasksResponse },
  createTask: { method: 'POST', path: '/api/v1/b/:slug/projects/:projectId/tasks', request: CreateTaskRequest, response: TaskResponse },
  updateTask: { method: 'PATCH', path: '/api/v1/b/:slug/projects/:projectId/tasks/:taskId', request: UpdateTaskRequest, response: TaskResponse },
  archiveTask: { method: 'POST', path: '/api/v1/b/:slug/projects/:projectId/tasks/:taskId/archive', response: TaskResponse },
  restoreTask: { method: 'POST', path: '/api/v1/b/:slug/projects/:projectId/tasks/:taskId/restore', response: TaskResponse },
  /** Board move: status and order in one server-authoritative change (docs/projects-data-model.md §4). */
  moveTask: { method: 'POST', path: '/api/v1/b/:slug/projects/:projectId/tasks/:taskId/move', request: MoveTaskRequest, response: TaskResponse },
  // Finance Zone F1 (docs/finance-data-model.md). No DELETE endpoints: drafts are discarded, issued documents voided.
  listQuotes: { method: 'GET', path: '/api/v1/b/:slug/finance/quotes', query: ListQuotesQuery, response: ListFinanceDocumentsResponse },
  /** Optional Idempotency-Key header: a retried create returns the first draft. */
  createQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes', request: CreateQuoteRequest, response: FinanceDocumentResponse },
  getQuote: { method: 'GET', path: '/api/v1/b/:slug/finance/quotes/:documentId', response: FinanceDocumentResponse },
  updateQuote: { method: 'PATCH', path: '/api/v1/b/:slug/finance/quotes/:documentId', request: UpdateQuoteRequest, response: FinanceDocumentResponse },
  issueQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/issue', request: IssueDocumentRequest, response: FinanceDocumentResponse },
  acceptQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/accept', request: QuoteTransitionRequest, response: FinanceDocumentResponse },
  declineQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/decline', request: QuoteTransitionRequest, response: FinanceDocumentResponse },
  expireQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/expire', request: QuoteTransitionRequest, response: FinanceDocumentResponse },
  voidQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/void', request: VoidDocumentRequest, response: FinanceDocumentResponse },
  discardQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/discard', request: DiscardDraftRequest, response: FinanceDocumentResponse },
  /** Creates a draft invoice from the quote (201). Never issues it; never changes the quote. Optional Idempotency-Key. */
  convertQuote: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/convert', request: ConvertQuoteRequest, response: FinanceDocumentResponse },
  listInvoices: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices', query: ListInvoicesQuery, response: ListFinanceDocumentsResponse },
  createInvoice: { method: 'POST', path: '/api/v1/b/:slug/finance/invoices', request: CreateInvoiceRequest, response: FinanceDocumentResponse },
  getInvoice: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId', response: FinanceDocumentResponse },
  updateInvoice: { method: 'PATCH', path: '/api/v1/b/:slug/finance/invoices/:documentId', request: UpdateInvoiceRequest, response: FinanceDocumentResponse },
  issueInvoice: { method: 'POST', path: '/api/v1/b/:slug/finance/invoices/:documentId/issue', request: IssueDocumentRequest, response: FinanceDocumentResponse },
  voidInvoice: { method: 'POST', path: '/api/v1/b/:slug/finance/invoices/:documentId/void', request: VoidDocumentRequest, response: FinanceDocumentResponse },
  discardInvoice: { method: 'POST', path: '/api/v1/b/:slug/finance/invoices/:documentId/discard', request: DiscardDraftRequest, response: FinanceDocumentResponse },
  /** Creates a draft credit note for an issued invoice (201). Optional Idempotency-Key. */
  createCreditNote: { method: 'POST', path: '/api/v1/b/:slug/finance/invoices/:documentId/credit-notes', request: CreateCreditNoteRequest, response: FinanceDocumentResponse },
  listCreditNotes: { method: 'GET', path: '/api/v1/b/:slug/finance/credit-notes', query: ListCreditNotesQuery, response: ListFinanceDocumentsResponse },
  getCreditNote: { method: 'GET', path: '/api/v1/b/:slug/finance/credit-notes/:documentId', response: FinanceDocumentResponse },
  updateCreditNote: { method: 'PATCH', path: '/api/v1/b/:slug/finance/credit-notes/:documentId', request: UpdateCreditNoteRequest, response: FinanceDocumentResponse },
  issueCreditNote: { method: 'POST', path: '/api/v1/b/:slug/finance/credit-notes/:documentId/issue', request: IssueDocumentRequest, response: FinanceDocumentResponse },
  voidCreditNote: { method: 'POST', path: '/api/v1/b/:slug/finance/credit-notes/:documentId/void', request: VoidDocumentRequest, response: FinanceDocumentResponse },
  discardCreditNote: { method: 'POST', path: '/api/v1/b/:slug/finance/credit-notes/:documentId/discard', request: DiscardDraftRequest, response: FinanceDocumentResponse },
  getFinanceSettings: { method: 'GET', path: '/api/v1/b/:slug/finance/settings', response: FinanceSettingsResponse },
  updateFinanceSettings: { method: 'PATCH', path: '/api/v1/b/:slug/finance/settings', request: UpdateFinanceSettingsRequest, response: FinanceSettingsResponse },
  listNumberSeries: { method: 'GET', path: '/api/v1/b/:slug/finance/number-series', response: ListNumberSeriesResponse },
  /** :kind is quote, invoice or credit-note. */
  updateNumberSeries: { method: 'PATCH', path: '/api/v1/b/:slug/finance/number-series/:kind', request: UpdateNumberSeriesRequest, response: NumberSeriesResponse },
  listTaxRates: { method: 'GET', path: '/api/v1/b/:slug/finance/tax-rates', query: ListTaxRatesQuery, response: ListTaxRatesResponse },
  createTaxRate: { method: 'POST', path: '/api/v1/b/:slug/finance/tax-rates', request: CreateTaxRateRequest, response: TaxRateResponse },
  updateTaxRate: { method: 'PATCH', path: '/api/v1/b/:slug/finance/tax-rates/:taxRateId', request: UpdateTaxRateRequest, response: TaxRateResponse },
  // Finance F2: payments, allocations, credit applications, settlement and reconciliation. Still no DELETE:
  // corrections are reversals. Recording a payment requires an Idempotency-Key header.
  listPayments: { method: 'GET', path: '/api/v1/b/:slug/finance/payments', query: ListPaymentsQuery, response: ListPaymentsResponse },
  recordPayment: { method: 'POST', path: '/api/v1/b/:slug/finance/payments', request: RecordPaymentRequest, response: FinancePaymentResponse },
  getPayment: { method: 'GET', path: '/api/v1/b/:slug/finance/payments/:paymentId', response: FinancePaymentResponse },
  updatePayment: { method: 'PATCH', path: '/api/v1/b/:slug/finance/payments/:paymentId', request: UpdatePaymentRequest, response: FinancePaymentResponse },
  allocatePayment: { method: 'POST', path: '/api/v1/b/:slug/finance/payments/:paymentId/allocations', request: AllocatePaymentRequest, response: FinancePaymentResponse },
  reverseAllocation: {
    method: 'POST', path: '/api/v1/b/:slug/finance/payments/:paymentId/allocations/:allocationId/reverse', request: ReverseAllocationRequest, response: FinancePaymentResponse,
  },
  reversePayment: { method: 'POST', path: '/api/v1/b/:slug/finance/payments/:paymentId/reverse', request: ReversePaymentRequest, response: FinancePaymentResponse },
  getInvoiceSettlement: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId/settlement', response: InvoiceSettlementResponse },
  getCreditNoteCredit: { method: 'GET', path: '/api/v1/b/:slug/finance/credit-notes/:documentId/applications', response: CreditNoteCreditResponse },
  applyCreditNote: { method: 'POST', path: '/api/v1/b/:slug/finance/credit-notes/:documentId/applications', request: ApplyCreditRequest, response: CreditNoteCreditResponse },
  reverseCreditApplication: {
    method: 'POST', path: '/api/v1/b/:slug/finance/credit-notes/:documentId/applications/:applicationId/reverse', request: ReverseCreditApplicationRequest,
    response: CreditNoteCreditResponse,
  },
  listCustomerBalances: { method: 'GET', path: '/api/v1/b/:slug/finance/customer-balances', query: ListCustomerBalancesQuery, response: ListCustomerBalancesResponse },
  /** F4 (additive, read-only): receivables per currency for the whole business. */
  getReceivables: { method: 'GET', path: '/api/v1/b/:slug/finance/receivables', response: InvoiceReceivablesResponse },
  /** Internal integrity reconciliation (read-only); not bank-statement reconciliation. */
  getReconciliation: { method: 'GET', path: '/api/v1/b/:slug/finance/reconciliation', response: ReconciliationResponse },
  // Finance F3: expense categories, expenses, payments made against expenses. No DELETE:
  // categories are archived, drafts discarded, recorded expenses voided, payments reversed.
  listExpenseCategories: { method: 'GET', path: '/api/v1/b/:slug/finance/expense-categories', query: ListExpenseCategoriesQuery, response: ListExpenseCategoriesResponse },
  createExpenseCategory: { method: 'POST', path: '/api/v1/b/:slug/finance/expense-categories', request: CreateExpenseCategoryRequest, response: ExpenseCategoryResponse },
  updateExpenseCategory: {
    method: 'PATCH', path: '/api/v1/b/:slug/finance/expense-categories/:categoryId', request: UpdateExpenseCategoryRequest, response: ExpenseCategoryResponse,
  },
  listExpenses: { method: 'GET', path: '/api/v1/b/:slug/finance/expenses', query: ListExpensesQuery, response: ListExpensesResponse },
  createExpense: { method: 'POST', path: '/api/v1/b/:slug/finance/expenses', request: CreateExpenseRequest, response: FinanceExpenseResponse },
  getExpense: { method: 'GET', path: '/api/v1/b/:slug/finance/expenses/:expenseId', response: FinanceExpenseResponse },
  updateExpense: { method: 'PATCH', path: '/api/v1/b/:slug/finance/expenses/:expenseId', request: UpdateExpenseRequest, response: FinanceExpenseResponse },
  recordExpense: { method: 'POST', path: '/api/v1/b/:slug/finance/expenses/:expenseId/record', request: RecordExpenseRequest, response: FinanceExpenseResponse },
  voidExpense: { method: 'POST', path: '/api/v1/b/:slug/finance/expenses/:expenseId/void', request: VoidExpenseRequest, response: FinanceExpenseResponse },
  getExpensePayables: { method: 'GET', path: '/api/v1/b/:slug/finance/expense-payables', response: ExpensePayablesResponse },
  listExpensePayments: { method: 'GET', path: '/api/v1/b/:slug/finance/expense-payments', query: ListExpensePaymentsQuery, response: ListExpensePaymentsResponse },
  /** Idempotency-Key required. */
  recordExpensePayment: { method: 'POST', path: '/api/v1/b/:slug/finance/expense-payments', request: RecordExpensePaymentRequest, response: ExpensePaymentResponse },
  getExpensePayment: { method: 'GET', path: '/api/v1/b/:slug/finance/expense-payments/:paymentId', response: ExpensePaymentResponse },
  allocateExpensePayment: {
    method: 'POST', path: '/api/v1/b/:slug/finance/expense-payments/:paymentId/allocations', request: AllocateExpensePaymentRequest, response: ExpensePaymentResponse,
  },
  reverseExpenseAllocation: {
    method: 'POST', path: '/api/v1/b/:slug/finance/expense-payments/:paymentId/allocations/:allocationId/reverse', request: ReverseExpenseAllocationRequest,
    response: ExpensePaymentResponse,
  },
  reverseExpensePayment: {
    method: 'POST', path: '/api/v1/b/:slug/finance/expense-payments/:paymentId/reverse', request: ReverseExpensePaymentRequest, response: ExpensePaymentResponse,
  },
  // People Zone P1 (docs/people-data-model.md). No DELETE: employees are never deleted, departments and
  // locations are archived, assignments are closed, status history is append-only.
  listEmployees: { method: 'GET', path: '/api/v1/b/:slug/people/employees', query: ListEmployeesQuery, response: ListEmployeesResponse },
  createEmployee: { method: 'POST', path: '/api/v1/b/:slug/people/employees', request: CreateEmployeeRequest, response: EmployeeResponse },
  getEmployee: { method: 'GET', path: '/api/v1/b/:slug/people/employees/:employeeId', response: EmployeeResponse },
  updateEmployee: { method: 'PATCH', path: '/api/v1/b/:slug/people/employees/:employeeId', request: UpdateEmployeeRequest, response: EmployeeResponse },
  changeEmploymentStatus: {
    method: 'POST', path: '/api/v1/b/:slug/people/employees/:employeeId/status', request: ChangeEmploymentStatusRequest, response: EmployeeResponse,
  },
  changeEmployeeDepartment: { method: 'POST', path: '/api/v1/b/:slug/people/employees/:employeeId/department', request: ChangeDepartmentRequest, response: EmployeeResponse },
  changeEmployeeManager: { method: 'POST', path: '/api/v1/b/:slug/people/employees/:employeeId/manager', request: ChangeManagerRequest, response: EmployeeResponse },
  getEmployeeHistory: { method: 'GET', path: '/api/v1/b/:slug/people/employees/:employeeId/history', response: EmployeeHistoryResponse },
  /** people:read_sensitive. */
  getEmployeePersonalDetails: { method: 'GET', path: '/api/v1/b/:slug/people/employees/:employeeId/personal', response: PersonalDetailsResponse },
  /** people:manage and people:read_sensitive. */
  updateEmployeePersonalDetails: {
    method: 'PATCH', path: '/api/v1/b/:slug/people/employees/:employeeId/personal', request: UpdatePersonalDetailsRequest, response: PersonalDetailsResponse,
  },
  listDepartments: { method: 'GET', path: '/api/v1/b/:slug/people/departments', query: ListOrgUnitsQuery, response: ListDepartmentsResponse },
  createDepartment: { method: 'POST', path: '/api/v1/b/:slug/people/departments', request: CreateDepartmentRequest, response: DepartmentResponse },
  updateDepartment: { method: 'PATCH', path: '/api/v1/b/:slug/people/departments/:departmentId', request: UpdateDepartmentRequest, response: DepartmentResponse },
  archiveDepartment: { method: 'POST', path: '/api/v1/b/:slug/people/departments/:departmentId/archive', response: DepartmentResponse },
  restoreDepartment: { method: 'POST', path: '/api/v1/b/:slug/people/departments/:departmentId/restore', response: DepartmentResponse },
  listLocations: { method: 'GET', path: '/api/v1/b/:slug/people/locations', query: ListOrgUnitsQuery, response: ListLocationsResponse },
  createLocation: { method: 'POST', path: '/api/v1/b/:slug/people/locations', request: CreateLocationRequest, response: LocationResponse },
  updateLocation: { method: 'PATCH', path: '/api/v1/b/:slug/people/locations/:locationId', request: UpdateLocationRequest, response: LocationResponse },
  archiveLocation: { method: 'POST', path: '/api/v1/b/:slug/people/locations/:locationId/archive', response: LocationResponse },
  restoreLocation: { method: 'POST', path: '/api/v1/b/:slug/people/locations/:locationId/restore', response: LocationResponse },
  // Scheduling S1 (docs/scheduling-s1.md). No DELETE: calendars and events are archived, events cancelled.
  listCalendars: { method: 'GET', path: '/api/v1/b/:slug/scheduling/calendars', query: ListCalendarsQuery, response: ListCalendarsResponse },
  createCalendar: { method: 'POST', path: '/api/v1/b/:slug/scheduling/calendars', request: CreateCalendarRequest, response: CalendarResponse },
  /** Idempotent: creates the default calendar in the business's time zone if there is none (201), else returns it (200). */
  initialiseDefaultCalendar: { method: 'POST', path: '/api/v1/b/:slug/scheduling/calendars/default', response: DefaultCalendarResponse },
  getCalendar: { method: 'GET', path: '/api/v1/b/:slug/scheduling/calendars/:calendarId', response: CalendarResponse },
  updateCalendar: { method: 'PATCH', path: '/api/v1/b/:slug/scheduling/calendars/:calendarId', request: UpdateCalendarRequest, response: CalendarResponse },
  /** 409 default_calendar for the default: make another calendar the default first. Events are kept. */
  archiveCalendar: { method: 'POST', path: '/api/v1/b/:slug/scheduling/calendars/:calendarId/archive', request: CalendarTransitionRequest, response: CalendarResponse },
  restoreCalendar: { method: 'POST', path: '/api/v1/b/:slug/scheduling/calendars/:calendarId/restore', request: CalendarTransitionRequest, response: CalendarResponse },
  listEvents: { method: 'GET', path: '/api/v1/b/:slug/scheduling/events', query: ListEventsQuery, response: ListEventsResponse },
  /** 409 with SchedulingConflictResponse when an enforced booking overlaps. */
  createEvent: { method: 'POST', path: '/api/v1/b/:slug/scheduling/events', request: CreateEventRequest, response: EventResponse },
  getEvent: { method: 'GET', path: '/api/v1/b/:slug/scheduling/events/:eventId', response: EventResponse },
  /** 409 with SchedulingConflictResponse when an enforced change overlaps. */
  updateEvent: { method: 'PATCH', path: '/api/v1/b/:slug/scheduling/events/:eventId', request: UpdateEventRequest, response: EventResponse },
  cancelEvent: { method: 'POST', path: '/api/v1/b/:slug/scheduling/events/:eventId/cancel', request: EventTransitionRequest, response: EventResponse },
  archiveEvent: { method: 'POST', path: '/api/v1/b/:slug/scheduling/events/:eventId/archive', request: EventTransitionRequest, response: EventResponse },
  checkAvailability: { method: 'GET', path: '/api/v1/b/:slug/scheduling/availability', query: AvailabilityQuery, response: AvailabilityResponse },
  // Reporting R1 (docs/reporting-r1.md). Registered metrics only; every run is checked against reporting:read
  // AND each metric's source permissions. Query and details are POST because their bodies are structured;
  // neither changes anything.
  reportingCatalog: { method: 'GET', path: '/api/v1/b/:slug/reporting/metrics', response: ReportingCatalogResponse },
  runReport: { method: 'POST', path: '/api/v1/b/:slug/reporting/query', request: ReportingQueryRequest, response: ReportingQueryResponse },
  reportDetails: { method: 'POST', path: '/api/v1/b/:slug/reporting/details', request: ReportingDetailsRequest, response: ReportingDetailsResponse },
  listSavedViews: { method: 'GET', path: '/api/v1/b/:slug/reporting/views', query: ListSavedViewsQuery, response: ListSavedViewsResponse },
  createSavedView: { method: 'POST', path: '/api/v1/b/:slug/reporting/views', request: CreateSavedViewRequest, response: SavedViewResponse },
  getSavedView: { method: 'GET', path: '/api/v1/b/:slug/reporting/views/:viewId', response: SavedViewResponse },
  /** Owner only. 409 stale when `version` is not the current one. */
  updateSavedView: { method: 'PATCH', path: '/api/v1/b/:slug/reporting/views/:viewId', request: UpdateSavedViewRequest, response: SavedViewResponse },
  /** The owner, or reporting:manage for a shared view. Deletes the configuration only; no source data is touched. */
  deleteSavedView: { method: 'DELETE', path: '/api/v1/b/:slug/reporting/views/:viewId', response: DeleteSavedViewResponse },
  /** Runs the stored configuration as the caller; metrics the caller may not read come back as per-metric errors. */
  runSavedView: { method: 'POST', path: '/api/v1/b/:slug/reporting/views/:viewId/run', response: RunSavedViewResponse },

  // Finance F5 (docs/finance-documents-f5.md): document branding and PDF versions of quotes and invoices.
  // The files themselves are served by fileEndpoints below. Nothing here sends a document.
  getDocumentBranding: { method: 'GET', path: '/api/v1/b/:slug/finance/document-branding', response: DocumentBrandingResponse },
  updateDocumentBranding: { method: 'PATCH', path: '/api/v1/b/:slug/finance/document-branding', request: UpdateDocumentBrandingRequest, response: DocumentBrandingResponse },
  uploadBrandingLogo: { method: 'POST', path: '/api/v1/b/:slug/finance/document-branding/logo', request: UploadBrandingLogoRequest, response: DocumentBrandingResponse },
  listQuotePdfVersions: { method: 'GET', path: '/api/v1/b/:slug/finance/quotes/:documentId/pdf-versions', response: ListDocumentPdfVersionsResponse },
  createQuotePdfVersion: { method: 'POST', path: '/api/v1/b/:slug/finance/quotes/:documentId/pdf-versions', request: CreateDocumentPdfVersionRequest, response: DocumentPdfVersionResponse },
  getQuotePdfVersion: { method: 'GET', path: '/api/v1/b/:slug/finance/quotes/:documentId/pdf-versions/:versionId', response: DocumentPdfVersionResponse },
  listInvoicePdfVersions: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId/pdf-versions', response: ListDocumentPdfVersionsResponse },
  createInvoicePdfVersion: { method: 'POST', path: '/api/v1/b/:slug/finance/invoices/:documentId/pdf-versions', request: CreateDocumentPdfVersionRequest, response: DocumentPdfVersionResponse },
  getInvoicePdfVersion: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId/pdf-versions/:versionId', response: DocumentPdfVersionResponse },
} as const;

/**
 * Endpoints that answer with a file instead of JSON (Finance F5). Errors are still JSON ({ error }).
 * `disposition` says how the file is served: inline (preview) or attachment (download).
 */
export const fileEndpoints = {
  getBrandingLogo: { method: 'GET', path: '/api/v1/b/:slug/finance/document-branding/logo', contentType: 'image/png | image/jpeg', disposition: 'none' },
  previewQuoteDraftPdf: { method: 'GET', path: '/api/v1/b/:slug/finance/quotes/:documentId/draft-pdf', contentType: 'application/pdf', disposition: 'inline' },
  previewQuotePdfVersion: { method: 'GET', path: '/api/v1/b/:slug/finance/quotes/:documentId/pdf-versions/:versionId/preview', contentType: 'application/pdf', disposition: 'inline' },
  downloadQuotePdfVersion: { method: 'GET', path: '/api/v1/b/:slug/finance/quotes/:documentId/pdf-versions/:versionId/download', contentType: 'application/pdf', disposition: 'attachment' },
  previewInvoiceDraftPdf: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId/draft-pdf', contentType: 'application/pdf', disposition: 'inline' },
  previewInvoicePdfVersion: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId/pdf-versions/:versionId/preview', contentType: 'application/pdf', disposition: 'inline' },
  downloadInvoicePdfVersion: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId/pdf-versions/:versionId/download', contentType: 'application/pdf', disposition: 'attachment' },
} as const;

/** Fills `:param` segments of an endpoint path; values are URL-encoded. */
export function endpointPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing path parameter ${key}`);
    return encodeURIComponent(value);
  });
}

/**
 * Endpoints served by the identity module's auth library under /api/v1/auth (catch-all route).
 * Request bodies are validated by the client before sending and by the library on the server.
 */
export const authEndpoints = {
  signUp: { method: 'POST', path: '/api/v1/auth/sign-up/email', request: SignUpRequest },
  signIn: { method: 'POST', path: '/api/v1/auth/sign-in/email', request: SignInRequest },
  signOut: { method: 'POST', path: '/api/v1/auth/sign-out' },
  requestPasswordReset: { method: 'POST', path: '/api/v1/auth/request-password-reset', request: RequestPasswordResetRequest },
  resetPassword: { method: 'POST', path: '/api/v1/auth/reset-password', request: ResetPasswordRequest },
  sendVerificationEmail: { method: 'POST', path: '/api/v1/auth/send-verification-email' },
  desktopAuthorize: { method: 'GET', path: '/api/v1/auth/desktop/authorize' },
} as const;

export type EndpointName = keyof typeof endpoints;
