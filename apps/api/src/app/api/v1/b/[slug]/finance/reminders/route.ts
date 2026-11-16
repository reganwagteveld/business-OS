import { ListRemindersQuery, ListRemindersResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listReminders } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-3: reminder history, newest first. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListRemindersQuery, response: ListRemindersResponse }, async ({ db, query }) => ({
  body: await listReminders(db, query),
}));

export const OPTIONS = preflight;
