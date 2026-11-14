import { FinanceExpenseResponse, UpdateExpenseRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getExpense, updateExpense } from '@/modules/finance';
import { expenseIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: FinanceExpenseResponse }, async ({ db, params }) => ({
  body: { expense: await getExpense(db, expenseIdOf(params)) },
}));

/** Drafts only (optimistic version). */
export const PATCH = tenantRoute({ permission: 'finance:expenses', input: UpdateExpenseRequest, response: FinanceExpenseResponse }, async ({ db, actor, params, input }) => ({
  body: { expense: await updateExpense(db, actor.userId, expenseIdOf(params), input) },
}));

export const OPTIONS = preflight;
