// Scheduler entry point for Communications retention and erasure (docs/communications-e1.md §7, §12).
// Same rules as the finance job routes: `Authorization: Bearer $CRON_SECRET`, no user, no input. It is NOT in
// vercel.json, and it answers 503 unless COMMUNICATIONS_RETENTION_JOBS_ENABLED=true as well: deploying it
// erases nothing. Activation needs the owner's approval (§12), not a code change.
import { getEnv } from '@/core/config/env';
import { cronAuthorised, cronReply as reply } from '@/app/api/_lib/cron';
import { runCommunicationsRetentionPass } from '@/app/api/_lib/retention-worker';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const env = getEnv();
  if (!env.CRON_SECRET || env.COMMUNICATIONS_RETENTION_JOBS_ENABLED !== 'true') return reply(503, { error: 'not_configured' });
  if (!cronAuthorised(request, env.CRON_SECRET)) return reply(401, { error: 'unauthorized' });
  try {
    return reply(200, { summary: await runCommunicationsRetentionPass({ deadlineMs: 45_000 }) });
  } catch {
    return reply(500, { error: 'job_failed' });
  }
}
