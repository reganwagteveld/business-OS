import { CreateExpenseRequest, FinanceExpenseResponse, ListExpensesQuery, ListExpensesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createExpense, listExpenses } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', query: ListExpensesQuery, response: ListExpensesResponse }, async ({ db, query }) => ({
  body: await listExpenses(db, query),
}));

/** Creates a draft (201). Recording is a separate step. */
export const POST = tenantRoute({ permission: 'finance:expenses', input: CreateExpenseRequest, response: FinanceExpenseResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { expense: await createExpense(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
