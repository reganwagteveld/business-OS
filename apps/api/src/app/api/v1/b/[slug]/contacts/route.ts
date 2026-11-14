import { ContactResponse, CreateContactRequest, ListContactsQuery, ListContactsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createContact, listContacts } from '@/modules/customers';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'customers:read', query: ListContactsQuery, response: ListContactsResponse }, async ({ db, query }) => ({
  body: await listContacts(db, query),
}));

export const POST = tenantRoute({ permission: 'customers:write', input: CreateContactRequest, response: ContactResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { contact: await createContact(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
