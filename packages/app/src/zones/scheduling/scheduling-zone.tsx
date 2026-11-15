import type { SchedulingCalendar } from '@business-os/contracts';
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Input, Select } from '@business-os/ui';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { SchedulingClient } from '../../api/scheduling';
import type { BusinessContext } from '../../api/tenancy';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { formatRangeTitle, shiftAnchor, todayIn, viewRange, weekStartFor, type ViewKind } from './calendar-math';
import { EventDetail } from './event-detail';
import { EventForm, type EventDraft } from './event-form';
import { MonthGrid, TimeGrid } from './views';

type Overlay = { kind: 'none' } | { kind: 'detail'; id: string } | { kind: 'new'; draft: EventDraft } | { kind: 'edit'; id: string } | { kind: 'calendar' };
const VIEWS: { id: ViewKind; label: string }[] = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }];

/**
 * The Scheduling Zone (S1): business calendars in day, week and month views. Mount it with `key={slug}`:
 * switching business discards every bit of its state, nothing is cached or persisted, and every request
 * names the business only through the URL. Times are shown in the selected calendar's zone, formatted for
 * the business's locale. Write controls follow the server's permission keys for presentation only; the API
 * enforces every rule again.
 */
export function SchedulingZone({ client, context, userLabel, now, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: SchedulingClient; context: BusinessContext; userLabel: string;
  /** Injected in tests; the current time otherwise. */
  now?: number;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, locale, timeZone: businessZone } = context.business;
  const can = (p: string) => context.membership.permissions.includes(p);
  const canCreate = can('scheduling:create');
  const [generation, setGeneration] = useState(0);
  const cals = useLoad(`scheduling-calendars|${slug}|${generation}`, (signal) => client.calendars(slug, 'active', signal));
  const calendars = cals.state.status === 'done' && cals.state.outcome.kind === 'ok' ? cals.state.outcome.data : null;

  // A business that has never used Scheduling gets its default calendar on first open, if this person may book.
  const initialising = useRef(false);
  const [initFailed, setInitFailed] = useState(false);
  useEffect(() => {
    if (!calendars || calendars.length > 0 || !canCreate || initialising.current) return;
    initialising.current = true;
    void client.initialiseDefault(slug).then((outcome) => {
      if (outcome.kind === 'ok') setGeneration((g) => g + 1);
      else if (outcome.kind === 'unauthenticated') onSessionEnded();
      else setInitFailed(true);
    });
  }, [calendars, canCreate, client, slug, onSessionEnded]);

  const content = useRef<HTMLDivElement>(null);
  return (
    <ZoneFrame zone="Schedule" business={name} user={userLabel} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>
      <div ref={content}>
        {cals.state.status === 'loading' ? (
          <ZonePage title="Schedule" state={{ kind: 'loading', label: 'Loading calendars…' }} />
        ) : cals.state.outcome.kind !== 'ok' ? (
          <ZonePage title="Schedule"><Problem outcome={cals.state.outcome} what="Calendars" onRetry={cals.reload} onSessionEnded={onSessionEnded} /></ZonePage>
        ) : calendars!.length === 0 ? (
          <ZonePage title="Schedule" state={initFailed || !canCreate
            ? { kind: 'empty', title: 'No calendars yet', description: canCreate ? 'The calendar could not be set up. Try again in a moment.' : 'Ask a manager to set up a calendar for this business.' }
            : { kind: 'loading', label: 'Setting up your calendar…' }} />
        ) : (
          <Schedule
            client={client} slug={slug} locale={locale} businessZone={businessZone} calendars={calendars!} now={now}
            canCreate={canCreate} canUpdate={can('scheduling:update')} canCancel={can('scheduling:cancel')} canManage={can('scheduling:manage_calendars')}
            onCalendarsChanged={() => setGeneration((g) => g + 1)} onSessionEnded={onSessionEnded}
          />
        )}
      </div>
    </ZoneFrame>
  );
}

