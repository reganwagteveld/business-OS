import { ReceiptResponse, RemoveReceiptRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { removeReceipt } from '@/modules/finance';
import { expenseIdOf, receiptIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Removes a receipt of a draft (one way; the row is kept). */
export const POST = tenantRoute({ permission: 'finance:expenses', input: RemoveReceiptRequest, response: ReceiptResponse }, async ({ db, actor, params }) => ({
  body: { receipt: await removeReceipt(db, actor.userId, expenseIdOf(params), receiptIdOf(params)) },
}));

export const OPTIONS = preflight;
