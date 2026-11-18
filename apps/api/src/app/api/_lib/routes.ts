import 'server-only';
// Route wrappers (architecture §7.3 layer 2). Every handler under app/api/v1/b/ is a tenantRoute;
// other authenticated handlers are publicRoutes. A wrapper authenticates (cookie or bearer), applies
// the CSRF policy, resolves the tenant from the URL against the caller's verified membership,
// authorises by permission key, validates input against the contract schema, and runs the handler
// inside one tenant unit of work. Handlers never see a client-supplied business id.
import type { z } from 'zod';
import { NextResponse } from 'next/server';
import { ForbiddenError, authorize, permissionsFor, type Permission } from '@/modules/access';
import { classifyAuthRequest, getCurrentUser, getSessionToken, type CurrentUser } from '@/modules/identity';
import { NotFoundError, type Actor } from '@/modules/tenancy';
import { betaSessionAdmitted, myMemberships, TenantScopeError, TransactionStartTimeoutError, TrustedPathError, withTenant, type AppTenantDb, type MembershipRow } from '@/core/db';
import { getEnv } from '@/core/config/env';
import { apiHeaders } from '@/core/http';
import {
  isUniqueViolation, RateLimitedError, RecordNotFoundError, RuleViolationError, SearchBusyError, SearchTimeoutError, ServiceFailureError, sqlState, StateConflictError,
} from '@/core/http/errors';

type Params = Promise<Record<string, string | string[] | undefined>>;
type RouteContext = { params: Params };

/** What a handler returns: a JSON body (validated by the contract) and work to run after commit. */
export interface Result<T> {
  status?: number;
  body: T;
  /** Network calls (e.g. email) happen only after the unit of work committed. */
  afterCommit?: () => Promise<void>;
}

const json = (request: Request, status: number, body: unknown) => NextResponse.json(body, { status, headers: apiHeaders(request) });
const fail = (request: Request, status: number, error: string) => json(request, status, { error });

/**
 * Finance guards raise their own SQLSTATEs (class FN, migration 20261115000000_finance), so an
 * integrity refusal maps to one stable error and is never confused with an RLS refusal. The services
 * check first and give the same codes; these are the database backstops. No detail is forwarded.
 */
const FINANCE_SQLSTATES: Record<string, [number, string]> = {
  FN001: [409, 'immutable'], FN002: [409, 'invalid_state'], FN003: [409, 'totals_mismatch'], FN004: [400, 'no_lines'],
  FN005: [409, 'invoice_not_open'], FN006: [409, 'invoice_credited'], FN007: [409, 'invoice_has_payments'], FN008: [409, 'series_in_use'],
  FN009: [409, 'invalid_state'], FN010: [409, 'immutable'], FN011: [400, 'unsupported_tax_mode'], FN012: [409, 'credit_exceeds_invoice'],
  FN013: [409, 'invoice_not_open'],
  // F2 (migration 20261116000000_finance_payments).
  FN014: [409, 'has_credit_applications'], FN015: [409, 'invalid_state'],
  // F3 (migration 20261117000000_finance_expenses).
  FN016: [409, 'has_payments'], FN017: [409, 'archived_reference'], FN018: [409, 'expense_not_open'],
  // F5 (migration 20261122000000_finance_documents): generated documents and branding assets.
  FN019: [409, 'not_eligible'], FN020: [409, 'stale'], FN021: [409, 'immutable'],
  // F7-A (migration 20261130000000_finance_catalog): catalog items.
  FN050: [409, 'immutable'], FN051: [409, 'archived'], FN052: [409, 'stale'],
  // People (migration 20261118000000_people, docs/people-data-model.md §4).
  PE001: [409, 'invalid_transition'], PE002: [409, 'manager_cycle'], PE003: [400, 'invalid_manager'], PE004: [409, 'immutable'],
  PE005: [409, 'has_direct_reports'], PE006: [409, 'terminated'], PE007: [409, 'archived_reference'], PE008: [409, 'in_use'],
  // People P3-A (migration 20261204000000_people_leave_policies, docs/people-leave-p3.md).
  PE009: [409, 'stale'], PE010: [409, 'archived'], PE011: [400, 'effective_date_order'], PE012: [409, 'inactive_reference'],
  // Communications C1 (migration 20261119300000_communications): history guards.
  CM001: [409, 'immutable'], CM002: [409, 'immutable'], CM003: [409, 'immutable'], CM004: [400, 'invalid_date'],
  // Communications C2-A (migration 20261121000000_communications_providers): connections and sync jobs.
  CM005: [409, 'immutable'], CM006: [409, 'disconnected'], CM007: [409, 'invalid_transition'],
  CM008: [409, 'holder_change_not_allowed'], CM009: [409, 'retention_not_set'], CM010: [409, 'business_mailbox_rule'],
  // Communications E1 (migration 20261201000000_communications_erasure): erased history, legal holds, the ledger.
  CM011: [409, 'erased'], CM012: [409, 'legal_hold_rule'], CM013: [409, 'immutable'],
  // WF-1B-1 (migration 20261207000000_workflow_links, docs/cross-zone-workflows-wf1.md §5.4): projects_guard_links.
  WF001: [409, 'project_has_quote'], WF002: [409, 'quote_not_accepted'], WF003: [409, 'quote_has_project'], WF004: [409, 'opportunity_mismatch'],
  // Sales S-CFG-1A (migration 20261210000000_sales_configuration, docs/sales-pipeline-configuration-scfg.md §6.4).
  SA001: [409, 'archived_reference'], SA002: [409, 'has_open_opportunities'], SA003: [409, 'last_stage'], SA004: [409, 'immutable'],
};

