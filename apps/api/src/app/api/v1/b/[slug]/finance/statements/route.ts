import { StatementQuery, StatementResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getStatement } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-2: a customer statement for one currency and an inclusive date range (derived, read-only). finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: StatementQuery, response: StatementResponse }, async ({ db, query }) => ({
  body: { statement: await getStatement(db, query) },
}));

export const OPTIONS = preflight;
