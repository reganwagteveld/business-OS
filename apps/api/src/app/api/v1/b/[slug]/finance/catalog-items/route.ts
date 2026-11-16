import { CatalogItemResponse, CreateCatalogItemRequest, ListCatalogItemsQuery, ListCatalogItemsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createCatalogItem, listCatalogItems } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F7-A: search, filter and page the products and services catalog (finance:read). */
export const GET = tenantRoute({ permission: 'finance:read', query: ListCatalogItemsQuery, response: ListCatalogItemsResponse }, async ({ db, query }) => ({
  body: await listCatalogItems(db, query),
}));

export const POST = tenantRoute({ permission: 'finance:catalog', input: CreateCatalogItemRequest, response: CatalogItemResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { item: await createCatalogItem(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
