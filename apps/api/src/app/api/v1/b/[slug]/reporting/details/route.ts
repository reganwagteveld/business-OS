import { ReportingDetailsRequest, ReportingDetailsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { runDetails } from '@/modules/reporting';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** One page of the records behind a metric (read-only). Same access rule as running the metric. */
export const POST = tenantRoute({ permission: 'reporting:read', input: ReportingDetailsRequest, response: ReportingDetailsResponse }, async ({ db, actor, input }) => ({
  body: await runDetails(db, actor, input),
}));

export const OPTIONS = preflight;
