import { CreateProjectRequest, ListProjectsQuery, ListProjectsResponse, ProjectResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createProject, listProjects, viewerOf } from '@/modules/projects';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'projects:read', query: ListProjectsQuery, response: ListProjectsResponse }, async ({ db, actor, query }) => ({
  body: await listProjects(db, viewerOf(actor), query),
}));

export const POST = tenantRoute({ permission: 'projects:create', input: CreateProjectRequest, response: ProjectResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { project: await createProject(db, viewerOf(actor), actor.userId, input) },
}));

export const OPTIONS = preflight;
