import { FinancePaymentResponse, ReversePaymentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { reversePayment } from '@/modules/finance';
import { paymentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Reverses the payment's live allocations, then the payment, atomically. A reason is required. */
export const POST = tenantRoute({ permission: 'finance:payments', input: ReversePaymentRequest, response: FinancePaymentResponse }, async ({ db, actor, params, input }) => ({
  body: { payment: await reversePayment(db, actor.userId, paymentIdOf(params), input) },
}));

export const OPTIONS = preflight;
