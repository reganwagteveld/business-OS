import { ProjectFromOpportunityRequest, ProjectResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { viewerOf } from '@/modules/projects';
import { projectFromOpportunity, workflowIdempotencyKey } from '@/modules/workflows';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * WF-1 §6.2 (LC-1): create a project from an OPEN or WON opportunity. Idempotency-Key required; 201 with the
 * new project, 200 with the same project when key and body repeat. projects:create + sales:read (all-of, §7);
 * customers:read as well when the opportunity has a customer (checked in the service).
 */
export const POST = tenantRoute(
  { permission: ['projects:create', 'sales:read'], input: ProjectFromOpportunityRequest, response: ProjectResponse },
  async ({ db, actor, input, request }) => {
    const { status, project } = await projectFromOpportunity(db, viewerOf(actor), actor.userId, workflowIdempotencyKey(request), input);
    return { status, body: { project } };
  },
);

export const OPTIONS = preflight;
