// @vitest-environment jsdom
// Scheduling S1: the calendar screens against a small stand-in for the S1 API. The real Scheduling client
// and shared contracts sit in front of it, so every request body is contract-checked and every response is
// parsed with the contract.
import {
  CreateEventRequest, CreateResourceRequest, EventTransitionRequest, parseWallTime, resolveWallTime, UpdateEventRequest, UpdateResourceRequest,
  type SchedulingCalendar, type SchedulingConflict, type SchedulingEvent, type SchedulingResource,
} from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusinessContext } from '../src';
import { createSchedulingClient } from '../src/api/scheduling';
import { SchedulingZone } from '../src/zones/scheduling/scheduling-zone';
import { daySegments, shiftAnchor, viewRange, weekStartFor } from '../src/zones/scheduling/calendar-math';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const NOW = Date.parse('2031-07-09T02:00:00Z'); // Wednesday 9 July 2031 in Perth and London
const T = '2031-07-01T00:00:00.000Z';
const ALL = ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel', 'scheduling:manage_calendars'];
const ctx = (permissions = ALL, locale = 'en-AU'): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Studio', countryCode: 'AU', timeZone: 'Australia/Perth', locale, currency: 'AUD' },
  membership: { id: randomUUID(), role: 'MEMBER', permissions },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user0 = randomUUID();

function calendar(over: Partial<SchedulingCalendar> = {}): SchedulingCalendar {
  return {
    id: randomUUID(), name: 'Calendar', description: null, colour: null, timeZone: 'Australia/Perth', isDefault: true, version: 1,
    createdById: user0, updatedById: user0, createdAt: T, updatedAt: T, archivedAt: null, ...over,
  };
}
function event(calendarId: string, over: Partial<SchedulingEvent> = {}): SchedulingEvent {
  return {
    id: randomUUID(), calendarId, title: 'Fitting', description: null, location: null, startAt: '2031-07-09T01:00:00.000Z', endAt: '2031-07-09T02:00:00.000Z',
    status: 'SCHEDULED', blocksAvailability: true, customerId: null, customer: null, resources: [], cancelledAt: null, cancelledById: null, version: 1,
    createdById: user0, updatedById: user0, createdAt: T, updatedAt: T, archivedAt: null, ...over,
  };
}

function resource(over: Partial<SchedulingResource> = {}): SchedulingResource {
  return {
    id: randomUUID(), name: 'Room 1', description: null, type: 'ROOM', status: 'ACTIVE', colour: null, version: 1,
    createdById: user0, updatedById: user0, createdAt: T, updatedAt: T, archivedAt: null, ...over,
  };
}

/**
 * In-memory S1 + S2 API: strict bodies through the contracts, versioned edits, enforced calendar and
 * resource overlaps, and a call log.
 */
