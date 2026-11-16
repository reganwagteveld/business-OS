import { z } from 'zod';
import { canonicalTimeZone, parseWallTime } from './scheduling-time.ts';

// Scheduling S1 (docs/scheduling-s1.md): calendars and events. Every path is under /api/v1/b/:slug, so no
// request carries a business id, and bodies are strict: an unknown field (a business id, an author, a
// status, a cancellation time) is rejected rather than ignored.

const Uuid = z.string().uuid();
/** The most resources one event may hold (S2). */
export const MAX_EVENT_RESOURCES = 20;
/** The most resources one availability request may name (S2). */
export const MAX_AVAILABILITY_RESOURCES = 50;
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const Instant = z.string().datetime();
const Version = z.number().int().min(1);

/** An IANA time zone the runtime knows, returned in its canonical spelling. No zone is assumed. */
export const TimeZone = z
  .string()
  .trim()
  .max(64)
  .transform((v, ctx) => {
    const zone = canonicalTimeZone(v);
    if (!zone) {
      ctx.addIssue({ code: 'custom', message: 'Use an IANA time zone such as Europe/London' });
      return z.NEVER;
    }
    return zone;
  });

/** #RRGGBB. */
export const CalendarColour = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour such as #2563EB');

/** "YYYY-MM-DDTHH:mm" or "YYYY-MM-DDTHH:mm:ss": a wall-clock time without zone or offset. */
export const LocalDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Use a local time such as 2026-12-31T09:30')
  .refine((v) => parseWallTime(v) !== null, 'Enter a real date and time');

/**
 * A point in time, given either as an unambiguous instant (ISO 8601 with Z or an offset), or as a local
 * wall-clock time in an explicit IANA zone. A local time that does not exist in that zone (clocks spring
 * forward over it) is refused with `nonexistent_local_time`. A local time that occurs twice (clocks fall
 * back) is refused with `ambiguous_local_time` unless `disambiguation` says which one is meant.
 */
export const EventTime = z.union([
  z.object({ at: z.string().datetime({ offset: true }) }).strict(),
  z.object({ local: LocalDateTime, timeZone: TimeZone, disambiguation: z.enum(['earlier', 'later']).optional() }).strict(),
]);
export type EventTime = z.input<typeof EventTime>;

export const SchedulingEventStatus = z.enum(['SCHEDULED', 'CANCELLED']);
export type SchedulingEventStatus = z.infer<typeof SchedulingEventStatus>;

// ---- calendars ---------------------------------------------------------------------------------

export const SchedulingCalendar = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    colour: z.string().nullable(),
    /** Events on this calendar are shown in this zone. */
    timeZone: z.string(),
    /** Exactly one active calendar per business is the default. It cannot be archived. */
    isDefault: z.boolean(),
    version: Version,
    createdById: Uuid,
    updatedById: Uuid,
    createdAt: Instant,
    updatedAt: Instant,
    archivedAt: Instant.nullable(),
  })
  .strict();
export type SchedulingCalendar = z.infer<typeof SchedulingCalendar>;

const calendarFields = {
  name: z.string().trim().min(1, 'A calendar name is required').max(100),
  description: optionalText(1000),
  colour: CalendarColour.nullable().optional(),
  /** Defaults to the business's time zone. */
  timeZone: TimeZone.optional(),
};
/** `isDefault: true` makes the new calendar the business's default (the previous default stops being one). */
export const CreateCalendarRequest = z.object({ ...calendarFields, isDefault: z.literal(true).optional() }).strict();
/**
 * Edits a calendar. `isDefault: true` makes it the default; there is no `false`: choose another default
 * instead, so the business always has one. Archiving goes through /archive.
 */
export const UpdateCalendarRequest = z
  .object(calendarFields)
  .partial()
  .extend({ isDefault: z.literal(true).optional(), version: Version })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
/** Archive or restore, based on the version the person saw. */
export const CalendarTransitionRequest = z.object({ version: Version }).strict();

const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();

