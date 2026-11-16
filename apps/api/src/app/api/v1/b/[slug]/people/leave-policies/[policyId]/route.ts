import { LeavePolicyResponse, UpdateLeavePolicyRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getLeavePolicy, updateLeavePolicy } from '@/modules/people';
import { leavePolicyIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'people:read', response: LeavePolicyResponse }, async ({ db, params }) => ({
  body: { policy: await getLeavePolicy(db, leavePolicyIdOf(params)) },
}));

/** Edit rules, activate or deactivate (optimistic version). The leave type and unit are fixed. */
export const PATCH = tenantRoute({ permission: 'people:configure', input: UpdateLeavePolicyRequest, response: LeavePolicyResponse }, async ({ db, actor, params, input }) => ({
  body: { policy: await updateLeavePolicy(db, actor.userId, leavePolicyIdOf(params), input) },
}));

export const OPTIONS = preflight;
