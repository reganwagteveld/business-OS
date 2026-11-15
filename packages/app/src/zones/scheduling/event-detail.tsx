import type { SchedulingCalendar, SchedulingEvent } from '@business-os/contracts';
import { Alert, AlertDescription, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Skeleton } from '@business-os/ui';
import { useState } from 'react';
import type { SchedulingClient } from '../../api/scheduling';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { formatDateTime } from './calendar-math';

/** One event: when (in the calendar's zone), where, status, overlaps; edit, cancel and archive as permitted. */
export function EventDetail({ client, slug, id, calendars, locale, canUpdate, canCancel, onEdit, onChanged, onClose, onSessionEnded }: {
  client: SchedulingClient; slug: string; id: string; calendars: SchedulingCalendar[]; locale: string; canUpdate: boolean; canCancel: boolean;
  onEdit: (event: SchedulingEvent) => void; onChanged: (message: string) => void; onClose: () => void; onSessionEnded: () => void;
}) {
  const loaded = useLoad(`scheduling-event|${slug}|${id}`, (signal) => client.event(slug, id, signal));
  const [confirming, setConfirming] = useState<'cancel' | 'archive' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = loaded.state.status === 'done' && loaded.state.outcome.kind === 'ok' ? loaded.state.outcome.data : null;
  const event = data?.event;
  const calendar = calendars.find((c) => c.id === event?.calendarId);
  const zone = calendar?.timeZone ?? 'UTC';
  const editable = event && event.status === 'SCHEDULED' && !event.archivedAt && calendar && !calendar.archivedAt;

  async function act(kind: 'cancel' | 'archive') {
    if (!event) return;
    setBusy(true);
    setError(null);
    const outcome = kind === 'cancel' ? await client.cancelEvent(slug, event.id, event.version) : await client.archiveEvent(slug, event.id, event.version);
    setBusy(false);
    if (outcome.kind === 'ok') {
      onChanged(kind === 'cancel' ? 'Event cancelled. It no longer blocks time and stays in the history.' : 'Event archived. It is kept in the history.');
      return;
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    setError(outcome.kind === 'conflict' && outcome.code === 'stale' ? 'Someone else changed this event. Close it and open it again.'
      : outcome.kind === 'forbidden' ? 'Your role does not allow this.' : outcome.kind === 'unreachable' ? "Can't reach Business OS. Nothing was changed." : 'This could not be done. Nothing was changed.');
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        {loaded.state.status === 'loading' ? (
          <>
            <DialogTitle className="sr-only">Loading event</DialogTitle>
            <div role="status" aria-busy="true" className="space-y-3"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-16 w-full" /></div>
          </>
        ) : !event ? (
          <>
            <DialogTitle className="sr-only">Event</DialogTitle>
            <Problem outcome={loaded.state.status === 'done' ? loaded.state.outcome : { kind: 'invalid' }} what="This event" onRetry={loaded.reload} onSessionEnded={onSessionEnded} />
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{event.title}</DialogTitle>
              {event.status === 'CANCELLED' ? <Badge tone="neutral">Cancelled</Badge> : null}
              {event.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
              {!event.blocksAvailability ? <Badge tone="info">Does not block time</Badge> : null}
            </div>
            <DialogDescription>
              {formatDateTime(event.startAt, locale, zone)} to {formatDateTime(event.endAt, locale, zone)}
            </DialogDescription>
            <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Calendar</dt><dd>{calendar?.name ?? 'Archived calendar'} ({zone})</dd>
              {event.location ? <><dt className="text-muted-foreground">Location</dt><dd>{event.location}</dd></> : null}
              {event.customer ? <><dt className="text-muted-foreground">Customer</dt><dd>{event.customer.displayName}</dd></> : null}
              {event.description ? <><dt className="text-muted-foreground">Notes</dt><dd className="whitespace-pre-wrap">{event.description}</dd></> : null}
              {event.cancelledAt ? <><dt className="text-muted-foreground">Cancelled</dt><dd>{formatDateTime(event.cancelledAt, locale, zone)}</dd></> : null}
            </dl>
            {data.conflicts.length > 0 ? (
              <Alert tone="warning" className="mt-4">
                <AlertDescription>
                  Overlaps {data.conflicts.map((c) => c.title).join(', ')} on this calendar.
                </AlertDescription>
              </Alert>
            ) : null}
            {confirming ? (
              <Alert tone="warning" role="alert" className="mt-4">
                <AlertDescription>
                  {confirming === 'cancel' ? 'Cancel this event? It stops blocking time. The record is kept.' : 'Archive this event? It disappears from the calendar. The record is kept.'}
                </AlertDescription>
              </Alert>
            ) : null}
            {error ? <Alert tone="danger" role="alert" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <DialogFooter>
              {confirming ? (
                <>
                  <Button variant="outline" onClick={() => setConfirming(null)} disabled={busy}>Keep it</Button>
                  <Button variant="destructive" loading={busy} onClick={() => void act(confirming)}>{confirming === 'cancel' ? 'Cancel event' : 'Archive event'}</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={onClose}>Close</Button>
                  {canCancel && !event.archivedAt && calendar && !calendar.archivedAt ? (
                    <Button variant="ghost" onClick={() => setConfirming('archive')}>Archive</Button>
                  ) : null}
                  {canCancel && editable ? <Button variant="secondary" onClick={() => setConfirming('cancel')}>Cancel event</Button> : null}
                  {canUpdate && editable ? <Button onClick={() => onEdit(event)}>Edit</Button> : null}
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
