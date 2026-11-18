import { CreateProjectRequest, ListProjectsQuery, ListProjectsResponse, ProjectResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { authorize } from '@/modules/access';
import { createProject, listProjects, viewerOf } from '@/modules/projects';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** WF-1 §6.6 (LC-1): the sourceOpportunityId filter also needs sales:read (a Projects key never reaches into Sales). */
export const GET = tenantRoute({ permission: 'projects:read', query: ListProjectsQuery, response: ListProjectsResponse }, async ({ db, actor, query }) => {
  if (query.sourceOpportunityId !== undefined) authorize(actor, 'sales:read');
  return { body: await listProjects(db, viewerOf(actor), query) };
});

export const POST = tenantRoute({ permission: 'projects:create', input: CreateProjectRequest, response: ProjectResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { project: await createProject(db, viewerOf(actor), actor.userId, input) },
}));

export const OPTIONS = preflight;
