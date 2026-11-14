import { MoveTaskRequest, TaskResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { moveTask } from '@/modules/projects';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Board move: status and order together (docs/projects-data-model.md §4). Same permission as any task change. */
export const POST = tenantRoute({ permission: 'projects:manage_tasks', input: MoveTaskRequest, response: TaskResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.projectId) || !isUuid(params.taskId)) throw new RecordNotFoundError();
  return { body: { task: await moveTask(db, actor.userId, params.projectId, params.taskId, input) } };
});

export const OPTIONS = preflight;
