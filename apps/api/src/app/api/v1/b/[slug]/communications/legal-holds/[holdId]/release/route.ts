import { LegalHoldResponse, ReleaseLegalHoldRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { releaseLegalHold } from '@/modules/communications';
import { holdIdOf, sessionTokenOf } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Releases a hold (final). Needs a single-use authorisation for RELEASE_LEGAL_HOLD on this hold. */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: ReleaseLegalHoldRequest, response: LegalHoldResponse, sessionToken: true },
  async ({ db, params, input, sessionToken }) => ({
    body: { hold: await releaseLegalHold(db, sessionTokenOf(sessionToken), holdIdOf(params), input.authorization) },
  }),
);

export const OPTIONS = preflight;
