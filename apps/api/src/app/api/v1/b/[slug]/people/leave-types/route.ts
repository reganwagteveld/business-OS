import { CreateLeaveTypeRequest, LeaveTypeResponse, ListLeaveTypesQuery, ListLeaveTypesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createLeaveType, listLeaveTypes } from '@/modules/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** P3-A: leave types (people:read); creating one is people:configure. */
export const GET = tenantRoute({ permission: 'people:read', query: ListLeaveTypesQuery, response: ListLeaveTypesResponse }, async ({ db, query }) => ({
  body: await listLeaveTypes(db, query),
}));

export const POST = tenantRoute({ permission: 'people:configure', input: CreateLeaveTypeRequest, response: LeaveTypeResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { leaveType: await createLeaveType(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
