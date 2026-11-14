import { ExpensePaymentResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getExpensePayment } from '@/modules/finance';
import { paymentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: ExpensePaymentResponse }, async ({ db, params }) => ({
  body: { payment: await getExpensePayment(db, paymentIdOf(params)) },
}));

export const OPTIONS = preflight;
