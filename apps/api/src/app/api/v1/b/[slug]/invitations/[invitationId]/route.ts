import { OkResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { NotFoundError, revokeInvitation } from '@/modules/tenancy';
import { isUuid, tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const DELETE = tenantRoute({ permission: 'members:invite', response: OkResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.invitationId)) throw new NotFoundError();
  await revokeInvitation(db, actor, params.invitationId);
  return { body: { ok: true as const } };
});

export const OPTIONS = preflight;
