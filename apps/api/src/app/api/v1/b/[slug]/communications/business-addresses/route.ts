import {
  CreateMailBusinessAddressRequest, ListMailBusinessAddressesQuery, ListMailBusinessAddressesResponse, MailBusinessAddressResponse,
} from '@business-os/contracts';
import { preflight } from '@/core/http';
import { designateAddress, listAddresses } from '@/modules/communications';
import { businessMailboxActor, connectionViewer } from '../../../../../_lib/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Designated business mailbox addresses (manage_connections). */
export const GET = tenantRoute(
  { permission: 'communications:manage_connections', query: ListMailBusinessAddressesQuery, response: ListMailBusinessAddressesResponse },
  async ({ db, actor, query }) => ({ body: { addresses: await listAddresses(db, connectionViewer(actor), query) } }),
);

/**
 * Designates an address: on a verified domain, or (consumer domains only) with an OWNER's attestation.
 * Refused while someone has the address connected as a personal mailbox here.
 */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: CreateMailBusinessAddressRequest, response: MailBusinessAddressResponse },
  async ({ db, actor, input }) => ({ status: 201, body: { address: await designateAddress(db, businessMailboxActor(actor), input) } }),
);

export const OPTIONS = preflight;
