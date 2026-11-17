// API contracts: the single definition of every endpoint that clients (desktop, web) call.
// The API validates its responses against these schemas in tests, and clients parse every
// response with them, so a breaking change fails CI on both sides.
import { HealthResponse } from './health.ts';
import {
  CancelRecurringInvoiceRequest, CreateRecurringInvoiceRequest, GenerateRecurringInvoiceResponse, ListRecurringInvoicesQuery, ListRecurringInvoicesResponse, ListRecurringRunsQuery,
  ListRecurringRunsResponse, RecurringInvoiceResponse, RecurringPreviewQuery, RecurringPreviewResponse, RecurringRunActionRequest, RecurringRunResponse,
  RecurringTransitionRequest, UpdateRecurringInvoiceRequest,
} from './finance-billing.ts';
import {
  ReceivablesAgeingDetailQuery, ReceivablesAgeingDetailResponse, ReceivablesAgeingQuery, ReceivablesAgeingResponse, StatementQuery, StatementResponse,
} from './finance-statements.ts';
import {
  ArchiveReminderPolicyRequest, CreateReminderHoldRequest, CreateReminderPolicyRequest, CustomerReminderSettingsResponse, DismissReminderRequest,
  InvoiceReminderScheduleResponse, ListReminderHoldsQuery, ListReminderHoldsResponse, ListReminderPoliciesQuery, ListReminderPoliciesResponse,
  ListRemindersQuery, ListRemindersResponse, ReleaseReminderHoldRequest, ReminderHoldResponse, ReminderPolicyResponse, ReminderResponse,
  UpdateCustomerReminderSettingsRequest, UpdateReminderPolicyRequest,
} from './finance-reminders.ts';
import {
  CatalogItemLifecycleRequest, CatalogItemResponse, CreateCatalogItemRequest, ListCatalogItemsQuery, ListCatalogItemsResponse, UpdateCatalogItemRequest,
} from './finance-catalog.ts';
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
export * from './finance-billing.ts';
export * from './finance-statements.ts';
export * from './finance-reminders.ts';
export * from './finance-catalog.ts';
export * from './people.ts';
export * from './people-leave.ts';
export * from './scheduling.ts';
export * from './scheduling-time.ts';
export * from './communications.ts';
export * from './communications-connections.ts';
export * from './communications-erasure.ts';
export * from './reporting.ts';
export * from './search.ts';
import {
  ConversationResponse, CreateConversationRequest, ImportMessagesRequest, ImportMessagesResponse, ListConversationsQuery, ListConversationsResponse,
  ListMessagesQuery, ListMessagesResponse, MessageResponse, RecordMessageRequest,
} from './communications.ts';
import {
  AuthorizeMailConnectionRequest, AuthorizeMailConnectionResponse, ListMailConnectionsQuery, ListMailConnectionsResponse, ListMailProvidersResponse,
  ListMailSyncJobsResponse, MailConnectionResponse, MailSyncJobResponse, RequestMailSyncRequest, UpdateMailConnectionRequest,
  CreateMailBusinessAddressRequest, CreateMailBusinessDomainRequest, ListMailBusinessAddressesQuery, ListMailBusinessAddressesResponse,
  ListMailBusinessDomainsResponse, ListMailConnectionMembersResponse, MailBusinessAddressResponse, MailBusinessDomainResponse, MailRetentionResponse,
  SetMailConnectionMemberRequest, SetMailRetentionRequest, VersionedRequest,
} from './communications-connections.ts';
import {
  ApplyRetentionReductionRequest, ApplyRetentionReductionResponse, CreatePrivilegedAuthorizationRequest, ErasureDetailResponse, ErasureResponse,
  LegalHoldResponse, ListErasuresQuery, ListErasuresResponse, ListLegalHoldsQuery, ListLegalHoldsResponse, PlaceLegalHoldRequest,
  PrivilegedAuthorizationResponse, ReleaseLegalHoldRequest, RequestErasureRequest, RetentionEligibilityResponse,
} from './communications-erasure.ts';
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
  ListQuotesQuery, ListTaxRatesQuery, ProjectFinanceSummaryResponse, ListTaxRatesResponse, NumberSeriesResponse, QuoteTransitionRequest, TaxRateResponse, UpdateCreditNoteRequest,
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
  UpdateEventRequest, CreateResourceRequest, ListResourcesQuery, ListResourcesResponse, ResourceAvailabilityQuery, ResourceAvailabilityResponse,
  ResourceResponse, ResourceTransitionRequest, UpdateResourceRequest,
} from './scheduling.ts';
import {
  CreateOpportunityRequest, CreatePipelineRequest, ListOpportunitiesQuery, ListOpportunitiesResponse, ListPipelinesResponse, ListStagesQuery,
  ListOutcomesResponse, ListStagesResponse, LoseOpportunityRequest, OpportunityResponse, PipelineResponse, ReopenOpportunityRequest, SalesSummaryResponse,
  UpdateOpportunityRequest,
  // S-CFG-1A: pipeline and stage configuration.
  ArchiveStageRequest, ArchiveStageResponse, CreateStageRequest, PipelineConfigResponse, ReorderStagesRequest, RestoreOpportunityRequest,
  RestoreStageRequest, UpdatePipelineRequest, UpdateStageRequest,
} from './sales.ts';
import {
  ActivityResponse, ContactResponse, CreateActivityRequest, CreateContactRequest, CreateCustomerRequest, CustomerResponse, CustomerSummaryResponse,
  ListActivitiesQuery, ListActivitiesResponse, UpdateNoteRequest, ListContactsQuery, ListContactsResponse, ListCustomersQuery, ListCustomersResponse,
  UpdateContactRequest, UpdateCustomerRequest,
} from './customers.ts';
import {
  AcceptInvitationRequest, AcceptInvitationResponse, BusinessContextResponse, BusinessProfileResponse, UpdateBusinessProfileRequest, ConfirmRequest, CreateBusinessRequest, CreateBusinessResponse, PlatformAccessResponse,
  CreateInvitationRequest, InvitationResponse, InvitationsResponse, ListBusinessesResponse, MemberResponse, MembersResponse, OkResponse,
  TransferOwnershipRequest, UpdateMemberRequest,
} from './tenancy.ts';

