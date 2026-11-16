import { SearchRequest, SearchResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { runSearch, searchApiEnabled } from '@/modules/search';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

// Global search (docs/global-search-gs1.md §7.1). POST so the text stays out of URLs (D-GS1-12). Every
// type also needs its own Zone's read key, checked in the service. 3 s unit of work, 1 s pool wait (§5.5).
// Until the reviewed enablement constant is flipped (modules/search availability), every caller gets 404
// before authentication or any database work.
export const POST = tenantRoute(
  { permission: 'business:read', input: SearchRequest, response: SearchResponse, timeoutMs: 3000, maxWaitMs: 1000, available: searchApiEnabled },
  async ({ db, actor, input }) => ({ body: await runSearch(db, actor, input) }),
);

export const OPTIONS = preflight;
