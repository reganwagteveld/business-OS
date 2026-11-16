import { CreateResourceRequest, ListResourcesQuery, ListResourcesResponse, ResourceResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createResource, listResources } from '@/modules/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'scheduling:read', query: ListResourcesQuery, response: ListResourcesResponse }, async ({ db, query }) => ({
  body: await listResources(db, query),
}));

export const POST = tenantRoute({ permission: 'scheduling:manage_resources', input: CreateResourceRequest, response: ResourceResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: await createResource(db, actor.userId, input),
}));

export const OPTIONS = preflight;
