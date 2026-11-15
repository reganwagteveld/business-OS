import { CalendarResponse, CreateCalendarRequest, ListCalendarsQuery, ListCalendarsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createCalendar, listCalendars } from '@/modules/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'scheduling:read', query: ListCalendarsQuery, response: ListCalendarsResponse }, async ({ db, query }) => ({
  body: await listCalendars(db, query),
}));

export const POST = tenantRoute({ permission: 'scheduling:manage_calendars', input: CreateCalendarRequest, response: CalendarResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { calendar: await createCalendar(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
