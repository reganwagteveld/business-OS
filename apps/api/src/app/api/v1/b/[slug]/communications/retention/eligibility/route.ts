import { RetentionEligibilityResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { retentionEligibility } from '@/modules/communications';
import { tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** What the next purge would erase, per category, computed by the same database rule the purge uses. Counts only. */
export const GET = tenantRoute({ permission: 'communications:manage_connections', response: RetentionEligibilityResponse }, async ({ db }) => ({
  body: { eligibility: await retentionEligibility(db) },
}));

export const OPTIONS = preflight;
