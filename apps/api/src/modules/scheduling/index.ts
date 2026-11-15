// Public API of the scheduling module (docs/scheduling-s1.md). Routes import only from here.
export {
  archiveCalendar, createCalendar, ensureDefaultCalendar, getCalendar, listCalendars, restoreCalendar, updateCalendar,
} from './server/calendars';
export { archiveEvent, cancelEvent, checkAvailability, createEvent, getEvent, listEvents, updateEvent } from './server/events';
export type { WriteResult } from './server/events';
export { viewerOf } from './server/shared';
export type { Viewer } from './server/shared';
