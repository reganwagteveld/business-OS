import { EmployeeResponse, UpdateEmployeeRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { getEmployee, updateEmployee } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

const idOf = (params: Record<string, string>) => {
  if (!isUuid(params.employeeId)) throw new RecordNotFoundError();
  return params.employeeId;
};

export const GET = tenantRoute({ permission: 'people:read', response: EmployeeResponse }, async ({ db, params }) => ({
  body: { employee: await getEmployee(db, idOf(params)) },
}));

export const PATCH = tenantRoute({ permission: 'people:manage', input: UpdateEmployeeRequest, response: EmployeeResponse }, async ({ db, actor, params, input }) => ({
  body: { employee: await updateEmployee(db, actor.userId, idOf(params), input) },
}));

export const OPTIONS = preflight;
