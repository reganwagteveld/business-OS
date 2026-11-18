import { RevokeSessionResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { revokeSession } from '@/modules/identity';
import { isUuid, publicRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * End one of your other sessions (contract: endpoints.revokeMySession, Settings A3-A). Your current session
 * answers 409 `use_sign_out`; any id that is not one of your live sessions answers 404.
 */
export const DELETE = publicRoute({ response: RevokeSessionResponse }, async ({ user, sessionToken, params }) => {
  if (!isUuid(params.sessionId)) throw new RecordNotFoundError();
  await revokeSession({ userId: user.id, sessionToken, targetSessionId: params.sessionId.toLowerCase() });
  return { body: { ok: true as const } };
});

export const OPTIONS = preflight;
