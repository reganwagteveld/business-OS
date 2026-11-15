import { CreateRecurringInvoiceRequest, ListRecurringInvoicesQuery, ListRecurringInvoicesResponse, RecurringInvoiceResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createRecurringInvoice, listRecurringInvoices } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-1: recurring invoice schedules, newest first. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListRecurringInvoicesQuery, response: ListRecurringInvoicesResponse }, async ({ db, query }) => ({
  body: await listRecurringInvoices(db, query),
}));

/** Creates an ACTIVE schedule. It generates DRAFT invoices only (D-F6-4). finance:billing. */
export const POST = tenantRoute({ permission: 'finance:billing', input: CreateRecurringInvoiceRequest, response: RecurringInvoiceResponse }, async ({ db, actor, input }) => ({
  status: 201, body: { recurringInvoice: await createRecurringInvoice(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
