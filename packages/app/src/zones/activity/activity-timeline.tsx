import type { Activity } from '@business-os/contracts';
import { useId, useState } from 'react';
import type { ActivityPage } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { activityTitle, formatWhen, isSystemActivity } from '../customers/format';
import { ActivityTypeBadge, ActivityTypeIcon } from './activity-badge';
import { messageEntryTitle, TIMELINE_FILTERS } from './labels';

/**
 * The unified activity timeline (docs/communications-c1.md): notes, logged interactions, recorded
 * messages and automated changes for one record, newest first, from the activity API only. The
 * server decides what the viewer may see (restricted notes, message entries); nothing is invented
 * here, and an empty timeline says how entries appear. Loading, empty and error states are built in.
 */
export function ActivityTimeline({ load, loadKey, refreshKey = 0, names, locale, timeZone, onSessionEnded, emptyText = 'No activity yet.', emptyHint }: {
  /** Fetches one page; the component owns paging and the type filter. */
  load: (cursor: string | undefined, types: string[] | undefined, signal: AbortSignal) => Promise<Outcome<ActivityPage>>;
  /** Identifies the record (for example `slug|customerId`), so switching records starts again. */
  loadKey: string;
  /** Change it to reload from the first page (after something was logged). */
  refreshKey?: number;
  /** Member names by user id; null while unknown. */
  names: Map<string, string> | null;
  locale?: string; timeZone: string; onSessionEnded: () => void; emptyText?: string;
  /** How entries appear, shown under the empty state (never sample data). */
  emptyHint?: string;
}) {
  const uid = useId();
  const [filter, setFilter] = useState('all');
  // Paging restarts from the first page whenever the record, the filter or the refresh key changes.
  const scope = `${loadKey}|${filter}|${refreshKey}`;
  const [paging, setPaging] = useState<{ scope: string; stack: string[] }>({ scope, stack: [] });
  const stack = paging.scope === scope ? paging.stack : [];
  const setStack = (next: string[]) => setPaging({ scope, stack: next });
  const cursor = stack[stack.length - 1];
  const types = TIMELINE_FILTERS.find((f) => f.value === filter)?.types;
  const { state, reload } = useLoad(`timeline|${loadKey}|${filter}|${cursor ?? ''}|${refreshKey}`, (signal) => load(cursor, types, signal));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor={`${uid}-filter`} className="text-xs font-medium text-muted-foreground">Show</label>
        <select id={`${uid}-filter`} value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-lg border border-input bg-background px-2 py-1 text-sm">
          {TIMELINE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        {state.status === 'done' && state.outcome.kind === 'ok' && stack.length > 0 ? <button type="button" className="text-xs underline" onClick={reload}>Refresh</button> : null}
      </div>
      {state.status === 'loading' ? <Skeleton rows={3} label="Loading activity…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Activity" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'done' && state.outcome.kind === 'ok' ? (
        <>
          {state.outcome.data.activities.length === 0 ? (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{filter === 'all' ? emptyText : 'Nothing of this kind yet.'}</p>
              {filter === 'all' && emptyHint ? <p className="text-xs text-muted-foreground">{emptyHint}</p> : null}
            </div>
          ) : (
            <ol className="space-y-3.5">
              {state.outcome.data.activities.map((a) => (
                <ActivityTimelineItem key={a.id} a={a} locale={locale} timeZone={timeZone} who={a.actorUserId ? (names ? names.get(a.actorUserId) ?? 'A team member' : null) : 'System'} />
              ))}
            </ol>
          )}
          {stack.length > 0 || state.outcome.data.nextCursor ? (
            <nav aria-label="Activity pages" className="mt-5 flex justify-between border-t border-border pt-4">
              <button type="button" className={secondaryClass} disabled={stack.length === 0} onClick={() => setStack(stack.slice(0, -1))}>Newer</button>
              <button type="button" className={secondaryClass} disabled={!state.outcome.data.nextCursor}
                onClick={() => state.outcome.kind === 'ok' && state.outcome.data.nextCursor && setStack([...stack, state.outcome.data.nextCursor])}>Older</button>
            </nav>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * One entry. Things people logged or recorded get an icon, a kind badge and normal weight; automated
 * changes are smaller and quieter, so the human history reads first. Every entry keeps who and when;
 * an edited note says so.
 */
export function ActivityTimelineItem({ a, who, locale, timeZone }: { a: Activity; who: string | null; locale?: string; timeZone: string }) {
  const meta = (
    <p className="mt-0.5 text-xs text-muted-foreground">
      {who ? `${who} · ` : ''}<time dateTime={a.occurredAt}>{formatWhen(a.occurredAt, timeZone, locale)}</time>{a.editedAt ? ' · edited' : ''}
    </p>
  );
  if (isSystemActivity(a) && a.type !== 'message.recorded') {
    return (
      <li data-kind="system" className="flex gap-3 pl-1.5">
        <ActivityTypeIcon activity={a} />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{activityTitle(a)}</p>
          {meta}
        </div>
      </li>
    );
  }
  const title = a.type === 'message.recorded' ? messageEntryTitle(a) : activityTitle(a);
  return (
    <li data-kind={a.type === 'message.recorded' ? 'message' : 'user'} className="flex gap-3">
      <ActivityTypeIcon activity={a} />
      <div className="min-w-0">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{title}</p>
        <div className="mt-1"><ActivityTypeBadge activity={a} /></div>
        {a.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">{a.body}</p> : null}
        {meta}
      </div>
    </li>
  );
}
