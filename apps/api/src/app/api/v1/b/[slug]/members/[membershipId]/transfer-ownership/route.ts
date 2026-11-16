import { MemberResponse, TransferOwnershipRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { NotFoundError, transferOwnership } from '@/modules/tenancy';
import { isUuid, tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Makes another ACTIVE member an OWNER (OWNER only, re-checked inside the transaction), optionally
 * stepping the caller down to ADMIN in the same transaction. Requires `confirm: true`. Audited.
 */
export const POST = tenantRoute(
  { permission: 'members:manage', input: TransferOwnershipRequest, response: MemberResponse, retryOnConflict: true },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.membershipId)) throw new NotFoundError();
    return { body: { member: await transferOwnership(db, actor, params.membershipId, { stepDown: input.stepDown }) } };
  },
);

export const OPTIONS = preflight;
