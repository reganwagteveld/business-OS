import { AvailabilityQuery, AvailabilityResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { checkAvailability } from '@/modules/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'scheduling:read', query: AvailabilityQuery, response: AvailabilityResponse }, async ({ db, query }) => ({
  body: await checkAvailability(db, query),
}));

export const OPTIONS = preflight;
