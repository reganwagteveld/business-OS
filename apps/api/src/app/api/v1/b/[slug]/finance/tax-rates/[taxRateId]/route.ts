import { TaxRateResponse, UpdateTaxRateRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { updateTaxRate } from '@/modules/finance';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Renames or archives a rate. Its percentage never changes: create a new rate instead. */
export const PATCH = tenantRoute({ permission: 'finance:manage', input: UpdateTaxRateRequest, response: TaxRateResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.taxRateId)) throw new RecordNotFoundError();
  return { body: { taxRate: await updateTaxRate(db, actor.userId, params.taxRateId, input) } };
});

export const OPTIONS = preflight;