import {
  ChangeDepartmentRequest, ChangeEmploymentStatusRequest, ChangeManagerRequest, CreateDepartmentRequest, CreateEmployeeRequest, CreateLocationRequest,
  DepartmentResponse, EmployeeHistoryResponse, EmployeeResponse, ListDepartmentsResponse, ListEmployeesQuery, ListEmployeesResponse,
  ListLocationsResponse, ListOrgUnitsQuery, LocationResponse, PersonalDetailsResponse, UpdateDepartmentRequest, UpdateEmployeeRequest,
  UpdateLocationRequest, UpdatePersonalDetailsRequest,
} from './people.ts';
import {
  AssignLeavePolicyRequest, AssignLeavePolicyResponse, CreateLeavePolicyRequest, CreateLeaveTypeRequest, EmployeeLeavePoliciesResponse,
  EndLeavePolicyAssignmentRequest, LeaveConfigLifecycleRequest, LeavePolicyResponse, LeaveTypeResponse, ListLeavePoliciesQuery, ListLeavePoliciesResponse,
  ListLeavePolicyRevisionsResponse, ListLeaveTypesQuery, ListLeaveTypesResponse, ListPolicyAssignmentsQuery, ListPolicyAssignmentsResponse,
  UpdateLeavePolicyRequest, UpdateLeaveTypeRequest,
} from './people-leave.ts';
import {
  CreateSavedViewRequest, DeleteSavedViewResponse, ListSavedViewsQuery, ListSavedViewsResponse, ReportingCatalogResponse, ReportingDetailsRequest,
  ReportingDetailsResponse, ReportingQueryRequest, ReportingQueryResponse, RunSavedViewResponse, SavedViewResponse, UpdateSavedViewRequest,
} from './reporting.ts';
import { SearchRequest, SearchResolveRequest, SearchResolveResponse, SearchResponse } from './search.ts';

