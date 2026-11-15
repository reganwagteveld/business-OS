import { MailConnectionResponse, UpdateMailConnectionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getConnection, updateConnection } from '@/modules/communications';
import { connectionIdOf, connectionViewer } from '../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'communications:read', response: MailConnectionResponse }, async ({ db, actor, params }) => ({
  body: { connection: await getConnection(db, connectionViewer(actor), connectionIdOf(params)) },
}));

/** Sharing (BUSINESS only by the owner) and pause/resume sync (owner or manage_connections). */
export const PATCH = tenantRoute(
  { permission: 'communications:read', input: UpdateMailConnectionRequest, response: MailConnectionResponse },
  async ({ db, actor, params, input }) => ({ body: { connection: await updateConnection(db, connectionViewer(actor), connectionIdOf(params), input) } }),
);

export const OPTIONS = preflight;
