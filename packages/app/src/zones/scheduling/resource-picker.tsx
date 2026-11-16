import type { SchedulingConflict, SchedulingResourceRef } from '@business-os/contracts';
import { Alert, AlertDescription, AlertTitle, Badge, Button, Input } from '@business-os/ui';
import { useId, useState } from 'react';
import type { ResourceAvailabilityResult, SchedulingClient } from '../../api/scheduling';
import { useLoad } from '../use-load';
import { formatDateTime } from './calendar-math';
import { STATUS_LABEL, STATUS_TONE, splitConflicts, TYPE_LABEL } from './resource-labels';

/**
 * The overlaps a write met, grouped so the person can see what caused them: the calendar's own events
 * (S1), then each resource with the bookings that already hold it (S2). Only ids, titles and times are
 * shown, the same as the schedule itself shows.
 */
export function ConflictList({ conflicts, calendarName, locale, timeZone }: {
  conflicts: SchedulingConflict[]; calendarName: string; locale: string; timeZone: string;
}) {
  const { calendar, resources } = splitConflicts(conflicts);
  return (
    <div className="space-y-2">
      {calendar.length > 0 ? (
        <div>
          <p className="font-medium">On {calendarName}</p>
          <ul className="list-disc pl-5">{calendar.map((c) => <li key={`c-${c.eventId}`}>{c.title}: {formatDateTime(c.startAt, locale, timeZone)}</li>)}</ul>
        </div>
      ) : null}
      {resources.map((r) => (
        <div key={r.id}>
          <p className="font-medium">{r.name} is booked</p>
          <ul className="list-disc pl-5">{r.conflicts.map((c) => <li key={`${r.id}-${c.eventId}`}>{c.title}: {formatDateTime(c.startAt, locale, timeZone)}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

const STATE_LABEL = { available: 'Free', occupied: 'Booked', unavailable: 'Not bookable' } as const;
const STATE_TONE = { available: 'success', occupied: 'danger', unavailable: 'neutral' } as const;

/**
 * Chooses the resources an event needs (S2). Offers ACTIVE resources only; resources the event already
 * holds stay listed whatever their status, and can be removed. "Check availability" asks the server about
 * the chosen resources for the form's current times; it is advice only, and saving re-checks.
 */
export function ResourcePicker({ client, slug, selected, onChange, interval, calendarId, eventId, locale, timeZone }: {
  client: SchedulingClient; slug: string; selected: SchedulingResourceRef[]; onChange: (next: SchedulingResourceRef[]) => void;
  /** The form's current interval as instants, or a reason it cannot be resolved yet. */
  interval: { start: string; end: string } | { problem: string };
  calendarId: string; eventId?: string; locale: string; timeZone: string;
}) {
  const [q, setQ] = useState('');
  const [check, setCheck] = useState<{ state: 'idle' } | { state: 'busy' } | { state: 'done'; result: ResourceAvailabilityResult } | { state: 'error'; message: string }>({ state: 'idle' });
  const listId = useId();
  const options = useLoad(`scheduling-resource-options|${slug}|${q}`, (signal) => client.resources(slug, { status: 'active', q: q || undefined, limit: 50 }, signal));
  const loaded = options.state.status === 'done' && options.state.outcome.kind === 'ok' ? options.state.outcome.data : null;
  const isSelected = (id: string) => selected.some((r) => r.id === id);
  const toggle = (r: SchedulingResourceRef) => {
    setCheck({ state: 'idle' });
    onChange(isSelected(r.id) ? selected.filter((x) => x.id !== r.id) : [...selected, r]);
  };

  async function checkAvailability() {
    if ('problem' in interval) return setCheck({ state: 'error', message: interval.problem });
    if (selected.length === 0) return setCheck({ state: 'error', message: 'Choose at least one resource first.' });
    setCheck({ state: 'busy' });
    const outcome = await client.resourceAvailability(slug, { ...interval, resourceIds: selected.map((r) => r.id), calendarId, excludeEventId: eventId });
    setCheck(outcome.kind === 'ok' ? { state: 'done', result: outcome.data } : { state: 'error', message: 'Availability could not be checked. You can still save; the booking is checked then.' });
  }

  return (
    <fieldset className="space-y-3 rounded-xl border p-3">
      <legend className="px-1 text-sm font-medium">Resources</legend>
      {selected.length > 0 ? (
        <ul aria-label="Chosen resources" className="flex flex-wrap gap-2">
          {selected.map((r) => (
            <li key={r.id} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs">
              <span>{r.name}</span>
              <span className="text-muted-foreground">· {TYPE_LABEL[r.type]}</span>
              {r.status !== 'ACTIVE' ? <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> : null}
              <button type="button" aria-label={`Remove ${r.name}`} onClick={() => toggle(r)}
                className="ml-1 rounded-full px-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">×</button>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">No resources. Add the people, rooms or equipment this event needs.</p>}
      <div>
        <label htmlFor={listId} className="sr-only">Find a resource</label>
        <Input id={listId} type="search" placeholder="Find a resource" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
        <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border" aria-busy={options.state.status === 'loading' || undefined}>
          {options.state.status === 'done' && options.state.outcome.kind !== 'ok' ? (
            <p className="p-2 text-xs text-destructive">Resources could not be loaded. <button type="button" className="underline" onClick={options.reload}>Try again</button></p>
          ) : loaded === null ? (
            <p className="p-2 text-xs text-muted-foreground" role="status">Loading resources…</p>
          ) : loaded.resources.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">{q ? 'No active resource matches.' : 'No active resources yet.'}</p>
          ) : (
            <ul>
              {loaded.resources.map((r) => (
                <li key={r.id}>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2 px-2 text-sm hover:bg-muted">
                    <input type="checkbox" className="size-4" checked={isSelected(r.id)} disabled={!isSelected(r.id) && selected.length >= 20}
                      onChange={() => toggle({ id: r.id, name: r.name, type: r.type, status: r.status })} />
                    <span className="flex-1">{r.name}</span>
                    <span className="text-xs text-muted-foreground">{TYPE_LABEL[r.type]}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" loading={check.state === 'busy'} onClick={() => void checkAvailability()}>Check availability</Button>
        <span className="text-xs text-muted-foreground">Advice only: saving checks again.</span>
      </div>
      {check.state === 'error' ? <p role="alert" className="text-xs text-destructive">{check.message}</p> : null}
      {check.state === 'done' ? (
        <div role="status" className="space-y-2 text-sm">
          <ul className="space-y-1">
            {check.result.resources.map((r) => (
              <li key={r.resource.id} className="flex flex-wrap items-center gap-2">
                <span>{r.resource.name}</span>
                <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
                {r.conflicts.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {r.conflicts.map((c) => `${c.title} (${formatDateTime(c.startAt, locale, timeZone)})`).join('; ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {check.result.calendar && check.result.calendar.conflicts.length > 0 ? (
            <Alert tone="warning"><AlertTitle>The calendar is busy then</AlertTitle>
              <AlertDescription>{check.result.calendar.conflicts.map((c) => c.title).join(', ')}</AlertDescription></Alert>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
