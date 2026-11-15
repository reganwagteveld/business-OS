import { RecurringRunActionRequest, RecurringRunResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { skipRecurringRun } from '@/modules/finance';
import { recurringIdOf, runIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'finance:billing', input: RecurringRunActionRequest, response: RecurringRunResponse }, async ({ db, actor, params }) => ({
  body: { run: await skipRecurringRun(db, actor.userId, recurringIdOf(params), runIdOf(params)) },
}));

export const OPTIONS = preflight;
