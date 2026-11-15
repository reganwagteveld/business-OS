import { ListMailSyncJobsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listSyncJobs } from '@/modules/communications';
import { connectionIdOf, connectionViewer } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The latest 20 sync jobs of a mailbox (owner or manage_connections). */
export const GET = tenantRoute({ permission: 'communications:read', response: ListMailSyncJobsResponse }, async ({ db, actor, params }) => ({
  body: { jobs: await listSyncJobs(db, connectionViewer(actor), connectionIdOf(params)) },
}));

export const OPTIONS = preflight;
