import { ReceivablesAgeingDetailQuery, ReceivablesAgeingDetailResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getReceivablesAgeingDetail } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-2: one customer and currency as of a date: each open invoice with its age bucket, and each credit. finance:read. */
export const GET = tenantRoute(
  { permission: 'finance:read', query: ReceivablesAgeingDetailQuery, response: ReceivablesAgeingDetailResponse },
  async ({ db, query }) => ({ body: { detail: await getReceivablesAgeingDetail(db, query) } }),
);

export const OPTIONS = preflight;
