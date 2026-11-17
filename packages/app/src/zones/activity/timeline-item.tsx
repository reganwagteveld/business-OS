import type { Activity } from '@business-os/contracts';
import type { ReactNode } from 'react';
import { activityTitle, formatWhen, isSystemActivity } from '../customers/format';
import { ActivityTypeBadge, ActivityTypeIcon } from './activity-badge';
import { messageEntryTitle } from './labels';

/**
 * One entry. Things people logged or recorded get an icon, a kind badge and normal weight; automated
 * changes are smaller and quieter, so the human history reads first. Every entry keeps who and when;
 * an edited note says so.
 */
export function ActivityTimelineItem({ a, who, locale, timeZone, actions, notice }: {
  a: Activity; who: string | null; locale?: string; timeZone: string;
  /** Controls shown under the entry (edit and remove), only passed where the viewer may change it. */
  actions?: ReactNode; notice?: string | null;
}) {
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
        {notice ? <p role="alert" className="mt-1 text-xs text-destructive">{notice}</p> : null}
        {actions}
      </div>
    </li>
  );
}
