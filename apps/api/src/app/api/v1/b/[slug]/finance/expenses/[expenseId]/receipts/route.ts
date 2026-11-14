import { ReceiptResponse, RegisterReceiptRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { registerReceipt } from '@/modules/finance';
import { expenseIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Registers receipt metadata (no bytes, URL or path; storage is FD-P6). 201. */
export const POST = tenantRoute({ permission: 'finance:expenses', input: RegisterReceiptRequest, response: ReceiptResponse }, async ({ db, actor, params, input }) => ({
  status: 201,
  body: { receipt: await registerReceipt(db, actor.userId, expenseIdOf(params), input) },
}));

export const OPTIONS = preflight;
