import { FinancePaymentResponse, ReverseAllocationRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { reverseAllocation } from '@/modules/finance';
import { allocationIdOf, paymentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Reverses one live allocation; the row is kept with its database-stamped reversal time. */
export const POST = tenantRoute({ permission: 'finance:payments', input: ReverseAllocationRequest, response: FinancePaymentResponse }, async ({ db, actor, params }) => ({
  body: { payment: await reverseAllocation(db, actor.userId, paymentIdOf(params), allocationIdOf(params)) },
}));

export const OPTIONS = preflight;
