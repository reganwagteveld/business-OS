import { ListMailConnectionsQuery, ListMailConnectionsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listConnections } from '@/modules/communications';
import { connectionViewer } from '../../../../../_lib/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Mailboxes the caller may see: their own, BUSINESS-shared ones, or all with manage_connections. */
export const GET = tenantRoute(
  { permission: 'communications:read', query: ListMailConnectionsQuery, response: ListMailConnectionsResponse },
  async ({ db, actor, query }) => ({ body: { connections: await listConnections(db, connectionViewer(actor), query) } }),
);

export const OPTIONS = preflight;
