import { TaskResponse, UpdateTaskRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { updateTask } from '@/modules/projects';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const PATCH = tenantRoute({ permission: 'projects:manage_tasks', input: UpdateTaskRequest, response: TaskResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.projectId) || !isUuid(params.taskId)) throw new RecordNotFoundError();
  return { body: { task: await updateTask(db, actor.userId, params.projectId, params.taskId, input) } };
});

export const OPTIONS = preflight;
