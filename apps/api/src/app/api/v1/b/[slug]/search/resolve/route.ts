import { SearchResolveRequest, SearchResolveResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { resolveRecords } from '@/modules/search';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

// Re-authorises recently opened records (docs/global-search-gs1.md §7.3) with the same providers and rules.
export const POST = tenantRoute(
  { permission: 'business:read', input: SearchResolveRequest, response: SearchResolveResponse, timeoutMs: 3000, maxWaitMs: 1000 },
  async ({ db, actor, input }) => ({ body: await resolveRecords(db, actor, input) }),
);

export const OPTIONS = preflight;
