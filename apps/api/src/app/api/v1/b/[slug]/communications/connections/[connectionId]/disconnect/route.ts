import { MailConnectionResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { disconnectConnection } from '@/modules/communications';
import { connectionIdOf, connectionViewer } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Disconnects (final). Tokens are deleted in the same transaction; the provider revocation runs after commit. */
export const POST = tenantRoute({ permission: 'communications:read', response: MailConnectionResponse }, async ({ db, actor, params }) => {
  const { connection, revoke } = await disconnectConnection(db, connectionViewer(actor), connectionIdOf(params));
  return { body: { connection }, afterCommit: revoke };
});

export const OPTIONS = preflight;
