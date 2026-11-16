import 'server-only';
// The Communications retention and erasure worker (docs/communications-e1.md §7). One pass:
//   1. ask the database which businesses have due work (ids only, app_private.communications_erasure_due);
//   2. per business, as bos_app inside withTenant with NO session user, each step its own short transaction:
//      a. retention purge batches (copies past their category's expiry and not held), until none is due;
//      b. one bounded step at a time of each due erasure request (PENDING, or DEFERRED whose recheck is due);
//      c. housekeeping (expired dedup markers and used/expired single-use codes).
// Every step is atomic and idempotent in the database: a crash or a lost connection leaves either nothing or
// a whole step; the next pass continues. Two passes at once are safe: request rows are claimed with
// SKIP LOCKED ('busy') and purge batches lock their rows in a fixed order (§9).
import { businessesWithDueErasure, withTenant } from '@/core/db';
import { sqlState } from '@/core/http/errors';
import { dueErasureIds, erasureHousekeeping, purgeExpired, recordErasureFailure, stepErasure } from '@/modules/communications';

export interface RetentionPassSummary {
  businesses: number; purgeBatches: number; purgedMessages: number; requestSteps: number; requestsCompleted: number; requestsDeferred: number;
  busy: number; failures: number; housekept: number; businessErrors: number; stoppedAtDeadline: boolean;
}

/** A stable, content-free code for a failed step (never the error message, which could quote data). */
export function failureCode(error: unknown): string {
  const state = sqlState(error);
  if (state === '40P01') return 'deadlock';
  if (state === '55P03') return 'lock_timeout';
  if (state === '40001') return 'serialization';
  if (state === '57014') return 'statement_timeout';
  return state ? 'database_error' : 'worker_error';
}

export async function runCommunicationsRetentionPass(opts: {
  deadlineMs: number; businessLimit?: number; batchSize?: number; maxPurgeBatches?: number; requestsPerBusiness?: number; maxStepsPerRequest?: number;
}): Promise<RetentionPassSummary> {
  const deadline = Date.now() + opts.deadlineMs;
  const batch = opts.batchSize ?? 200;
  const s: RetentionPassSummary = {
    businesses: 0, purgeBatches: 0, purgedMessages: 0, requestSteps: 0, requestsCompleted: 0, requestsDeferred: 0, busy: 0, failures: 0, housekept: 0,
    businessErrors: 0, stoppedAtDeadline: false,
  };
  const late = () => {
    if (Date.now() < deadline) return false;
    s.stoppedAtDeadline = true;
    return true;
  };
  const ids = await businessesWithDueErasure(opts.businessLimit ?? 50);
  for (const businessId of ids) {
    if (late()) break;
    s.businesses++;
    const unit = { businessId, userId: null };
    try {
      for (let n = 0; n < (opts.maxPurgeBatches ?? 25) && !late(); n++) {
        const purged = await withTenant(unit, (db) => purgeExpired(db, batch), { timeoutMs: 20_000 });
        if (!purged) break;
        s.purgeBatches++;
        s.purgedMessages += purged.messages;
      }
      const due = await withTenant(unit, (db) => dueErasureIds(db, opts.requestsPerBusiness ?? 20));
      for (const id of due) {
        for (let step = 0; step < (opts.maxStepsPerRequest ?? 50); step++) {
          if (late()) break;
          let outcome: Awaited<ReturnType<typeof stepErasure>>['outcome'];
          try {
            outcome = (await withTenant(unit, (db) => stepErasure(db, id, batch), { timeoutMs: 20_000 })).outcome;
          } catch (error) {
            // The step rolled back whole. Record a content-free code and back off; the next pass retries.
            s.failures++;
            await withTenant(unit, (db) => recordErasureFailure(db, id, failureCode(error)));
            break;
          }
          s.requestSteps++;
          if (outcome === 'progress') continue;
          if (outcome === 'completed') s.requestsCompleted++;
          else if (outcome === 'deferred') s.requestsDeferred++;
          else s.busy++;
          break;
        }
      }
      if (!late()) s.housekept += await withTenant(unit, (db) => erasureHousekeeping(db, 500));
    } catch {
      // One business's database trouble must not stop the others; its work stays due.
      s.businessErrors++;
    }
  }
  return s;
}
