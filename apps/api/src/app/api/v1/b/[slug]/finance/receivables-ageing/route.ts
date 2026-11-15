import { ReceivablesAgeingQuery, ReceivablesAgeingResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getReceivablesAgeing } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-2: accounts-receivable ageing per customer and currency as of a date (derived, read-only). finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: ReceivablesAgeingQuery, response: ReceivablesAgeingResponse }, async ({ db, query }) => ({
  body: { ageing: await getReceivablesAgeing(db, query) },
}));

export const OPTIONS = preflight;
