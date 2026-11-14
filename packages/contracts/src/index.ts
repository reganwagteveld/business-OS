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
import {
  CreateOpportunityRequest, CreatePipelineRequest, ListOpportunitiesQuery, ListOpportunitiesResponse, ListPipelinesResponse, ListStagesQuery,
  ListStagesResponse, LoseOpportunityRequest, OpportunityResponse, PipelineResponse, ReopenOpportunityRequest, UpdateOpportunityRequest,
} from './sales.ts';
import {
  ActivityResponse, ContactResponse, CreateActivityRequest, CreateContactRequest, CreateCustomerRequest, CustomerResponse, CustomerSummaryResponse,
  ListActivitiesQuery, ListActivitiesResponse, ListContactsQuery, ListContactsResponse, ListCustomersQuery, ListCustomersResponse,
  UpdateContactRequest, UpdateCustomerRequest,
} from './customers.ts';
import {
  AcceptInvitationRequest, AcceptInvitationResponse, BusinessContextResponse, ChangeRoleRequest, CreateBusinessRequest, CreateBusinessResponse,
  CreateInvitationRequest, InvitationResponse, InvitationsResponse, ListBusinessesResponse, MemberResponse, MembersResponse, OkResponse,
} from './tenancy.ts';

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
  // Sales Zone (docs/sales-data-model.md)
  listPipelines: { method: 'GET', path: '/api/v1/b/:slug/sales/pipelines', response: ListPipelinesResponse },
  createPipeline: { method: 'POST', path: '/api/v1/b/:slug/sales/pipelines', request: CreatePipelineRequest, response: PipelineResponse },
  listStages: { method: 'GET', path: '/api/v1/b/:slug/sales/stages', query: ListStagesQuery, response: ListStagesResponse },
  listOpportunities: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities', query: ListOpportunitiesQuery, response: ListOpportunitiesResponse },
  createOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities', request: CreateOpportunityRequest, response: OpportunityResponse },
  getOpportunity: { method: 'GET', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId', response: OpportunityResponse },
  updateOpportunity: { method: 'PATCH', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId', request: UpdateOpportunityRequest, response: OpportunityResponse },
  winOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/win', response: OpportunityResponse },
  loseOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/lose', request: LoseOpportunityRequest, response: OpportunityResponse },
  reopenOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/reopen', request: ReopenOpportunityRequest, response: OpportunityResponse },
  archiveOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/archive', response: OpportunityResponse },
  restoreOpportunity: { method: 'POST', path: '/api/v1/b/:slug/sales/opportunities/:opportunityId/restore', response: OpportunityResponse },
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
