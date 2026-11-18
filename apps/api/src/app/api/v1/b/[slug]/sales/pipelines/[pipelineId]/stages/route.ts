import { CreateStageRequest, PipelineConfigResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { CONFIG_ROUTE_TIMEOUT_MS, createStage } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// S-CFG-1A §6.1: add a stage (at the end, or after a named active stage). sales:manage.
export const POST = tenantRoute(
  { permission: 'sales:manage', input: CreateStageRequest, response: PipelineConfigResponse, timeoutMs: CONFIG_ROUTE_TIMEOUT_MS },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.pipelineId)) throw new RecordNotFoundError();
    return { status: 201, body: await createStage(db, actor.userId, params.pipelineId, input) };
  },
);

export const OPTIONS = preflight;
