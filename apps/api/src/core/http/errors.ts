import 'server-only';
// Errors a service may throw on purpose. The route wrappers turn each into one generic, stable
// response, so no service builds HTTP responses and no detail leaks (architecture §7.3).

/** The record does not exist in this business (or is not visible to it): always 404. */
export class RecordNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('not_found');
    this.name = 'RecordNotFoundError';
  }
}

export type StateConflictCode =
  | 'archived' | 'not_archived' | 'archived_reference' | 'not_open' | 'not_closed' | 'stale' | 'project_archived' | 'order_changed'
  // Finance (docs/finance-data-model.md §5): a document or setting is not in a state that allows the change.
  | 'invalid_state' | 'immutable' | 'invoice_not_open' | 'invoice_credited' | 'invoice_has_payments' | 'credit_exceeds_invoice'
  | 'series_in_use' | 'number_conflict' | 'idempotency_conflict' | 'quote_not_convertible' | 'totals_mismatch'
  // Finance F2: payments, allocations and credit applications.
  | 'payment_not_open' | 'credit_note_not_open' | 'over_allocation' | 'over_settlement' | 'over_application' | 'already_allocated'
  | 'already_applied' | 'already_reversed' | 'has_credit_applications'
  // Finance F3: expenses, categories, and payments made.
  | 'duplicate_name' | 'has_payments' | 'expense_not_open' | 'over_payment'
  // People (docs/people-data-model.md §4).
  | 'invalid_transition' | 'has_direct_reports' | 'manager_cycle' | 'in_use' | 'duplicate_employee_number' | 'user_already_linked' | 'terminated'
  | 'start_date_locked'
  // People P3-A (docs/people-leave-p3.md): leave configuration.
  | 'inactive_reference' | 'not_assigned'
  // Scheduling S1: the default calendar cannot be archived; cancelled events are read-only.
  | 'default_calendar' | 'not_scheduled'
  // Scheduling S2 (docs/scheduling-s2.md §3): an inactive resource cannot be newly assigned.
  | 'resource_inactive'
  // Finance F5 (docs/finance-documents-f5.md §7): generated documents.
  | 'not_eligible' | 'not_draft' | 'no_original' | 'version_limit' | 'document_too_large' | 'branding_logo_invalid'
  // Finance F6-2: a statement with more entries than one document holds (narrow the range).
  | 'statement_too_large'
  // Communications C2-A (docs/communications-c2.md §10): mailbox connections and sync jobs.
  | 'provider_not_configured' | 'already_connected' | 'account_mismatch' | 'disconnected' | 'not_active' | 'sync_disabled'
  // Reporting R1: per-owner saved-view cap; a stored view whose config this version cannot read.
  | 'too_many_views' | 'view_config_invalid'
  // Communications C2-B1 (docs/communications-c2.md §16): business mailbox identity, members and retention.
  | 'retention_not_set' | 'not_personal' | 'not_business' | 'consumer_domain' | 'domain_exists' | 'domain_not_verified' | 'domain_in_use'
  | 'already_verified' | 'dns_record_not_found' | 'dns_unavailable' | 'removed' | 'attestation_required' | 'attestation_not_applicable'
  | 'already_designated' | 'personal_connection_exists' | 'address_in_use'
  // Communications E1 (docs/communications-e1.md §8): erased history; an erased provider id cannot be imported again.
  | 'erased' | 'legal_hold_rule' | 'erasure_in_progress'
  // Finance F7-A (docs/finance-catalog-f7a.md): a catalog item's code is already used in this business.
  | 'duplicate_code'
  // Finance F7-B (docs/finance-catalog-f7b.md): an inactive catalog item cannot be added to a draft line.
  | 'catalog_item_inactive'
  // Administration A2-B (docs/administration-a2.md §6, §7): memberships and invitations.
  | 'invitation_exists' | 'already_member' | 'invitation_closed' | 'last_owner' | 'already_owner' | 'member_not_active'
  // WF-1 (docs/cross-zone-workflows-wf1.md §6.9): cross-Zone links.
  | 'project_customer_locked' | 'quote_not_accepted' | 'quote_has_project' | 'project_has_quote' | 'opportunity_set_by_quote'
  | 'opportunity_mismatch' | 'opportunity_lost' | 'opportunity_projects_changed'
  // Sales S-CFG-1A (docs/sales-pipeline-configuration-scfg.md §6): pipeline and stage configuration.
  | 'name_taken' | 'stage_limit' | 'pipeline_limit' | 'last_stage' | 'has_open_opportunities' | 'busy';

/** The request is well-formed but not allowed in the record's current state (e.g. editing an archived customer): 409. */
export class StateConflictError extends Error {
  readonly status = 409;
  constructor(readonly code: StateConflictCode) {
    super(code);
    this.name = 'StateConflictError';
  }
}

/**
 * The server could not complete the request and nothing was changed (Finance F5): `generation_failed`
 * (503, safe to retry) when a document could not be rendered, `integrity_error` (500) when stored bytes
 * no longer match their recorded checksum. No detail is returned.
 */
export class ServiceFailureError extends Error {
  constructor(readonly status: 500 | 503, readonly code: 'generation_failed' | 'integrity_error') {
    super(code);
    this.name = 'ServiceFailureError';
  }
}

/** Too many requests of this kind for now (A2-B: invitation resend throttle): 429, safe to retry later. */
export class RateLimitedError extends Error {
  readonly status = 429;
  constructor() {
    super('rate_limited');
    this.name = 'RateLimitedError';
  }
}

/** A business rule the contract schema cannot express was broken: 400 with a safe, human message. */
export class RuleViolationError extends Error {
  readonly status = 400;
  constructor(readonly code: string, readonly detail: string) {
    super(code);
    this.name = 'RuleViolationError';
  }
}

/**
 * The SQLSTATE of a database error, unwrapped from Prisma's driver-adapter error shapes (model
 * operations and raw queries report it in different places). Undefined for anything else.
 */
export function sqlState(error: unknown): string | undefined {
  const e = error as {
    code?: unknown; cause?: { originalCode?: unknown; code?: unknown };
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } };
  } | null;
  const candidates = [e?.meta?.driverAdapterError?.cause?.originalCode, e?.cause?.originalCode, e?.meta?.code, e?.cause?.code, e?.code];
  return candidates.find((c): c is string => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c));
}

/** True for a unique violation on the named index or constraint (from Prisma's error metadata or message). */
export function isUniqueViolation(error: unknown, name: string): boolean {
  if (sqlState(error) !== '23505' && (error as { code?: string } | null)?.code !== 'P2002') return false;
  const text = `${error instanceof Error ? error.message : ''} ${JSON.stringify((error as { meta?: unknown } | null)?.meta ?? {})}`;
  return text.includes(name);
}

/**
 * Global search (docs/global-search-gs1.md §5.5, §6.9). Raised only by the search service, so the global
 * handling of 57014 and pool errors elsewhere is unchanged. `slot`: no concurrency slot free (429, with
 * Retry-After); `pool`: no pooled connection in time (503).
 */
export class SearchBusyError extends Error {
  constructor(readonly reason: 'slot' | 'pool') {
    super('search_busy');
    this.name = 'SearchBusyError';
  }
}

/** The search statement hit its statement timeout (SQLSTATE 57014 inside the search service only): 503. */
export class SearchTimeoutError extends Error {
  constructor() {
    super('search_timeout');
    this.name = 'SearchTimeoutError';
  }
}
