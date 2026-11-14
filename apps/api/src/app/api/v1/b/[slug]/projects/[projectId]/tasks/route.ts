import { CreateTaskRequest, ListTasksQuery, ListTasksResponse, TaskResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { createTask, listTasks } from '@/modules/projects';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

const idOf = (params: Record<string, string>) => {
  if (!isUuid(params.projectId)) throw new RecordNotFoundError();
  return params.projectId;
};

export const GET = tenantRoute({ permission: 'projects:read', query: ListTasksQuery, response: ListTasksResponse }, async ({ db, params, query }) => ({
  body: await listTasks(db, idOf(params), query),
}));

export const POST = tenantRoute({ permission: 'projects:manage_tasks', input: CreateTaskRequest, response: TaskResponse }, async ({ db, actor, params, input }) => ({
  status: 201,
  body: { task: await createTask(db, actor.userId, idOf(params), input) },
}));

export const OPTIONS = preflight;
