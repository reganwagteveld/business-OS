import { PipelineResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { initialiseDefaultPipeline } from '@/modules/sales';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// Explicit, idempotent initialisation of the default pipeline (docs/sales-data-model.md §2). Any role
// that can work on opportunities may run it, since opportunities need a pipeline; it creates only the
// standard default and is safe to repeat or race.
export const POST = tenantRoute({ permission: 'sales:write', response: PipelineResponse }, async ({ db, actor }) => {
  const { created, ...body } = await initialiseDefaultPipeline(db, actor.userId);
  return { status: created ? 201 : 200, body };
});

export const OPTIONS = preflight;
