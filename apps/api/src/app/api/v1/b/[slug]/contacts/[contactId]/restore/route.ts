import { ContactResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { restoreContact } from '@/modules/customers';
import { isUuid, tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'customers:write', response: ContactResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.contactId)) throw new RecordNotFoundError();
  return { body: { contact: await restoreContact(db, actor.userId, params.contactId) } };
});

export const OPTIONS = preflight;
