import { ListCustomerBalancesQuery, ListCustomerBalancesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listCustomerBalances } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Receivables and customer credit per customer and currency (derived, read-only). finance:read only: no customers:* key needed or granted. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListCustomerBalancesQuery, response: ListCustomerBalancesResponse }, async ({ db, query }) => ({
  body: await listCustomerBalances(db, query),
}));

export const OPTIONS = preflight;
