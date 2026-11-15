import { DefaultCalendarResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { ensureDefaultCalendar } from '@/modules/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

// Idempotent initialisation: anyone who may book can make sure the business has its default calendar,
// so the first booking never waits for a manager. 201 when created now, 200 when it existed.
export const POST = tenantRoute({ permission: 'scheduling:create', response: DefaultCalendarResponse }, async ({ db, actor }) => {
  const result = await ensureDefaultCalendar(db, actor.userId);
  return { status: result.created ? 201 : 200, body: result };
});

export const OPTIONS = preflight;
