import { ErasureDetailResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getErasure } from '@/modules/communications';
import { erasureIdOf } from '../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** One erasure with the items that still need a person (ids only). */
export const GET = tenantRoute({ permission: 'communications:manage_connections', response: ErasureDetailResponse }, async ({ db, params }) => ({
  body: await getErasure(db, erasureIdOf(params)),
}));

export const OPTIONS = preflight;
