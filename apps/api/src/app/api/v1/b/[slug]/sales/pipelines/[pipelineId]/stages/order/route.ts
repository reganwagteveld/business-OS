import { PipelineConfigResponse, ReorderStagesRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { CONFIG_ROUTE_TIMEOUT_MS, reorderStages } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// S-CFG-1A §6.1: the complete new order of the active stages. sales:manage.
export const PUT = tenantRoute(
  { permission: 'sales:manage', input: ReorderStagesRequest, response: PipelineConfigResponse, timeoutMs: CONFIG_ROUTE_TIMEOUT_MS },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.pipelineId)) throw new RecordNotFoundError();
    return { body: await reorderStages(db, actor.userId, params.pipelineId, input) };
  },
);

export const OPTIONS = preflight;
