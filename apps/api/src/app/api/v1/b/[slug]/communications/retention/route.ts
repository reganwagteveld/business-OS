import { MailRetentionResponse, SetMailRetentionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getRetention, setRetention } from '@/modules/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The ordinary-communications retention period (null until the business sets it; no product default). */
export const GET = tenantRoute({ permission: 'communications:read', response: MailRetentionResponse }, async ({ db }) => ({
  body: { retention: await getRetention(db) },
}));

/** Sets (version null) or changes it (OWNER and ADMIN through manage_connections). It cannot be unset. */
export const PUT = tenantRoute(
  { permission: 'communications:manage_connections', input: SetMailRetentionRequest, response: MailRetentionResponse },
  async ({ db, actor, input }) => ({ body: { retention: await setRetention(db, actor.userId, input) } }),
);

export const OPTIONS = preflight;
