import { ProjectResponse, UpdateProjectRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { getProject, updateProject, viewerOf } from '@/modules/projects';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

const idOf = (params: Record<string, string>) => {
  if (!isUuid(params.projectId)) throw new RecordNotFoundError();
  return params.projectId;
};

export const GET = tenantRoute({ permission: 'projects:read', response: ProjectResponse }, async ({ db, actor, params }) => ({
  body: { project: await getProject(db, viewerOf(actor), idOf(params)) },
}));

export const PATCH = tenantRoute({ permission: 'projects:update', input: UpdateProjectRequest, response: ProjectResponse }, async ({ db, actor, params, input }) => ({
  body: { project: await updateProject(db, viewerOf(actor), actor.userId, idOf(params), input) },
}));

export const OPTIONS = preflight;
