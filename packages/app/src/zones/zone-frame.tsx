import type { ReactNode } from 'react';
import { BusinessOsMark } from '../shell/business-os-mark';

/**
 * The frame every Zone shares: brand, a path back to the Zone home, and the active business, always
 * visible. Zones stay focused workspaces; there is no permanent sidebar.
 */
export function ZoneFrame({ zone, business, user, onHome, onSwitch, onSignOut, children }: {
  zone: string; business: string; user: string; onHome: () => void; onSwitch: () => void; onSignOut: () => void; children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <BusinessOsMark className="h-9 w-9 shrink-0" />
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
              <button type="button" onClick={onHome} className="rounded-md px-2 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                <span aria-hidden="true">←</span> All Zones
              </button>
              <span aria-hidden="true" className="text-muted-foreground/60">/</span>
              <span aria-current="page" className="font-semibold">{zone}</span>
            </nav>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <button type="button" onClick={onSwitch} className="max-w-[16rem] truncate rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Switch business, current business ${business}`}>
              {business} <span aria-hidden="true" className="ml-1 text-muted-foreground">⌄</span>
            </button>
            <span className="hidden text-muted-foreground sm:inline">{user}</span>
            <button type="button" onClick={onSignOut} className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 pb-20 pt-6 sm:px-6 sm:pt-8">{children}</main>
    </div>
  );
}
