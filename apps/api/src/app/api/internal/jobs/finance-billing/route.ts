// Scheduler entry point for recurring billing (docs/finance-billing-f6.md §5, D-F6-1). Called by
// Vercel Cron with `Authorization: Bearer $CRON_SECRET`. Not a tenant route: it has no user and takes
// no input; which businesses to work on comes from the database. With CRON_SECRET unset it refuses
// every call, so deploying this route activates nothing until the owner sets the secret AND adds the
// cron schedule to vercel.json.
import { getEnv } from '@/core/config/env';
import { runBillingPass } from '@/app/api/_lib/billing-worker';
import { cronAuthorised, cronReply as reply } from '@/app/api/_lib/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = getEnv().CRON_SECRET;
  if (!secret) return reply(503, { error: 'not_configured' });
  if (!cronAuthorised(request, secret)) return reply(401, { error: 'unauthorized' });
  try {
    // Leave headroom under maxDuration for the last transaction to commit.
    return reply(200, { summary: await runBillingPass({ deadlineMs: 45_000 }) });
  } catch {
    return reply(500, { error: 'job_failed' });
  }
}
