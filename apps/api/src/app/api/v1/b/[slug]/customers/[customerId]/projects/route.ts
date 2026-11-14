import { ListProjectsQuery, ListProjectsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { listCustomerProjects, viewerOf } from '@/modules/projects';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Projects linked to one customer. Needs projects:read here and customers:read in the service. */
export const GET = tenantRoute({ permission: 'projects:read', query: ListProjectsQuery, response: ListProjectsResponse }, async ({ db, actor, params, query }) => {
  if (!isUuid(params.customerId)) throw new RecordNotFoundError();
  return { body: await listCustomerProjects(db, viewerOf(actor), params.customerId, query) };
});

export const OPTIONS = preflight;
