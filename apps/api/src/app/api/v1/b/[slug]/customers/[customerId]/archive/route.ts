import { CustomerResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { archiveCustomer } from '@/modules/customers';
import { isUuid, tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Archiving is reversible and available to anyone who may edit customers (implementation plan 1d). */
export const POST = tenantRoute({ permission: 'customers:write', response: CustomerResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.customerId)) throw new RecordNotFoundError();
  return { body: { customer: await archiveCustomer(db, actor.userId, params.customerId) } };
});

export const OPTIONS = preflight;
