import { InvoiceReminderScheduleResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getInvoiceReminders } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-3: the invoice's reminder eligibility today, its policy's stages and its reminder history. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', response: InvoiceReminderScheduleResponse }, async ({ db, params }) => ({
  body: { schedule: await getInvoiceReminders(db, documentIdOf(params)) },
}));

export const OPTIONS = preflight;
