import { SalesSummaryResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { salesSummary } from '@/modules/sales';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// The open pipeline as totals for the operational dashboard: the same permission as reading opportunities,
// and the same tenant unit of work. Read only; one grouped query.
export const GET = tenantRoute({ permission: 'sales:read', response: SalesSummaryResponse }, async ({ db }) => ({ body: await salesSummary(db) }));

export const OPTIONS = preflight;
