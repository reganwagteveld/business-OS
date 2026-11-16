import { DismissReminderRequest, ReminderResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { dismissReminder } from '@/modules/finance';
import { reminderIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** A pending or ready reminder will not be sent (final for its stage). finance:billing. */
export const POST = tenantRoute({ permission: 'finance:billing', input: DismissReminderRequest, response: ReminderResponse }, async ({ db, actor, params }) => ({
  body: { reminder: await dismissReminder(db, actor.userId, reminderIdOf(params)) },
}));

export const OPTIONS = preflight;