function fakeApi(data: { calendars: SchedulingCalendar[]; events: SchedulingEvent[]; resources?: SchedulingResource[] }) {
  data.resources ??= [];
  const resources = data.resources;
  const calls: { method: string; path: string; query: Record<string, string>; body: unknown }[] = [];
  const next: ((path: string, method: string, body: unknown) => Response | undefined)[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace('/api/v1/b/alpha/scheduling', '');
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), body });
    for (let i = 0; i < next.length; i++) {
      const r = next[i]!(path, method, body);
      if (r) {
        next.splice(i, 1);
        return r;
      }
    }
    let m: RegExpExecArray | null;
    if (path === '/calendars' && method === 'GET') return json(200, { calendars: data.calendars.filter((c) => !c.archivedAt), nextCursor: null });
    if (path === '/calendars/default' && method === 'POST') {
      const existing = data.calendars.find((c) => c.isDefault);
      if (existing) return json(200, { calendar: existing, created: false });
      const c = calendar();
      data.calendars.push(c);
      return json(201, { calendar: c, created: true });
    }
    if (path === '/events' && method === 'GET') {
      const from = Date.parse(url.searchParams.get('from')!);
      const to = Date.parse(url.searchParams.get('to')!);
      const cal = url.searchParams.get('calendarId');
      const rid = url.searchParams.get('resourceId');
      const list = data.events.filter((e) => (!cal || e.calendarId === cal) && (!rid || e.resources.some((r) => r.id === rid))
        && !e.archivedAt && Date.parse(e.startAt) < to && Date.parse(e.endAt) > from);
      return json(200, { events: list, nextCursor: null });
    }
    // ---- S2 resources ----
    const ref = (r: SchedulingResource) => ({ id: r.id, name: r.name, type: r.type, status: r.status });
    const withCount = (r: SchedulingResource) => ({ resource: r, upcomingBookings: data.events.filter((e) => e.resources.some((x) => x.id === r.id)).length });
    if (path === '/resources' && method === 'GET') {
      const st = url.searchParams.get('status') ?? 'current';
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const type = url.searchParams.get('type');
      const list = resources.filter((r) => (st === 'all' || (st === 'current' ? r.status !== 'ARCHIVED' : r.status === st.toUpperCase()))
        && (!q || r.name.toLowerCase().includes(q)) && (!type || r.type === type)).sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { resources: list, nextCursor: null });
    }
    if (path === '/resources' && method === 'POST') {
      const input = CreateResourceRequest.parse(body);
      const r = resource({ name: input.name, type: input.type, description: input.description ?? null, colour: input.colour ?? null });
      resources.push(r);
      return json(201, withCount(r));
    }
    if (path === '/resources/availability' && method === 'GET') {
      const ids = url.searchParams.get('resourceIds')!.split(',');
      const s = url.searchParams.get('start')!;
      const e = url.searchParams.get('end')!;
      return json(200, {
        resources: ids.map((id) => {
          const r = resources.find((x) => x.id === id)!;
          const conflicts = resourceOverlaps([id], s, e, url.searchParams.get('excludeEventId') ?? undefined);
          return { resource: ref(r), state: r.status !== 'ACTIVE' ? 'unavailable' : conflicts.length ? 'occupied' : 'available', conflicts };
        }),
        calendar: null, nextCursor: null,
      });
    }
    if ((m = /^\/resources\/([^/]+)$/.exec(path))) {
      const r = resources.find((x) => x.id === m![1]);
      if (!r) return json(404, { error: 'not_found' });
      if (method === 'GET') return json(200, withCount(r));
      const input = UpdateResourceRequest.parse(body);
      if (input.version !== r.version) return json(409, { error: 'stale' });
      Object.assign(r, { ...(input.name ? { name: input.name } : {}), ...(input.status ? { status: input.status } : {}), version: r.version + 1 });
      return json(200, withCount(r));
    }
    if ((m = /^\/resources\/([^/]+)\/(archive|restore)$/.exec(path)) && method === 'POST') {
      const r = resources.find((x) => x.id === m![1])!;
      Object.assign(r, m[2] === 'archive' ? { status: 'ARCHIVED', archivedAt: T } : { status: 'ACTIVE', archivedAt: null }, { version: r.version + 1 });
      return json(200, withCount(r));
    }
    const resolve = (t: { at?: string; local?: string; timeZone?: string; disambiguation?: 'earlier' | 'later' }) => {
      if (t.at) return new Date(t.at).toISOString();
      const r = resolveWallTime(parseWallTime(t.local!)!, t.timeZone!, t.disambiguation ?? 'earlier');
      return new Date(r.ok ? r.instant : 0).toISOString();
    };
    const overlapping = (calendarId: string, s: string, e: string, self?: string) => data.events.filter((x) => x.calendarId === calendarId && x.id !== self
      && x.status === 'SCHEDULED' && !x.archivedAt && x.blocksAvailability && x.startAt < e && x.endAt > s)
      .map((x): SchedulingConflict => ({ kind: 'calendar', eventId: x.id, calendarId: x.calendarId, title: x.title, startAt: x.startAt, endAt: x.endAt, resource: null, blocking: false }));
    function resourceOverlaps(ids: string[], s: string, e: string, self?: string): SchedulingConflict[] {
      return ids.flatMap((rid) => data.events.filter((x) => x.id !== self && x.status === 'SCHEDULED' && !x.archivedAt && x.blocksAvailability
        && x.startAt < e && x.endAt > s && x.resources.some((r) => r.id === rid))
        .map((x): SchedulingConflict => ({
          kind: 'resource', eventId: x.id, calendarId: x.calendarId, title: x.title, startAt: x.startAt, endAt: x.endAt,
          resource: { id: rid, name: resources.find((r) => r.id === rid)!.name }, blocking: false,
        })));
    }
    if (path === '/events' && method === 'POST') {
      const input = CreateEventRequest.parse(body);
      const s = resolve(input.start);
      const e = resolve(input.end);
      const ids = input.resourceIds ?? [];
      const conflicts = input.blocksAvailability === false ? [] : [...overlapping(input.calendarId, s, e), ...resourceOverlaps(ids, s, e)];
      if (conflicts.length && input.enforceConflicts) return json(409, { error: 'scheduling_conflict', conflicts: conflicts.map((c) => ({ ...c, blocking: true })) });
      const ev = event(input.calendarId, {
        title: input.title, location: input.location ?? null, startAt: s, endAt: e, blocksAvailability: input.blocksAvailability ?? true,
        resources: ids.map((id) => ref(resources.find((r) => r.id === id)!)),
      });
      data.events.push(ev);
      return json(201, { event: ev, conflicts });
    }
    if ((m = /^\/events\/([^/]+)$/.exec(path))) {
      const ev = data.events.find((x) => x.id === m![1]);
      if (!ev) return json(404, { error: 'not_found' });
      if (method === 'GET') return json(200, { event: ev, conflicts: [] });
      const input = UpdateEventRequest.parse(body);
      if (input.version !== ev.version) return json(409, { error: 'stale' });
      Object.assign(ev, { title: input.title ?? ev.title, version: ev.version + 1 });
      if (input.resourceIds) ev.resources = input.resourceIds.map((id) => ref(resources.find((r) => r.id === id)!));
      if (input.start) ev.startAt = resolve(input.start);
      if (input.end) ev.endAt = resolve(input.end);
      return json(200, { event: ev, conflicts: [] });
    }
    if ((m = /^\/events\/([^/]+)\/(cancel|archive)$/.exec(path)) && method === 'POST') {
      const ev = data.events.find((x) => x.id === m![1])!;
      const input = EventTransitionRequest.parse(body);
      if (input.version !== ev.version) return json(409, { error: 'stale' });
      if (m[2] === 'cancel') Object.assign(ev, { status: 'CANCELLED', cancelledAt: T, cancelledById: user0 });
      else ev.archivedAt = T;
      ev.version += 1;
      return json(200, { event: ev, conflicts: [] });
    }
    return json(500, { error: 'internal_error' });
  }) as typeof globalThis.fetch;
  return { client: createSchedulingClient(BASE, { kind: 'cookie' }, fetch), calls, next, data };
}

