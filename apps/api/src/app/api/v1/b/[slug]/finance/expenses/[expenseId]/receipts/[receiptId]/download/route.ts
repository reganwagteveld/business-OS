import { ReceiptResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { receiptForDownload } from '@/modules/finance';
import { expenseIdOf, receiptIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Tenant-authorised receipt download. No storage provider is configured (FD-P6), so every receipt is
 * PENDING and this answers 409 receipt_not_stored. It never redirects to or returns a public URL.
 */
export const GET = tenantRoute({ permission: 'finance:read', response: ReceiptResponse }, async ({ db, params }) => ({
  body: { receipt: await receiptForDownload(db, expenseIdOf(params), receiptIdOf(params)) },
}));

export const OPTIONS = preflight;
