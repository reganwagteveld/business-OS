import { ListMailConnectionMembersResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { removeMember } from '@/modules/communications';
import { connectionIdOf, connectionViewer, memberUserIdOf } from '../../../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Revokes a member's access to a BUSINESS mailbox (manage_connections). */
export const POST = tenantRoute({ permission: 'communications:read', response: ListMailConnectionMembersResponse }, async ({ db, actor, params }) => ({
  body: { members: await removeMember(db, connectionViewer(actor), connectionIdOf(params), memberUserIdOf(params)) },
}));

export const OPTIONS = preflight;
