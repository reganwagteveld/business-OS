import { CreateMailBusinessDomainRequest, ListMailBusinessDomainsResponse, MailBusinessDomainResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { addDomain, listDomains } from '@/modules/communications';
import { connectionViewer } from '../../../../../_lib/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Email domains this business has added or verified (manage_connections; docs/communications-c2.md §16.3). */
export const GET = tenantRoute({ permission: 'communications:manage_connections', response: ListMailBusinessDomainsResponse }, async ({ db, actor }) => ({
  body: { domains: await listDomains(db, connectionViewer(actor)) },
}));

/** Adds an unverified domain; the answer carries the TXT record value once (only its hash is stored). */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: CreateMailBusinessDomainRequest, response: MailBusinessDomainResponse },
  async ({ db, actor, input }) => ({ status: 201, body: { domain: await addDomain(db, connectionViewer(actor), input) } }),
);

export const OPTIONS = preflight;
