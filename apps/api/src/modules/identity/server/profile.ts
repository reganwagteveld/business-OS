import 'server-only';
// Account › Profile (Settings A3-A component 1, settings-a3 §7.1, G-A3-4): the signed-in person changes their
// own display name. No other field: email change is deferred (D-A3-6), avatars are deferred (D-A3-4).
import { withAuthTransaction } from './auth-adapter';
import { consumeAccountLimit, lockAccount, recordIdentityEvent } from './account-support';
import type { CurrentUser } from './session';

/**
 * Sets the caller's display name. The user comes from the verified session, never from the request. An
 * unchanged name writes nothing and records nothing. The audit row carries the field name only, never the
 * old or new value.
 */
export async function updateDisplayName(input: { userId: string; sessionToken: string; name: string }): Promise<CurrentUser> {
  await consumeAccountLimit('profile', input.userId);
  return withAuthTransaction(async (tx) => {
    const sessionId = await lockAccount(tx, input.userId, input.sessionToken);
    const select = { id: true, email: true, name: true, emailVerified: true } as const;
    const current = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select });
    if (current.name === input.name) return current;
    const updated = await tx.user.update({ where: { id: input.userId }, data: { name: input.name }, select });
    await recordIdentityEvent(tx, {
      userId: input.userId, actorSessionId: sessionId, event: 'identity.profile.name_changed', target: { type: 'user', id: input.userId }, metadata: { fields: ['name'] },
    });
    return updated;
  });
}
