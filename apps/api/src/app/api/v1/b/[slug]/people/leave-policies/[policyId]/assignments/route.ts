import { AssignLeavePolicyRequest, AssignLeavePolicyResponse, ListPolicyAssignmentsQuery, ListPolicyAssignmentsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { assignLeavePolicy, listPolicyAssignments } from '@/modules/people';
import { leavePolicyIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'people:read', query: ListPolicyAssignmentsQuery, response: ListPolicyAssignmentsResponse }, async ({ db, params, query }) => ({
  body: await listPolicyAssignments(db, leavePolicyIdOf(params), query),
}));

/** Assign the policy to up to 100 employees, all or nothing (people:manage). */
export const POST = tenantRoute({ permission: 'people:manage', input: AssignLeavePolicyRequest, response: AssignLeavePolicyResponse }, async ({ db, actor, params, input }) => ({
  body: await assignLeavePolicy(db, actor.userId, leavePolicyIdOf(params), input),
}));

export const OPTIONS = preflight;
