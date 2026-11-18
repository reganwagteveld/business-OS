import { PipelineConfigResponse, UpdateStageRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { CONFIG_ROUTE_TIMEOUT_MS, updateStage } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// S-CFG-1A §6.1: rename a stage or change its default probability (a hint only, D-SCFG-4). sales:manage.
export const PATCH = tenantRoute(
  { permission: 'sales:manage', input: UpdateStageRequest, response: PipelineConfigResponse, timeoutMs: CONFIG_ROUTE_TIMEOUT_MS },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.pipelineId) || !isUuid(params.stageId)) throw new RecordNotFoundError();
    return { body: await updateStage(db, actor.userId, params.pipelineId, params.stageId, input) };
  },
);

export const OPTIONS = preflight;
