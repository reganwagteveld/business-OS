import { PipelineConfigResponse, RestoreStageRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { CONFIG_ROUTE_TIMEOUT_MS, restoreStage } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// S-CFG-1A §6.1: restore an archived stage to the end of the active order. sales:manage.
export const POST = tenantRoute(
  { permission: 'sales:manage', input: RestoreStageRequest, response: PipelineConfigResponse, timeoutMs: CONFIG_ROUTE_TIMEOUT_MS },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.pipelineId) || !isUuid(params.stageId)) throw new RecordNotFoundError();
    return { body: await restoreStage(db, actor.userId, params.pipelineId, params.stageId, input) };
  },
);

export const OPTIONS = preflight;
