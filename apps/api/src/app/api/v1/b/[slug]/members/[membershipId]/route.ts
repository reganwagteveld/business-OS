import { ChangeRoleRequest, MemberResponse, OkResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { changeRole, NotFoundError, removeMember } from '@/modules/tenancy';
import { isUuid, tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const PATCH = tenantRoute({ permission: 'members:manage', input: ChangeRoleRequest, response: MemberResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.membershipId)) throw new NotFoundError();
  return { body: { member: await changeRole(db, actor, params.membershipId, input.role) } };
});

export const DELETE = tenantRoute({ permission: 'members:manage', response: OkResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.membershipId)) throw new NotFoundError();
  await removeMember(db, actor, params.membershipId);
  return { body: { ok: true as const } };
});

export const OPTIONS = preflight;
