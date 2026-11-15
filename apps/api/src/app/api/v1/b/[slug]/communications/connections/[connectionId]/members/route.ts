import { ListMailConnectionMembersResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listMembers } from '@/modules/communications';
import { connectionIdOf, connectionViewer } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Who may use a BUSINESS mailbox (manage_connections). */
export const GET = tenantRoute({ permission: 'communications:read', response: ListMailConnectionMembersResponse }, async ({ db, actor, params }) => ({
  body: { members: await listMembers(db, connectionViewer(actor), connectionIdOf(params)) },
}));

export const OPTIONS = preflight;
