import { MailBusinessDomainResponse, VersionedRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { removeDomain } from '@/modules/communications';
import { connectionViewer, domainIdOf } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Removes a domain (final). Refused while a designated business address is on it. */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: VersionedRequest, response: MailBusinessDomainResponse },
  async ({ db, actor, params, input }) => ({ body: { domain: await removeDomain(db, connectionViewer(actor), domainIdOf(params), input.version) } }),
);

export const OPTIONS = preflight;
