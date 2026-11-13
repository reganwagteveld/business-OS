import { BusinessContextResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getBusiness } from '@/modules/tenancy';
import { tenantRoute } from '../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The current business and the caller's role and permissions (for client-side visibility only). */
export const GET = tenantRoute({ permission: 'business:read', response: BusinessContextResponse }, async ({ db, actor }) => ({
  body: {
    business: await getBusiness(db),
    membership: { id: actor.membershipId, role: actor.role, permissions: [...actor.permissions] },
  },
}));

export const OPTIONS = preflight;
