import { ChangeManagerRequest, EmployeeResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { changeManager } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'people:manage', input: ChangeManagerRequest, response: EmployeeResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.employeeId)) throw new RecordNotFoundError();
  return { body: { employee: await changeManager(db, actor.userId, params.employeeId, input) } };
});

export const OPTIONS = preflight;
