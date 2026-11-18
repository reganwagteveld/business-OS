import { ProjectFromQuoteRequest, ProjectResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { viewerOf } from '@/modules/projects';
import { projectFromQuote, workflowIdempotencyKey } from '@/modules/workflows';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * WF-1 §6.3 (LC-1): create a project from an ACCEPTED quote. Idempotency-Key required; 201, or 200 on replay.
 * projects:create + finance:read + customers:read (all-of, §7, W1 §8.2).
 */
export const POST = tenantRoute(
  { permission: ['projects:create', 'finance:read', 'customers:read'], input: ProjectFromQuoteRequest, response: ProjectResponse },
  async ({ db, actor, input, request }) => {
    const { status, project } = await projectFromQuote(db, viewerOf(actor), actor.userId, workflowIdempotencyKey(request), input);
    return { status, body: { project } };
  },
);

export const OPTIONS = preflight;
