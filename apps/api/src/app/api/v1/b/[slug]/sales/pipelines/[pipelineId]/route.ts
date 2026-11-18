import { PipelineConfigResponse, UpdatePipelineRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { CONFIG_ROUTE_TIMEOUT_MS, getPipelineConfig, updatePipeline } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// S-CFG-1A (docs/sales-pipeline-configuration-scfg.md §6.1). Every role that reads Sales may read the
// configuration; changing it is a business setting: sales:manage (OWNER, ADMIN).
export const GET = tenantRoute({ permission: 'sales:read', response: PipelineConfigResponse }, async ({ db, params }) => {
  if (!isUuid(params.pipelineId)) throw new RecordNotFoundError();
  return { body: await getPipelineConfig(db, params.pipelineId) };
});

export const PATCH = tenantRoute(
  { permission: 'sales:manage', input: UpdatePipelineRequest, response: PipelineConfigResponse, timeoutMs: CONFIG_ROUTE_TIMEOUT_MS },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.pipelineId)) throw new RecordNotFoundError();
    return { body: await updatePipeline(db, actor.userId, params.pipelineId, input) };
  },
);

export const OPTIONS = preflight;
