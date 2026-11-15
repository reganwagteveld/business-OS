import { DepartmentResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { archiveOrgUnit, toDepartment } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'people:configure', response: DepartmentResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.departmentId)) throw new RecordNotFoundError();
  return { body: { department: toDepartment(await archiveOrgUnit(db, 'department', actor.userId, params.departmentId)) } };
});

export const OPTIONS = preflight;
