import { MailConnectionResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { disconnectConnection } from '@/modules/communications';
import { connectionIdOf, connectionViewer } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Disconnects (final). Tokens are deleted in the same transaction; the provider grant is not revoked (C2A-03). */
export const POST = tenantRoute({ permission: 'communications:read', response: MailConnectionResponse }, async ({ db, actor, params }) => ({
  body: { connection: await disconnectConnection(db, connectionViewer(actor), connectionIdOf(params)) },
}));

export const OPTIONS = preflight;