/**
 * F2 settlement CHECKs and live-link unique indexes, by name: the database backstops behind the
 * service checks (a race the service lost). Stable codes, no detail.
 */
const FINANCE_CONSTRAINTS: [RegExp, string][] = [
  [/finance_documents_settled|finance_documents_allocated/, 'over_settlement'],
  [/finance_payments_allocated/, 'over_allocation'],
  [/finance_documents_credit_applied/, 'over_application'],
  [/finance_payment_allocations_active_key/, 'already_allocated'],
  [/finance_credit_applications_active_key/, 'already_applied'],
  [/finance_payments_idempotency_key/, 'idempotency_conflict'],
  // F3.
  [/finance_expenses_paid/, 'over_payment'],
  [/finance_expense_allocations_active_key/, 'already_allocated'],
  [/finance_expense_categories_active_name_key/, 'duplicate_name'],
  // F7-A.
  [/finance_catalog_items_code_key/, 'duplicate_code'],
  // People: the unique indexes behind the service checks (a race the service lost).
  [/people_employees_number_key/, 'duplicate_employee_number'],
  [/people_employees_user_key/, 'user_already_linked'],
  [/people_departments_active_name_key|people_locations_active_name_key/, 'duplicate_name'],
  [/people_leave_types_active_name_key|people_leave_policies_active_name_key/, 'duplicate_name'],
  [/people_leave_policy_assignments_open_key/, 'stale'],
  [/people_department_assignments_open_key|people_manager_assignments_open_key|people_employee_personal_details_pkey/, 'stale'],
  // Sales S-CFG-1A (§4.3): active stage and pipeline names, behind the service checks.
  [/sales_stages_active_name_key|sales_pipelines_active_name_key/, 'name_taken'],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Maps known failures to generic responses; anything unexpected is a 500 with no detail. */
function errorResponse(request: Request, error: unknown): Response {
  if (error instanceof ForbiddenError || error instanceof TenantScopeError) return fail(request, 403, 'forbidden');
  if (error instanceof NotFoundError || error instanceof RecordNotFoundError) return fail(request, 404, 'not_found');
  if (error instanceof StateConflictError) return fail(request, 409, error.code);
  if (error instanceof ServiceFailureError) return fail(request, error.status, error.code);
  if (error instanceof RateLimitedError) return fail(request, 429, 'rate_limited');
  // Global search only (GS1 §5.5, §6.9): no concurrency slot (429, retry after 1 s), no pooled connection
  // in time or the search statement's own timeout (503). Other routes never raise these.
  if (error instanceof SearchBusyError) {
    if (error.reason === 'pool') return fail(request, 503, 'search_busy');
    const response = fail(request, 429, 'search_busy');
    response.headers.set('Retry-After', '1');
    return response;
  }
  if (error instanceof SearchTimeoutError) return fail(request, 503, 'search_timeout');
  if (error instanceof RuleViolationError) return json(request, 400, { error: error.code, message: error.detail });
  if (error instanceof TrustedPathError) {
    const status = { not_allowed: 403, invalid: 400, slug_unavailable: 409, rate_limited: 429, invitation_invalid: 400, business_creation_not_permitted: 403 }[error.reason];
    return fail(request, status, error.reason);
  }
  const state = sqlState(error);
  const finance = state ? FINANCE_SQLSTATES[state] : undefined;
  if (finance) return fail(request, finance[0], finance[1]);
  // Deadlock, serialization failure or lock timeout: the unit of work rolled back whole and may be
  // retried by the client. The API retries a mutation itself only where a route opts in (retryOnConflict, A2-B).
  if (state === '40P01' || state === '40001' || state === '55P03') return fail(request, 503, 'retryable');
  if (isUniqueViolation(error, 'finance_documents_business_id_kind_number')) return fail(request, 409, 'number_conflict');
  // A concurrent import of the same external id won the race; retrying reports it as a duplicate.
  if (isUniqueViolation(error, 'messages_external_key')) return fail(request, 409, 'idempotency_conflict');
  // Another member connected the same mailbox at the same moment (C2-A).
  if (isUniqueViolation(error, 'mail_connections_live_account_key')) return fail(request, 409, 'already_connected');
  if (isUniqueViolation(error, 'mail_business_domains_live_key')) return fail(request, 409, 'domain_exists');
  if (isUniqueViolation(error, 'mail_business_addresses_live_key')) return fail(request, 409, 'already_designated');
  if (state === '23514' || state === '23505') {
    const text = `${error instanceof Error ? error.message : ''} ${JSON.stringify((error as { meta?: unknown } | null)?.meta ?? {})}`;
    const hit = FINANCE_CONSTRAINTS.find(([pattern]) => pattern.test(text));
    if (hit) return fail(request, 409, hit[1]);
  }
  // WF-1B-1 (§5.2, §5.3): the customer-consistency FKs, behind the service checks. On the referencing side
  // (a Finance record links a project of another customer) the record is refused; on the referenced side (a
  // project's customer changes while customer-specific records or its source quote link it) the project is locked.
  if (state === '23503') {
    const text = `${error instanceof Error ? error.message : ''} ${JSON.stringify((error as { meta?: unknown } | null)?.meta ?? {})}`;
    if (/projects_source_quote_fkey/.test(text) || (/_project_customer_fkey/.test(text) && /update or delete on table \\?"projects\\?"/.test(text))) {
      return fail(request, 409, 'project_customer_locked');
    }
    if (/_project_customer_fkey/.test(text)) return fail(request, 400, 'project_customer_mismatch');
  }
  if (state === '22003') return fail(request, 400, 'invalid_amount');
  const message = error instanceof Error ? error.message : '';
  const code = (error as { code?: string } | null)?.code;
  if (/at least one owner/.test(message)) return fail(request, 409, 'last_owner');
  // Administration A2-A: the businesses time-zone guard (the API checks first; this is the backstop).
  if (/unknown time zone/.test(message)) return fail(request, 400, 'invalid_input');
  // Database guarantees surfacing as client errors: a reference to another business's record (or a
  // primary contact that is not this customer's), or a CHECK the schema did not catch. Never details.
  if (code === 'P2003' || /foreign key constraint/i.test(message)) return fail(request, 400, 'invalid_reference');
  if (code === 'P2025') return fail(request, 404, 'not_found');
  if (/violates check constraint/i.test(message)) return fail(request, 400, 'invalid_input');
  if (/role change not allowed|status change not allowed/.test(message)) return fail(request, 403, 'forbidden');
  console.error('[api] unexpected error', error instanceof Error ? error.name : typeof error);
  return fail(request, 500, 'internal_error');
}

async function readInput<S extends z.ZodType>(request: Request, schema: S | undefined): Promise<{ ok: true; data: z.infer<S> } | { ok: false }> {
  if (!schema) return { ok: true, data: undefined as z.infer<S> };
  const body = await request.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

/** Authentication and CSRF shared by the wrappers. Returns the user, or a response to send. */
async function authenticate(request: Request, invitationRedemption = false): Promise<{ user: CurrentUser; sessionToken: string } | Response> {
  const mode = classifyAuthRequest(request);
  if (mode.kind === 'reject') return fail(request, mode.status, mode.error);
  const user = await getCurrentUser(request);
  const sessionToken = await getSessionToken(request);
  if (!user || !sessionToken) return fail(request, 401, 'unauthenticated');
  if (!user.emailVerified) return fail(request, 403, 'email_not_verified');
  if (!invitationRedemption && !await betaSessionAdmitted(sessionToken)) return fail(request, 403, 'invite_required');
  return { user, sessionToken };
}

/** Signed-in routes that do not belong to one business (list/create businesses, accept invitation). */
export function publicRoute<S extends z.ZodType | undefined, T>(
  opts: { input?: S; response: z.ZodType<T>; invitationRedemption?: boolean },
  handler: (args: { request: Request; user: CurrentUser; sessionToken: string; input: S extends z.ZodType ? z.infer<S> : undefined }) => Promise<Result<T>>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const auth = await authenticate(request, opts.invitationRedemption === true);
      if (auth instanceof Response) return auth;
      const input = await readInput(request, opts.input);
      if (!input.ok) return fail(request, 400, 'invalid_input');
      const result = await handler({ request, ...auth, input: input.data as never });
      await result.afterCommit?.();
      return json(request, result.status ?? 200, opts.response.parse(result.body));
    } catch (error) {
      return errorResponse(request, error);
    }
  };
}

