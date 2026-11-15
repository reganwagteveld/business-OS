// Public API of the activity module (data-model §4.7, docs/communications-c1.md §3). The single
// authority for the business-facing timeline; other modules write to it only through these functions.
export {
  createActivity, getActivity, KNOWN_ACTIVITY_TYPES, listActivities, MESSAGE_ACTIVITY_TYPE, recordMessageActivity, recordSystemActivity,
  removeActivity, resolveSubject, SYSTEM_ACTIVITY_TYPES, updateNote, USER_ACTIVITY_TYPES,
} from './server/activities';
export type { ActivityViewer, SystemActivityType, UserActivityType } from './server/activities';
