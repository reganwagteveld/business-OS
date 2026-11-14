import { ListStagesQuery, ListStagesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listStages } from '@/modules/sales';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'sales:read', query: ListStagesQuery, response: ListStagesResponse }, async ({ db, actor, query }) => ({
  body: await listStages(db, actor.userId, query),
}));

export const OPTIONS = preflight;
