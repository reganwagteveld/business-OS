import { AccountSessionsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listSessions } from '@/modules/identity';
import { publicRoute } from '../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Your signed-in devices (contract: endpoints.listMySessions, Settings A3-A). Opaque ids only. */
export const GET = publicRoute({ response: AccountSessionsResponse }, async ({ user, sessionToken }) => ({
  body: await listSessions({ userId: user.id, sessionToken }),
}));

export const OPTIONS = preflight;
