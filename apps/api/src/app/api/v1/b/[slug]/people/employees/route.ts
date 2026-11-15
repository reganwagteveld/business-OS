import { CreateEmployeeRequest, EmployeeResponse, ListEmployeesQuery, ListEmployeesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createEmployee, listEmployees } from '@/modules/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'people:read', query: ListEmployeesQuery, response: ListEmployeesResponse }, async ({ db, query }) => ({
  body: await listEmployees(db, query),
}));

export const POST = tenantRoute({ permission: 'people:manage', input: CreateEmployeeRequest, response: EmployeeResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { employee: await createEmployee(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
