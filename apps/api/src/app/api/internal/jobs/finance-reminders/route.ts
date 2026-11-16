// Scheduler entry point for payment reminders (docs/finance-billing-f6.md §10.6, D-F6-13).
// Same rules as the billing route: Vercel Cron with `Authorization: Bearer $CRON_SECRET`, no user, no
// input, 503 while CRON_SECRET is unset. It is NOT in vercel.json: deploying it activates nothing. Even
// when scheduled it sends nothing until C2-C provides an outbox (configuredReminderOutbox() is null),
// so eligible reminders stop at READY.
import { getEnv } from '@/core/config/env';
import { configuredReminderOutbox } from '@/modules/finance';
import { cronAuthorised, cronReply as reply } from '@/app/api/_lib/cron';
import { runReminderPass } from '@/app/api/_lib/reminder-worker';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = getEnv().CRON_SECRET;
  if (!secret) return reply(503, { error: 'not_configured' });
  if (!cronAuthorised(request, secret)) return reply(401, { error: 'unauthorized' });
  try {
    return reply(200, { summary: await runReminderPass({ deadlineMs: 45_000, outbox: configuredReminderOutbox() }) });
  } catch {
    return reply(500, { error: 'job_failed' });
  }
}
