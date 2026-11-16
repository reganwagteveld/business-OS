import { LeaveConfigLifecycleRequest, LeavePolicyResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { restoreLeavePolicy } from '@/modules/people';
import { leavePolicyIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'people:configure', input: LeaveConfigLifecycleRequest, response: LeavePolicyResponse }, async ({ db, actor, params, input }) => ({
  body: { policy: await restoreLeavePolicy(db, actor.userId, leavePolicyIdOf(params), input) },
}));

export const OPTIONS = preflight;
