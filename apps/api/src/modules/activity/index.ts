// Public API of the activity module (data-model §4.7).
export { createActivity, listActivities, recordSystemActivity, SYSTEM_ACTIVITY_TYPES, USER_ACTIVITY_TYPES } from './server/activities';
export type { SystemActivityType } from './server/activities';
