import { parseWallTime, resolveWallTime, type SchedulingCalendar, type SchedulingConflict, type SchedulingEvent, type SchedulingResourceRef } from '@business-os/contracts';
import { Alert, AlertDescription, AlertTitle, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Input, Select, Textarea } from '@business-os/ui';
import { useState, type FormEvent } from 'react';
import type { SchedulingClient, WriteOutcome } from '../../api/scheduling';
import { localParts } from './calendar-math';
import { ConflictList, ResourcePicker } from './resource-picker';

export interface EventDraft { date: string; start: string; endDate: string; end: string }

/**
 * Create or edit an event. Times are typed as wall-clock times in the chosen calendar's zone and sent as
 * such with the zone named; the server turns them into instants and refuses a time the zone skips or
 * asks which one is meant when the clocks go back. An enforced overlap comes back with what it overlaps,
 * and the person can choose to keep the overlap.
 */
export function EventForm({ client, slug, calendars, initialCalendarId, draft, event, locale, onSaved, onClose, onSessionEnded }: {
  client: SchedulingClient; slug: string; calendars: SchedulingCalendar[]; initialCalendarId: string; draft: EventDraft;
  /** Editing this event (its version is sent); creating when absent. */
  event?: SchedulingEvent; locale: string;
  onSaved: (event: SchedulingEvent, message: string) => void; onClose: () => void; onSessionEnded: () => void;
}) {
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? initialCalendarId);
  const calendar = calendars.find((c) => c.id === calendarId) ?? calendars[0]!;
  const initialTimes = event
    ? (() => {
      const s = localParts(event.startAt, calendar.timeZone);
      const e = localParts(event.endAt, calendar.timeZone);
      return { date: s.date, start: s.time, endDate: e.date, end: e.time };
    })()
    : draft;
  const [title, setTitle] = useState(event?.title ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [times, setTimes] = useState(initialTimes);
  const [blocks, setBlocks] = useState(event?.blocksAvailability ?? true);
  const [timesTouched, setTimesTouched] = useState(false);
  const [disambiguation, setDisambiguation] = useState<'earlier' | 'later' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [ambiguous, setAmbiguous] = useState(false);
  const [conflicts, setConflicts] = useState<SchedulingConflict[] | null>(null);
  const [resources, setResources] = useState<SchedulingResourceRef[]>(event?.resources ?? []);
  const resourcesChanged = !event || resources.map((r) => r.id).sort().join() !== event.resources.map((r) => r.id).sort().join();

  const setTime = (key: keyof EventDraft, value: string) => {
    setTimes((t) => ({ ...t, [key]: value }));
    setTimesTouched(true);
    setConflicts(null);
  };

  const local = (date: string, time: string) => ({
    local: `${date}T${time}`, timeZone: calendar.timeZone, ...(disambiguation ? { disambiguation } : {}),
  });

  /** The form's interval as instants, for the advisory availability check (the server resolves it again on save). */
  const instant = (date: string, time: string): string | null => {
    const wall = parseWallTime(`${date}T${time}`);
    if (!wall) return null;
    const r = resolveWallTime(wall, calendar.timeZone, disambiguation ?? undefined);
    return r.ok ? new Date(r.instant).toISOString() : null;
  };
  const startInstant = instant(times.date, times.start);
  const endInstant = instant(times.endDate, times.end);
  const interval = startInstant && endInstant && Date.parse(endInstant) > Date.parse(startInstant)
    ? { start: startInstant, end: endInstant }
    : { problem: 'Enter a start and end time that exist in this time zone, with the end after the start.' };

  async function save(enforceConflicts: boolean) {
    setBusy(true);
    setError(null);
    setFields({});
    const sendTimes = !event || timesTouched || calendarId !== event.calendarId;
    const body: Record<string, unknown> = {
      title, location, description, blocksAvailability: blocks, enforceConflicts,
      ...(sendTimes ? { start: local(times.date, times.start), end: local(times.endDate, times.end) } : {}),
    };
    let outcome: WriteOutcome;
    if (event) {
      const patch: Record<string, unknown> = { version: event.version, enforceConflicts };
      if (title !== event.title) patch.title = title;
      if ((location || null) !== event.location) patch.location = location;
      if ((description || null) !== event.description) patch.description = description;
      if (blocks !== event.blocksAvailability) patch.blocksAvailability = blocks;
      if (calendarId !== event.calendarId) patch.calendarId = calendarId;
      if (sendTimes) Object.assign(patch, { start: body.start, end: body.end });
      if (resourcesChanged) patch.resourceIds = resources.map((r) => r.id);
      if (Object.keys(patch).length === 2) {
        setBusy(false);
        onClose();
        return;
      }
      outcome = await client.updateEvent(slug, event.id, patch);
    } else {
      outcome = await client.createEvent(slug, { calendarId, ...body, ...(resources.length > 0 ? { resourceIds: resources.map((r) => r.id) } : {}) });
    }
    setBusy(false);
    switch (outcome.kind) {
      case 'ok':
        onSaved(outcome.data.event, outcome.data.conflicts.length > 0
          ? outcome.data.conflicts.some((c) => c.kind === 'resource') ? 'Saved. It overlaps other bookings of the same resources or calendar.' : 'Saved. It overlaps other events on this calendar.'
          : event ? 'Changes saved.' : 'Event added.');
        return;
      case 'scheduling_conflict':
        setConflicts(outcome.conflicts);
        return;
      case 'time_problem':
        setAmbiguous(outcome.code === 'ambiguous_local_time');
        setError(outcome.message);
        return;
      case 'invalid_input':
        setFields(outcome.fields ?? {});
        setError(outcome.message);
        return;
      case 'conflict':
        setError(outcome.code === 'stale' ? 'Someone else changed this event. Close and open it again to see the latest version.'
          : outcome.code === 'archived_reference' ? 'A calendar or resource you chose has been archived. Choose another one.'
          : outcome.code === 'resource_inactive' ? 'A resource you added is inactive and cannot be booked. Remove it or choose another.'
          : 'This event can no longer be changed.');
        return;
      case 'unauthenticated':
        onSessionEnded();
        return;
      case 'forbidden':
        setError('Your role does not allow this change.');
        return;
      case 'unreachable':
        setError("Can't reach Business OS. Nothing was saved. Try again.");
        return;
      default:
        setError('Something went wrong. Nothing was saved.');
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(true);
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogTitle>{event ? 'Edit event' : 'New event'}</DialogTitle>
        <DialogDescription>Times are in {calendar.timeZone}, the calendar’s time zone.</DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
          <Field label="Title" error={fields.title}>
            {(p) => <Input {...p} value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} autoFocus />}
          </Field>
          {calendars.length > 1 ? (
            <Field label="Calendar">
              {(p) => (
                <Select {...p} value={calendarId} onChange={(e) => { setCalendarId(e.target.value); setConflicts(null); }}>
                  {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </Field>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">{(p) => <Input {...p} type="date" value={times.date} required onChange={(e) => setTime('date', e.target.value)} />}</Field>
            <Field label="Start time">{(p) => <Input {...p} type="time" value={times.start} required onChange={(e) => setTime('start', e.target.value)} />}</Field>
            <Field label="End date">{(p) => <Input {...p} type="date" value={times.endDate} required onChange={(e) => setTime('endDate', e.target.value)} />}</Field>
            <Field label="End time">{(p) => <Input {...p} type="time" value={times.end} required onChange={(e) => setTime('end', e.target.value)} />}</Field>
          </div>
          {ambiguous ? (
            <Field label="The clocks go back at this time. Which one do you mean?">
              {(p) => (
                <Select {...p} value={disambiguation ?? ''} onChange={(e) => setDisambiguation((e.target.value || null) as 'earlier' | 'later' | null)}>
                  <option value="">Choose…</option>
                  <option value="earlier">The earlier one (before the clocks go back)</option>
                  <option value="later">The later one (after the clocks go back)</option>
                </Select>
              )}
            </Field>
          ) : null}
          <Field label="Location" error={fields.location}>{(p) => <Input {...p} value={location} maxLength={500} onChange={(e) => setLocation(e.target.value)} />}</Field>
          <Field label="Notes" error={fields.description}>{(p) => <Textarea {...p} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={blocks} onChange={(e) => { setBlocks(e.target.checked); setConflicts(null); }} />
            <span>
              <span className="font-medium">Blocks this calendar’s time</span>
              <span className="block text-xs text-muted-foreground">Other blocking events on this calendar cannot overlap it unless you allow it.</span>
            </span>
          </label>
          <ResourcePicker client={client} slug={slug} selected={resources} onChange={(next) => { setResources(next); setConflicts(null); }}
            interval={interval} calendarId={calendarId} eventId={event?.id} locale={locale} timeZone={calendar.timeZone} />
          {conflicts ? (
            <Alert tone="warning" role="alert">
              <AlertTitle>{conflicts.some((c) => c.kind === 'resource') ? 'This clashes with existing bookings' : `This overlaps ${conflicts.length === 1 ? 'another event' : `${conflicts.length} other events`} on ${calendar.name}`}</AlertTitle>
              <AlertDescription>
                <ConflictList conflicts={conflicts} calendarName={calendar.name} locale={locale} timeZone={calendar.timeZone} />
                Nothing was saved. Change the time or the resources, or keep the overlap.
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? <Alert tone="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
            {conflicts ? <Button variant="secondary" loading={busy} onClick={() => void save(false)}>Keep the overlap</Button> : null}
            <Button type="submit" loading={busy}>{event ? 'Save changes' : 'Add event'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
