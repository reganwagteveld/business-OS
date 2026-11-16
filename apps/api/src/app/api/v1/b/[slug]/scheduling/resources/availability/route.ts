import { ResourceAvailabilityQuery, ResourceAvailabilityResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { resourceAvailability } from '@/modules/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// Advisory (no lock): an enforced booking re-checks inside its own transaction.
export const GET = tenantRoute({ permission: 'scheduling:read', query: ResourceAvailabilityQuery, response: ResourceAvailabilityResponse }, async ({ db, query }) => ({
  body: await resourceAvailability(db, query),
}));

export const OPTIONS = preflight;
