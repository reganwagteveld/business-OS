import { ProjectResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { archiveProject, viewerOf } from '@/modules/projects';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'projects:archive', response: ProjectResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.projectId)) throw new RecordNotFoundError();
  return { body: { project: await archiveProject(db, viewerOf(actor), actor.userId, params.projectId) } };
});

export const OPTIONS = preflight;
