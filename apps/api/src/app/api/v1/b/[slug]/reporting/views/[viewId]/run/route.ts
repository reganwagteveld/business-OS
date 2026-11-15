import { RunSavedViewResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { runView } from '@/modules/reporting';
import { reportingActor, viewIdOf } from '@/app/api/_lib/reporting';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Runs a saved view's stored configuration as the CALLER (read-only). The view grants nothing: each metric
 * is checked against the current registry and the caller's own keys, and a metric that fails comes back
 * as an error entry with no data. reporting:read.
 */
export const POST = tenantRoute({ permission: 'reporting:read', response: RunSavedViewResponse }, async ({ db, actor, params }) => ({
  body: await runView(db, reportingActor(actor), viewIdOf(params)),
}));

export const OPTIONS = preflight;