/**
 * Tenant routes: /api/v1/b/{slug}/… The slug is resolved to a business through the caller's own
 * active memberships (in the database, from the verified session token) on every request; an
 * unknown slug and a business the caller does not belong to both answer 404.
 */
type Resolved = { auth: { user: CurrentUser; sessionToken: string }; params: Record<string, string>; membership: { businessId: string }; actor: Actor };

/**
 * Shared by the tenant wrappers: authenticates, resolves the slug to a business through the caller's
 * own active memberships (in the database, from the verified session token) and authorises. An unknown
 * slug and a business the caller does not belong to both answer 404.
 */
async function resolveTenant(request: Request, context: RouteContext, permission: Permission | readonly Permission[]): Promise<Resolved | Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const raw = await context.params;
  const params = Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const membership = (await myMemberships(auth.sessionToken)).find((m) => m.slug === params.slug);
  if (!membership) return fail(request, 404, 'not_found');
  const actor: Actor = {
    userId: auth.user.id,
    membershipId: membership.membershipId,
    role: membership.role,
    permissions: new Set(permissionsFor(membership.role)),
  };
  // All-of (WF-1 §7, W1 §10): a cross-Zone route names every key it needs; each is checked.
  for (const key of typeof permission === 'string' ? [permission] : permission) authorize(actor, key);
  return { auth, params, membership, actor };
}

