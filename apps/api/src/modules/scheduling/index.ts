// Public API of the scheduling module (docs/scheduling-s1.md, docs/scheduling-s2.md). Routes import only from here.
export {
  archiveCalendar, createCalendar, ensureDefaultCalendar, getCalendar, listCalendars, restoreCalendar, updateCalendar,
} from './server/calendars';
export { archiveEvent, cancelEvent, checkAvailability, createEvent, getEvent, listEvents, updateEvent } from './server/events';
export type { WriteResult } from './server/events';
export {
  archiveResource, createResource, getResource, listResources, resourceAvailability, restoreResource, updateResource,
} from './server/resources';
export { viewerOf } from './server/shared';
export type { Viewer } from './server/shared';
// Reporting WP-R1 (docs/reporting-operational-r1.md): the Scheduling Zone's own reporting read model.
export { scheduledEventCounts, scheduledEventDetails } from './server/reporting';
export type { EventPeriodQuery, EventPeriodRow, ScheduledEventDetail } from './server/reporting';
