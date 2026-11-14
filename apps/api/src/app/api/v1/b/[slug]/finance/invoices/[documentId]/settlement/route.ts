import { InvoiceSettlementResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getInvoiceSettlement } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Read-only settlement projection: payments, applied credit, outstanding and overdue (derived, never stored). */
export const GET = tenantRoute({ permission: 'finance:read', response: InvoiceSettlementResponse }, async ({ db, params }) => ({
  body: { settlement: await getInvoiceSettlement(db, documentIdOf(params)) },
}));

export const OPTIONS = preflight;
