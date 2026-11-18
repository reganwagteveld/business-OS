import { LinkProjectQuoteRequest, ProjectResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { viewerOf } from '@/modules/projects';
import { linkProjectQuote } from '@/modules/workflows';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** WF-1 §6.4 (LC-1): associate an ACCEPTED quote with a project, once. projects:update + finance:read (all-of, §7). */
export const POST = tenantRoute(
  { permission: ['projects:update', 'finance:read'], input: LinkProjectQuoteRequest, response: ProjectResponse },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.projectId)) throw new RecordNotFoundError();
    return { body: { project: await linkProjectQuote(db, viewerOf(actor), actor.userId, params.projectId, input) } };
  },
);

export const OPTIONS = preflight;
