import { ListRecurringRunsQuery, ListRecurringRunsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listRecurringRuns } from '@/modules/finance';
import { recurringIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Generation and failure history of a schedule, newest period first. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListRecurringRunsQuery, response: ListRecurringRunsResponse }, async ({ db, params, query }) => ({
  body: await listRecurringRuns(db, recurringIdOf(params), query),
}));

export const OPTIONS = preflight;
