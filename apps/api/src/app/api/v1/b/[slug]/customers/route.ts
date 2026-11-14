import { CreateCustomerRequest, CustomerResponse, ListCustomersQuery, ListCustomersResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createCustomer, listCustomers } from '@/modules/customers';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'customers:read', query: ListCustomersQuery, response: ListCustomersResponse }, async ({ db, query }) => ({
  body: await listCustomers(db, query),
}));

export const POST = tenantRoute({ permission: 'customers:write', input: CreateCustomerRequest, response: CustomerResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { customer: await createCustomer(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