function renderZone(api: ReturnType<typeof fakeApi>, context = ctx()) {
  const onSessionEnded = vi.fn();
  render(<SchedulingZone client={api.client} context={context} userLabel="Sam" now={NOW} onHome={() => {}} onSwitch={() => {}} onSignOut={() => {}} onSessionEnded={onSessionEnded} />);
  return { onSessionEnded };
}
const eventsCalls = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path === '/events' && c.method === 'GET');

describe('Scheduling Zone', () => {
  it('sets up the default calendar on first open, then shows this week with its events', async () => {
    const api = fakeApi({ calendars: [], events: [] });
    renderZone(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Schedule' })).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/calendars/default' && c.method === 'POST')).toBe(true));
    expect(await screen.findByText('Nothing scheduled this week.')).toBeTruthy();
    // en-AU weeks start on Monday: 7–13 July 2031, as instants of Perth midnight.
    const q = eventsCalls(api).at(-1)!.query;
    expect(q).toMatchObject({ from: '2031-07-06T16:00:00.000Z', to: '2031-07-13T16:00:00.000Z', status: 'all' });
  });

  it('navigates day, week and month with previous, next and today', async () => {
    const cal = calendar();
    const api = fakeApi({ calendars: [cal], events: [event(cal.id, { title: 'Morning fitting' })] });
    const user = userEvent.setup();
    renderZone(api);
    expect(await screen.findByRole('button', { name: /Morning fitting, 9:00 am to 10:00 am/i })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(eventsCalls(api).at(-1)!.query.from).toBe('2031-07-13T16:00:00.000Z'));
    expect(await screen.findByText('Nothing scheduled this week.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Today' }));
    await screen.findByRole('button', { name: /Morning fitting/ });
    await user.click(screen.getByRole('button', { name: 'Day' }));
    expect(screen.getByRole('button', { name: 'Day' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(eventsCalls(api).at(-1)!.query).toMatchObject({ from: '2031-07-08T16:00:00.000Z', to: '2031-07-09T16:00:00.000Z' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/Wednesday,? 9 July 2031/);
    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    await waitFor(() => expect(eventsCalls(api).at(-1)!.query.from).toBe('2031-07-07T16:00:00.000Z'));
    await user.click(screen.getByRole('button', { name: 'Month' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/July 2031/);
    // Six weeks from Monday 30 June.
    await waitFor(() => expect(eventsCalls(api).at(-1)!.query).toMatchObject({ from: '2031-06-29T16:00:00.000Z', to: '2031-08-10T16:00:00.000Z' }));
    await user.click(await screen.findByRole('button', { name: /Morning fitting/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('shows times in the calendar’s zone and the business’s locale', async () => {
    const london = calendar({ name: 'London', timeZone: 'Europe/London' });
    const ev = event(london.id, { title: 'Night shift', startAt: '2031-07-08T21:00:00.000Z', endAt: '2031-07-09T05:00:00.000Z' });
    const api = fakeApi({ calendars: [london], events: [ev] });
    renderZone(api, ctx(ALL, 'de-DE'));
    expect(await screen.findByText(/times in Europe\/London \(the business uses Australia\/Perth\)/)).toBeTruthy();
    // Midnight-crossing: one piece on each day, 24-hour German times in London time (BST).
    await screen.findAllByRole('button', { name: /Night shift/ });
    const pieces = screen.getAllByRole('button', { name: /^Night shift/ });
    expect(pieces.map((b) => b.getAttribute('aria-label'))).toEqual(['Night shift, 22:00 to 6:00', 'Night shift, 22:00 to 6:00']);
    expect(pieces).toHaveLength(2);
    cleanup();
    renderZone(fakeApi({ calendars: [london], events: [ev] }), ctx(ALL, 'en-US'));
    expect(await screen.findAllByRole('button', { name: /Night shift, 10:00\s?PM to 6:00\s?AM/ })).toHaveLength(2);
  });

  it('creates an event in the calendar’s zone, reports a conflict, and keeps the overlap only when asked', async () => {
    const cal = calendar();
    const api = fakeApi({ calendars: [cal], events: [event(cal.id, { title: 'Existing' })] });
    const user = userEvent.setup();
    renderZone(api);
    await user.click(await screen.findByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Overlapping');
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    const alert = await within(dialog).findByText(/This overlaps another event on Calendar/);
    expect(alert).toBeTruthy();
    expect(within(dialog).getByText(/Existing:/)).toBeTruthy();
    const sent = api.calls.filter((c) => c.path === '/events' && c.method === 'POST');
    expect(sent[0]!.body).toMatchObject({
      calendarId: cal.id, title: 'Overlapping', enforceConflicts: true, blocksAvailability: true,
      start: { local: '2031-07-09T09:00', timeZone: 'Australia/Perth' }, end: { local: '2031-07-09T10:00', timeZone: 'Australia/Perth' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Keep the overlap' }));
    expect(await screen.findByText('Saved. It overlaps other events on this calendar.')).toBeTruthy();
    expect(api.calls.filter((c) => c.path === '/events' && c.method === 'POST')[1]!.body).toMatchObject({ enforceConflicts: false });
  });

  it('asks which time is meant when the clocks go back, and refuses a skipped time', async () => {
    const cal = calendar({ timeZone: 'America/New_York' });
    const api = fakeApi({ calendars: [cal], events: [] });
    const user = userEvent.setup();
    renderZone(api);
    await user.click(await screen.findByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Late');
    api.next.push((path, method) => (path === '/events' && method === 'POST'
      ? json(400, { error: 'ambiguous_local_time', message: 'The start time happens twice in America/New_York (the clocks go back).' }) : undefined));
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    expect(await within(dialog).findByText(/happens twice/)).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText(/Which one do you mean/), 'later');
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    await screen.findByText('Event added.');
    const last = api.calls.filter((c) => c.path === '/events' && c.method === 'POST').at(-1)!.body as { start: Record<string, string> };
    expect(last.start).toMatchObject({ timeZone: 'America/New_York', disambiguation: 'later' });
  });

  it('opens an event, edits it with its version, and cancels it', async () => {
    const cal = calendar();
    const ev = event(cal.id, { title: 'Consultation', location: 'Room 2' });
    const api = fakeApi({ calendars: [cal], events: [ev] });
    const user = userEvent.setup();
    renderZone(api);
    await user.click(await screen.findByRole('button', { name: /Consultation/ }));
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Room 2')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit event' });
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Consultation (moved)');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes saved.');
    // An edit that does not touch the times does not resend them (no re-interpretation of a local time).
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ version: 1, enforceConflicts: true, title: 'Consultation (moved)' });
    await user.click(await screen.findByRole('button', { name: /Consultation \(moved\)/ }));
    dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Cancel event' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel event' }));
    await screen.findByText(/Event cancelled/);
    expect(api.calls.find((c) => c.path.endsWith('/cancel'))!.body).toEqual({ version: 2 });
    expect(await screen.findByRole('button', { name: /Consultation \(moved\).*cancelled/ })).toBeTruthy();
  });

  it('hides write controls from a read-only role, and shows load failures', async () => {
    const cal = calendar();
    const api = fakeApi({ calendars: [cal], events: [] });
    api.next.push((path, method) => (path === '/events' && method === 'GET' ? json(500, { error: 'internal_error' }) : undefined));
    const user = userEvent.setup();
    renderZone(api, ctx(['scheduling:read']));
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New event' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add calendar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing scheduled this week.')).toBeTruthy();
  });

  it('does not create a calendar for someone who may not book; says what to do instead', async () => {
    const api = fakeApi({ calendars: [], events: [] });
    renderZone(api, ctx(['scheduling:read']));
    expect(await screen.findByText('No calendars yet')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/calendars/default')).toBe(false);
  });
});

describe('calendar geometry', () => {
  it('builds 23- and 25-hour days and six-week months in the calendar’s zone', () => {
    const spring = viewRange('day', '2031-03-09', 'America/New_York', 0);
    expect((spring.to - spring.from) / 3_600_000).toBe(23);
    const fall = viewRange('day', '2031-11-02', 'America/New_York', 0);
    expect((fall.to - fall.from) / 3_600_000).toBe(25);
    const month = viewRange('month', '2031-02-14', 'UTC', 1);
    expect(month.days).toHaveLength(42);
    expect(month.days[0]).toBe('2031-01-27');
    expect(viewRange('week', '2031-07-09', 'UTC', 0).days[0]).toBe('2031-07-06'); // Sunday-start locales
    expect(shiftAnchor('month', '2031-01-31', 1)).toBe('2031-02-28');
    expect(shiftAnchor('month', '2031-12-15', 1)).toBe('2032-01-15');
    expect([0, 1, 6]).toContain(weekStartFor('en-US'));
  });

  it('lays out overlapping events in lanes and splits multi-day events per day', () => {
    const cal = randomUUID();
    const a = event(cal, { id: 'a', startAt: '2031-07-09T09:00:00Z', endAt: '2031-07-09T11:00:00Z' });
    const b = event(cal, { id: 'b', startAt: '2031-07-09T10:00:00Z', endAt: '2031-07-09T12:00:00Z' });
    const c = event(cal, { id: 'c', startAt: '2031-07-09T12:00:00Z', endAt: '2031-07-09T13:00:00Z' });
    const segs = daySegments([a, b, c], '2031-07-09', 'UTC');
    expect(segs.map((s) => [s.event.id, s.lane, s.lanes])).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 0, 1]]);
    const trip = event(cal, { id: 't', startAt: '2031-07-09T20:00:00Z', endAt: '2031-07-11T08:00:00Z' });
    expect(daySegments([trip], '2031-07-10', 'UTC')[0]).toMatchObject({ top: 0, bottom: 1440, continuesBefore: true, continuesAfter: true });
    expect(daySegments([trip], '2031-07-11', 'UTC')[0]).toMatchObject({ top: 0, bottom: 480, continuesAfter: false });
  });
});