export const API_VERSION = 'v1' as const;

export const endpoints = {
  health: { method: 'GET', path: '/api/v1/health', response: HealthResponse },
  me: { method: 'GET', path: '/api/v1/me', response: MeResponse },
  desktopToken: { method: 'POST', path: '/api/v1/auth/desktop/token', request: DesktopTokenRequest, response: DesktopTokenResponse },
  listBusinesses: { method: 'GET', path: '/api/v1/businesses', response: ListBusinessesResponse },
  createBusiness: { method: 'POST', path: '/api/v1/businesses', request: CreateBusinessRequest, response: CreateBusinessResponse },
  platformAccess: { method: 'GET', path: '/api/v1/access', response: PlatformAccessResponse },
  acceptInvitation: { method: 'POST', path: '/api/v1/invitations/accept', request: AcceptInvitationRequest, response: AcceptInvitationResponse },
  businessContext: { method: 'GET', path: '/api/v1/b/:slug', response: BusinessContextResponse },
  getBusinessProfile: { method: 'GET', path: '/api/v1/b/:slug/business', response: BusinessProfileResponse },
  updateBusinessProfile: { method: 'PATCH', path: '/api/v1/b/:slug/business', request: UpdateBusinessProfileRequest, response: BusinessProfileResponse },
  listMembers: { method: 'GET', path: '/api/v1/b/:slug/members', response: MembersResponse },
  /** Role change ({ role }) or, A2-B, suspend/reactivate ({ status }). */
  changeMemberRole: { method: 'PATCH', path: '/api/v1/b/:slug/members/:membershipId', request: UpdateMemberRequest, response: MemberResponse },
  removeMember: { method: 'DELETE', path: '/api/v1/b/:slug/members/:membershipId', response: OkResponse },
  transferOwnership: {
    method: 'POST', path: '/api/v1/b/:slug/members/:membershipId/transfer-ownership', request: TransferOwnershipRequest, response: MemberResponse,
  },
  stepDownAsOwner: { method: 'POST', path: '/api/v1/b/:slug/membership/step-down', request: ConfirmRequest, response: MemberResponse },
  leaveBusiness: { method: 'POST', path: '/api/v1/b/:slug/membership/leave', request: ConfirmRequest, response: OkResponse },
  listInvitations: { method: 'GET', path: '/api/v1/b/:slug/invitations', response: InvitationsResponse },
  createInvitation: { method: 'POST', path: '/api/v1/b/:slug/invitations', request: CreateInvitationRequest, response: InvitationResponse },
  resendInvitation: { method: 'POST', path: '/api/v1/b/:slug/invitations/:invitationId/resend', response: InvitationResponse },
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
  // Communications C2-B1 (docs/communications-c2.md §16): business mailbox identity and lifecycle.
  listMailBusinessDomains: { method: 'GET', path: '/api/v1/b/:slug/communications/business-domains', response: ListMailBusinessDomainsResponse },
  /** 201; the response carries the TXT record value once. */
  createMailBusinessDomain: {
    method: 'POST', path: '/api/v1/b/:slug/communications/business-domains', request: CreateMailBusinessDomainRequest, response: MailBusinessDomainResponse,
  },
  /** Looks up the TXT record now; 409 dns_record_not_found if it is not there (yet). */
  verifyMailBusinessDomain: {
    method: 'POST', path: '/api/v1/b/:slug/communications/business-domains/:domainId/verify', request: VersionedRequest, response: MailBusinessDomainResponse,
  },
  removeMailBusinessDomain: {
    method: 'POST', path: '/api/v1/b/:slug/communications/business-domains/:domainId/remove', request: VersionedRequest, response: MailBusinessDomainResponse,
  },
  listMailBusinessAddresses: {
    method: 'GET', path: '/api/v1/b/:slug/communications/business-addresses', query: ListMailBusinessAddressesQuery, response: ListMailBusinessAddressesResponse,
  },
  createMailBusinessAddress: {
    method: 'POST', path: '/api/v1/b/:slug/communications/business-addresses', request: CreateMailBusinessAddressRequest, response: MailBusinessAddressResponse,
  },
  removeMailBusinessAddress: {
    method: 'POST', path: '/api/v1/b/:slug/communications/business-addresses/:addressId/remove', request: VersionedRequest, response: MailBusinessAddressResponse,
  },
  listMailConnectionMembers: {
    method: 'GET', path: '/api/v1/b/:slug/communications/connections/:connectionId/members', response: ListMailConnectionMembersResponse,
  },
  /** Grants or changes a member's access to a BUSINESS mailbox; answers with the member list. */
  setMailConnectionMember: {
    method: 'PUT', path: '/api/v1/b/:slug/communications/connections/:connectionId/members/:userId', request: SetMailConnectionMemberRequest,
    response: ListMailConnectionMembersResponse,
  },
  removeMailConnectionMember: {
    method: 'POST', path: '/api/v1/b/:slug/communications/connections/:connectionId/members/:userId/remove', response: ListMailConnectionMembersResponse,
  },
  getMailRetention: { method: 'GET', path: '/api/v1/b/:slug/communications/retention', response: MailRetentionResponse },
  setMailRetention: { method: 'PUT', path: '/api/v1/b/:slug/communications/retention', request: SetMailRetentionRequest, response: MailRetentionResponse },
  // Communications E1 (docs/communications-e1.md §8): retention eligibility, legal holds, erasure. manage_connections,
  // plus a database-verified OWNER/ADMIN session and a single-use authorisation for the high-risk operations.
  getRetentionEligibility: { method: 'GET', path: '/api/v1/b/:slug/communications/retention/eligibility', response: RetentionEligibilityResponse },
  /** OWNER only: makes a pending (30-day delayed) reduction apply now. Audited with the reason. */
  applyRetentionReduction: {
    method: 'POST', path: '/api/v1/b/:slug/communications/retention/apply-reduction', request: ApplyRetentionReductionRequest,
    response: ApplyRetentionReductionResponse,
  },
  /** A single-use code (5 minutes) for one high-risk operation on one target; presented with that operation. */
  createPrivilegedAuthorization: {
    method: 'POST', path: '/api/v1/b/:slug/communications/authorizations', request: CreatePrivilegedAuthorizationRequest,
    response: PrivilegedAuthorizationResponse,
  },
  listLegalHolds: { method: 'GET', path: '/api/v1/b/:slug/communications/legal-holds', query: ListLegalHoldsQuery, response: ListLegalHoldsResponse },
  /** Idempotent: an active hold on the same target is returned (200) instead of a new one (201). */
  placeLegalHold: { method: 'POST', path: '/api/v1/b/:slug/communications/legal-holds', request: PlaceLegalHoldRequest, response: LegalHoldResponse },
  releaseLegalHold: {
    method: 'POST', path: '/api/v1/b/:slug/communications/legal-holds/:holdId/release', request: ReleaseLegalHoldRequest, response: LegalHoldResponse,
  },
  listErasures: { method: 'GET', path: '/api/v1/b/:slug/communications/erasures', query: ListErasuresQuery, response: ListErasuresResponse },
  /** 202: recorded and started; the worker finishes it. An open request for the same target is returned (200). */
  requestErasure: { method: 'POST', path: '/api/v1/b/:slug/communications/erasures', request: RequestErasureRequest, response: ErasureResponse },
  getErasure: { method: 'GET', path: '/api/v1/b/:slug/communications/erasures/:erasureId', response: ErasureDetailResponse },
  // Sales Zone (docs/sales-data-model.md)
  listPipelines: { method: 'GET', path: '/api/v1/b/:slug/sales/pipelines', response: ListPipelinesResponse },
  createPipeline: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines', request: CreatePipelineRequest, response: PipelineResponse },
  /** Idempotent: creates the default pipeline and standard stages if missing (201), else returns them (200). */
  initialiseDefaultPipeline: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines/default', response: PipelineResponse },
  listStages: { method: 'GET', path: '/api/v1/b/:slug/sales/stages', query: ListStagesQuery, response: ListStagesResponse },
  // S-CFG-1A (docs/sales-pipeline-configuration-scfg.md §6.1): reads sales:read, writes sales:manage.
  getPipelineConfig: { method: 'GET', path: '/api/v1/b/:slug/sales/pipelines/:pipelineId', response: PipelineConfigResponse },
  updatePipeline: { method: 'PATCH', path: '/api/v1/b/:slug/sales/pipelines/:pipelineId', request: UpdatePipelineRequest, response: PipelineConfigResponse },
  createStage: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines/:pipelineId/stages', request: CreateStageRequest, response: PipelineConfigResponse },
  updateStage: { method: 'PATCH', path: '/api/v1/b/:slug/sales/pipelines/:pipelineId/stages/:stageId', request: UpdateStageRequest, response: PipelineConfigResponse },
  reorderStages: { method: 'PUT', path: '/api/v1/b/:slug/sales/pipelines/:pipelineId/stages/order', request: ReorderStagesRequest, response: PipelineConfigResponse },
  archiveStage: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines/:pipelineId/stages/:stageId/archive', request: ArchiveStageRequest, response: ArchiveStageResponse },
  restoreStage: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines/:pipelineId/stages/:stageId/restore', request: RestoreStageRequest, response: PipelineConfigResponse },
  // R2 operational dashboard: the open pipeline as grouped totals (sales:read).
  salesSummary: { method: 'GET', path: '/api/v1/b/:slug/sales/summary', response: SalesSummaryResponse },
  listOpportunities: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities', query: ListOpportunitiesQuery, response: ListOpportunitiesResponse },
  createOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities', request: CreateOpportunityRequest, response: OpportunityResponse },
  getOpportunity: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId', response: OpportunityResponse },
  updateOpportunity: { method: 'PATCH', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId', request: UpdateOpportunityRequest, response: OpportunityResponse },
  winOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/win', response: OpportunityResponse },
  loseOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/lose', request: LoseOpportunityRequest, response: OpportunityResponse },
  reopenOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/reopen', request: ReopenOpportunityRequest, response: OpportunityResponse },
  listOpportunityOutcomes: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/outcomes', response: ListOutcomesResponse },
  archiveOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/archive', response: OpportunityResponse },
  restoreOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/restore', request: RestoreOpportunityRequest, response: OpportunityResponse },
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
  /** WF-1 §6.6.1: a project's figures per currency, derived from the ledger. finance:read + projects:read. */
  getProjectFinanceSummary: { method: 'GET', path: '/api/v1/b/:slug/finance/projects/:projectId/summary', response: ProjectFinanceSummaryResponse },
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
  // Finance F6-2: customer statements and receivables ageing as of a date (read-only, finance:read).
  getStatement: { method: 'GET', path: '/api/v1/b/:slug/finance/statements', query: StatementQuery, response: StatementResponse },
  getReceivablesAgeing: { method: 'GET', path: '/api/v1/b/:slug/finance/receivables-ageing', query: ReceivablesAgeingQuery, response: ReceivablesAgeingResponse },
  getReceivablesAgeingDetail: {
    method: 'GET', path: '/api/v1/b/:slug/finance/receivables-ageing/detail', query: ReceivablesAgeingDetailQuery, response: ReceivablesAgeingDetailResponse,
  },
  /** Internal integrity reconciliation (read-only); not bank-statement reconciliation. */
  getReconciliation: { method: 'GET', path: '/api/v1/b/:slug/finance/reconciliation', response: ReconciliationResponse },
  // Finance F6-1: recurring invoice schedules. Runs only ever create DRAFT invoices; nothing is issued
  // or sent. Reads need finance:read, every change finance:billing (D-F6-3, proposed).
  listRecurringInvoices: { method: 'GET', path: '/api/v1/b/:slug/finance/recurring-invoices', query: ListRecurringInvoicesQuery, response: ListRecurringInvoicesResponse },
  createRecurringInvoice: { method: 'POST', path: '/api/v1/b/:slug/finance/recurring-invoices', request: CreateRecurringInvoiceRequest, response: RecurringInvoiceResponse },
  getRecurringInvoice: { method: 'GET', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId', response: RecurringInvoiceResponse },
  updateRecurringInvoice: {
    method: 'PATCH', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId', request: UpdateRecurringInvoiceRequest, response: RecurringInvoiceResponse,
  },
  pauseRecurringInvoice: {
    method: 'POST', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/pause', request: RecurringTransitionRequest, response: RecurringInvoiceResponse,
  },
  resumeRecurringInvoice: {
    method: 'POST', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/resume', request: RecurringTransitionRequest, response: RecurringInvoiceResponse,
  },
  cancelRecurringInvoice: {
    method: 'POST', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/cancel', request: CancelRecurringInvoiceRequest, response: RecurringInvoiceResponse,
  },
  /** Generates the next period's draft now, as the signed-in member. */
  generateRecurringInvoice: {
    method: 'POST', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/generate', request: RecurringTransitionRequest,
    response: GenerateRecurringInvoiceResponse,
  },
  previewRecurringInvoice: {
    method: 'GET', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/preview', query: RecurringPreviewQuery, response: RecurringPreviewResponse,
  },
  listRecurringRuns: {
    method: 'GET', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/runs', query: ListRecurringRunsQuery, response: ListRecurringRunsResponse,
  },
  retryRecurringRun: {
    method: 'POST', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/runs/:runId/retry', request: RecurringRunActionRequest, response: RecurringRunResponse,
  },
  skipRecurringRun: {
    method: 'POST', path: '/api/v1/b/:slug/finance/recurring-invoices/:recurringId/runs/:runId/skip', request: RecurringRunActionRequest, response: RecurringRunResponse,
  },
  // Finance F6-3: payment reminders. Nothing is sent: a reminder stops at READY until Communications C2-C
  // provides an outbox (D-F6-8). Managing is finance:billing; reading is finance:read. No DELETE.
  listReminderPolicies: { method: 'GET', path: '/api/v1/b/:slug/finance/reminder-policies', query: ListReminderPoliciesQuery, response: ListReminderPoliciesResponse },
  createReminderPolicy: { method: 'POST', path: '/api/v1/b/:slug/finance/reminder-policies', request: CreateReminderPolicyRequest, response: ReminderPolicyResponse },
  getReminderPolicy: { method: 'GET', path: '/api/v1/b/:slug/finance/reminder-policies/:policyId', response: ReminderPolicyResponse },
  updateReminderPolicy: {
    method: 'PATCH', path: '/api/v1/b/:slug/finance/reminder-policies/:policyId', request: UpdateReminderPolicyRequest, response: ReminderPolicyResponse,
  },
  archiveReminderPolicy: {
    method: 'POST', path: '/api/v1/b/:slug/finance/reminder-policies/:policyId/archive', request: ArchiveReminderPolicyRequest, response: ReminderPolicyResponse,
  },
  getCustomerReminderSettings: {
    method: 'GET', path: '/api/v1/b/:slug/finance/customers/:customerId/reminder-settings', response: CustomerReminderSettingsResponse,
  },
  updateCustomerReminderSettings: {
    method: 'PUT', path: '/api/v1/b/:slug/finance/customers/:customerId/reminder-settings', request: UpdateCustomerReminderSettingsRequest,
    response: CustomerReminderSettingsResponse,
  },
  listReminderHolds: { method: 'GET', path: '/api/v1/b/:slug/finance/reminder-holds', query: ListReminderHoldsQuery, response: ListReminderHoldsResponse },
  createReminderHold: { method: 'POST', path: '/api/v1/b/:slug/finance/reminder-holds', request: CreateReminderHoldRequest, response: ReminderHoldResponse },
  releaseReminderHold: {
    method: 'POST', path: '/api/v1/b/:slug/finance/reminder-holds/:holdId/release', request: ReleaseReminderHoldRequest, response: ReminderHoldResponse,
  },
  listReminders: { method: 'GET', path: '/api/v1/b/:slug/finance/reminders', query: ListRemindersQuery, response: ListRemindersResponse },
  dismissReminder: { method: 'POST', path: '/api/v1/b/:slug/finance/reminders/:reminderId/dismiss', request: DismissReminderRequest, response: ReminderResponse },
  getInvoiceReminders: { method: 'GET', path: '/api/v1/b/:slug/finance/invoices/:documentId/reminders', response: InvoiceReminderScheduleResponse },
  // Finance F7-A: the products and services catalog (docs/finance-catalog-f7a.md). No DELETE: items are
  // deactivated or archived. Reading is finance:read; every change is finance:catalog.
  listCatalogItems: { method: 'GET', path: '/api/v1/b/:slug/finance/catalog-items', query: ListCatalogItemsQuery, response: ListCatalogItemsResponse },
  createCatalogItem: { method: 'POST', path: '/api/v1/b/:slug/finance/catalog-items', request: CreateCatalogItemRequest, response: CatalogItemResponse },
  getCatalogItem: { method: 'GET', path: '/api/v1/b/:slug/finance/catalog-items/:itemId', response: CatalogItemResponse },
  updateCatalogItem: { method: 'PATCH', path: '/api/v1/b/:slug/finance/catalog-items/:itemId', request: UpdateCatalogItemRequest, response: CatalogItemResponse },
  archiveCatalogItem: {
    method: 'POST', path: '/api/v1/b/:slug/finance/catalog-items/:itemId/archive', request: CatalogItemLifecycleRequest, response: CatalogItemResponse,
  },
  restoreCatalogItem: {
    method: 'POST', path: '/api/v1/b/:slug/finance/catalog-items/:itemId/restore', request: CatalogItemLifecycleRequest, response: CatalogItemResponse,
  },
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
  // People P3-A (docs/people-leave-p3.md): leave configuration. Reading is people:read; types and policies
  // are people:configure; assigning policies to employees is people:manage. No DELETE: types and policies
  // are deactivated or archived, revisions are append-only, assignments are closed.
  listLeaveTypes: { method: 'GET', path: '/api/v1/b/:slug/people/leave-types', query: ListLeaveTypesQuery, response: ListLeaveTypesResponse },
  createLeaveType: { method: 'POST', path: '/api/v1/b/:slug/people/leave-types', request: CreateLeaveTypeRequest, response: LeaveTypeResponse },
  getLeaveType: { method: 'GET', path: '/api/v1/b/:slug/people/leave-types/:leaveTypeId', response: LeaveTypeResponse },
  updateLeaveType: { method: 'PATCH', path: '/api/v1/b/:slug/people/leave-types/:leaveTypeId', request: UpdateLeaveTypeRequest, response: LeaveTypeResponse },
  /** 409 in_use while the type has a policy that is not archived. */
  archiveLeaveType: { method: 'POST', path: '/api/v1/b/:slug/people/leave-types/:leaveTypeId/archive', request: LeaveConfigLifecycleRequest, response: LeaveTypeResponse },
  restoreLeaveType: { method: 'POST', path: '/api/v1/b/:slug/people/leave-types/:leaveTypeId/restore', request: LeaveConfigLifecycleRequest, response: LeaveTypeResponse },
  listLeavePolicies: { method: 'GET', path: '/api/v1/b/:slug/people/leave-policies', query: ListLeavePoliciesQuery, response: ListLeavePoliciesResponse },
  createLeavePolicy: { method: 'POST', path: '/api/v1/b/:slug/people/leave-policies', request: CreateLeavePolicyRequest, response: LeavePolicyResponse },
  getLeavePolicy: { method: 'GET', path: '/api/v1/b/:slug/people/leave-policies/:policyId', response: LeavePolicyResponse },
  updateLeavePolicy: { method: 'PATCH', path: '/api/v1/b/:slug/people/leave-policies/:policyId', request: UpdateLeavePolicyRequest, response: LeavePolicyResponse },
  /** 409 in_use while any employee is currently assigned. */
  archiveLeavePolicy: { method: 'POST', path: '/api/v1/b/:slug/people/leave-policies/:policyId/archive', request: LeaveConfigLifecycleRequest, response: LeavePolicyResponse },
  restoreLeavePolicy: { method: 'POST', path: '/api/v1/b/:slug/people/leave-policies/:policyId/restore', request: LeaveConfigLifecycleRequest, response: LeavePolicyResponse },
  listLeavePolicyRevisions: { method: 'GET', path: '/api/v1/b/:slug/people/leave-policies/:policyId/revisions', response: ListLeavePolicyRevisionsResponse },
  listLeavePolicyAssignments: {
    method: 'GET', path: '/api/v1/b/:slug/people/leave-policies/:policyId/assignments', query: ListPolicyAssignmentsQuery, response: ListPolicyAssignmentsResponse,
  },
  assignLeavePolicy: {
    method: 'POST', path: '/api/v1/b/:slug/people/leave-policies/:policyId/assignments', request: AssignLeavePolicyRequest, response: AssignLeavePolicyResponse,
  },
  getEmployeeLeavePolicies: { method: 'GET', path: '/api/v1/b/:slug/people/employees/:employeeId/leave-policies', response: EmployeeLeavePoliciesResponse },
  endEmployeeLeavePolicy: {
    method: 'POST', path: '/api/v1/b/:slug/people/employees/:employeeId/leave-policies/end', request: EndLeavePolicyAssignmentRequest, response: EmployeeLeavePoliciesResponse,
  },
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
  // Scheduling S2 (docs/scheduling-s2.md): resources. No DELETE: resources are archived. Assignments are
  // written with the event (resourceIds on createEvent/updateEvent), all or nothing.
  listResources: { method: 'GET', path: '/api/v1/b/:slug/scheduling/resources', query: ListResourcesQuery, response: ListResourcesResponse },
  createResource: { method: 'POST', path: '/api/v1/b/:slug/scheduling/resources', request: CreateResourceRequest, response: ResourceResponse },
  /** Advisory: the booking transaction re-checks under locks. */
  resourceAvailability: { method: 'GET', path: '/api/v1/b/:slug/scheduling/resources/availability', query: ResourceAvailabilityQuery, response: ResourceAvailabilityResponse },
  getResource: { method: 'GET', path: '/api/v1/b/:slug/scheduling/resources/:resourceId', response: ResourceResponse },
  updateResource: { method: 'PATCH', path: '/api/v1/b/:slug/scheduling/resources/:resourceId', request: UpdateResourceRequest, response: ResourceResponse },
  /** Existing bookings keep the resource; it cannot be newly assigned until restored. */
  archiveResource: { method: 'POST', path: '/api/v1/b/:slug/scheduling/resources/:resourceId/archive', request: ResourceTransitionRequest, response: ResourceResponse },
  restoreResource: { method: 'POST', path: '/api/v1/b/:slug/scheduling/resources/:resourceId/restore', request: ResourceTransitionRequest, response: ResourceResponse },
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
  // Global search GS1-A (docs/global-search-gs1.md §7). POST bodies keep search text out of URLs. Not enabled yet:
  // both answer 404 until the reviewed enablement constant is flipped after the readiness gate (GS2 §12.1).
  search: { method: 'POST', path: '/api/v1/b/:slug/search', request: SearchRequest, response: SearchResponse },
  resolveSearchRecords: { method: 'POST', path: '/api/v1/b/:slug/search/resolve', request: SearchResolveRequest, response: SearchResolveResponse },

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
  /** F6-2: rendered on demand, never stored (D-F6-9); query as getStatement (StatementQuery). finance:documents_download, audited with the content hash. */
  downloadStatementPdf: { method: 'GET', path: '/api/v1/b/:slug/finance/statements/pdf', contentType: 'application/pdf', disposition: 'attachment' },
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
