import { CreateReminderHoldRequest, ListReminderHoldsQuery, ListReminderHoldsResponse, ReminderHoldResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createReminderHold, listReminderHolds } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-3: reminder holds (suppression, exclusion), newest first. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListReminderHoldsQuery, response: ListReminderHoldsResponse }, async ({ db, query }) => ({
  body: await listReminderHolds(db, query),
}));

/** Places a hold on a customer or one issued invoice. finance:billing. */
export const POST = tenantRoute({ permission: 'finance:billing', input: CreateReminderHoldRequest, response: ReminderHoldResponse }, async ({ db, actor, input }) => ({
  status: 201, body: { hold: await createReminderHold(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
