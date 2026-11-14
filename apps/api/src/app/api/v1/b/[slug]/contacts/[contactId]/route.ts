import { ContactResponse, UpdateContactRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { getContact, updateContact } from '@/modules/customers';
import { isUuid, tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'customers:read', response: ContactResponse }, async ({ db, params }) => {
  if (!isUuid(params.contactId)) throw new RecordNotFoundError();
  return { body: { contact: await getContact(db, params.contactId) } };
});

export const PATCH = tenantRoute({ permission: 'customers:write', input: UpdateContactRequest, response: ContactResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.contactId)) throw new RecordNotFoundError();
  return { body: { contact: await updateContact(db, actor.userId, params.contactId, input) } };
});

export const OPTIONS = preflight;
