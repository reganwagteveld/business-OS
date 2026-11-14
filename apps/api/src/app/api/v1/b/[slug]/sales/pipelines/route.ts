import { CreatePipelineRequest, ListPipelinesResponse, PipelineResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createPipeline, listPipelines } from '@/modules/sales';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// Reading creates the default pipeline on first use (concurrency-safe; docs/sales-data-model.md §2).
export const GET = tenantRoute({ permission: 'sales:read', response: ListPipelinesResponse }, async ({ db, actor }) => ({
  body: await listPipelines(db, actor.userId),
}));

// Pipeline configuration is a business setting: sales:manage (OWNER, ADMIN).
export const POST = tenantRoute({ permission: 'sales:manage', input: CreatePipelineRequest, response: PipelineResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: await createPipeline(db, actor.userId, input),
}));

export const OPTIONS = preflight;
