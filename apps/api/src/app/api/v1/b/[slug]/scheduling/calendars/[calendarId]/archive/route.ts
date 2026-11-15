import { CalendarResponse, CalendarTransitionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { archiveCalendar } from '@/modules/scheduling';
import { calendarIdOf } from '@/app/api/_lib/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'scheduling:manage_calendars', input: CalendarTransitionRequest, response: CalendarResponse }, async ({ db, actor, params, input }) => ({
  body: { calendar: await archiveCalendar(db, actor.userId, calendarIdOf(params), input.version) },
}));

export const OPTIONS = preflight;
