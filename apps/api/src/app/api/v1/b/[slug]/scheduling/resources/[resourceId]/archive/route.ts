import { ResourceResponse, ResourceTransitionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { archiveResource } from '@/modules/scheduling';
import { resourceIdOf } from '@/app/api/_lib/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'scheduling:manage_resources', input: ResourceTransitionRequest, response: ResourceResponse }, async ({ db, actor, params, input }) => ({
  body: await archiveResource(db, actor.userId, resourceIdOf(params), input.version),
}));

export const OPTIONS = preflight;
