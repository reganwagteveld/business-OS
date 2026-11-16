import { ConfirmRequest, MemberResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { stepDown } from '@/modules/tenancy';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The calling owner becomes ADMIN, when another active owner remains (409 last_owner otherwise). */
export const POST = tenantRoute(
  { permission: 'business:read', input: ConfirmRequest, response: MemberResponse, retryOnConflict: true },
  async ({ db, actor }) => ({ body: { member: await stepDown(db, actor) } }),
);

export const OPTIONS = preflight;
