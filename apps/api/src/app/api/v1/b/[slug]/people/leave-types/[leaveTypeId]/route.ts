import { LeaveTypeResponse, UpdateLeaveTypeRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getLeaveType, updateLeaveType } from '@/modules/people';
import { leaveTypeIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'people:read', response: LeaveTypeResponse }, async ({ db, params }) => ({
  body: { leaveType: await getLeaveType(db, leaveTypeIdOf(params)) },
}));

/** Edit, activate or deactivate (optimistic version). There is no DELETE: types are archived. */
export const PATCH = tenantRoute({ permission: 'people:configure', input: UpdateLeaveTypeRequest, response: LeaveTypeResponse }, async ({ db, actor, params, input }) => ({
  body: { leaveType: await updateLeaveType(db, actor.userId, leaveTypeIdOf(params), input) },
}));

export const OPTIONS = preflight;