const CONFLICT_RETRY_ATTEMPTS = 3;

/** Runs `attempt` again (short jittered pause) while it fails with 40P01/40001; the last error is thrown. */
async function withConflictRetry<R>(attempt: () => Promise<R>): Promise<R> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      const state = sqlState(error);
      if (n >= CONFLICT_RETRY_ATTEMPTS || (state !== '40P01' && state !== '40001')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40) * n));
    }
  }
}

/**
 * Tenant routes: /api/v1/b/{slug}/… The slug is resolved to a business through the caller's own
 * active memberships (in the database, from the verified session token) on every request; an
 * unknown slug and a business the caller does not belong to both answer 404.
 */
export function tenantRoute<S extends z.ZodType | undefined, T, Q extends z.ZodType | undefined = undefined>(
  opts: {
    /**
     * The key the caller must hold. A cross-Zone route (WF-1 §7) lists several: all of them are required
     * (all-of), so holding one Zone's key never grants another Zone's data.
     */
    permission: Permission | readonly [Permission, ...Permission[]];
    input?: S; query?: Q; response: z.ZodType<T>; /** Unit-of-work timeout; default 5 s (F5 rendering: 15 s). */ timeoutMs?: number;
    /**
     * E1 (docs/communications-e1.md §8): hand the raw session token to the handler, which passes it to a
     * privileged database function that verifies the caller itself. Only the erasure routes set it
     * (boundary rule); every other handler never sees the token.
     */
    sessionToken?: true;
    /**
     * Administration A2-B (docs/administration-a2.md §3.10): re-run the whole unit of work, up to 3
     * attempts, when PostgreSQL aborted it with a deadlock (40P01) or serialization failure (40001).
     * Only for handlers whose work is entirely inside the transaction (it rolled back whole) and whose
     * after-commit work runs once, after the attempt that committed.
     */
    retryOnConflict?: boolean;
    /**
     * Global search (GS1 §5.5): Prisma `maxWait` for a pooled connection. When the unit of work could not
     * start in time, the route answers 503 search_busy instead of the generic 500. Only the search routes set it.
     */
    maxWaitMs?: number;
    /**
     * A route that is not switched on yet (global search, GS2 §12.1): while this returns false the route
     * answers 404 not_found to every caller before any authentication, tenant or database work, exactly as
     * if it did not exist.
     */
    available?: () => boolean;
  },
  handler: (args: {
    request: Request;
    actor: Actor;
    db: AppTenantDb;
    sessionToken: string | null;
    params: Record<string, string>;
    input: S extends z.ZodType ? z.infer<S> : undefined;
    query: Q extends z.ZodType ? z.infer<Q> : undefined;
  }) => Promise<Result<T>>,
) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    if (opts.available && !opts.available()) return fail(request, 404, 'not_found');
    try {
      const resolved = await resolveTenant(request, context, opts.permission);
      if (resolved instanceof Response) return resolved;
      const { auth, params, membership, actor } = resolved;
      const input = await readInput(request, opts.input);
      if (!input.ok) return fail(request, 400, 'invalid_input');
      let query: unknown = undefined;
      if (opts.query) {
        const parsed = opts.query.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
        if (!parsed.success) return fail(request, 400, 'invalid_query');
        query = parsed.data;
      }
      const attempt = () => withTenant({ businessId: membership.businessId, userId: auth.user.id }, (db) =>
        handler({ request, actor, db, params, input: input.data as never, query: query as never, sessionToken: opts.sessionToken ? auth.sessionToken : null }),
      opts.timeoutMs || opts.maxWaitMs ? { timeoutMs: opts.timeoutMs, maxWaitMs: opts.maxWaitMs } : undefined);
      let result: Result<T>;
      try {
        result = opts.retryOnConflict ? await withConflictRetry(attempt) : await attempt();
      } catch (error) {
        // The unit of work never started: no pooled connection within maxWait (only routes that set it: search).
        if (opts.maxWaitMs && error instanceof TransactionStartTimeoutError) throw new SearchBusyError('pool');
        throw error;
      }
      await result.afterCommit?.();
      return json(request, result.status ?? 200, opts.response.parse(result.body));
    } catch (error) {
      return errorResponse(request, error);
    }
  };
}

