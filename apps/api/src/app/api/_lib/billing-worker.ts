import 'server-only';
// The recurring-billing worker (docs/finance-billing-f6.md §5, D-F6-1). One pass:
//   1. ask the database which businesses have due work (ids only, app_private.finance_billing_due);
//   2. per business, as bos_app inside withTenant with NO session user: plan due periods, then claim
//      and execute runs one at a time, each step in its own short transaction.
// A crash anywhere leaves either nothing or a complete (draft + GENERATED run) result: an expired lease
// is reclaimed by a later pass, and the unique period key and the system idempotency key make a
// repeat a no-op. The pass stops at its deadline; remaining work waits for the next pass.
import { businessesWithDueBilling, withTenant } from '@/core/db';
import { claimRecurringRun, executeRecurringRun, failRecurringRun, planDueRuns } from '@/modules/finance';

export interface BillingPassSummary {
  businesses: number; planned: number; ended: number; generated: number; failed: number; retrying: number; skipped: number; leaseLost: number;
  businessErrors: number; planBatches: number; stoppedAtDeadline: boolean;
}

/** Planning batches per business per pass (each up to TEMPLATES_PER_PLAN_BATCH templates); the rest waits for the next pass. */
const MAX_PLAN_BATCHES = 25;

export async function runBillingPass(opts: { deadlineMs: number; businessLimit?: number; runsPerBusiness?: number; leaseSeconds?: number }): Promise<BillingPassSummary> {
  const deadline = Date.now() + opts.deadlineMs;
  const s: BillingPassSummary = { businesses: 0, planned: 0, ended: 0, generated: 0, failed: 0, retrying: 0, skipped: 0, leaseLost: 0, businessErrors: 0, planBatches: 0, stoppedAtDeadline: false };
  const ids = await businessesWithDueBilling(opts.businessLimit ?? 50);
  for (const id of ids) {
    if (Date.now() >= deadline) { s.stoppedAtDeadline = true; break; }
    s.businesses++;
    const unit = { businessId: id, userId: null };
    try {
      // Planning runs in bounded batches, each its own short transaction, so a large backlog never
      // becomes one long transaction that could roll back as a whole.
      const planned: string[] = [];
      for (let batch = 0; batch < MAX_PLAN_BATCHES; batch++) {
        if (Date.now() >= deadline) { s.stoppedAtDeadline = true; break; }
        const plan = await withTenant(unit, (db) => planDueRuns(db, { exclude: planned }));
        planned.push(...plan.templateIds);
        s.planned += plan.planned;
        s.ended += plan.ended;
        s.planBatches++;
        if (!plan.more) break;
      }
      for (let n = 0; n < (opts.runsPerBusiness ?? 25); n++) {
        if (Date.now() >= deadline) { s.stoppedAtDeadline = true; break; }
        const claimed = await withTenant(unit, (db) => claimRecurringRun(db, { leaseSeconds: opts.leaseSeconds }));
        if (!claimed) break;
        try {
          const outcome = await withTenant(unit, (db) => executeRecurringRun(db, claimed));
          if (outcome === 'generated') s.generated++;
          else if (outcome === 'skipped') s.skipped++;
          else s.leaseLost++;
        } catch (error) {
          const result = await withTenant(unit, (db) => failRecurringRun(db, claimed, error));
          if (result === 'failed') s.failed++;
          else if (result === 'retrying') s.retrying++;
          else s.leaseLost++;
        }
      }
    } catch {
      // One business's database trouble must not stop the others. Its runs stay claimable.
      s.businessErrors++;
    }
  }
  return s;
}
