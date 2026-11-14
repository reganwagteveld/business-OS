import type { ReactNode } from 'react';
import { AppShell, useInShell, useShellGuard } from '../shell/app-shell';
import { resolveNavigation } from '../shell/registry';

/**
 * Where a Zone plugs into the application shell. Inside the shell (always, in the apps) it only hands
 * the shell the Zone's unsaved-changes guard, so leaving through the sidebar, the breadcrumbs, the
 * business switcher or the account menu asks first. Rendered on its own (in tests, or a future
 * embedding) it brings up the same AppShell around itself with the handlers it was given.
 */
export function ZoneFrame({ zone, business, user, leave, onHome, onSwitch, onSignOut, children }: {
  zone: string; business: string; user: string;
  /** The Zone's unsaved-changes guard: runs the action now, or after the person confirms. */
  leave?: (action: () => void) => void;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; children: ReactNode;
}) {
  if (useInShell()) return <Guarded leave={leave}>{children}</Guarded>;
  return (
    <AppShell
      business={{ slug: '', name: business }}
      businesses={[]}
      user={{ name: user, email: user }}
      navigation={resolveNavigation({ state: 'ready', permissions: [] })}
      route={{ zone: 'customers' }}
      currentLabel={zone}
      onNavigate={(route) => (route.zone === 'home' ? onHome() : undefined)}
      onChooseBusiness={onSwitch}
      onSignOut={onSignOut}
    >
      <Guarded leave={leave}>{children}</Guarded>
    </AppShell>
  );
}

function Guarded({ leave, children }: { leave?: (action: () => void) => void; children: ReactNode }) {
  useShellGuard(leave);
  return <>{children}</>;
}
