import { permissionsFor } from '@/modules/access';
import {
  AuthorizationFailure, completeAuthorization, consumeAuthorization, oauthRedirectUri, parseState, ProviderError, providerAdapter, recordAuthorizationFailure,
  type CallbackFailure, type ConnectionViewer, type MailProvider, type PendingAuthorization,
} from '@/modules/communications';
import { withTenant } from '@/core/db';
import { isUniqueViolation } from '@/core/http/errors';
import { connectionViewer } from '../../../../_lib/communications';
import { browserRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

const FAILURES: Record<CallbackFailure, [number, string]> = {
  unauthenticated: [401, 'Sign in to Business OS in this browser, then start connecting your mailbox again.'],
  invalid_state: [400, 'This link has expired or was already used. Start connecting your mailbox again from Business OS.'],
  declined: [400, 'Access was not granted, so nothing was connected.'],
  insufficient_scope: [400, 'Business OS needs read access to your mail. Nothing was connected; try again and allow every permission requested.'],
  account_mismatch: [409, 'You signed in with a different mailbox than the one being reconnected. Nothing was changed.'],
  already_connected: [409, 'Someone else in this business has already connected this mailbox. Nothing was changed.'],
  disconnected: [409, 'This mailbox connection was removed. Connect it again from Business OS.'],
  not_allowed: [403, 'You are not allowed to connect mailboxes in this business.'],
  provider_error: [502, 'The mail provider did not complete the connection. Nothing was connected; please try again later.'],
};
const failed = (reason: CallbackFailure) => ({ status: FAILURES[reason][0], title: 'Mailbox not connected', message: `${FAILURES[reason][1]} (${reason})` });

/**
 * The provider redirects the browser here after consent (docs/communications-c2.md §7.1). The
 * signed-in session in THIS browser must be the user who started the consent, so nobody can attach
 * someone else's mailbox to their business. Provider calls run between two units of work.
 */
export const GET = browserRoute(async ({ request, user, memberships }) => {
  const url = new URL(request.url);
  if (!user) return failed('unauthenticated');
  const state = parseState(url.searchParams.get('state'));
  const membership = state ? await memberships(state.slug) : undefined;
  if (!state || !membership) return failed('invalid_state');
  const viewer: ConnectionViewer = connectionViewer({
    userId: user.id, membershipId: membership.membershipId, role: membership.role, permissions: new Set(permissionsFor(membership.role)),
  });
  const run = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ businessId: membership.businessId, userId: user.id }, work);
  const audit = (pending: PendingAuthorization, reason: CallbackFailure) =>
    run((db) => recordAuthorizationFailure(db, viewer, pending.connectionId ?? pending.stateId, pending.provider, reason));

  const first = await run(async (db) => {
    const pending = await consumeAuthorization(db, viewer, state.nonce);
    if (!pending) return { ok: false as const, reason: 'invalid_state' as CallbackFailure };
    let reason: CallbackFailure | null = null;
    if (!viewer.canConnect) reason = 'not_allowed';
    else if (url.searchParams.has('error') || !url.searchParams.get('code')) reason = 'declined';
    if (!reason) return { ok: true as const, pending };
    await recordAuthorizationFailure(db, viewer, pending.connectionId ?? pending.stateId, pending.provider, reason);
    return { ok: false as const, reason };
  });
  if (!first.ok) return failed(first.reason);
  const { pending } = first;
  const adapter = providerAdapter(pending.provider as MailProvider);
  if (!adapter) {
    await audit(pending, 'provider_error');
    return failed('provider_error');
  }
  const code = url.searchParams.get('code')!.slice(0, 4096);
  // C2A-03: tokens issued for a refused connection are DISCARDED, never revoked. A Google revocation
  // removes the whole grant of that account to this app, which would also break a legitimate
  // connection of the same mailbox (another member's, or in another business). Nothing is stored,
  // so the discarded tokens are unreachable; the user can remove the grant in their account.
  try {
    const issued = await adapter.exchangeCode({ code, codeVerifier: pending.codeVerifier, redirectUri: oauthRedirectUri() });
    if (!adapter.hasScopes(issued.scopes, 'read')) {
      await audit(pending, 'insufficient_scope');
      return failed('insufficient_scope');
    }
    const account = await adapter.account(issued.accessToken);
    const result = await run((db) => completeAuthorization(db, viewer, pending, issued, account));
    return {
      status: 200,
      title: result.outcome === 'connected' ? 'Mailbox connected' : 'Mailbox reconnected',
      message: 'You can close this window and return to Business OS. No mail has been read yet.',
    };
  } catch (error) {
    const reason: CallbackFailure | null = error instanceof AuthorizationFailure ? error.reason
      : isUniqueViolation(error, 'mail_connections_live_account_key') ? 'already_connected'
      : error instanceof ProviderError ? 'provider_error' : null;
    if (!reason) throw error;
    await audit(pending, reason);
    return failed(reason);
  }
});
