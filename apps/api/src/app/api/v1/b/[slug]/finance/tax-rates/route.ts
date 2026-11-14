import { CreateTaxRateRequest, ListTaxRatesQuery, ListTaxRatesResponse, TaxRateResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createTaxRate, listTaxRates } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', query: ListTaxRatesQuery, response: ListTaxRatesResponse }, async ({ db, query }) => ({
  body: { taxRates: await listTaxRates(db, query) },
}));

export const POST = tenantRoute({ permission: 'finance:manage', input: CreateTaxRateRequest, response: TaxRateResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { taxRate: await createTaxRate(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
