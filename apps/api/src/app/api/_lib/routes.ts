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
import { myMemberships, TenantScopeError, TrustedPathError, withTenant, type AppTenantDb } from '@/core/db';
import { apiHeaders } from '@/core/http';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Maps known failures to generic responses; anything unexpected is a 500 with no detail. */
function errorResponse(request: Request, error: unknown): Response {
  if (error instanceof ForbiddenError || error instanceof TenantScopeError) return fail(request, 403, 'forbidden');
  if (error instanceof NotFoundError || error instanceof RecordNotFoundError) return fail(request, 404, 'not_found');
  if (error instanceof StateConflictError) return fail(request, 409, error.code);
  if (error instanceof RuleViolationError) return json(request, 400, { error: error.code, message: error.detail });
  if (error instanceof TrustedPathError) {
    const status = { not_allowed: 403, invalid: 400, slug_unavailable: 409, rate_limited: 429, invitation_invalid: 400 }[error.reason];
    return fail(request, status, error.reason);
  }
  const message = error instanceof Error ? error.message : '';
  const code = (error as { code?: string } | null)?.code;
  if (/at least one owner/.test(message)) return fail(request, 409, 'last_owner');
  // Database guarantees surfacing as client errors: a reference to another business's record (or a
  // primary contact that is not this customer's), or a CHECK the schema did not catch. Never details.
  if (code === 'P2003' || /foreign key constraint/i.test(message)) return fail(request, 400, 'invalid_reference');
  if (code === 'P2025') return fail(request, 404, 'not_found');
  if (/violates check constraint/i.test(message)) return fail(request, 400, 'invalid_input');
  if (/role change not allowed/.test(message)) return fail(request, 403, 'forbidden');
  console.error('[api] unexpected error', error instanceof Error ? error.name : typeof error);
  return fail(request, 500, 'internal_error');
}

async function readInput<S extends z.ZodType>(request: Request, schema: S | undefined): Promise<{ ok: true; data: z.infer<S> } | { ok: false }> {
  if (!schema) return { ok: true, data: undefined as z.infer<S> };
  const body = await request.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

/** Authentication and CSRF shared by both wrappers. Returns the user, or a response to send. */
async function authenticate(request: Request): Promise<{ user: CurrentUser; sessionToken: string } | Response> {
  const mode = classifyAuthRequest(request);
  if (mode.kind === 'reject') return fail(request, mode.status, mode.error);
  const user = await getCurrentUser(request);
  const sessionToken = await getSessionToken(request);
  if (!user || !sessionToken) return fail(request, 401, 'unauthenticated');
  if (!user.emailVerified) return fail(request, 403, 'email_not_verified');
  return { user, sessionToken };
}

/** Signed-in routes that do not belong to one business (list/create businesses, accept invitation). */
export function publicRoute<S extends z.ZodType | undefined, T>(
  opts: { input?: S; response: z.ZodType<T> },
  handler: (args: { request: Request; user: CurrentUser; sessionToken: string; input: S extends z.ZodType ? z.infer<S> : undefined }) => Promise<Result<T>>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const auth = await authenticate(request);
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
export function tenantRoute<S extends z.ZodType | undefined, T, Q extends z.ZodType | undefined = undefined>(
  opts: { permission: Permission; input?: S; query?: Q; response: z.ZodType<T> },
  handler: (args: {
    request: Request;
    actor: Actor;
    db: AppTenantDb;
    params: Record<string, string>;
    input: S extends z.ZodType ? z.infer<S> : undefined;
    query: Q extends z.ZodType ? z.infer<Q> : undefined;
  }) => Promise<Result<T>>,
) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    try {
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
      authorize(actor, opts.permission);
      const input = await readInput(request, opts.input);
      if (!input.ok) return fail(request, 400, 'invalid_input');
      let query: unknown = undefined;
      if (opts.query) {
        const parsed = opts.query.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
        if (!parsed.success) return fail(request, 400, 'invalid_query');
        query = parsed.data;
      }
      const result = await withTenant({ businessId: membership.businessId, userId: auth.user.id }, (db) =>
        handler({ request, actor, db, params, input: input.data as never, query: query as never }),
      );
      await result.afterCommit?.();
      return json(request, result.status ?? 200, opts.response.parse(result.body));
    } catch (error) {
      return errorResponse(request, error);
    }
  };
}
