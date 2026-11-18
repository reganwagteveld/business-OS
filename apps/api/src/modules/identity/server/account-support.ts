import 'server-only';
// Shared controls for the account-management services (Settings A3-A, docs/settings-a3-architecture.md
// §15.2–15.4): the per-account lock, the current-session check, rate limits and the identity audit trail.
// Profile, password and session services each build on these and nothing else, so each can be tested alone.
import { randomUUID } from 'node:crypto';
import { RateLimitedError, SessionEndedError } from '@/core/http/errors';
import { getAuth, withAuthClient, type AuthTx } from './auth-adapter';
import { sha256Hex } from './hashed-adapter';

// ---- Identity audit (§15.4, D-A3-12) ------------------------------------------------------------------
//
// Identity events have no business. They are written as platform rows of the append-only `audit_events`
// table (business_id IS NULL): bos_auth may only INSERT them (policy audit_platform_write), no runtime role
// can read, change or delete them, and tenant code never sees them (audit_tenant_read requires a business).
// Every event and its metadata keys are allow-listed here. Never written: passwords, tokens, token hashes,
// emails, names (old or new), IP addresses, user agents or request bodies.

const EVENT_METADATA = {
  'identity.profile.name_changed': ['fields'],
  'identity.password.changed': ['otherSessionsEnded'],
  'identity.password.change_failed': ['reason'],
  'identity.session.revoked': [],
  'identity.sessions.revoked_others': ['ended'],
  'identity.sessions.revoke_others_failed': ['reason'],
} as const satisfies Record<string, readonly string[]>;

export type IdentityEvent = keyof typeof EVENT_METADATA;
type Metadata = Record<string, string | number | readonly string[]>;

export interface IdentityEventInput {
  userId: string;
  /** The opaque id of the session that acted (never its token). */
  actorSessionId: string | null;
  event: IdentityEvent;
  target: { type: 'user' | 'session'; id: string };
  metadata?: Metadata;
}

export class IdentityAuditError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IdentityAuditError';
  }
}

/**
 * Writes one identity event. Called inside the change's transaction, so a failed insert rolls the change back
 * (fail closed, §15.4). Unknown events and metadata keys are refused before anything is written.
 */
export async function recordIdentityEvent(db: AuthTx, input: IdentityEventInput): Promise<void> {
  const allowed: readonly string[] | undefined = EVENT_METADATA[input.event];
  if (!allowed) throw new IdentityAuditError('unknown identity event');
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  for (const key of Object.keys(metadata)) {
    if (!allowed.includes(key)) throw new IdentityAuditError('metadata key not allowed for this event');
  }
  if (input.actorSessionId !== null) metadata.actorSessionId = input.actorSessionId;
  // createMany: a plain INSERT with no RETURNING, since bos_auth may insert platform rows but never read them.
  await db.auditEvent.createMany({
    data: {
      id: randomUUID(),
      businessId: null,
      actorUserId: input.userId,
      action: input.event,
      targetType: input.target.type,
      targetId: input.target.id,
      metadata: metadata as never,
    },
  });
}

/**
 * A failed attempt (wrong current password) is recorded best effort, outside any transaction: an audit outage
 * must never turn into an account lockout, and the refusal stands either way (§15.4).
 */
export async function recordFailedAttempt(userId: string, sessionToken: string, event: 'identity.password.change_failed' | 'identity.sessions.revoke_others_failed'): Promise<void> {
  try {
    await withAuthClient(async (db) => {
      const sessionId = await currentSessionId(db, userId, sessionToken);
      await recordIdentityEvent(db, { userId, actorSessionId: sessionId, event, target: { type: 'user', id: userId }, metadata: { reason: 'invalid_password' } });
    });
  } catch {
    console.error('[identity] failed-attempt audit not written');
  }
}

// ---- The account lock and the current session ----------------------------------------------------------

