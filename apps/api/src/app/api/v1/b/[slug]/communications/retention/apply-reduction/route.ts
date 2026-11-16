import { ApplyRetentionReductionRequest, ApplyRetentionReductionResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { applyRetentionReduction } from '@/modules/communications';
import { sessionTokenOf } from '../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Ends the 30-day delay on a shortened retention period now (D-E1-3 exception). OWNER only, single-use
 * authorisation, audited with the reason. applied: false when no reduction was pending.
 */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: ApplyRetentionReductionRequest, response: ApplyRetentionReductionResponse, sessionToken: true },
  async ({ db, input, sessionToken }) => ({
    body: { applied: await applyRetentionReduction(db, sessionTokenOf(sessionToken), input.authorization, input.reason) },
  }),
);

export const OPTIONS = preflight;
