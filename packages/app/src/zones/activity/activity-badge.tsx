import type { Activity } from '@business-os/contracts';
import { CallIcon, EmailIcon, MeetingIcon, NoteIcon } from '../customers/icons';
import { badgeKind, badgeLabel, type BadgeKind } from './labels';

function Svg({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
const ChatIcon = () => <Svg d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />;
const ArchiveIcon = () => <Svg d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" />;
export const LockIcon = () => <Svg d="M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2" />;

const ICONS: Record<Exclude<BadgeKind, 'system'>, () => React.JSX.Element> = {
  note: NoteIcon, call: CallIcon, meeting: MeetingIcon, email: EmailIcon, interaction: ChatIcon, message: ArchiveIcon,
};

/**
 * The icon for one timeline entry, labelled for assistive technology with its kind and direction
 * ("Call · outgoing", "Recorded email · incoming"). System entries have no icon (they read quieter).
 */
export function ActivityTypeIcon({ activity }: { activity: Activity }) {
  const kind = badgeKind(activity);
  if (kind === 'system') return <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />;
  const Icon = ICONS[kind];
  return (
    <span role="img" aria-label={badgeLabel(activity)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
      <Icon />
    </span>
  );
}

/** A small text badge with the entry's kind, plus "Restricted" for notes only some people can see. */
export function ActivityTypeBadge({ activity }: { activity: Activity }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{badgeLabel(activity)}</span>
      {activity.visibility === 'RESTRICTED' ? (
        <span title="Only the author, owners and admins can see this note" className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium">
          <LockIcon />Restricted
        </span>
      ) : null}
    </span>
  );
}
