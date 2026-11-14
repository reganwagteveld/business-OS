import { AllocateExpensePaymentRequest, ExpensePaymentResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { allocateExpensePayment } from '@/modules/finance';
import { paymentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Allocates a payment made to one or more recorded expenses, all or nothing. */
export const POST = tenantRoute({ permission: 'finance:payments', input: AllocateExpensePaymentRequest, response: ExpensePaymentResponse }, async ({ db, actor, params, input }) => ({
  body: { payment: await allocateExpensePayment(db, actor.userId, paymentIdOf(params), input.allocations) },
}));

export const OPTIONS = preflight;
