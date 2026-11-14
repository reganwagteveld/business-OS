import type { CurrentUser } from '@business-os/contracts';
import { actionClass, Frame, secondaryClass } from './frame';

/** The server could not be reached. Offline and "service not responding" differ; neither says "signed out". */
export function Unreachable({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <Frame
      alert
      title={offline ? "You're offline" : "Can't reach Business OS"}
      subtitle={
        offline
          ? 'Check your internet connection. Business OS reconnects by itself when it comes back, or you can try again now.'
          : 'The service did not respond. Your session is still saved. Try again in a moment.'
      }
    >
      <button type="button" className={actionClass} onClick={onRetry}>Try again</button>
    </Frame>
  );
}

export function Failed({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => void }) {
  return (
    <Frame alert title="Something went wrong" subtitle="Business OS could not load your workspace. Nothing was changed.">
      <div className="flex gap-3">
        <button type="button" className={actionClass} onClick={onRetry}>Try again</button>
        <button type="button" className={secondaryClass} onClick={onSignOut}>Sign out</button>
      </div>
    </Frame>
  );
}

/** Shown above the sign-in form when a session that existed has ended. */
export function SessionExpiredNotice() {
  return (
    <p role="status" className="mx-auto mt-6 max-w-sm px-4 text-center text-sm text-muted-foreground">
      Your session has ended. Please sign in again.
    </p>
  );
}

export function Unverified({ user, onSignOut, onRefresh }: { user: CurrentUser; onSignOut: () => void; onRefresh: () => void }) {
  return (
    <Frame title="Verify your email" subtitle={`We sent a link to ${user.email}. Open it to finish setting up your account, then come back here.`}>
      <div className="flex gap-3">
        <button type="button" className={actionClass} onClick={onRefresh}>I've verified</button>
        <button type="button" className={secondaryClass} onClick={onSignOut}>Sign out</button>
      </div>
    </Frame>
  );
}
