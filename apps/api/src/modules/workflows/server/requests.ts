import 'server-only';
// workflow_requests (docs/cross-zone-workflows-wf1.md §5.5, W1-D13, D-WF1-12): the idempotency ledger of the
// workflow creates. A row is inserted in the action's own transaction, so a rolled-back action leaves no key.
// Retention target 90 days (D-WF1-12) is policy only: no cleanup job exists, and safety never depends on
// deletion, because an expired key falls back on the state guards (existingProjectCount, the source-quote key).
import { createHash, randomUUID } from 'node:crypto';
import type { AppTenantDb } from '@/core/db';
import { RuleViolationError, StateConflictError } from '@/core/http/errors';

export type Operation = 'project.from_opportunity' | 'project.from_quote';

const KEY = /^[\x21-\x7e]{1,200}$/;
/** The Idempotency-Key header, required on the workflow creates: 1–200 visible ASCII characters. */
export function workflowIdempotencyKey(request: Request): string {
  const key = request.headers.get('idempotency-key');
  if (key === null) throw new RuleViolationError('idempotency_key_required', 'This request needs an Idempotency-Key header.');
  if (!KEY.test(key)) throw new RuleViolationError('invalid_idempotency_key', 'An Idempotency-Key is 1 to 200 visible ASCII characters.');
  return key;
}

/** Canonical SHA-256 of the operation and request body (key order does not matter). */
export function requestHash(operation: Operation, input: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify([operation, canonical(input ?? null)])).digest('hex');
}

/**
 * First lock of every workflow create (§6.10 class order: idempotency → Finance → Sales → Projects): a
 * transaction-scoped advisory lock on (business, operation, key), so racing duplicates queue and exactly
 * one acts. Then the ledger: the same key and body replays the first result; another body is 409.
 * Returns the project id to replay, or null when this request should act.
 */
export async function claimKey(db: AppTenantDb, operation: Operation, key: string, hash: string): Promise<string | null> {
  await db.$queryRaw<{ locked: number }[]>`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(
      'workflows.idempotency:' || current_setting('app.business_id', true) || ':' || ${operation}::text || ':' || ${key}::text, 0))) AS l`;
  const existing = await db.workflowRequest.findFirst({ where: { operation, idempotencyKey: key }, select: { requestHash: true, resultId: true } });
  if (!existing) return null;
  if (existing.requestHash !== hash) throw new StateConflictError('idempotency_conflict');
  return existing.resultId;
}

/** Records the key in the action's transaction. The actor is pinned to the session user by RLS. */
export async function recordKey(db: AppTenantDb, operation: Operation, key: string, hash: string, projectId: string, actorUserId: string) {
  await db.workflowRequest.create({
    data: { id: randomUUID(), operation, idempotencyKey: key, requestHash: hash, resultType: 'project', resultId: projectId, actorUserId } as never,
  });
}
