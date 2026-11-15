import type { SchedulingEvent } from '@business-os/contracts';
import { cn } from '@business-os/ui';
import { useEffect, useRef } from 'react';
import {
  daySegments, eventsOnDay, formatDayHeading, formatHour, formatTime, formatWeekday, type ViewRange,
} from './calendar-math';

const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function label(event: SchedulingEvent, locale: string, timeZone: string) {
  const status = event.status === 'CANCELLED' ? ', cancelled' : event.blocksAvailability ? '' : ', does not block time';
  return `${event.title}, ${formatTime(event.startAt, locale, timeZone)} to ${formatTime(event.endAt, locale, timeZone)}${status}`;
}

function tone(event: SchedulingEvent, colour: string | null) {
  if (event.status === 'CANCELLED') return { className: 'border-dashed border-border bg-muted text-muted-foreground line-through', style: {} };
  const accent = colour ?? 'var(--color-ring)';
  return {
    className: cn('border-l-4 bg-card text-foreground shadow-sm', !event.blocksAvailability && 'border-dashed opacity-80'),
    style: { borderLeftColor: accent },
  };
}

/** Day and week views: one column per day, a 24-hour grid, events placed by local wall-clock time. */
export function TimeGrid({ range, events, today, locale, timeZone, colour, onOpen, onDay }: {
  range: ViewRange; events: SchedulingEvent[]; today: string; locale: string; timeZone: string; colour: string | null;
  onOpen: (id: string) => void; onDay?: (day: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Start the view at the working morning; the whole day stays reachable by scrolling.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX;
  }, [range.from]);
  const columns = range.days.length;
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="overflow-x-auto">
        <div style={{ minWidth: columns > 1 ? 720 : undefined }}>
          <div className="grid border-b" style={{ gridTemplateColumns: `4rem repeat(${columns}, minmax(0, 1fr))` }}>
            <div aria-hidden="true" />
            {range.days.map((day) => (
              <div key={day} className="border-l px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                {onDay && columns > 1 ? (
                  <button type="button" onClick={() => onDay(day)} aria-label={`Open ${day}`}
                    className={cn('rounded-md px-2 py-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring', day === today && 'bg-primary text-primary-foreground hover:bg-primary')}>
                    {formatDayHeading(day, locale)}
                  </button>
                ) : (
                  <span className={cn('rounded-md px-2 py-1', day === today && 'bg-primary text-primary-foreground')}>{formatDayHeading(day, locale)}</span>
                )}
              </div>
            ))}
          </div>
          <div ref={scroller} className="max-h-[36rem] overflow-y-auto">
            <div className="relative grid" style={{ gridTemplateColumns: `4rem repeat(${columns}, minmax(0, 1fr))`, height: 24 * HOUR_PX }}>
              <div aria-hidden="true">
                {HOURS.map((h) => (
                  <div key={h} className="relative pr-2 text-right text-[11px] text-muted-foreground" style={{ height: HOUR_PX }}>
                    <span className="relative -top-2">{h === 0 ? '' : formatHour(h, locale)}</span>
                  </div>
                ))}
              </div>
              {range.days.map((day) => (
                <div key={day} role="list" aria-label={`Events on ${day}`} className="relative border-l">
                  {HOURS.map((h) => <div key={h} aria-hidden="true" className="border-b border-border/60" style={{ height: HOUR_PX }} />)}
                  {daySegments(events, day, timeZone).map((s) => {
                    const t = tone(s.event, colour);
                    return (
                      <div key={s.event.id} role="listitem" className="absolute px-0.5" style={{
                        top: (s.top / 60) * HOUR_PX, height: Math.max(((s.bottom - s.top) / 60) * HOUR_PX, 20),
                        left: `${(s.lane / s.lanes) * 100}%`, width: `${100 / s.lanes}%`,
                      }}>
                        <button type="button" onClick={() => onOpen(s.event.id)} aria-label={label(s.event, locale, timeZone)}
                          className={cn('h-full w-full overflow-hidden rounded-md border px-1.5 py-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring', t.className)}
                          style={t.style}>
                          <span className="block truncate font-semibold">{s.event.title}</span>
                          <span className="block truncate text-muted-foreground">
                            {s.continuesBefore ? '… ' : ''}{formatTime(s.event.startAt, locale, timeZone)}–{formatTime(s.event.endAt, locale, timeZone)}{s.continuesAfter ? ' …' : ''}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const MAX_CHIPS = 3;

/** Month view: six weeks, up to three events per day, the rest behind "+N more" (opens the day). */
export function MonthGrid({ range, month, events, today, locale, timeZone, colour, onOpen, onDay }: {
  range: ViewRange; month: string; events: SchedulingEvent[]; today: string; locale: string; timeZone: string; colour: string | null;
  onOpen: (id: string) => void; onDay: (day: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid grid-cols-7 border-b">
            {range.days.slice(0, 7).map((day) => (
              <div key={day} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">{formatWeekday(day, locale)}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {range.days.map((day) => {
              const list = eventsOnDay(events, day, timeZone);
              const inMonth = day.slice(0, 7) === month;
              return (
                <div key={day} className={cn('min-h-28 border-b border-l p-1.5 first:border-l-0 [&:nth-child(7n+1)]:border-l-0', !inMonth && 'bg-muted/40')}>
                  <button type="button" onClick={() => onDay(day)} aria-label={`Open ${day}`}
                    className={cn('mb-1 inline-flex size-7 items-center justify-center rounded-full text-xs font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
                      day === today ? 'bg-primary text-primary-foreground hover:bg-primary' : inMonth ? 'text-foreground' : 'text-muted-foreground')}>
                    {Number(day.slice(8))}
                  </button>
                  <ul aria-label={`Events on ${day}`} className="space-y-1">
                    {list.slice(0, MAX_CHIPS).map((event) => {
                      const t = tone(event, colour);
                      return (
                        <li key={event.id}>
                          <button type="button" onClick={() => onOpen(event.id)} aria-label={label(event, locale, timeZone)}
                            className={cn('w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] focus-visible:outline-2 focus-visible:outline-ring', t.className)} style={t.style}>
                            <span className="text-muted-foreground">{formatTime(event.startAt, locale, timeZone)}</span> {event.title}
                          </button>
                        </li>
                      );
                    })}
                    {list.length > MAX_CHIPS ? (
                      <li>
                        <button type="button" onClick={() => onDay(day)} className="px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
                          +{list.length - MAX_CHIPS} more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
