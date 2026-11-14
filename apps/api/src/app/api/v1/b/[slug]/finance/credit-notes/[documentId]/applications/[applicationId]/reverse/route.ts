import { CreditNoteCreditResponse, ReverseCreditApplicationRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { reverseCreditApplication } from '@/modules/finance';
import { applicationIdOf, documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Reverses one live credit application; the row is kept. */
export const POST = tenantRoute({ permission: 'finance:payments', input: ReverseCreditApplicationRequest, response: CreditNoteCreditResponse }, async ({ db, actor, params }) => ({
  body: { credit: await reverseCreditApplication(db, actor.userId, documentIdOf(params), applicationIdOf(params)) },
}));

export const OPTIONS = preflight;
