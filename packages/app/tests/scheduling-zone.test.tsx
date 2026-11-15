// @vitest-environment jsdom
// Scheduling S1: the calendar screens against a small stand-in for the S1 API. The real Scheduling client
// and shared contracts sit in front of it, so every request body is contract-checked and every response is
// parsed with the contract.
import {
  CreateEventRequest, EventTransitionRequest, parseWallTime, resolveWallTime, UpdateEventRequest, type SchedulingCalendar, type SchedulingEvent,
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
    status: 'SCHEDULED', blocksAvailability: true, customerId: null, customer: null, cancelledAt: null, cancelledById: null, version: 1,
    createdById: user0, updatedById: user0, createdAt: T, updatedAt: T, archivedAt: null, ...over,
  };
}

/** In-memory S1 API: strict bodies through the contracts, versioned edits, enforced overlaps, and a call log. */
function fakeApi(data: { calendars: SchedulingCalendar[]; events: SchedulingEvent[] }) {
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
      const list = data.events.filter((e) => e.calendarId === url.searchParams.get('calendarId') && !e.archivedAt && Date.parse(e.startAt) < to && Date.parse(e.endAt) > from);
      return json(200, { events: list, nextCursor: null });
    }
    const resolve = (t: { at?: string; local?: string; timeZone?: string; disambiguation?: 'earlier' | 'later' }) => {
      if (t.at) return new Date(t.at).toISOString();
      const r = resolveWallTime(parseWallTime(t.local!)!, t.timeZone!, t.disambiguation ?? 'earlier');
      return new Date(r.ok ? r.instant : 0).toISOString();
    };
    const overlapping = (calendarId: string, s: string, e: string, self?: string) => data.events.filter((x) => x.calendarId === calendarId && x.id !== self
      && x.status === 'SCHEDULED' && !x.archivedAt && x.blocksAvailability && x.startAt < e && x.endAt > s)
      .map((x) => ({ eventId: x.id, calendarId: x.calendarId, title: x.title, startAt: x.startAt, endAt: x.endAt }));
    if (path === '/events' && method === 'POST') {
      const input = CreateEventRequest.parse(body);
      const s = resolve(input.start);
      const e = resolve(input.end);
      const conflicts = input.blocksAvailability === false ? [] : overlapping(input.calendarId, s, e);
      if (conflicts.length && input.enforceConflicts) return json(409, { error: 'scheduling_conflict', conflicts });
      const ev = event(input.calendarId, { title: input.title, location: input.location ?? null, startAt: s, endAt: e, blocksAvailability: input.blocksAvailability ?? true });
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
