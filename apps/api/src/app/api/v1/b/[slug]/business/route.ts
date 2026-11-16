import { BusinessProfileResponse, UpdateBusinessProfileRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getBusinessProfile, updateBusinessProfile } from '@/modules/tenancy';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The business profile (Administration A2-A). Every member may read it. */
export const GET = tenantRoute({ permission: 'business:read', response: BusinessProfileResponse }, async ({ db }) => ({
  body: { business: await getBusinessProfile(db) },
}));

/** Partial edit with optimistic concurrency (`version`). Regional changes apply to new records only. */
export const PATCH = tenantRoute(
  { permission: 'business:manage', input: UpdateBusinessProfileRequest, response: BusinessProfileResponse },
  async ({ db, actor, input }) => ({ body: { business: await updateBusinessProfile(db, actor, input) } }),
);

export const OPTIONS = preflight;
