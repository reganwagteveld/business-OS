import { ExpensePaymentResponse, ReverseExpenseAllocationRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { reverseExpenseAllocation } from '@/modules/finance';
import { allocationIdOf, paymentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Reverses one live expense allocation; the row is kept with its database-stamped reversal time. */
export const POST = tenantRoute({ permission: 'finance:payments', input: ReverseExpenseAllocationRequest, response: ExpensePaymentResponse }, async ({ db, actor, params }) => ({
  body: { payment: await reverseExpenseAllocation(db, actor.userId, paymentIdOf(params), allocationIdOf(params)) },
}));

export const OPTIONS = preflight;