function Schedule({ client, slug, locale, businessZone, calendars, now, canCreate, canUpdate, canCancel, canManage, onCalendarsChanged, onSessionEnded }: {
  client: SchedulingClient; slug: string; locale: string; businessZone: string; calendars: SchedulingCalendar[]; now?: number;
  canCreate: boolean; canUpdate: boolean; canCancel: boolean; canManage: boolean; onCalendarsChanged: () => void; onSessionEnded: () => void;
}) {
  const [calendarId, setCalendarId] = useState(() => (calendars.find((c) => c.isDefault) ?? calendars[0]!).id);
  const calendar = calendars.find((c) => c.id === calendarId) ?? calendars.find((c) => c.isDefault) ?? calendars[0]!;
  const zone = calendar.timeZone;
  const today = todayIn(zone, now);
  const [kind, setKind] = useState<ViewKind>('week');
  const [anchor, setAnchor] = useState(today);
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const weekStart = useMemo(() => weekStartFor(locale), [locale]);
  const range = useMemo(() => viewRange(kind, anchor, zone, weekStart), [kind, anchor, zone, weekStart]);
  const from = new Date(range.from).toISOString();
  const to = new Date(range.to).toISOString();
  const loaded = useLoad(`scheduling-events|${slug}|${calendar.id}|${from}|${to}|${tick}`, (signal) => client.events(slug, { calendarId: calendar.id, from, to }, signal));
  const events = loaded.state.status === 'done' && loaded.state.outcome.kind === 'ok' ? loaded.state.outcome.data
    : loaded.previous?.kind === 'ok' ? loaded.previous.data : null;
  const title = formatRangeTitle(kind, range, anchor, locale);
  const refresh = (message: string | null) => {
    setOverlay({ kind: 'none' });
    setNotice(message);
    setTick((t) => t + 1);
  };
  const openDay = (day: string) => {
    setKind('day');
    setAnchor(day);
  };
  const newDraft = (): EventDraft => ({ date: anchor, start: '09:00', endDate: anchor, end: '10:00' });

  return (
    <ZonePage
      title="Schedule"
      description={`${calendar.name} · times in ${zone}${zone !== businessZone ? ` (the business uses ${businessZone})` : ''}`}
      primaryActions={canCreate && !calendar.archivedAt ? <Button onClick={() => setOverlay({ kind: 'new', draft: newDraft() })}>New event</Button> : undefined}
      secondaryActions={canManage ? <Button variant="outline" onClick={() => setOverlay({ kind: 'calendar' })}>Add calendar</Button> : undefined}
    >
      <div className="space-y-4">
        {notice ? <Alert tone="success" role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
        <div className="flex flex-wrap items-center gap-3">
          {calendars.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Calendar</span>
              <Select className="w-auto" value={calendar.id} onChange={(e) => setCalendarId(e.target.value)}>
                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isDefault ? ' (default)' : ''}</option>)}
              </Select>
            </label>
          ) : null}
          <div role="group" aria-label="View" className="inline-flex rounded-lg border p-0.5">
            {VIEWS.map((v) => (
              <button key={v.id} type="button" aria-pressed={kind === v.id} onClick={() => setKind(v.id)}
                className={`min-h-9 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${kind === v.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" aria-label={`Previous ${kind}`} onClick={() => setAnchor(shiftAnchor(kind, anchor, -1))}>‹</Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(today)}>Today</Button>
            <Button variant="outline" size="sm" aria-label={`Next ${kind}`} onClick={() => setAnchor(shiftAnchor(kind, anchor, 1))}>›</Button>
          </div>
          <h2 aria-live="polite" className="text-base font-semibold tracking-tight">{title}</h2>
        </div>
        {loaded.state.status === 'done' && loaded.state.outcome.kind !== 'ok' ? (
          <Problem outcome={loaded.state.outcome} what="Events" onRetry={loaded.reload} onSessionEnded={onSessionEnded} />
        ) : events === null ? (
          <div role="status" aria-busy="true" className="h-96 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"><span className="sr-only">Loading events…</span></div>
        ) : (
          <div aria-busy={loaded.state.status === 'loading' || undefined}>
            {events.length === 0 ? (
              <p className="mb-3 text-sm text-muted-foreground">Nothing scheduled {kind === 'day' ? 'on this day' : kind === 'week' ? 'this week' : 'this month'}.</p>
            ) : null}
            {kind === 'month' ? (
              <MonthGrid range={range} month={anchor.slice(0, 7)} events={events} today={today} locale={locale} timeZone={zone} colour={calendar.colour}
                onOpen={(id) => setOverlay({ kind: 'detail', id })} onDay={openDay} />
            ) : (
              <TimeGrid range={range} events={events} today={today} locale={locale} timeZone={zone} colour={calendar.colour}
                onOpen={(id) => setOverlay({ kind: 'detail', id })} onDay={openDay} />
            )}
          </div>
        )}
      </div>
      {overlay.kind === 'detail' ? (
        <EventDetail client={client} slug={slug} id={overlay.id} calendars={calendars} locale={locale} canUpdate={canUpdate} canCancel={canCancel}
          onEdit={(event) => setOverlay({ kind: 'edit', id: event.id })} onChanged={refresh} onClose={() => setOverlay({ kind: 'none' })} onSessionEnded={onSessionEnded} />
      ) : null}
      {overlay.kind === 'new' ? (
        <EventForm client={client} slug={slug} calendars={calendars} initialCalendarId={calendar.id} draft={overlay.draft} locale={locale}
          onSaved={(_, message) => refresh(message)} onClose={() => setOverlay({ kind: 'none' })} onSessionEnded={onSessionEnded} />
      ) : null}
      {overlay.kind === 'edit' ? (
        <EditLoader client={client} slug={slug} id={overlay.id} calendars={calendars} locale={locale} draft={newDraft()}
          onSaved={(message) => refresh(message)} onClose={() => setOverlay({ kind: 'none' })} onSessionEnded={onSessionEnded} />
      ) : null}
      {overlay.kind === 'calendar' ? (
        <CalendarForm client={client} slug={slug} defaultZone={businessZone} onClose={() => setOverlay({ kind: 'none' })} onSessionEnded={onSessionEnded}
          onSaved={(created) => {
            setOverlay({ kind: 'none' });
            setNotice(`Calendar “${created.name}” added.`);
            setCalendarId(created.id);
            onCalendarsChanged();
          }} />
      ) : null}
    </ZonePage>
  );
}

/** Loads the latest version of an event before editing it, so the edit is based on what is stored now. */
function EditLoader({ client, slug, id, calendars, locale, draft, onSaved, onClose, onSessionEnded }: {
  client: SchedulingClient; slug: string; id: string; calendars: SchedulingCalendar[]; locale: string; draft: EventDraft;
  onSaved: (message: string) => void; onClose: () => void; onSessionEnded: () => void;
}) {
  const loaded = useLoad(`scheduling-edit|${slug}|${id}`, (signal) => client.event(slug, id, signal));
  if (loaded.state.status === 'loading') return null;
  if (loaded.state.outcome.kind !== 'ok') {
    return (
      <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent>
          <DialogTitle className="sr-only">Edit event</DialogTitle>
          <Problem outcome={loaded.state.outcome} what="This event" onRetry={loaded.reload} onSessionEnded={onSessionEnded} />
        </DialogContent>
      </Dialog>
    );
  }
  const event = loaded.state.outcome.data.event;
  return (
    <EventForm client={client} slug={slug} calendars={calendars} initialCalendarId={event.calendarId} draft={draft} event={event} locale={locale}
      onSaved={(_, message) => onSaved(message)} onClose={onClose} onSessionEnded={onSessionEnded} />
  );
}

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

/** The theme's accent as a hex colour (the colour input needs one), read from the design tokens; none if unavailable. */
function themeAccent(): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--ring').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : '';
  } catch {
    return '';
  }
}

/** Adds a calendar: a name, an optional colour, and the zone its events are shown in (the business's by default). */
function CalendarForm({ client, slug, defaultZone, onSaved, onClose, onSessionEnded }: {
  client: SchedulingClient; slug: string; defaultZone: string; onSaved: (calendar: SchedulingCalendar) => void; onClose: () => void; onSessionEnded: () => void;
}) {
  const [name, setName] = useState('');
  const [colour, setColour] = useState(themeAccent);
  const [zone, setZone] = useState(defaultZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await client.createCalendar(slug, { name, timeZone: zone, ...(colour ? { colour } : {}) });
    setBusy(false);
    if (outcome.kind === 'ok') return onSaved(outcome.data);
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    if (outcome.kind === 'invalid_input') {
      setFields(outcome.fields ?? {});
      setError(outcome.message);
      return;
    }
    setError(outcome.kind === 'forbidden' ? 'Your role does not allow adding calendars.' : outcome.kind === 'unreachable' ? "Can't reach Business OS. Nothing was saved." : 'Something went wrong. Nothing was saved.');
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogTitle>Add calendar</DialogTitle>
        <DialogDescription>Calendars are shared with everyone in this business who can see the schedule.</DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4" noValidate>
          <Field label="Name" error={fields.name}>{(p) => <Input {...p} value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Colour" error={fields.colour}>{(p) => <Input {...p} type="color" className="h-10 w-20 p-1" value={colour} onChange={(e) => setColour(e.target.value)} />}</Field>
          <Field label="Time zone" hint="Events on this calendar are shown in this zone." error={fields.timeZone}>
            {(p) => (
              <>
                <Input {...p} value={zone} list="scheduling-zones" onChange={(e) => setZone(e.target.value)} />
                <datalist id="scheduling-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
              </>
            )}
          </Field>
          {error ? <Alert tone="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
            <Button type="submit" loading={busy}>Add calendar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
