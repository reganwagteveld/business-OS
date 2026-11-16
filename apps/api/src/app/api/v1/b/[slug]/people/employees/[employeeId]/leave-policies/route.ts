import { EmployeeLeavePoliciesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { employeeLeavePolicies } from '@/modules/people';
import { employeeIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** P3-A: the leave policies that apply (and applied) to one employee. */
export const GET = tenantRoute({ permission: 'people:read', response: EmployeeLeavePoliciesResponse }, async ({ db, params }) => ({
  body: await employeeLeavePolicies(db, employeeIdOf(params)),
}));

export const OPTIONS = preflight;
