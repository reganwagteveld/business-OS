import { ExpenseCategoryResponse, UpdateExpenseCategoryRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { updateCategory } from '@/modules/finance';
import { categoryIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Rename, reorder, archive or restore. There is no DELETE: recorded expenses keep their category. */
export const PATCH = tenantRoute({ permission: 'finance:manage', input: UpdateExpenseCategoryRequest, response: ExpenseCategoryResponse }, async ({ db, actor, params, input }) => ({
  body: { category: await updateCategory(db, actor.userId, categoryIdOf(params), input) },
}));

export const OPTIONS = preflight;
