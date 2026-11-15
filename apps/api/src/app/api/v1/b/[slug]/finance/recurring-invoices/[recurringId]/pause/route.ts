import { RecurringInvoiceResponse, RecurringTransitionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { pauseRecurringInvoice } from '@/modules/finance';
import { recurringIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'finance:billing', input: RecurringTransitionRequest, response: RecurringInvoiceResponse }, async ({ db, actor, params, input }) => ({
  body: { recurringInvoice: await pauseRecurringInvoice(db, actor.userId, recurringIdOf(params), input) },
}));

export const OPTIONS = preflight;
