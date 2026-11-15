import 'server-only';
// Durable sync jobs (docs/communications-c2.md §9). C2-A provides the table, the state machine and
// the tenant-side operations; the worker that runs them (and the cross-tenant dispatcher) is C2-B.
//
//   QUEUED ──claim──▶ RUNNING ──complete──▶ SUCCEEDED
//     ▲                 │ fail (retryable, attempts left) → QUEUED with backoff
//     └─────────────────┤ fail (final) / lease expired with no attempts left → FAILED
//                       └ connection disconnected, paused or owner gone → CANCELLED
//
// At most one QUEUED or RUNNING job per connection (partial unique index), so enqueueing is
// idempotent. Every transition after the claim requires the caller's lease id, so a worker whose
// lease expired cannot overwrite the work of the one that reclaimed the job. Guard CM007 rejects any
// other transition in the database.
import { randomUUID } from 'node:crypto';
import type { MailSyncJob as JobDto } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { permissionsFor, type Role } from '@/modules/access';
import { markReauthRequired } from './credentials';

export type SyncKind = JobDto['kind'];

export type JobRow = {
  id: string; connectionId: string; kind: string; status: string; attempts: number; runAfter: Date; startedAt: Date | null; finishedAt: Date | null;
  lastErrorCode: string | null; createdAt: Date;
};
export const jobSelect = {
  id: true, connectionId: true, kind: true, status: true, attempts: true, runAfter: true, startedAt: true, finishedAt: true, lastErrorCode: true, createdAt: true,
} as const;

export function toJob(r: JobRow): JobDto {
  return {
    id: r.id, connectionId: r.connectionId, kind: r.kind as SyncKind, status: r.status as JobDto['status'], attempts: r.attempts,
    runAfter: r.runAfter.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null,
    lastErrorCode: r.lastErrorCode, createdAt: r.createdAt.toISOString(),
  };
}

