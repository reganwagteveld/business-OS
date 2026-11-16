import { ConfirmRequest, OkResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { leaveBusiness } from '@/modules/tenancy';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The caller leaves this business (not the last active owner: 409 last_owner). Access ends at once. */
export const POST = tenantRoute(
  { permission: 'business:read', input: ConfirmRequest, response: OkResponse, retryOnConflict: true },
  async ({ db, actor }) => {
    await leaveBusiness(db, actor);
    return { body: { ok: true as const } };
  },
);

export const OPTIONS = preflight;
