import { MailBusinessDomainResponse, VersionedRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { StateConflictError } from '@/core/http/errors';
import { dnsHasToken, domainToVerify, recordDomainVerification } from '@/modules/communications';
import { connectionViewer, domainIdOf } from '../../../../../../../_lib/communications';
import { tenantRunRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Looks up the TXT record now (server-side DNS, outside any transaction) and records the outcome.
 * 409 dns_record_not_found when the record is not (yet) visible; DNS changes can take a while.
 */
export const POST = tenantRunRoute(
  { permission: 'communications:manage_connections', input: VersionedRequest, response: MailBusinessDomainResponse },
  async ({ actor, params, input, run }) => {
    const viewer = connectionViewer(actor);
    const id = domainIdOf(params);
    const target = await run((db) => domainToVerify(db, viewer, id, input.version));
    const found = await dnsHasToken(target.name, target.hash);
    const domain = await run((db) => recordDomainVerification(db, viewer, id, input.version, found));
    if (!domain) throw new StateConflictError('dns_record_not_found');
    return { body: { domain } };
  },
);

export const OPTIONS = preflight;
