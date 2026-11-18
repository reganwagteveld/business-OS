import { LinkProjectOpportunityRequest, ProjectResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { viewerOf } from '@/modules/projects';
import { linkProjectOpportunity } from '@/modules/workflows';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** WF-1 §6.4 (LC-1): set, change or clear a project's source opportunity. projects:update + sales:read (all-of, §7). */
export const POST = tenantRoute(
  { permission: ['projects:update', 'sales:read'], input: LinkProjectOpportunityRequest, response: ProjectResponse },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.projectId)) throw new RecordNotFoundError();
    return { body: { project: await linkProjectOpportunity(db, viewerOf(actor), actor.userId, params.projectId, input) } };
  },
);

export const OPTIONS = preflight;
