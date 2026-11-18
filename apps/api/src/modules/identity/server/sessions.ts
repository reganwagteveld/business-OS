import 'server-only';
// Account › Signed-in devices (Settings A3-A component 3, settings-a3 §15.3, G-A3-3): list your sessions, end one
// other session, or end every session but this one.
//
// A session is ended by deleting its row. Both per-request checks look the row up in the database on every
// request (Better Auth's session lookup, with no cookie cache, and app_private's session resolution), so an
// ended session fails on its next request, browser or desktop.
import { RecordNotFoundError, RuleViolationError, SessionEndedError, StateConflictError } from '@/core/http/errors';
import { withAuthClient, withAuthTransaction } from './auth-adapter';
import {
  consumeAccountLimit, credentialPassword, lockAccount, passwordMatches, readCurrentSessionId, recordFailedAttempt, recordIdentityEvent,
} from './account-support';
import { DESKTOP_SESSION_USER_AGENT } from './desktop';

export const SESSION_LIST_LIMIT = 50;

export interface AccountSessionView {
  id: string;
  client: 'browser' | 'desktop';
  current: boolean;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

/**
 * The caller's live sessions, current first, then most recently active. Returns opaque ids only: never the
 * token, its hash, the IP address or the user agent.
 */
export async function listSessions(input: { userId: string; sessionToken: string }): Promise<{ sessions: AccountSessionView[]; truncated: boolean }> {
  return withAuthClient(async (db) => {
    const currentId = await readCurrentSessionId(db, input.userId, input.sessionToken);
    // The session was ended (or expired) after the request authenticated: answer 401, never a list.
    if (!currentId) throw new SessionEndedError();
    const rows = await db.session.findMany({
      where: { userId: input.userId, expiresAt: { gt: new Date() }, revokedAt: null },
      select: { id: true, userAgent: true, createdAt: true, updatedAt: true, expiresAt: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: SESSION_LIST_LIMIT + 1,
    });
    const truncated = rows.length > SESSION_LIST_LIMIT;
    let page = rows.slice(0, SESSION_LIST_LIMIT);
    // The current session is always listed, even when the list is cut.
    if (!page.some((row) => row.id === currentId)) {
      const current = await db.session.findUnique({ where: { id: currentId }, select: { id: true, userAgent: true, createdAt: true, updatedAt: true, expiresAt: true } });
      if (current) page = [current, ...page.slice(0, SESSION_LIST_LIMIT - 1)];
    }
    const sessions = page
      .map((row) => ({
        id: row.id,
        client: row.userAgent === DESKTOP_SESSION_USER_AGENT ? 'desktop' as const : 'browser' as const,
        current: row.id === currentId,
        createdAt: row.createdAt.toISOString(),
        lastActiveAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }))
      .sort((a, b) => Number(b.current) - Number(a.current));
    return { sessions, truncated };
  });
}

/**
 * Ends one of the caller's other sessions. The caller's own session answers `use_sign_out` (signing out is how
 * to end it, so a stray click cannot cut off the request in progress). Another person's session id, an unknown
 * id and an already-ended session all answer 404 alike.
 */
export async function revokeSession(input: { userId: string; sessionToken: string; targetSessionId: string }): Promise<void> {
  await consumeAccountLimit('revoke', input.userId);
  await withAuthTransaction(async (tx) => {
    const sessionId = await lockAccount(tx, input.userId, input.sessionToken);
    if (input.targetSessionId === sessionId) throw new StateConflictError('use_sign_out');
    const ended = await tx.session.deleteMany({ where: { id: input.targetSessionId, userId: input.userId } });
    if (ended.count !== 1) throw new RecordNotFoundError();
    await recordIdentityEvent(tx, {
      userId: input.userId, actorSessionId: sessionId, event: 'identity.session.revoked', target: { type: 'session', id: input.targetSessionId },
    });
  });
}

/**
 * Ends every session of the caller except the one making the request, in one statement inside one
 * transaction. Needs the current password, checked on the server (step-up, D-A3-11): a stolen session alone
 * cannot sign the real owner out everywhere.
 *
 * The password is verified before the account lock (scrypt must not hold it), so the proof is bound to the
 * exact hash it was checked against: under the lock the stored hash is read again and must still be that one.
 * If the password changed in between, the proof is stale and nothing is revoked or recorded (409 `stale`).
 */
export async function revokeOtherSessions(input: { userId: string; sessionToken: string; password: string }): Promise<{ ended: number }> {
  await consumeAccountLimit('revoke', input.userId);
  const stored = await credentialPassword(input.userId);
  if (!stored || !await passwordMatches(stored.hash, input.password)) {
    await recordFailedAttempt(input.userId, input.sessionToken, 'identity.sessions.revoke_others_failed');
    throw new RuleViolationError('invalid_password', 'Your password is not correct.');
  }
  return withAuthTransaction(async (tx) => {
    const sessionId = await lockAccount(tx, input.userId, input.sessionToken);
    const fresh = await tx.account.findUnique({ where: { id: stored.accountId }, select: { userId: true, password: true } });
    if (fresh?.userId !== input.userId || fresh.password !== stored.hash) throw new StateConflictError('stale');
    const ended = await tx.session.deleteMany({ where: { userId: input.userId, id: { not: sessionId } } });
    await recordIdentityEvent(tx, {
      userId: input.userId, actorSessionId: sessionId, event: 'identity.sessions.revoked_others', target: { type: 'user', id: input.userId }, metadata: { ended: ended.count },
    });
    return { ended: ended.count };
  });
}
