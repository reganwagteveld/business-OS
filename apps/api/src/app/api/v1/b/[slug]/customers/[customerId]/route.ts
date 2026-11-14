import { CustomerResponse, UpdateCustomerRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { getCustomer, updateCustomer } from '@/modules/customers';
import { isUuid, tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'customers:read', response: CustomerResponse }, async ({ db, params }) => {
  if (!isUuid(params.customerId)) throw new RecordNotFoundError();
  return { body: { customer: await getCustomer(db, params.customerId) } };
});

export const PATCH = tenantRoute({ permission: 'customers:write', input: UpdateCustomerRequest, response: CustomerResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.customerId)) throw new RecordNotFoundError();
  return { body: { customer: await updateCustomer(db, actor.userId, params.customerId, input) } };
});

export const OPTIONS = preflight;
