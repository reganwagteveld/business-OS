import { CreateOpportunityRequest, ListOpportunitiesQuery, ListOpportunitiesResponse, OpportunityResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createOpportunity, listOpportunities } from '@/modules/sales';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'sales:read', query: ListOpportunitiesQuery, response: ListOpportunitiesResponse }, async ({ db, query }) => ({
  body: await listOpportunities(db, query),
}));

export const POST = tenantRoute({ permission: 'sales:write', input: CreateOpportunityRequest, response: OpportunityResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { opportunity: await createOpportunity(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