/**
 * Tenant routes whose work includes a network call (C2-B1 domain verification: a DNS lookup). Same
 * authentication, tenancy, authorisation and error mapping as tenantRoute, but the handler gets `run`
 * instead of one `db`: it opens a unit of work, makes the call with no transaction open, then opens
 * another (the pattern of the OAuth callback, docs/communications-c2.md §7.1).
 */
export function tenantRunRoute<S extends z.ZodType | undefined, T>(
  opts: { permission: Permission; input?: S; response: z.ZodType<T> },
  handler: (args: {
    request: Request;
    actor: Actor;
    params: Record<string, string>;
    input: S extends z.ZodType ? z.infer<S> : undefined;
    run: <R>(work: (db: AppTenantDb) => Promise<R>) => Promise<R>;
  }) => Promise<Result<T>>,
) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    try {
      const resolved = await resolveTenant(request, context, opts.permission);
      if (resolved instanceof Response) return resolved;
      const { auth, params, membership, actor } = resolved;
      const input = await readInput(request, opts.input);
      if (!input.ok) return fail(request, 400, 'invalid_input');
      const run = <R>(work: (db: AppTenantDb) => Promise<R>) => withTenant({ businessId: membership.businessId, userId: auth.user.id }, work);
      const result = await handler({ request, actor, params, input: input.data as never, run });
      await result.afterCommit?.();
      return json(request, result.status ?? 200, opts.response.parse(result.body));
    } catch (error) {
      return errorResponse(request, error);
    }
  };
}

