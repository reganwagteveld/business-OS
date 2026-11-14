import { NumberSeriesResponse, UpdateNumberSeriesRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { updateSeries } from '@/modules/finance';
import { seriesKindOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Prefix and padding are editable; the starting number only before the series issues its first document (FD-L1). */
export const PATCH = tenantRoute({ permission: 'finance:manage', input: UpdateNumberSeriesRequest, response: NumberSeriesResponse }, async ({ db, actor, params, input }) => ({
  body: { series: await updateSeries(db, actor.userId, seriesKindOf(params), input) },
}));

export const OPTIONS = preflight;
