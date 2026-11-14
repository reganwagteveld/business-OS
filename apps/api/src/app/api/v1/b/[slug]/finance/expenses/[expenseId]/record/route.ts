import { FinanceExpenseResponse, RecordExpenseRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { authorize } from '@/modules/access';
import { payExpenseInFull, recordExpense } from '@/modules/finance';
import { expenseIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Records (posts) a draft. With paidInFull, a payment of the whole total is recorded and allocated in
 * the same unit of work, which also needs finance:payments (checked before anything is written).
 */
export const POST = tenantRoute({ permission: 'finance:expenses', input: RecordExpenseRequest, response: FinanceExpenseResponse }, async ({ db, actor, params, input }) => {
  const paid = input.paidInFull;
  if (paid) authorize(actor, 'finance:payments');
  const expense = await recordExpense(db, actor.userId, expenseIdOf(params), input, paid ? (e) => payExpenseInFull(db, actor.userId, e, paid) : undefined);
  return { body: { expense } };
});

export const OPTIONS = preflight;