/** Backoff for retry n (1-based): 30 s × 2^(n-1), capped at 1 h; a provider Retry-After wins if longer. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 3_600_000);
  return Math.max(base, Math.min(retryAfterMs ?? 0, 3_600_000));
}

/** Queues a job unless one is already queued or running for the connection (then returns that one). */
export async function enqueueSyncJob(db: AppTenantDb, connectionId: string, kind: SyncKind, requestedById: string | null): Promise<{ job: JobDto; created: boolean }> {
  const id = randomUUID();
  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "mail_sync_jobs" ("id", "business_id", "connection_id", "kind", "requested_by_id")
    VALUES (${id}::uuid, nullif(current_setting('app.business_id', true), '')::uuid, ${connectionId}::uuid, ${kind}, ${requestedById}::uuid)
    ON CONFLICT ("business_id", "connection_id") WHERE "status" IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING "id"::text`;
  const row = (await db.mailSyncJob.findFirst({
    where: inserted.length ? { id } : { connectionId, status: { in: ['QUEUED', 'RUNNING'] } }, select: jobSelect,
  })) as JobRow | null;
  if (!row) throw new Error('sync job vanished');
  return { job: toJob(row), created: inserted.length === 1 };
}

export interface ClaimedJob { job: JobDto; leaseId: string; connection: { id: string; provider: string; ownerUserId: string } }

/** Is the mailbox owner still an active member allowed to connect mailboxes? */
async function ownerActive(db: AppTenantDb, ownerUserId: string): Promise<boolean> {
  const m = (await db.membership.findFirst({ where: { userId: ownerUserId, status: 'ACTIVE' }, select: { role: true } })) as { role: Role } | null;
  return Boolean(m && permissionsFor(m.role).includes('communications:connect'));
}

/**
 * Claims the oldest due job of this business (FOR UPDATE SKIP LOCKED, so concurrent workers get
 * different jobs) and checks the connection may still be synced. Runs with no session user.
 * Returns null when nothing is due.
 */
export async function claimSyncJob(db: AppTenantDb, opts: { leaseSeconds?: number } = {}): Promise<ClaimedJob | null> {
  const leaseSeconds = Math.min(Math.max(opts.leaseSeconds ?? 120, 10), 900);
  for (;;) {
    // Expired leases with no attempts left fail first, so they are never handed out again.
    await db.$queryRaw`
      UPDATE "mail_sync_jobs" SET "status" = 'FAILED', "lease_id" = NULL, "lease_expires_at" = NULL, "finished_at" = now(),
        "last_error_code" = 'lease_expired', "updated_at" = now()
      WHERE "status" = 'RUNNING' AND "lease_expires_at" < now() AND "attempts" >= "max_attempts"
      RETURNING "id"`;
    const leaseId = randomUUID();
    const claimed = await db.$queryRaw<{ id: string; connection_id: string }[]>`
      UPDATE "mail_sync_jobs" j SET "status" = 'RUNNING', "lease_id" = ${leaseId}::uuid,
        "lease_expires_at" = now() + make_interval(secs => ${leaseSeconds}::int), "attempts" = j."attempts" + 1,
        "started_at" = coalesce(j."started_at", now()), "last_error_code" = NULL, "updated_at" = now()
      WHERE (j."business_id", j."id") = (
        SELECT d."business_id", d."id" FROM "mail_sync_jobs" d
        WHERE (d."status" = 'QUEUED' AND d."run_after" <= now()) OR (d."status" = 'RUNNING' AND d."lease_expires_at" < now())
        ORDER BY d."run_after", d."id" LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING j."id"::text, j."connection_id"::text AS connection_id`;
    const hit = claimed[0];
    if (!hit) return null;
    const connection = (await db.mailConnection.findFirst({
      where: { id: hit.connection_id }, select: { id: true, provider: true, ownerUserId: true, status: true, syncEnabled: true },
    })) as { id: string; provider: string; ownerUserId: string; status: string; syncEnabled: boolean } | null;
    let refusal: string | null = null;
    if (!connection || connection.status !== 'ACTIVE') refusal = 'not_active';
    else if (!connection.syncEnabled) refusal = 'sync_disabled';
    else if (!(await ownerActive(db, connection.ownerUserId))) refusal = 'owner_inactive';
    if (!refusal) {
      const job = (await db.mailSyncJob.findFirst({ where: { id: hit.id }, select: jobSelect })) as JobRow;
      return { job: toJob(job), leaseId, connection: { id: connection!.id, provider: connection!.provider, ownerUserId: connection!.ownerUserId } };
    }
    if (refusal === 'owner_inactive') {
      // Stops the mailbox: credentials are deleted and a system audit event is written.
      await markReauthRequired(db, connection!.id, connection!.provider, 'owner_inactive');
    } else {
      await db.mailSyncJob.updateMany({
        where: { id: hit.id, leaseId }, data: { status: 'CANCELLED', leaseId: null, leaseExpiresAt: null, finishedAt: new Date(), lastErrorCode: refusal },
      });
    }
  }
}

/** Extends the lease of a running job; false if the caller no longer holds it. */
export async function heartbeatSyncJob(db: AppTenantDb, jobId: string, leaseId: string, leaseSeconds = 120): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "mail_sync_jobs" SET "lease_expires_at" = now() + make_interval(secs => ${Math.min(Math.max(leaseSeconds, 10), 900)}::int), "updated_at" = now()
    WHERE "id" = ${jobId}::uuid AND "lease_id" = ${leaseId}::uuid AND "status" = 'RUNNING'
    RETURNING "id"`;
  return rows.length === 1;
}

/** Marks a job done and records the connection's new cursor. False if the lease was lost. */
export async function completeSyncJob(db: AppTenantDb, jobId: string, leaseId: string, result: { cursor?: string | null } = {}): Promise<boolean> {
  const job = (await db.mailSyncJob.findFirst({ where: { id: jobId, leaseId, status: 'RUNNING' }, select: { connectionId: true } })) as { connectionId: string } | null;
  if (!job) return false;
  const now = new Date();
  const done = await db.mailSyncJob.updateMany({
    where: { id: jobId, leaseId, status: 'RUNNING' },
    data: { status: 'SUCCEEDED', leaseId: null, leaseExpiresAt: null, finishedAt: now, lastErrorCode: null, updatedAt: now },
  });
  if (done.count !== 1) return false;
  await db.mailConnection.updateMany({
    where: { id: job.connectionId, status: 'ACTIVE' },
    data: { lastSyncedAt: now, lastErrorCode: null, updatedAt: now, ...(result.cursor !== undefined ? { syncCursor: result.cursor } : {}) },
  });
  return true;
}

export type SyncFailureCode = 'rate_limited' | 'unavailable' | 'busy' | 'reauth_required' | 'insufficient_scope' | 'invalid_response' | 'cursor_expired' | 'internal_error';
const RETRYABLE = new Set<SyncFailureCode>(['rate_limited', 'unavailable', 'busy', 'internal_error']);

/**
 * Records a failure. Retryable failures with attempts left go back to QUEUED with backoff; anything
 * else is FAILED. reauth_required also stops the connection. Returns the new status, or null if the
 * caller no longer holds the lease.
 */
export async function failSyncJob(
  db: AppTenantDb,
  jobId: string,
  leaseId: string,
  failure: { code: SyncFailureCode; retryAfterMs?: number },
): Promise<'QUEUED' | 'FAILED' | null> {
  const job = (await db.mailSyncJob.findFirst({
    where: { id: jobId, leaseId, status: 'RUNNING' }, select: { attempts: true, maxAttempts: true, connectionId: true },
  })) as { attempts: number; maxAttempts: number; connectionId: string } | null;
  if (!job) return null;
  const now = new Date();
  const retry = RETRYABLE.has(failure.code) && job.attempts < job.maxAttempts;
  const changed = await db.mailSyncJob.updateMany({
    where: { id: jobId, leaseId, status: 'RUNNING' },
    data: retry
      ? { status: 'QUEUED', leaseId: null, leaseExpiresAt: null, runAfter: new Date(now.getTime() + backoffMs(job.attempts, failure.retryAfterMs)), lastErrorCode: failure.code, updatedAt: now }
      : { status: 'FAILED', leaseId: null, leaseExpiresAt: null, finishedAt: now, lastErrorCode: failure.code, updatedAt: now },
  });
  if (changed.count !== 1) return null;
  if (failure.code === 'reauth_required') {
    const connection = (await db.mailConnection.findFirst({ where: { id: job.connectionId }, select: { provider: true } })) as { provider: string } | null;
    if (connection) await markReauthRequired(db, job.connectionId, connection.provider, 'reauth_required');
  } else {
    await db.mailConnection.updateMany({ where: { id: job.connectionId, status: 'ACTIVE' }, data: { lastErrorCode: failure.code, updatedAt: now } });
  }
  return retry ? 'QUEUED' : 'FAILED';
}
