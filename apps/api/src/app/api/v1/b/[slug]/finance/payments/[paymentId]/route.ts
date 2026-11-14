import { FinancePaymentResponse, UpdatePaymentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getPayment, updatePayment } from '@/modules/finance';
import { paymentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: FinancePaymentResponse }, async ({ db, params }) => ({
  body: { payment: await getPayment(db, paymentIdOf(params)) },
}));

/** Only the reference of a recorded payment can change. */
export const PATCH = tenantRoute({ permission: 'finance:payments', input: UpdatePaymentRequest, response: FinancePaymentResponse }, async ({ db, actor, params, input }) => ({
  body: { payment: await updatePayment(db, actor.userId, paymentIdOf(params), input) },
}));

export const OPTIONS = preflight;
