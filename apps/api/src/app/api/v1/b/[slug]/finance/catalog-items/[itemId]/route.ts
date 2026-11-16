import { CatalogItemResponse, UpdateCatalogItemRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getCatalogItem, updateCatalogItem } from '@/modules/finance';
import { catalogItemIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: CatalogItemResponse }, async ({ db, params }) => ({
  body: { item: await getCatalogItem(db, catalogItemIdOf(params)) },
}));

/** Edit, activate or deactivate (optimistic version). There is no DELETE: items are archived. */
export const PATCH = tenantRoute({ permission: 'finance:catalog', input: UpdateCatalogItemRequest, response: CatalogItemResponse }, async ({ db, actor, params, input }) => ({
  body: { item: await updateCatalogItem(db, actor.userId, catalogItemIdOf(params), input) },
}));

export const OPTIONS = preflight;
