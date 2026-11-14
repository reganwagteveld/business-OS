import { FinanceExpenseResponse, VoidExpenseRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { voidExpense } from '@/modules/finance';
import { expenseIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Voids a recorded expense without live payments (reason required), or discards a draft. */
export const POST = tenantRoute({ permission: 'finance:expenses', input: VoidExpenseRequest, response: FinanceExpenseResponse }, async ({ db, actor, params, input }) => ({
  body: { expense: await voidExpense(db, actor.userId, expenseIdOf(params), input) },
}));

export const OPTIONS = preflight;
