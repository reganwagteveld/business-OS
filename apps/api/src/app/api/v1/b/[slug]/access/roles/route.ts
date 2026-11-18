import { AccessRolesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { describeAccessModel } from '@/modules/access';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * The fixed roles and what each may do (Administration A2-C, docs/administration-a2.md §7). Read-only, and the same
 * for every business: it holds no tenant data. Every member may read it (business:read, D-A3 §9). There is no write
 * route and no custom roles; changing that needs its own architecture decision.
 */
export const GET = tenantRoute({ permission: 'business:read', response: AccessRolesResponse }, async () => ({
  body: describeAccessModel(),
}));

export const OPTIONS = preflight;
