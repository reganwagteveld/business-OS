import { CreateDepartmentRequest, DepartmentResponse, ListDepartmentsResponse, ListOrgUnitsQuery } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createOrgUnit, listOrgUnits, toDepartment } from '@/modules/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'people:read', query: ListOrgUnitsQuery, response: ListDepartmentsResponse }, async ({ db, query }) => {
  const { rows, nextCursor } = await listOrgUnits(db, 'department', query);
  return { body: { departments: rows.map(toDepartment), nextCursor } };
});

export const POST = tenantRoute({ permission: 'people:configure', input: CreateDepartmentRequest, response: DepartmentResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { department: toDepartment(await createOrgUnit(db, 'department', actor.userId, input)) },
}));

export const OPTIONS = preflight;
