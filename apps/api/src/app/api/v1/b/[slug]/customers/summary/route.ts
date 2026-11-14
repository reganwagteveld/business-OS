import { CustomerSummaryResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { customerSummary } from '@/modules/customers';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

// Counts for the Zone home: same permission as reading the list, and the same tenant unit of work.
export const GET = tenantRoute({ permission: 'customers:read', response: CustomerSummaryResponse }, async ({ db }) => ({
  body: { summary: await customerSummary(db) },
}));

export const OPTIONS = preflight;
