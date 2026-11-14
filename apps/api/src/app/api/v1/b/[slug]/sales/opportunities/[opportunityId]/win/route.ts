import { OpportunityResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { winOpportunity } from '@/modules/sales';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'sales:write', response: OpportunityResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.opportunityId)) throw new RecordNotFoundError();
  const idOf = (p: Record<string, string>) => p.opportunityId!;
  return { body: { opportunity: await winOpportunity(db, actor.userId, idOf(params)) } };
});

export const OPTIONS = preflight;
