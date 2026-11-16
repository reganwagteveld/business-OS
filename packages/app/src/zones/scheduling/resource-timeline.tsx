import type { SchedulingEvent, SchedulingResourceType } from '@business-os/contracts';
import { Button, cn, Input, Select } from '@business-os/ui';
import { useMemo, useState } from 'react';
import type { SchedulingClient } from '../../api/scheduling';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import {
  dayBounds, formatDayHeading, formatRangeTitle, formatTime, overlappingIds, shiftAnchor, timelineFraction, todayIn, viewRange, weekStartFor,
} from './calendar-math';
import { TYPE_LABEL, TYPES } from './resource-labels';

const ROWS = 100;

/**
 * The resource schedule (S2): one row per resource, time across, each booking placed in the rows of the
 * resources it holds. Day or week, in the zone of the calendar being viewed (the same S1 date functions,
 * so a daylight-saving day is drawn as its own 23 or 25 hours). Bookings from every active calendar are
 * shown. Overlapping occupying bookings in a row (overlaps kept on purpose) are marked. Read-only:
 * selecting a booking opens the event.
 */
export function ResourceTimeline({ client, slug, locale, timeZone, now, refresh = 0, onOpen, onSessionEnded }: {
  client: SchedulingClient; slug: string; locale: string; timeZone: string; now?: number;
  /** Changes after a booking was saved elsewhere in the Zone, so the rows reload. */
  refresh?: number; onOpen: (eventId: string) => void; onSessionEnded: () => void;
}) {
  const today = todayIn(timeZone, now);
  const [kind, setKind] = useState<'day' | 'week'>('day');
  const [anchor, setAnchor] = useState(today);
  const [type, setType] = useState<SchedulingResourceType | ''>('');
  const [q, setQ] = useState('');
  const weekStart = useMemo(() => weekStartFor(locale), [locale]);
  const range = useMemo(() => viewRange(kind, anchor, timeZone, weekStart), [kind, anchor, timeZone, weekStart]);
  const bounds = useMemo(() => dayBounds(range, timeZone), [range, timeZone]);
  const from = new Date(range.from).toISOString();
  const to = new Date(range.to).toISOString();
  const res = useLoad(`scheduling-timeline-resources|${slug}|${type}|${q}`, (signal) => client.resources(slug, { status: 'current', type: type || undefined, q: q || undefined, limit: ROWS }, signal));
  const evs = useLoad(`scheduling-timeline-events|${slug}|${from}|${to}|${refresh}`, (signal) => client.events(slug, { from, to, status: 'scheduled' }, signal));
  const resources = res.state.status === 'done' && res.state.outcome.kind === 'ok' ? res.state.outcome.data : null;
  const events = evs.state.status === 'done' && evs.state.outcome.kind === 'ok' ? evs.state.outcome.data : null;
  const byResource = useMemo(() => {
    const map = new Map<string, SchedulingEvent[]>();
    for (const e of events ?? []) for (const r of e.resources) map.set(r.id, [...(map.get(r.id) ?? []), e]);
    return map;
  }, [events]);

  const failed = res.state.status === 'done' && res.state.outcome.kind !== 'ok' ? res.state.outcome : evs.state.status === 'done' && evs.state.outcome.kind !== 'ok' ? evs.state.outcome : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Range" className="inline-flex rounded-lg border p-0.5">
          {(['day', 'week'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
              className={`min-h-9 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {k === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" aria-label={`Previous ${kind}`} onClick={() => setAnchor(shiftAnchor(kind, anchor, -1))}>‹</Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(today)}>Today</Button>
          <Button variant="outline" size="sm" aria-label={`Next ${kind}`} onClick={() => setAnchor(shiftAnchor(kind, anchor, 1))}>›</Button>
        </div>
        <h2 aria-live="polite" className="text-base font-semibold tracking-tight">{formatRangeTitle(kind, range, anchor, locale)}</h2>
        <label className="flex items-center gap-2 text-sm"><span className="font-medium">Type</span>
          <Select className="w-auto" value={type} onChange={(e) => setType(e.target.value as SchedulingResourceType | '')}>
            <option value="">All</option>{TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </Select></label>
        <label className="flex items-center gap-2 text-sm"><span className="sr-only">Find a resource</span>
          <Input type="search" placeholder="Find a resource" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} className="w-44" /></label>
      </div>
      {failed ? (
        <Problem outcome={failed} what="The resource schedule" onRetry={() => { res.reload(); evs.reload(); }} onSessionEnded={onSessionEnded} />
      ) : resources === null || events === null ? (
        <div role="status" aria-busy="true" className="h-64 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"><span className="sr-only">Loading the resource schedule…</span></div>
      ) : resources.resources.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{q || type ? 'No resources match.' : 'No resources yet. Add them under Resources.'}</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-collapse text-sm" style={{ minWidth: kind === 'week' ? 900 : 640 }}>
              <caption className="sr-only">Bookings by resource, {formatRangeTitle(kind, range, anchor, locale)}, times in {timeZone}</caption>
              <colgroup><col style={{ width: '10rem' }} /><col /></colgroup>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="px-3 py-2 text-left font-medium">Resource</th>
                  <th scope="col" className="p-0">
                    <div className="grid" style={{ gridTemplateColumns: `repeat(${kind === 'week' ? bounds.length : 24}, minmax(0, 1fr))` }}>
                      {kind === 'week'
                        ? bounds.map((b) => <span key={b.day} className={cn('border-l px-1 py-2 text-xs font-medium', b.day === today && 'text-primary')}>{formatDayHeading(b.day, locale)}</span>)
                        : Array.from({ length: 24 }, (_, h) => <span key={h} className="border-l px-0.5 py-2 text-[10px] text-muted-foreground">{h % 3 === 0 ? `${String(h).padStart(2, '0')}` : ''}</span>)}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {resources.resources.map((r) => {
                  const rowEvents = byResource.get(r.id) ?? [];
                  const clash = overlappingIds(rowEvents);
                  return (
                    <tr key={r.id} className="border-b last:border-b-0">
                      <th scope="row" className="truncate px-3 py-2 text-left font-normal">
                        <span className="font-medium">{r.name}</span>
                        <span className="block text-xs text-muted-foreground">{TYPE_LABEL[r.type]}{r.status === 'INACTIVE' ? ' · inactive' : ''}</span>
                      </th>
                      <td className="relative h-14 p-0">
                        <ul aria-label={`${r.name} bookings`} className="absolute inset-0">
                          {rowEvents.length === 0 ? <li className="sr-only">Free</li> : null}
                          {rowEvents.map((e) => {
                            const left = timelineFraction(Date.parse(e.startAt), bounds);
                            const right = timelineFraction(Date.parse(e.endAt), bounds);
                            const overlap = clash.has(e.id);
                            return (
                              <li key={e.id} className="absolute top-1.5 bottom-1.5" style={{ left: `${left * 100}%`, width: `max(${(right - left) * 100}%, 6px)` }}>
                                <button type="button" onClick={() => onOpen(e.id)}
                                  aria-label={`${e.title}, ${formatTime(e.startAt, locale, timeZone)} to ${formatTime(e.endAt, locale, timeZone)}${overlap ? ', overlaps another booking of this resource' : ''}${e.blocksAvailability ? '' : ', does not block time'}`}
                                  className={cn('size-full truncate rounded-md border-l-4 bg-muted px-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring',
                                    overlap && 'ring-2 ring-warning', !e.blocksAvailability && 'border-dashed opacity-70')}
                                  style={{ borderLeftColor: r.colour ?? 'var(--color-ring)' }}>
                                  {overlap ? <span aria-hidden>⚠ </span> : null}{e.title}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {resources.nextCursor ? <p className="border-t p-2 text-xs text-muted-foreground">Showing the first {ROWS} resources. Filter by type or name to see others.</p> : null}
        </div>
      )}
    </div>
  );
}