export const ListCalendarsQuery = z
  .object({
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    cursor: Cursor,
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();
/** By name, then id. `isDefault` marks the default. */
export const ListCalendarsResponse = z.object({ calendars: z.array(SchedulingCalendar), nextCursor: z.string().nullable() }).strict();
export const CalendarResponse = z.object({ calendar: SchedulingCalendar }).strict();
/** POST …/scheduling/calendars/default: 201 when it was created now, 200 when it already existed. */
export const DefaultCalendarResponse = z.object({ calendar: SchedulingCalendar, created: z.boolean() }).strict();

// ---- events ------------------------------------------------------------------------------------

/** The linked customer as the Customer Zone holds it now; null unless the viewer may read customers. */
export const SchedulingEventCustomer = z.object({ id: Uuid, displayName: z.string(), archived: z.boolean() }).strict();

// ---- resources (Scheduling S2, docs/scheduling-s2.md) ------------------------------------------

/** Industry-neutral kinds. The business's own words ("Chair 3", "Van 2") go in the name. */
export const SchedulingResourceType = z.enum(['PERSON', 'ROOM', 'EQUIPMENT', 'OTHER']);
export type SchedulingResourceType = z.infer<typeof SchedulingResourceType>;
/** ACTIVE: bookable. INACTIVE: out of service, no new bookings. ARCHIVED: retired, read-only. Existing bookings are kept in every state. */
export const SchedulingResourceStatus = z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']);
export type SchedulingResourceStatus = z.infer<typeof SchedulingResourceStatus>;

/** A resource as an event or a conflict names it. */
export const SchedulingResourceRef = z
  .object({ id: Uuid, name: z.string(), type: SchedulingResourceType, status: SchedulingResourceStatus })
  .strict();
export type SchedulingResourceRef = z.infer<typeof SchedulingResourceRef>;

export const SchedulingEvent = z
  .object({
    id: Uuid,
    calendarId: Uuid,
    title: z.string(),
    description: z.string().nullable(),
    location: z.string().nullable(),
    /** UTC instants of the half-open interval [startAt, endAt). */
    startAt: Instant,
    endAt: Instant,
    status: SchedulingEventStatus,
    /** Only blocking, scheduled, active events take part in conflict checks. */
    blocksAvailability: z.boolean(),
    customerId: Uuid.nullable(),
    customer: SchedulingEventCustomer.nullable(),
    /** S2: resources assigned to the event now (removed assignments are not listed), by name. */
    resources: z.array(SchedulingResourceRef),
    cancelledAt: Instant.nullable(),
    cancelledById: Uuid.nullable(),
    version: Version,
    createdById: Uuid,
    updatedById: Uuid,
    createdAt: Instant,
    updatedAt: Instant,
    archivedAt: Instant.nullable(),
  })
  .strict();
export type SchedulingEvent = z.infer<typeof SchedulingEvent>;

/**
 * An existing occupying event that overlaps a proposed interval: on the same calendar (`kind: calendar`,
 * S1) or holding the same resource (`kind: resource`, S2, `resource` names it). One entry per event and
 * reason, so an event clashing on two resources appears twice. `blocking` is true when the overlap
 * refused the write (409) and false when it was accepted (enforceConflicts false) or only reported.
 * Never carries the event's description, location, customer or anyone's personal details.
 */
export const SchedulingConflict = z
  .object({
    kind: z.enum(['calendar', 'resource']),
    eventId: Uuid,
    calendarId: Uuid,
    title: z.string(),
    startAt: Instant,
    endAt: Instant,
    resource: z.object({ id: Uuid, name: z.string() }).strict().nullable(),
    blocking: z.boolean(),
  })
  .strict();
export type SchedulingConflict = z.infer<typeof SchedulingConflict>;

const eventFields = {
  calendarId: Uuid,
  title: z.string().trim().min(1, 'A title is required').max(200),
  description: optionalText(5000),
  location: optionalText(500),
  start: EventTime,
  end: EventTime,
  blocksAvailability: z.boolean().optional(),
  customerId: Uuid.nullable().optional(),
  /**
   * S2: the resources the event needs, all or nothing. On create, the initial set; on edit, the complete
   * new set (omit to keep the current one, [] to remove all). Each must be ACTIVE to be newly added.
   */
  resourceIds: z
    .array(Uuid)
    .max(MAX_EVENT_RESOURCES, `An event can use at most ${MAX_EVENT_RESOURCES} resources`)
    .refine((ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length, 'Each resource can be added once')
    .optional(),
};
/**
 * `enforceConflicts` (default true): refuse the write with 409 `scheduling_conflict` if the event would
 * block time that an existing blocking event on the same calendar already blocks. False allows the
 * overlap; the overlaps are still reported in the response. A non-blocking event never conflicts.
 */
const enforceConflicts = z.boolean().default(true);

/** A new event is SCHEDULED and blocks availability unless told otherwise. */
export const CreateEventRequest = z.object({ ...eventFields, enforceConflicts }).strict();
/**
 * Edits a scheduled event: details, times, blocking, customer link, or moves it to another active
 * calendar. Cancelled and archived events are read-only. `start` and `end` are each optional; the
 * result must still end after it starts.
 */
export const UpdateEventRequest = z
  .object(eventFields)
  .partial()
  .extend({ enforceConflicts, version: Version })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version' && k !== 'enforceConflicts'), 'Nothing to update');
/** Cancel or archive, based on the version the person saw. */
export const EventTransitionRequest = z.object({ version: Version }).strict();

/** Events in a bounded range: those overlapping [from, to). At most 62 days. Archived events never appear. */
export const ListEventsQuery = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    calendarId: Uuid.optional(),
    /** S2: only events this resource is assigned to now. */
    resourceId: Uuid.optional(),
    status: z.enum(['scheduled', 'cancelled', 'all']).default('scheduled'),
    cursor: Cursor,
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .strict();
/** Ordered by start, then id. */
export const ListEventsResponse = z.object({ events: z.array(SchedulingEvent), nextCursor: z.string().nullable() }).strict();
/** A written event, and the blocking events it overlaps (empty unless the write allowed an overlap). */
export const EventResponse = z.object({ event: SchedulingEvent, conflicts: z.array(SchedulingConflict) }).strict();
/** The body of 409 `scheduling_conflict`: nothing was written. */
export const SchedulingConflictResponse = z.object({ error: z.literal('scheduling_conflict'), conflicts: z.array(SchedulingConflict).min(1) }).strict();

/**
 * Which blocking events on a calendar overlap [start, end)? Advisory only: it takes no lock, so a write
 * with enforceConflicts is still what guarantees no double booking. `excludeEventId` leaves out the event
 * being edited. This answers only for the calendar's events; resources have their own query (S2).
 */
export const AvailabilityQuery = z
  .object({
    calendarId: Uuid,
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    excludeEventId: Uuid.optional(),
  })
  .strict();
export const AvailabilityResponse = z.object({ available: z.boolean(), conflicts: z.array(SchedulingConflict) }).strict();

// ---- resource registry (Scheduling S2) ---------------------------------------------------------

export const SchedulingResource = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    type: SchedulingResourceType,
    status: SchedulingResourceStatus,
    colour: z.string().nullable(),
    version: Version,
    createdById: Uuid,
    updatedById: Uuid,
    createdAt: Instant,
    updatedAt: Instant,
    archivedAt: Instant.nullable(),
  })
  .strict();
export type SchedulingResource = z.infer<typeof SchedulingResource>;

const resourceFields = {
  name: z.string().trim().min(1, 'A resource name is required').max(100),
  description: optionalText(1000),
  colour: CalendarColour.nullable().optional(),
};
/** A new resource is ACTIVE. */
export const CreateResourceRequest = z.object({ ...resourceFields, type: SchedulingResourceType }).strict();
/**
 * Edits details, the type, or switches between ACTIVE and INACTIVE. Archiving and restoring go through
 * /archive and /restore. Archived resources are read-only.
 */
export const UpdateResourceRequest = z
  .object({ ...resourceFields, type: SchedulingResourceType, status: z.enum(['ACTIVE', 'INACTIVE']) })
  .partial()
  .extend({ version: Version })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
export const ResourceTransitionRequest = z.object({ version: Version }).strict();

export const ListResourcesQuery = z
  .object({
    /** Case-insensitive search in the name. */
    q: z.string().trim().max(100).optional(),
    type: SchedulingResourceType.optional(),
    /** `current` (default) = ACTIVE and INACTIVE. */
    status: z.enum(['current', 'active', 'inactive', 'archived', 'all']).default('current'),
    cursor: Cursor,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
/** By name, then id. */
export const ListResourcesResponse = z.object({ resources: z.array(SchedulingResource), nextCursor: z.string().nullable() }).strict();
/**
 * A resource, and how many scheduled, blocking, active events from now on still hold it (so archiving
 * or deactivating it says what is left to move).
 */
export const ResourceResponse = z.object({ resource: SchedulingResource, upcomingBookings: z.number().int().min(0) }).strict();

/** Comma-separated resource ids in a query string. */
const ResourceIdList = z
  .string()
  .max(MAX_AVAILABILITY_RESOURCES * 37)
  .transform((v, ctx) => {
    const ids = [...new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (ids.length === 0 || ids.length > MAX_AVAILABILITY_RESOURCES || !ids.every((i) => Uuid.safeParse(i).success)) {
      ctx.addIssue({ code: 'custom', message: `Name 1 to ${MAX_AVAILABILITY_RESOURCES} resource ids, separated by commas` });
      return z.NEVER;
    }
    return ids;
  });

/**
 * Which resources are free for [start, end)? Either the named `resourceIds`, or a page of current
 * (non-archived) resources by name, optionally of one `type`. With `calendarId`, the calendar's own
 * overlaps (S1) are included. `excludeEventId` leaves out the event being edited. Advisory only: no lock
 * is taken; an enforced write re-checks under the lock protocol.
 */
export const ResourceAvailabilityQuery = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    resourceIds: ResourceIdList.optional(),
    type: SchedulingResourceType.optional(),
    calendarId: Uuid.optional(),
    excludeEventId: Uuid.optional(),
    cursor: Cursor,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/**
 * available: no occupying overlap. occupied: at least one (listed). unavailable: INACTIVE or ARCHIVED,
 * so it cannot be newly booked (its existing overlaps are still listed).
 */
export const ResourceAvailability = z
  .object({ resource: SchedulingResourceRef, state: z.enum(['available', 'occupied', 'unavailable']), conflicts: z.array(SchedulingConflict) })
  .strict();
export const ResourceAvailabilityResponse = z
  .object({
    resources: z.array(ResourceAvailability),
    /** Present when calendarId was given: the calendar's own overlaps (S1 rules). */
    calendar: z.object({ calendarId: Uuid, available: z.boolean(), conflicts: z.array(SchedulingConflict) }).strict().nullable(),
    nextCursor: z.string().nullable(),
  })
  .strict();
