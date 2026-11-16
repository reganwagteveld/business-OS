import { LeaveConfigLifecycleRequest, LeaveTypeResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { archiveLeaveType } from '@/modules/people';
import { leaveTypeIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'people:configure', input: LeaveConfigLifecycleRequest, response: LeaveTypeResponse }, async ({ db, actor, params, input }) => ({
  body: { leaveType: await archiveLeaveType(db, actor.userId, leaveTypeIdOf(params), input) },
}));

export const OPTIONS = preflight;
