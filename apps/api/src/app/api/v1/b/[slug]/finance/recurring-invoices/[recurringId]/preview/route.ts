import { RecurringPreviewQuery, RecurringPreviewResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { previewRecurringInvoice } from '@/modules/finance';
import { recurringIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Upcoming periods and what each draft would total today. Writes nothing. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: RecurringPreviewQuery, response: RecurringPreviewResponse }, async ({ db, params, query }) => ({
  body: { preview: await previewRecurringInvoice(db, recurringIdOf(params), query.count) },
}));

export const OPTIONS = preflight;
