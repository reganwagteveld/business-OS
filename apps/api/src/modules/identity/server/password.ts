import 'server-only';
// Account › Password (Settings A3-A component 2, settings-a3 §7.1, §10.2, §15.3): change your password while
// signed in. Needs the current password, checked on the server; ends every other session of the account.
import { RuleViolationError, StateConflictError } from '@/core/http/errors';
import { withAuthTransaction } from './auth-adapter';
import {
  consumeAccountLimit, credentialPassword, hashPassword, lockAccount, passwordMatches, recordFailedAttempt, recordIdentityEvent,
} from './account-support';

/**
 * Changes the caller's password.
 *
 * 1. Rate limit (5 attempts per hour per account, right or wrong), counted before anything else.
 * 2. The current password is verified against the stored hash, outside the transaction (scrypt is slow and
 *    must not hold the account lock). A wrong one is audited best effort and refused with `invalid_password`.
 * 3. In one transaction, under the account lock: the hash is replaced only if it is still the one verified in
 *    step 2 (a concurrent change answers `stale` and writes nothing), every other session is deleted (browser
 *    and desktop alike: each request checks the database, so they fail on their next request), any outstanding
 *    password-reset link is invalidated, and `identity.password.changed` is recorded. If the audit insert
 *    fails, the whole change rolls back.
 *
 * The session making the request stays signed in.
 */
export async function changePassword(input: { userId: string; sessionToken: string; currentPassword: string; newPassword: string }): Promise<{ otherSessionsEnded: number }> {
  await consumeAccountLimit('password', input.userId);
  const stored = await credentialPassword(input.userId);
  if (!stored) throw new StateConflictError('no_password');
  if (!await passwordMatches(stored.hash, input.currentPassword)) {
    await recordFailedAttempt(input.userId, input.sessionToken, 'identity.password.change_failed');
    throw new RuleViolationError('invalid_password', 'Your current password is not correct.');
  }
  if (input.newPassword === input.currentPassword) {
    throw new RuleViolationError('password_unchanged', 'Choose a new password that is different from your current one.');
  }
  const newHash = await hashPassword(input.newPassword);

  return withAuthTransaction(async (tx) => {
    const sessionId = await lockAccount(tx, input.userId, input.sessionToken);
    const replaced = await tx.account.updateMany({ where: { id: stored.accountId, userId: input.userId, password: stored.hash }, data: { password: newHash } });
    if (replaced.count !== 1) throw new StateConflictError('stale');
    const ended = await tx.session.deleteMany({ where: { userId: input.userId, id: { not: sessionId } } });
    // Better Auth keeps a reset link as `reset-password:<hashed token>` with the user id as its value.
    await tx.verification.deleteMany({ where: { identifier: { startsWith: 'reset-password:' }, value: input.userId } });
    await recordIdentityEvent(tx, {
      userId: input.userId, actorSessionId: sessionId, event: 'identity.password.changed', target: { type: 'user', id: input.userId },
      metadata: { otherSessionsEnded: ended.count },
    });
    return { otherSessionsEnded: ended.count };
  });
}