// ---- Scheduling S2: resources ------------------------------------------------------------------
const MANAGE = [...ALL, 'scheduling:manage_resources'];
const resourceCalls = (api: ReturnType<typeof fakeApi>, method = 'GET') => api.calls.filter((c) => c.path === '/resources' && c.method === method);

describe('Scheduling Zone: resources (S2)', () => {
  it('lists resources with search, type and status filters, and creates one when the role may manage resources', async () => {
    const cal = calendar();
    const api = fakeApi({ calendars: [cal], events: [], resources: [resource({ name: 'Chair 1', type: 'EQUIPMENT' }), resource({ name: 'Ana', type: 'PERSON' })] });
    const user = userEvent.setup();
    renderZone(api, ctx(MANAGE));
    await user.click(await screen.findByRole('tab', { name: 'Resources' }));
    const list = await screen.findByRole('list', { name: 'Resources' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([expect.stringMatching(/^Ana/), expect.stringMatching(/^Chair 1/)]);
    expect(resourceCalls(api).at(-1)!.query).toMatchObject({ status: 'current', limit: '50' });
    await user.selectOptions(screen.getByLabelText('Type'), 'PERSON');
    await waitFor(() => expect(resourceCalls(api).at(-1)!.query).toMatchObject({ type: 'PERSON' }));
    await user.selectOptions(screen.getByLabelText('Status'), 'archived');
    expect(await screen.findByText('No resources match these filters.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Status'), 'current');
    await user.selectOptions(screen.getByLabelText('Type'), '');
    await user.click(screen.getByRole('button', { name: 'New resource' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Room 2');
    await user.click(within(dialog).getByRole('button', { name: 'Add resource' }));
    expect(await screen.findByText('Resource “Room 2” added.')).toBeTruthy();
    expect(resourceCalls(api, 'POST')[0]!.body).toMatchObject({ name: 'Room 2', type: 'ROOM' });
  });

  it('hides management for a role without scheduling:manage_resources (the API refuses it too)', async () => {
    const cal = calendar();
    const r = resource({ name: 'Room 1' });
    const api = fakeApi({ calendars: [cal], events: [], resources: [r] });
    const user = userEvent.setup();
    renderZone(api, ctx(ALL));
    await user.click(await screen.findByRole('tab', { name: 'Resources' }));
    expect(await screen.findByRole('list', { name: 'Resources' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New resource' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Room 1/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Nothing booked.');
    expect(within(dialog).queryByRole('button', { name: /Edit|Archive|Set inactive/ })).toBeNull();
  });

  it('shows the empty state and a load failure with retry', async () => {
    const cal = calendar();
    const api = fakeApi({ calendars: [cal], events: [], resources: [] });
    const user = userEvent.setup();
    renderZone(api, ctx(MANAGE));
    api.next.push((path, method) => (path === '/resources' && method === 'GET' ? json(500, { error: 'internal_error' }) : undefined));
    await user.click(await screen.findByRole('tab', { name: 'Resources' }));
    await user.click(await screen.findByRole('button', { name: /Try again/i }));
    expect(await screen.findByText(/No resources yet/)).toBeTruthy();
  });

  it('sets a resource inactive, archives it after confirming, and restores it', async () => {
    const cal = calendar();
    const r = resource({ name: 'Van 2', type: 'EQUIPMENT' });
    const api = fakeApi({ calendars: [cal], events: [event(cal.id, { resources: [{ id: r.id, name: r.name, type: r.type, status: 'ACTIVE' }] })], resources: [r] });
    const user = userEvent.setup();
    renderZone(api, ctx(MANAGE));
    await user.click(await screen.findByRole('tab', { name: 'Resources' }));
    await user.click(await screen.findByRole('button', { name: /Van 2/ }));
    let dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Set inactive' }));
    expect(await screen.findByText(/“Van 2” is inactive and cannot be newly booked\. 1 upcoming booking still use/)).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ version: 1, status: 'INACTIVE' });
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    await user.click(await screen.findByRole('button', { name: /Van 2/ }));
    dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Archive' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/It stays on 1 upcoming booking/);
    await user.click(within(dialog).getByRole('button', { name: 'Archive resource' }));
    expect(await screen.findByText(/“Van 2” archived\./)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /Van 2/ }));
    dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('“Van 2” restored and bookable again.')).toBeTruthy();
  });

  it('books several resources with an event, checks availability, names the resource that clashes, and keeps the overlap only when asked', async () => {
    const cal = calendar();
    const room = resource({ name: 'Room 1' });
    const ana = resource({ name: 'Ana', type: 'PERSON' });
    const busy = event(cal.id, { title: 'Facial', calendarId: randomUUID(), resources: [{ id: room.id, name: room.name, type: 'ROOM', status: 'ACTIVE' }] });
    const api = fakeApi({ calendars: [cal], events: [busy], resources: [room, ana] });
    const user = userEvent.setup();
    renderZone(api);
    await user.click(await screen.findByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Massage');
    await user.click(await within(dialog).findByRole('checkbox', { name: /Room 1/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Ana/ }));
    expect(within(within(dialog).getByRole('list', { name: 'Chosen resources' })).getAllByRole('listitem')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Check availability' }));
    const status = await within(dialog).findByText('Booked');
    expect(status).toBeTruthy();
    expect(within(dialog).getByText('Free')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/resources/availability')!.query).toMatchObject({
      resourceIds: `${room.id},${ana.id}`, start: '2031-07-09T01:00:00.000Z', end: '2031-07-09T02:00:00.000Z', calendarId: cal.id,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    expect(await within(dialog).findByText('This clashes with existing bookings')).toBeTruthy();
    expect(within(dialog).getByText('Room 1 is booked')).toBeTruthy();
    const posts = api.calls.filter((c) => c.path === '/events' && c.method === 'POST');
    expect(posts[0]!.body).toMatchObject({ resourceIds: [room.id, ana.id], enforceConflicts: true });
    await user.click(within(dialog).getByRole('button', { name: 'Keep the overlap' }));
    expect(await screen.findByText('Saved. It overlaps other bookings of the same resources or calendar.')).toBeTruthy();
    expect(api.calls.filter((c) => c.path === '/events' && c.method === 'POST')[1]!.body).toMatchObject({ enforceConflicts: false });
  });

  it('edits an event’s resources: shows the current ones (inactive kept), removes one and sends the complete new set', async () => {
    const cal = calendar();
    const room = resource({ name: 'Room 1' });
    const old = resource({ name: 'Old chair', type: 'EQUIPMENT', status: 'INACTIVE' });
    const ev = event(cal.id, { title: 'Cut', resources: [{ id: old.id, name: old.name, type: 'EQUIPMENT', status: 'INACTIVE' }, { id: room.id, name: room.name, type: 'ROOM', status: 'ACTIVE' }] });
    const api = fakeApi({ calendars: [cal], events: [ev], resources: [room, old] });
    const user = userEvent.setup();
    renderZone(api);
    await user.click(await screen.findByRole('button', { name: /Cut,/ }));
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Old chair/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog');
    const chosen = await within(dialog).findByRole('list', { name: 'Chosen resources' });
    expect(within(chosen).getByText('Inactive')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove Old chair' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'PATCH' && c.path.startsWith('/events/'))!.body).toEqual({ version: 1, enforceConflicts: true, resourceIds: [room.id] });
  });

  it('draws the resource schedule: one row per resource, bookings placed by time, overlaps marked, bookings open by keyboard', async () => {
    const cal = calendar();
    const room = resource({ name: 'Room 1' });
    const ana = resource({ name: 'Ana', type: 'PERSON' });
    const r = (x: SchedulingResource) => ({ id: x.id, name: x.name, type: x.type, status: x.status });
    // Perth day 9 July 2031 = 2031-07-08T16:00Z .. 2031-07-09T16:00Z. 09:00–10:00 and 09:30–10:30 local overlap in Room 1.
    const a = event(cal.id, { title: 'A', startAt: '2031-07-09T01:00:00.000Z', endAt: '2031-07-09T02:00:00.000Z', resources: [r(room), r(ana)] });
    const b = event(cal.id, { title: 'B', startAt: '2031-07-09T01:30:00.000Z', endAt: '2031-07-09T02:30:00.000Z', resources: [r(room)] });
    const api = fakeApi({ calendars: [cal], events: [a, b], resources: [room, ana] });
    const user = userEvent.setup();
    renderZone(api);
    await user.click(await screen.findByRole('tab', { name: 'Resource schedule' }));
    const roomRow = await screen.findByRole('list', { name: 'Room 1 bookings' });
    const anaRow = screen.getByRole('list', { name: 'Ana bookings' });
    expect(within(roomRow).getAllByRole('button').map((x) => x.getAttribute('aria-label'))).toEqual([
      'A, 9:00 am to 10:00 am, overlaps another booking of this resource', 'B, 9:30 am to 10:30 am, overlaps another booking of this resource',
    ]);
    expect(within(anaRow).getAllByRole('button').map((x) => x.getAttribute('aria-label'))).toEqual(['A, 9:00 am to 10:00 am']);
    // 09:00 is 9/24 of the Perth day.
    expect((within(anaRow).getByRole('listitem') as HTMLElement).style.left).toBe(`${(9 / 24) * 100}%`);
    // Events are asked for across all calendars, scheduled only.
    expect(api.calls.filter((c) => c.path === '/events').at(-1)!.query).toMatchObject({ status: 'scheduled', from: '2031-07-08T16:00:00.000Z', to: '2031-07-09T16:00:00.000Z' });
    expect(api.calls.filter((c) => c.path === '/events').at(-1)!.query.calendarId).toBeUndefined();
    within(anaRow).getByRole('button').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Week' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/events').at(-1)!.query).toMatchObject({ from: '2031-07-06T16:00:00.000Z', to: '2031-07-13T16:00:00.000Z' }));
  });
});

describe('resource timeline geometry', () => {
  it('places instants by their share of their own local day, including 23- and 25-hour days', async () => {
    const { dayBounds, timelineFraction, overlappingIds } = await import('../src/zones/scheduling/calendar-math');
    // Sydney: 5 Oct 2031 is 23 hours (clocks go forward at 02:00).
    const syd = dayBounds(viewRange('day', '2031-10-05', 'Australia/Sydney', 1), 'Australia/Sydney');
    expect(syd[0]!.end - syd[0]!.start).toBe(23 * 3_600_000);
    expect(timelineFraction(syd[0]!.start + 11.5 * 3_600_000, syd)).toBeCloseTo(0.5);
    // New York: 2 Nov 2031 is 25 hours.
    const ny = dayBounds(viewRange('day', '2031-11-02', 'America/New_York', 1), 'America/New_York');
    expect(ny[0]!.end - ny[0]!.start).toBe(25 * 3_600_000);
    // Kolkata (+05:30) week: day i starts at i/7.
    const kol = dayBounds(viewRange('week', '2031-07-09', 'Asia/Kolkata', 1), 'Asia/Kolkata');
    expect(kol).toHaveLength(7);
    expect(timelineFraction(kol[3]!.start, kol)).toBeCloseTo(3 / 7);
    expect(timelineFraction(kol[0]!.start - 1, kol)).toBe(0);
    expect(timelineFraction(kol[6]!.end + 1, kol)).toBe(1);
    // Touching bookings are not overlaps; cancelled and non-blocking never are.
    const cal = randomUUID();
    const x = event(cal, { startAt: '2031-07-09T01:00:00.000Z', endAt: '2031-07-09T02:00:00.000Z' });
    const y = event(cal, { startAt: '2031-07-09T02:00:00.000Z', endAt: '2031-07-09T03:00:00.000Z' });
    const z = event(cal, { startAt: '2031-07-09T01:30:00.000Z', endAt: '2031-07-09T01:45:00.000Z', blocksAvailability: false });
    expect([...overlappingIds([x, y, z])]).toEqual([]);
    const w = event(cal, { startAt: '2031-07-09T01:59:00.000Z', endAt: '2031-07-09T02:01:00.000Z' });
    expect(overlappingIds([x, y, w])).toEqual(new Set([x.id, y.id, w.id]));
  });
});
