import { ReportingQueryRequest, ReportingQueryResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { runQuery } from '@/modules/reporting';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Runs registered metrics (read-only; POST because the body is structured). reporting:read, plus each
 * metric's own source keys, checked in the module: a metric the caller may not read fails the request
 * with 403, and a registry or range problem with 400 and an actionable code.
 */
export const POST = tenantRoute({ permission: 'reporting:read', input: ReportingQueryRequest, response: ReportingQueryResponse }, async ({ db, actor, input }) => ({
  body: await runQuery(db, actor, input, 'strict'),
}));

export const OPTIONS = preflight;
