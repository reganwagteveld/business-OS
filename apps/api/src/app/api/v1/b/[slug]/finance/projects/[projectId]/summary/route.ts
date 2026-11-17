import { ProjectFinanceSummaryResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { projectFinanceSummary } from '@/modules/finance';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';
import { RecordNotFoundError } from '@/core/http/errors';

export const dynamic = 'force-dynamic';

/**
 * WF-1 §6.6.1: a project's figures per currency, derived from the Finance ledger. Both keys are required
 * (D-WF1-05): finance:read for the figures and projects:read for the project. Another business's project,
 * or an id that is not a UUID, is 404.
 */
export const GET = tenantRoute({ permission: ['finance:read', 'projects:read'], response: ProjectFinanceSummaryResponse }, async ({ db, params }) => {
  if (!isUuid(params.projectId)) throw new RecordNotFoundError();
  return { body: await projectFinanceSummary(db, params.projectId) };
});

export const OPTIONS = preflight;
