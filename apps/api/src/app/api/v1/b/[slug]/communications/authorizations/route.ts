import { CreatePrivilegedAuthorizationRequest, PrivilegedAuthorizationResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { authorizeOperation } from '@/modules/communications';
import { sessionTokenOf } from '../../../../../_lib/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * A single-use, 5-minute code for exactly one high-risk operation on one target (D-E1-4,
 * docs/communications-e1.md §8). The database checks the session itself: an active OWNER or ADMIN (OWNER
 * for APPLY_RETENTION_REDUCTION) with a verified email. Only a hash of the code is stored.
 */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: CreatePrivilegedAuthorizationRequest, response: PrivilegedAuthorizationResponse, sessionToken: true },
  async ({ db, input, sessionToken }) => ({
    status: 201, body: { authorization: await authorizeOperation(db, sessionTokenOf(sessionToken), input.operation, input.targetId) },
  }),
);

export const OPTIONS = preflight;
