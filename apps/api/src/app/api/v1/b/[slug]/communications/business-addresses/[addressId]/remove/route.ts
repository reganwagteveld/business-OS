import { MailBusinessAddressResponse, VersionedRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { removeAddress } from '@/modules/communications';
import { addressIdOf, connectionViewer } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Ends a designation (final). Its business mailbox must be disconnected first. */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: VersionedRequest, response: MailBusinessAddressResponse },
  async ({ db, actor, params, input }) => ({ body: { address: await removeAddress(db, connectionViewer(actor), addressIdOf(params), input.version) } }),
);

export const OPTIONS = preflight;
