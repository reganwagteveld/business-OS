import { OpportunityResponse, RestoreOpportunityRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { restoreOpportunity } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'sales:write', input: RestoreOpportunityRequest, response: OpportunityResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.opportunityId)) throw new RecordNotFoundError();
  const idOf = (p: Record<string, string>) => p.opportunityId!;
  return { body: { opportunity: await restoreOpportunity(db, actor.userId, idOf(params), input ?? {}) } };
});

export const OPTIONS = preflight;
