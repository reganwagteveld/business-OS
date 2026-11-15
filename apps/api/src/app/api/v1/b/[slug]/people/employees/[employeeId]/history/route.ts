import { EmployeeHistoryResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { employeeHistory, viewerOf } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'people:read', response: EmployeeHistoryResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.employeeId)) throw new RecordNotFoundError();
  return { body: await employeeHistory(db, viewerOf(actor), params.employeeId) };
});

export const OPTIONS = preflight;
