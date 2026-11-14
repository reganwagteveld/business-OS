import type { CurrentUser } from '@business-os/contracts';
import type { AuthClient } from '../api/auth';
import type { BusinessContext, BusinessSummary, TenancyClient } from '../api/tenancy';
import type { WorkspaceStorage } from './storage';

/**
 * Where the app is after asking the server who you are and which businesses you belong to.
 * Nothing here is invented: every field comes from the API, and the active business is only ever
 * chosen from the server's membership list, never from what was saved locally.
 */
export type Phase =
  | { kind: 'booting'; message: string }
  | { kind: 'signed-out'; expired: boolean }
  | { kind: 'unreachable' }
  | { kind: 'failed' }
  | { kind: 'unverified'; user: CurrentUser }
  | { kind: 'no-workspace'; user: CurrentUser }
  | { kind: 'pick'; user: CurrentUser; businesses: BusinessSummary[] }
  | { kind: 'ready'; user: CurrentUser; businesses: BusinessSummary[]; context: BusinessContext };

export type Resolved = Exclude<Phase, { kind: 'booting' }>;

export interface ResolveDeps {
  auth: AuthClient;
  tenancy: TenancyClient;
  storage: WorkspaceStorage;
  /** An explicit choice made in this session (the picker or the switcher). Still checked against the server. */
  preferredSlug?: string | null;
  signal?: AbortSignal;
}

export async function resolveWorkspace(deps: ResolveDeps, attempt = 0): Promise<Resolved> {
  const { auth, tenancy, storage, signal } = deps;

  const session = await auth.session(signal);
  if (session.kind === 'unreachable') return { kind: 'unreachable' };
  if (session.kind === 'failed') return { kind: 'failed' };
  if (session.kind === 'signed-out') return { kind: 'signed-out', expired: storage.hadSession() };
  const user = session.user;
  storage.setHadSession(true);
  if (!user.emailVerified) return { kind: 'unverified', user };

  const listed = await tenancy.listBusinesses(signal);
  if (listed.kind === 'unauthenticated') return { kind: 'signed-out', expired: true };
  if (listed.kind === 'unverified') return { kind: 'unverified', user };
  if (listed.kind === 'unreachable') return { kind: 'unreachable' };
  if (listed.kind !== 'ok') return { kind: 'failed' };
  const businesses = listed.data;

  if (businesses.length === 0) {
    storage.clearSlug();
    return { kind: 'no-workspace', user };
  }

  const known = new Set(businesses.map((b) => b.slug));
  const saved = storage.getSlug();
  if (saved !== null && !known.has(saved)) storage.clearSlug(); // stale: no longer a member, or the slug changed
  const choice =
    deps.preferredSlug && known.has(deps.preferredSlug)
      ? deps.preferredSlug
      : saved !== null && known.has(saved)
        ? saved
        : businesses.length === 1
          ? businesses[0]!.slug
          : null;
  if (choice === null) return { kind: 'pick', user, businesses };

  const context = await tenancy.businessContext(choice, signal);
  if (context.kind === 'ok') {
    storage.setSlug(choice);
    return { kind: 'ready', user, businesses, context: context.data };
  }
  if (context.kind === 'unauthenticated') return { kind: 'signed-out', expired: true };
  if (context.kind === 'unreachable') return { kind: 'unreachable' };
  if (context.kind === 'not_found' && attempt === 0) {
    // Membership changed between the two calls: forget the choice and look again, once.
    storage.clearSlug();
    return resolveWorkspace({ ...deps, preferredSlug: null }, 1);
  }
  return { kind: 'failed' };
}

export type CreateFlowResult =
  | { kind: 'created'; slug: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'session-ended' };

/**
 * Creates a business, with the safeguards the UI relies on. After a network failure the server may
 * have committed, so memberships are read again BEFORE reporting an error or allowing a retry: if
 * the business is there, that is success (no duplicate). Messages are plain and actionable.
 */
export async function createBusinessFlow(tenancy: TenancyClient, input: { slug: string } & Record<string, unknown>): Promise<CreateFlowResult> {
  let result = await tenancy.createBusiness(input);
  if (result.kind === 'unreachable') {
    const check = await tenancy.listBusinesses();
    if (check.kind === 'ok' && check.data.some((b) => b.slug === input.slug)) result = { kind: 'ok', data: { slug: input.slug } };
  }
  switch (result.kind) {
    case 'ok':
      return { kind: 'created', slug: result.data.slug };
    case 'conflict':
      return { kind: 'rejected', message: 'That workspace address is already taken. Choose another.' };
    case 'invalid_input':
      return { kind: 'rejected', message: result.message };
    case 'rate_limited':
      return { kind: 'rejected', message: 'Too many attempts. Please wait a minute and try again.' };
    case 'unauthenticated':
      return { kind: 'session-ended' };
    case 'unreachable':
      return { kind: 'rejected', message: 'Cannot reach Business OS. Check your connection and try again.' };
    default:
      return { kind: 'rejected', message: 'Business OS could not create your business. Please try again.' };
  }
}
