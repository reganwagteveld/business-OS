import { RecurringInvoiceResponse, UpdateRecurringInvoiceRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getRecurringInvoice, updateRecurringInvoice } from '@/modules/finance';
import { recurringIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: RecurringInvoiceResponse }, async ({ db, params }) => ({
  body: { recurringInvoice: await getRecurringInvoice(db, recurringIdOf(params)) },
}));

/** Changes apply to periods generated afterwards. Optimistic concurrency on `version`. */
export const PATCH = tenantRoute({ permission: 'finance:billing', input: UpdateRecurringInvoiceRequest, response: RecurringInvoiceResponse }, async ({ db, actor, params, input }) => ({
  body: { recurringInvoice: await updateRecurringInvoice(db, actor.userId, recurringIdOf(params), input) },
}));

export const OPTIONS = preflight;
