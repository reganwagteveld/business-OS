import { RevokeOtherSessionsRequest, RevokeOtherSessionsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { revokeOtherSessions } from '@/modules/identity';
import { publicRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * End every session but this one (contract: endpoints.revokeMyOtherSessions, Settings A3-A). Needs the current
 * password (step-up, D-A3-11). Rate-limited per account.
 */
export const POST = publicRoute({ input: RevokeOtherSessionsRequest, response: RevokeOtherSessionsResponse }, async ({ user, sessionToken, input }) => ({
  body: await revokeOtherSessions({ userId: user.id, sessionToken, password: input.password }),
}));

export const OPTIONS = preflight;
