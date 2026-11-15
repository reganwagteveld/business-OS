import { ListMailConnectionMembersResponse, SetMailConnectionMemberRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { setMember } from '@/modules/communications';
import { connectionIdOf, connectionViewer, memberUserIdOf } from '../../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Grants or changes READ/SEND on a BUSINESS mailbox for an active member (manage_connections). */
export const PUT = tenantRoute(
  { permission: 'communications:read', input: SetMailConnectionMemberRequest, response: ListMailConnectionMembersResponse },
  async ({ db, actor, params, input }) => ({
    body: { members: await setMember(db, connectionViewer(actor), connectionIdOf(params), memberUserIdOf(params), input.access) },
  }),
);

export const OPTIONS = preflight;
