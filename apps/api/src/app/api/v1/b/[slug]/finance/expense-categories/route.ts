import { CreateExpenseCategoryRequest, ExpenseCategoryResponse, ListExpenseCategoriesQuery, ListExpenseCategoriesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createCategory, listCategories } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Seeds the business's default categories on first use (idempotent), then lists them in display order. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListExpenseCategoriesQuery, response: ListExpenseCategoriesResponse }, async ({ db, query }) => ({
  body: { categories: await listCategories(db, query) },
}));

export const POST = tenantRoute({ permission: 'finance:manage', input: CreateExpenseCategoryRequest, response: ExpenseCategoryResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { category: await createCategory(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
