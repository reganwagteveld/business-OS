import { CatalogItemLifecycleRequest, CatalogItemResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { restoreCatalogItem } from '@/modules/finance';
import { catalogItemIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'finance:catalog', input: CatalogItemLifecycleRequest, response: CatalogItemResponse }, async ({ db, actor, params, input }) => ({
  body: { item: await restoreCatalogItem(db, actor.userId, catalogItemIdOf(params), input) },
}));

export const OPTIONS = preflight;
