import { ReconciliationResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { runReconciliation } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** On-demand, read-only internal integrity check of this business's finance records (not bank reconciliation). Modifies nothing. */
export const GET = tenantRoute({ permission: 'finance:read', response: ReconciliationResponse }, async ({ db }) => ({
  body: { report: await runReconciliation(db) },
}));

export const OPTIONS = preflight;
