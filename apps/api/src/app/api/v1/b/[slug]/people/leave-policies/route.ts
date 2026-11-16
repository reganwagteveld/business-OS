import { CreateLeavePolicyRequest, LeavePolicyResponse, ListLeavePoliciesQuery, ListLeavePoliciesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createLeavePolicy, listLeavePolicies } from '@/modules/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** P3-A: leave policies (people:read); creating one is people:configure. */
export const GET = tenantRoute({ permission: 'people:read', query: ListLeavePoliciesQuery, response: ListLeavePoliciesResponse }, async ({ db, query }) => ({
  body: await listLeavePolicies(db, query),
}));

export const POST = tenantRoute({ permission: 'people:configure', input: CreateLeavePolicyRequest, response: LeavePolicyResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { policy: await createLeavePolicy(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
