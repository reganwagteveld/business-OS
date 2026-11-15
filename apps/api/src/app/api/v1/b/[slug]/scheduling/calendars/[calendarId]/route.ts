import { CalendarResponse, UpdateCalendarRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getCalendar, updateCalendar } from '@/modules/scheduling';
import { calendarIdOf } from '@/app/api/_lib/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'scheduling:read', response: CalendarResponse }, async ({ db, params }) => ({
  body: { calendar: await getCalendar(db, calendarIdOf(params)) },
}));

export const PATCH = tenantRoute({ permission: 'scheduling:manage_calendars', input: UpdateCalendarRequest, response: CalendarResponse }, async ({ db, actor, params, input }) => ({
  body: { calendar: await updateCalendar(db, actor.userId, calendarIdOf(params), input) },
}));

export const OPTIONS = preflight;
