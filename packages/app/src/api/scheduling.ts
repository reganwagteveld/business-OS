import {
  AvailabilityResponse, CalendarResponse, CreateCalendarRequest, CreateEventRequest, CreateResourceRequest, DefaultCalendarResponse, endpointPath, endpoints,
  EventResponse, EventTransitionRequest, ListCalendarsResponse, ListEventsResponse, ListResourcesResponse, ResourceAvailabilityResponse, ResourceResponse,
  ResourceTransitionRequest, SchedulingConflictResponse, UpdateCalendarRequest, UpdateEventRequest, UpdateResourceRequest,
  type SchedulingCalendar, type SchedulingConflict, type SchedulingEvent, type SchedulingResource, type SchedulingResourceType,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

/** Event pages (500 each) a calendar view follows. Beyond this it reports an error rather than a partial view. */
export const MAX_EVENT_PAGES = 4;

export interface EventWrite { event: SchedulingEvent; conflicts: SchedulingConflict[] }
/**
 * A write's outcome: the ordinary outcomes, plus the two the event form handles itself, an enforced
 * overlap (nothing was written) and a local time the zone skips or repeats.
 */
export type WriteOutcome =
  | Outcome<EventWrite>
  | { kind: 'scheduling_conflict'; conflicts: SchedulingConflict[] }
  | { kind: 'time_problem'; code: 'nonexistent_local_time' | 'ambiguous_local_time'; message: string };

/**
 * Scheduling calls (docs/scheduling-s1.md). The business is only the `:slug` in the path. Every body is
 * checked against the shared contract before it is sent, and every response is parsed with it.
 */
export interface SchedulingClient {
  calendars(slug: string, archived: 'active' | 'archived' | 'all', signal?: AbortSignal): Promise<Outcome<SchedulingCalendar[]>>;
  /** Creates the business's default calendar if it has none; returns it either way. */
  initialiseDefault(slug: string, signal?: AbortSignal): Promise<Outcome<SchedulingCalendar>>;
  createCalendar(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<SchedulingCalendar>>;
  updateCalendar(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<SchedulingCalendar>>;
  /**
   * Every event overlapping [from, to) (scheduled and cancelled), following the server's cursors: on one
   * calendar, or on every active calendar when none is named; optionally only those holding one resource.
   */
  events(slug: string, query: { calendarId?: string; resourceId?: string; from: string; to: string; status?: 'scheduled' | 'all' }, signal?: AbortSignal): Promise<Outcome<SchedulingEvent[]>>;
  event(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<EventWrite>>;
  createEvent(slug: string, input: unknown, signal?: AbortSignal): Promise<WriteOutcome>;
  updateEvent(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<WriteOutcome>;
  cancelEvent(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<EventWrite>>;
  archiveEvent(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<EventWrite>>;
  availability(slug: string, query: { calendarId: string; start: string; end: string; excludeEventId?: string }, signal?: AbortSignal): Promise<Outcome<{ available: boolean; conflicts: SchedulingConflict[] }>>;
  // ---- S2 resources (docs/scheduling-s2.md) ----
  /** One page of resources by name, and the cursor for the next. */
  resources(slug: string, query: ResourceListQuery, signal?: AbortSignal): Promise<Outcome<{ resources: SchedulingResource[]; nextCursor: string | null }>>;
  resource(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<ResourceWithBookings>>;
  createResource(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ResourceWithBookings>>;
  updateResource(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<ResourceWithBookings>>;
  archiveResource(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<ResourceWithBookings>>;
  restoreResource(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<ResourceWithBookings>>;
  /** Advisory: the booking itself is re-checked by the server. */
  resourceAvailability(slug: string, query: { start: string; end: string; resourceIds?: string[]; calendarId?: string; excludeEventId?: string }, signal?: AbortSignal): Promise<Outcome<ResourceAvailabilityResult>>;
}

/** S2: a resource and how many upcoming bookings still hold it. */
export interface ResourceWithBookings { resource: SchedulingResource; upcomingBookings: number }
export type ResourceAvailabilityResult = z.infer<typeof ResourceAvailabilityResponse>;
export interface ResourceListQuery {
  q?: string; type?: SchedulingResourceType; status?: 'current' | 'active' | 'inactive' | 'archived' | 'all'; cursor?: string; limit?: number;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
const invalid = (error: z.ZodError): Outcome<never> => ({ kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the highlighted fields.', fields: fieldErrors(error) });

export function createSchedulingClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): SchedulingClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? 'Please check the details and try again.' };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  function settleWrite(raw: RawResult): WriteOutcome {
    if (raw.kind === 'response' && raw.status === 409) {
      const conflict = SchedulingConflictResponse.safeParse(raw.json);
      if (conflict.success) return { kind: 'scheduling_conflict', conflicts: conflict.data.conflicts };
    }
    if (raw.kind === 'response' && raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      if (body?.error === 'nonexistent_local_time' || body?.error === 'ambiguous_local_time') {
        return { kind: 'time_problem', code: body.error, message: body.message ?? 'Choose another time.' };
      }
    }
    return settle(raw, EventResponse, (d) => d);
  }
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);
  const qs = (values: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') params.set(k, v);
    return `?${params.toString()}`;
  };
  const check = (schema: z.ZodType, input: unknown) => schema.safeParse(input);

  return {
    async calendars(slug, archived, signal) {
      const raw = await http.request('GET', p(endpoints.listCalendars.path, { slug }) + qs({ archived, limit: '100' }), undefined, signal);
      return settle(raw, ListCalendarsResponse, (d) => d.calendars);
    },
    async initialiseDefault(slug, signal) {
      return settle(await http.request('POST', p(endpoints.initialiseDefaultCalendar.path, { slug }), undefined, signal), DefaultCalendarResponse, (d) => d.calendar);
    },
    async createCalendar(slug, input, signal) {
      const checked = check(CreateCalendarRequest, input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createCalendar.path, { slug }), checked.data, signal), CalendarResponse, (d) => d.calendar);
    },
    async updateCalendar(slug, id, patch, signal) {
      const checked = check(UpdateCalendarRequest, patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', p(endpoints.updateCalendar.path, { slug, calendarId: id }), checked.data, signal), CalendarResponse, (d) => d.calendar);
    },
    async events(slug, query, signal) {
      const all: SchedulingEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const raw = await http.request('GET', p(endpoints.listEvents.path, { slug }) + qs({ ...query, status: query.status ?? 'all', cursor }), undefined, signal);
        const outcome = settle(raw, ListEventsResponse, (d) => d);
        if (outcome.kind !== 'ok') return outcome;
        all.push(...outcome.data.events);
        if (!outcome.data.nextCursor) return { kind: 'ok', data: all };
        cursor = outcome.data.nextCursor;
      }
      return { kind: 'incomplete', message: 'This range has more events than one view can show. Choose a shorter view.' };
    },
    async event(slug, id, signal) {
      return settle(await http.request('GET', p(endpoints.getEvent.path, { slug, eventId: id }), undefined, signal), EventResponse, (d) => d);
    },
    async createEvent(slug, input, signal) {
      const checked = check(CreateEventRequest, input);
      if (!checked.success) return invalid(checked.error);
      return settleWrite(await http.request('POST', p(endpoints.createEvent.path, { slug }), checked.data, signal));
    },
    async updateEvent(slug, id, patch, signal) {
      const checked = check(UpdateEventRequest, patch);
      if (!checked.success) return invalid(checked.error);
      return settleWrite(await http.request('PATCH', p(endpoints.updateEvent.path, { slug, eventId: id }), checked.data, signal));
    },
    async cancelEvent(slug, id, version, signal) {
      const body = EventTransitionRequest.parse({ version });
      return settle(await http.request('POST', p(endpoints.cancelEvent.path, { slug, eventId: id }), body, signal), EventResponse, (d) => d);
    },
    async archiveEvent(slug, id, version, signal) {
      const body = EventTransitionRequest.parse({ version });
      return settle(await http.request('POST', p(endpoints.archiveEvent.path, { slug, eventId: id }), body, signal), EventResponse, (d) => d);
    },
    async availability(slug, query, signal) {
      return settle(await http.request('GET', p(endpoints.checkAvailability.path, { slug }) + qs(query), undefined, signal), AvailabilityResponse, (d) => d);
    },
    async resources(slug, query, signal) {
      const raw = await http.request('GET', p(endpoints.listResources.path, { slug }) + qs({ ...query, limit: String(query.limit ?? 50) }), undefined, signal);
      return settle(raw, ListResourcesResponse, (d) => d);
    },
    async resource(slug, id, signal) {
      return settle(await http.request('GET', p(endpoints.getResource.path, { slug, resourceId: id }), undefined, signal), ResourceResponse, (d) => d);
    },
    async createResource(slug, input, signal) {
      const checked = check(CreateResourceRequest, input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createResource.path, { slug }), checked.data, signal), ResourceResponse, (d) => d);
    },
    async updateResource(slug, id, patch, signal) {
      const checked = check(UpdateResourceRequest, patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', p(endpoints.updateResource.path, { slug, resourceId: id }), checked.data, signal), ResourceResponse, (d) => d);
    },
    async archiveResource(slug, id, version, signal) {
      const body = ResourceTransitionRequest.parse({ version });
      return settle(await http.request('POST', p(endpoints.archiveResource.path, { slug, resourceId: id }), body, signal), ResourceResponse, (d) => d);
    },
    async restoreResource(slug, id, version, signal) {
      const body = ResourceTransitionRequest.parse({ version });
      return settle(await http.request('POST', p(endpoints.restoreResource.path, { slug, resourceId: id }), body, signal), ResourceResponse, (d) => d);
    },
    async resourceAvailability(slug, query, signal) {
      const { resourceIds, ...rest } = query;
      const raw = await http.request('GET', p(endpoints.resourceAvailability.path, { slug }) + qs({ ...rest, resourceIds: resourceIds?.join(',') }), undefined, signal);
      return settle(raw, ResourceAvailabilityResponse, (d) => d);
    },
  };
}
