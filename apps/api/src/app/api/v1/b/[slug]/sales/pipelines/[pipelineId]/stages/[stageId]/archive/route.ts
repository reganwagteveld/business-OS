import { ArchiveStageRequest, ArchiveStageResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { archiveStage, CONFIG_ROUTE_TIMEOUT_MS } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// S-CFG-1A §5.3, §6.1: archive a stage, moving its open opportunities to `moveOpenTo` in the same unit of
// work (D-SCFG-2). sales:manage. A lock wait or time limit answers 409 busy with nothing changed.
export const POST = tenantRoute(
  { permission: 'sales:manage', input: ArchiveStageRequest, response: ArchiveStageResponse, timeoutMs: CONFIG_ROUTE_TIMEOUT_MS },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.pipelineId) || !isUuid(params.stageId)) throw new RecordNotFoundError();
    return { body: await archiveStage(db, actor.userId, params.pipelineId, params.stageId, input) };
  },
);

export const OPTIONS = preflight;
