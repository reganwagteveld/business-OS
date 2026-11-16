import 'server-only';
// The payment-reminder worker (docs/finance-billing-f6.md §10.6). One pass:
//   1. ask the database which businesses have reminder work (ids only, app_private.finance_reminders_due);
//   2. per business, as bos_app inside withTenant with NO session user: plan today's due stages in
//      bounded batches, then claim and check reminders one at a time, each step in its own short
//      transaction.
// A crash anywhere leaves either nothing or a complete result: an expired lease is reclaimed by a later
// pass, UNIQUE (invoice, offset) makes a repeated plan a no-op, and the hand-over to the outbox commits
// with the move to QUEUED. Without an outbox (until C2-C) eligible reminders stop at READY.
import { businessesWithDueReminders, withTenant } from '@/core/db';
import { claimReminder, executeReminder, failReminder, markRemindersPlanned, planDueReminders, type ReminderOutbox } from '@/modules/finance';

export interface ReminderPassSummary {
  businesses: number; planned: number; ready: number; queued: number; refused: number; skipped: number; failed: number; retrying: number;
  leaseLost: number; businessErrors: number; planBatches: number; stoppedAtDeadline: boolean;
}

/** Planning batches per business per pass (each up to INVOICES_PER_PLAN_BATCH invoices); the rest waits for the next pass. */
const MAX_PLAN_BATCHES = 25;

export async function runReminderPass(opts: {
  deadlineMs: number; outbox: ReminderOutbox | null; businessLimit?: number; remindersPerBusiness?: number; leaseSeconds?: number; planBatchSize?: number;
}): Promise<ReminderPassSummary> {
  const deadline = Date.now() + opts.deadlineMs;
  const s: ReminderPassSummary = {
    businesses: 0, planned: 0, ready: 0, queued: 0, refused: 0, skipped: 0, failed: 0, retrying: 0, leaseLost: 0, businessErrors: 0, planBatches: 0,
    stoppedAtDeadline: false,
  };
  const ids = await businessesWithDueReminders(opts.businessLimit ?? 50);
  for (const id of ids) {
    if (Date.now() >= deadline) { s.stoppedAtDeadline = true; break; }
    s.businesses++;
    const unit = { businessId: id, userId: null };
    try {
      let after: string | null = null;
      let complete = false;
      for (let batch = 0; batch < MAX_PLAN_BATCHES; batch++) {
        if (Date.now() >= deadline) { s.stoppedAtDeadline = true; break; }
        const plan: { planned: number; next: string | null } = await withTenant(unit, (db) => planDueReminders(db, { after, limit: opts.planBatchSize }));
        s.planned += plan.planned;
        s.planBatches++;
        after = plan.next;
        if (!after) { complete = true; break; }
      }
      // Only a complete pass counts as planned; otherwise the next pass plans this business again.
      if (complete) await withTenant(unit, (db) => markRemindersPlanned(db));
      for (let n = 0; n < (opts.remindersPerBusiness ?? 100); n++) {
        if (Date.now() >= deadline) { s.stoppedAtDeadline = true; break; }
        const claimed = await withTenant(unit, (db) => claimReminder(db, { leaseSeconds: opts.leaseSeconds }));
        if (!claimed) break;
        try {
          const outcome = await withTenant(unit, (db) => executeReminder(db, claimed, opts.outbox));
          if (outcome === 'ready') s.ready++;
          else if (outcome === 'queued') s.queued++;
          else if (outcome === 'refused') s.refused++;
          else if (outcome === 'skipped') s.skipped++;
          else s.leaseLost++;
        } catch {
          const result = await withTenant(unit, (db) => failReminder(db, claimed));
          if (result === 'failed') s.failed++;
          else if (result === 'retrying') s.retrying++;
          else s.leaseLost++;
        }
      }
    } catch {
      // One business's database trouble must not stop the others. Its reminders stay claimable.
      s.businessErrors++;
    }
  }
  return s;
}
