import { AuthorizeMailConnectionRequest, AuthorizeMailConnectionResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { startAuthorization } from '@/modules/communications';
import { connectionViewer } from '../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Starts a consent at the provider (or a reconnect of the caller's own mailbox). Returns the
 * provider URL to open in the browser where the caller is signed in; it works once, for 10 minutes.
 */
export const POST = tenantRoute(
  { permission: 'communications:connect', input: AuthorizeMailConnectionRequest, response: AuthorizeMailConnectionResponse },
  async ({ db, actor, params, input }) => ({ status: 201, body: await startAuthorization(db, connectionViewer(actor), params.slug!, input) }),
);

export const OPTIONS = preflight;
