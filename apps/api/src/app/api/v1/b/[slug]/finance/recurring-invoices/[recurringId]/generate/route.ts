import { GenerateRecurringInvoiceResponse, RecurringTransitionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { generateNextPeriod } from '@/modules/finance';
import { recurringIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Generates the next period's DRAFT now, as the signed-in member. 201 with the run and the updated schedule. */
export const POST = tenantRoute({ permission: 'finance:billing', input: RecurringTransitionRequest, response: GenerateRecurringInvoiceResponse }, async ({ db, actor, params, input }) => ({
  status: 201, body: await generateNextPeriod(db, actor.userId, recurringIdOf(params), input),
}));

export const OPTIONS = preflight;
