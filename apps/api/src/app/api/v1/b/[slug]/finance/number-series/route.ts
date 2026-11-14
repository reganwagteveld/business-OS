import { ListNumberSeriesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listSeries } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: ListNumberSeriesResponse }, async ({ db }) => ({
  body: { series: await listSeries(db) },
}));

export const OPTIONS = preflight;