async function currentSessionId(db: AuthTx, userId: string, sessionToken: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "sessions"
    WHERE "token_hash" = ${sha256Hex(sessionToken)} AND "user_id" = ${userId}::uuid
      AND "expires_at" > now() AND "revoked_at" IS NULL`;
  return rows[0]?.id ?? null;
}

/**
 * Starts an account mutation: locks the user's row, so every account change of one person runs one at a time
 * (two "sign out other devices" requests from two devices cannot both win), then confirms that the session
 * making the request still exists. A session ended by a concurrent request answers 401, never a partial change.
 * Returns the caller's opaque session id.
 */
export async function lockAccount(tx: AuthTx, userId: string, sessionToken: string): Promise<string> {
  const user = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid AND "deactivated_at" IS NULL FOR UPDATE`;
  if (!user[0]) throw new SessionEndedError();
  const sessionId = await currentSessionId(tx, userId, sessionToken);
  if (!sessionId) throw new SessionEndedError();
  return sessionId;
}

/** The token's session id for read-only use (marking the current row in a list). Null if it is gone. */
export function readCurrentSessionId(db: AuthTx, userId: string, sessionToken: string): Promise<string | null> {
  return currentSessionId(db, userId, sessionToken);
}

// ---- Rate limits (§12 item 9, §15.3) --------------------------------------------------------------------
//
// Account routes are not Better Auth endpoints, so its limiter does not see them. These counters live in the
// same PostgreSQL `rate_limits` table (ADR 0001 condition 2: limits hold across serverless instances), under
// keys that cannot collide with Better Auth's (`<ip><path>`): `account:<rule>:<user id>`. Each attempt is
// counted in its own statement before the work starts, so a failed or rolled-back attempt still counts.

export const ACCOUNT_RATE_LIMITS = {
  /** Display-name changes. */
  profile: { windowSeconds: 60 * 60, max: 20 },
  /** Password-change attempts, right or wrong. */
  password: { windowSeconds: 60 * 60, max: 5 },
  /** Revoking one session or all other sessions (shared, §15.3: 10 per hour per user). */
  revoke: { windowSeconds: 60 * 60, max: 10 },
} as const;
export type AccountRateLimit = keyof typeof ACCOUNT_RATE_LIMITS;

/** Counts one attempt against the rule for this user; throws RateLimitedError (429) once over the limit. */
export async function consumeAccountLimit(rule: AccountRateLimit, userId: string): Promise<void> {
  const { windowSeconds, max } = ACCOUNT_RATE_LIMITS[rule];
  const now = BigInt(Date.now());
  const windowMs = BigInt(windowSeconds * 1000);
  const key = `account:${rule}:${userId}`;
  const rows = await withAuthClient((db) => db.$queryRaw<{ count: number }[]>`
    INSERT INTO "rate_limits" ("id", "key", "count", "last_request")
    VALUES (${randomUUID()}::uuid, ${key}, 1, ${now}::bigint)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limits"."last_request" <= ${now - windowMs}::bigint THEN 1 ELSE "rate_limits"."count" + 1 END,
      "last_request" = CASE WHEN "rate_limits"."last_request" <= ${now - windowMs}::bigint THEN ${now}::bigint ELSE "rate_limits"."last_request" END
    RETURNING "count"`);
  if ((rows[0]?.count ?? Number.POSITIVE_INFINITY) > max) throw new RateLimitedError();
}

// ---- Passwords ----------------------------------------------------------------------------------------

/** The account's stored password hash (email-and-password sign-up), or null when it has none. */
export async function credentialPassword(userId: string): Promise<{ accountId: string; hash: string } | null> {
  const account = await withAuthClient((db) => db.account.findFirst({ where: { userId, providerId: 'credential' }, select: { id: true, password: true } }));
  return account?.password ? { accountId: account.id, hash: account.password } : null;
}

/** Checks a password against a stored hash with Better Auth's own hasher (scrypt, constant-time compare). */
export async function passwordMatches(hash: string, password: string): Promise<boolean> {
  const ctx = await getAuth().$context;
  return ctx.password.verify({ hash, password });
}

export async function hashPassword(password: string): Promise<string> {
  const ctx = await getAuth().$context;
  return ctx.password.hash(password);
}
