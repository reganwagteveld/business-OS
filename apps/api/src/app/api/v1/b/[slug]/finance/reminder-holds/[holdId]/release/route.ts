import { ReleaseReminderHoldRequest, ReminderHoldResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { releaseReminderHold } from '@/modules/finance';
import { holdIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Ends a hold. Stages that came due during it stay skipped. finance:billing. */
export const POST = tenantRoute({ permission: 'finance:billing', input: ReleaseReminderHoldRequest, response: ReminderHoldResponse }, async ({ db, actor, params }) => ({
  body: { hold: await releaseReminderHold(db, actor.userId, holdIdOf(params)) },
}));

export const OPTIONS = preflight;
