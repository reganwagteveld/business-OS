import { MailSyncJobResponse, RequestMailSyncRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { requestSync } from '@/modules/communications';
import { connectionIdOf, connectionViewer } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Idempotent: the queued or running job if there is one (200), else a new one (201). */
export const POST = tenantRoute(
  { permission: 'communications:read', input: RequestMailSyncRequest, response: MailSyncJobResponse },
  async ({ db, actor, params, input }) => {
    const { job, created } = await requestSync(db, connectionViewer(actor), connectionIdOf(params), input.kind);
    return { status: created ? 201 : 200, body: { job } };
  },
);

export const OPTIONS = preflight;