/** A file a tenant route returns instead of JSON (Finance F5: PDFs and logos). */
export interface FileResult {
  bytes: Uint8Array;
  contentType: 'application/pdf' | 'image/png' | 'image/jpeg';
  /** A complete Content-Disposition value (see contentDisposition in the finance module), or omitted for images. */
  disposition?: string;
  sha256: string;
  /** Draft previews: some text used characters the fonts cannot draw (sent as X-Unsupported-Characters: true). */
  unsupportedCharacters?: boolean;
}

/**
 * Tenant routes that answer with a file (GET only). Same authentication, tenancy, authorisation and
 * error mapping as tenantRoute; errors are still JSON. The file is never cached (private, no-store),
 * never sniffed (nosniff), and carries its checksum. CORS callers (the desktop app) may read the
 * file name and checksum headers.
 */
export function tenantFileRoute(
  opts: { permission: Permission },
  handler: (args: { request: Request; actor: Actor; db: AppTenantDb; params: Record<string, string> }) => Promise<FileResult>,
) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    try {
      const resolved = await resolveTenant(request, context, opts.permission);
      if (resolved instanceof Response) return resolved;
      const { auth, params, membership, actor } = resolved;
      const file = await withTenant({ businessId: membership.businessId, userId: auth.user.id }, (db) => handler({ request, actor, db, params }), { timeoutMs: 15_000 });
      const headers: Record<string, string> = {
        ...apiHeaders(request),
        'Content-Type': file.contentType,
        'Content-Length': String(file.bytes.byteLength),
        'X-Document-Sha256': file.sha256,
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-site',
      };
      if (file.disposition) headers['Content-Disposition'] = file.disposition;
      if (file.unsupportedCharacters !== undefined) headers['X-Unsupported-Characters'] = String(file.unsupportedCharacters);
      if (headers['Access-Control-Allow-Origin']) headers['Access-Control-Expose-Headers'] = 'Content-Disposition, X-Document-Sha256, X-Unsupported-Characters';
      return new Response(file.bytes as unknown as BodyInit, { status: 200, headers });
    } catch (error) {
      return errorResponse(request, error);
    }
  };
}

/**
 * Browser navigation targets that must answer with a page, not JSON: the OAuth provider redirects
 * the browser here (docs/communications-c2.md §7.1). Same authentication as the other wrappers (the
 * signed-in session in this browser is required); GET only, so CSRF does not apply. The page is
 * static text chosen by the handler: no input is ever echoed, nothing is cached, nothing can be
 * framed and no script runs.
 */
/**
 * `returnCode` is a fixed word chosen by the handler (never user input): the page then offers a link back to the
 * application at `${APP_BASE_URL}/?mailbox=<code>`, which shows fixed wording for that code. No token, id or provider text.
 */
export interface BrowserPage { status: number; title: string; message: string; returnCode?: 'connected' | 'reconnected' | 'declined' | 'invalid_state' | 'insufficient_scope' | 'account_mismatch' | 'already_connected' | 'not_allowed' | 'error' }

export function browserRoute(
  handler: (args: { request: Request; user: CurrentUser | null; sessionToken: string | null; memberships: (slug: string) => Promise<MembershipRow | undefined> }) => Promise<BrowserPage>,
) {
  return async (request: Request): Promise<Response> => {
    let page: BrowserPage;
    try {
      const auth = await authenticate(request);
      const signedIn = auth instanceof Response ? null : auth;
      page = await handler({
        request,
        user: signedIn?.user ?? null,
        sessionToken: signedIn?.sessionToken ?? null,
        memberships: async (slug) => (signedIn ? (await myMemberships(signedIn.sessionToken)).find((m) => m.slug === slug) : undefined),
      });
    } catch (error) {
      console.error('[api] unexpected error', error instanceof Error ? error.name : typeof error);
      page = { status: 500, title: 'Something went wrong', message: 'Nothing was connected. Please try again from Business OS.' };
    }
    const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const back = page.returnCode
      ? `<p><a href="${escape(new URL(`/?mailbox=${page.returnCode}`, getEnv().APP_BASE_URL).toString())}" rel="noreferrer">Return to Pixa OS</a></p>`
      : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<meta name="referrer" content="no-referrer"><title>${escape(page.title)}</title></head>`
      + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">`
      + `<h1 style="font-size:1.25rem">${escape(page.title)}</h1><p>${escape(page.message)}</p>${back}</body></html>`;
    return new Response(html, {
      status: page.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      },
    });
  };
}
