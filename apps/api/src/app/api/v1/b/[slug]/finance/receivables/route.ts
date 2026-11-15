import { InvoiceReceivablesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { invoiceReceivables } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * F4 (read-only): receivables per currency for the Finance overview. finance:read only. Outstanding is
 * what issued invoices still have open; unallocated payments and unapplied credit are reported beside it.
 */
export const GET = tenantRoute({ permission: 'finance:read', response: InvoiceReceivablesResponse }, async ({ db }) => ({
  body: { receivables: await invoiceReceivables(db) },
}));

export const OPTIONS = preflight;
