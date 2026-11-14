import { ListOutcomesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { listOutcomes } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'sales:read', response: ListOutcomesResponse }, async ({ db, params }) => {
  if (!isUuid(params.opportunityId)) throw new RecordNotFoundError();
  return { body: await listOutcomes(db, params.opportunityId) };
});

export const OPTIONS = preflight;
