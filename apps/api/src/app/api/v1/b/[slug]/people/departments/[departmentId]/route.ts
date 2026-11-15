import { DepartmentResponse, UpdateDepartmentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { toDepartment, updateOrgUnit } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const PATCH = tenantRoute({ permission: 'people:configure', input: UpdateDepartmentRequest, response: DepartmentResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.departmentId)) throw new RecordNotFoundError();
  return { body: { department: toDepartment(await updateOrgUnit(db, 'department', actor.userId, params.departmentId, input)) } };
});

export const OPTIONS = preflight;
