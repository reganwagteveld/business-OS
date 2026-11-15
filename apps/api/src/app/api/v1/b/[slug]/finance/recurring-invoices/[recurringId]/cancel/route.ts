import { CancelRecurringInvoiceRequest, RecurringInvoiceResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { cancelRecurringInvoice } from '@/modules/finance';
import { recurringIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Final. Periods planned but not yet generated are skipped; drafts already generated are untouched. */
export const POST = tenantRoute({ permission: 'finance:billing', input: CancelRecurringInvoiceRequest, response: RecurringInvoiceResponse }, async ({ db, actor, params, input }) => ({
  body: { recurringInvoice: await cancelRecurringInvoice(db, actor.userId, recurringIdOf(params), input) },
}));

export const OPTIONS = preflight;
