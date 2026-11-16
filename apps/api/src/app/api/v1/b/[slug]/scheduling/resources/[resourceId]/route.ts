import { ResourceResponse, UpdateResourceRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getResource, updateResource } from '@/modules/scheduling';
import { resourceIdOf } from '@/app/api/_lib/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'scheduling:read', response: ResourceResponse }, async ({ db, params }) => ({
  body: await getResource(db, resourceIdOf(params)),
}));

export const PATCH = tenantRoute({ permission: 'scheduling:manage_resources', input: UpdateResourceRequest, response: ResourceResponse }, async ({ db, actor, params, input }) => ({
  body: await updateResource(db, actor.userId, resourceIdOf(params), input),
}));

export const OPTIONS = preflight;
