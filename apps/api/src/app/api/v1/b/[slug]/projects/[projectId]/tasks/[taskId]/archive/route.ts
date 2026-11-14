import { TaskResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { archiveTask } from '@/modules/projects';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'projects:manage_tasks', response: TaskResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.projectId) || !isUuid(params.taskId)) throw new RecordNotFoundError();
  return { body: { task: await archiveTask(db, actor.userId, params.projectId, params.taskId) } };
});

export const OPTIONS = preflight;
