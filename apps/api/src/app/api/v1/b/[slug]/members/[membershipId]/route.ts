import { MemberResponse, OkResponse, UpdateMemberRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { changeRole, NotFoundError, removeMember, setMemberStatus } from '@/modules/tenancy';
import { isUuid, tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Changes a member's role ({ role }) or suspends/reactivates them ({ status }). */
export const PATCH = tenantRoute(
  { permission: 'members:manage', input: UpdateMemberRequest, response: MemberResponse, retryOnConflict: true },
  async ({ db, actor, params, input }) => {
    if (!isUuid(params.membershipId)) throw new NotFoundError();
    const member = 'role' in input
      ? await changeRole(db, actor, params.membershipId, input.role)
      : await setMemberStatus(db, actor, params.membershipId, input.status);
    return { body: { member } };
  },
);

export const DELETE = tenantRoute({ permission: 'members:manage', response: OkResponse, retryOnConflict: true }, async ({ db, actor, params }) => {
  if (!isUuid(params.membershipId)) throw new NotFoundError();
  await removeMember(db, actor, params.membershipId);
  return { body: { ok: true as const } };
});

export const OPTIONS = preflight;
