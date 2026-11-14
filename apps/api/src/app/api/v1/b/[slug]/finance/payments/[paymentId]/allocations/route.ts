import { AllocatePaymentRequest, FinancePaymentResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { allocatePayment } from '@/modules/finance';
import { paymentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Allocates the payment to one or more issued invoices of its customer and currency, all or nothing. */
export const POST = tenantRoute({ permission: 'finance:payments', input: AllocatePaymentRequest, response: FinancePaymentResponse }, async ({ db, actor, params, input }) => ({
  body: { payment: await allocatePayment(db, actor.userId, paymentIdOf(params), input.allocations) },
}));

export const OPTIONS = preflight;
