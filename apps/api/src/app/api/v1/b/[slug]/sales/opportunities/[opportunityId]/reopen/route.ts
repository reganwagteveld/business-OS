import { ReopenOpportunityRequest, OpportunityResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { reopenOpportunity } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'sales:write', input: ReopenOpportunityRequest, response: OpportunityResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.opportunityId)) throw new RecordNotFoundError();
  const idOf = (p: Record<string, string>) => p.opportunityId!;
  return { body: { opportunity: await reopenOpportunity(db, actor.userId, idOf(params), input) } };
});

export const OPTIONS = preflight;
