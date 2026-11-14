import { ExpensePaymentResponse, ListExpensePaymentsQuery, ListExpensePaymentsResponse, RecordExpensePaymentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { idempotencyKeyOf, listExpensePayments, recordExpensePayment } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', query: ListExpensePaymentsQuery, response: ListExpensePaymentsResponse }, async ({ db, query }) => ({
  body: await listExpensePayments(db, query),
}));

/** Idempotency-Key required. 201 with the new payment; 200 with the original when the key is repeated with the same request. */
export const POST = tenantRoute({ permission: 'finance:payments', input: RecordExpensePaymentRequest, response: ExpensePaymentResponse }, async ({ db, actor, input, request }) => {
  const { status, payment } = await recordExpensePayment(db, actor.userId, input, idempotencyKeyOf(request));
  return { status, body: { payment } };
});

export const OPTIONS = preflight;
