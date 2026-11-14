import { OpportunityResponse, UpdateOpportunityRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { getOpportunity, updateOpportunity } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

const idOf = (params: Record<string, string>) => {
  if (!isUuid(params.opportunityId)) throw new RecordNotFoundError();
  return params.opportunityId;
};

export const GET = tenantRoute({ permission: 'sales:read', response: OpportunityResponse }, async ({ db, params }) => ({
  body: { opportunity: await getOpportunity(db, idOf(params)) },
}));

export const PATCH = tenantRoute({ permission: 'sales:write', input: UpdateOpportunityRequest, response: OpportunityResponse }, async ({ db, actor, params, input }) => ({
  body: { opportunity: await updateOpportunity(db, actor.userId, idOf(params), input) },
}));

export const OPTIONS = preflight;
