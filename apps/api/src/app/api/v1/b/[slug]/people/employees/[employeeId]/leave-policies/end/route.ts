import { EmployeeLeavePoliciesResponse, EndLeavePolicyAssignmentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { endLeavePolicyAssignment } from '@/modules/people';
import { employeeIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Stop applying the employee's policy of one leave type from the effective date (people:manage). */
export const POST = tenantRoute({ permission: 'people:manage', input: EndLeavePolicyAssignmentRequest, response: EmployeeLeavePoliciesResponse }, async ({ db, actor, params, input }) => ({
  body: await endLeavePolicyAssignment(db, actor.userId, employeeIdOf(params), input),
}));

export const OPTIONS = preflight;
