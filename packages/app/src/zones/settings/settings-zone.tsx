import type { CurrentUser } from '@business-os/contracts';
import { cn } from '@business-os/ui';
import { useEffect, useMemo, useRef } from 'react';
import type { SettingsClient } from '../../api/settings';
import type { BusinessContext } from '../../api/tenancy';
import type { ShellRoute } from '../../shell/registry';
import { useDraftGuard } from '../drafts';
import { ZoneFrame } from '../zone-frame';
import { AccountPreferences } from './account-preferences';
import { BusinessProfilePage, type SettingsPageEnv } from './business-profile';
import { isScope, pagesFor, resolvePage, type SettingsScope } from './pages';
import { InvitationsPage } from './invitations';
import { MembersPage } from './members';
import { OwnershipPage } from './ownership';
import { ZoneConfigurationPage } from './zones';
import { RegionalSettingsPage } from './regional-settings';

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * Settings (A3 / A2-D stage 1): one destination with two scopes, the signed-in person (Account) and the
 * active business (Business). The shell's section bar switches scope; this Zone's own list switches page.
 * Which pages exist depends on the server's permission keys and on whether the backend behind a page
 * exists: a page that cannot work is not listed at all. Mount with `key={slug}` so switching business
 * discards every bit of state. Unsaved edits are protected on every way of leaving (pages, scopes,
 * Zones, business switcher, sign out, closing the window).
 */
export function SettingsZone({ client, user, context, scope: scopeId, page: pageId, onNavigate, onContextChanged, onLeft, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: SettingsClient;
  user: CurrentUser;
  context: BusinessContext;
  /** The shell route's child: `account` or `business`. Anything else opens the Business scope. */
  scope?: string;
  /** The shell route's target: a page id inside the scope. Unknown or unpermitted ids open the scope's first page. */
  page?: string;
  onNavigate: (route: ShellRoute) => void;
  /** Re-reads the business context (name, formats) after a save, so the shell never shows stale values. */
  onContextChanged: () => void;
  /** The person left this business: the app re-reads their memberships and moves on. */
  onLeft: () => void;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name } = context.business;
  const permissions = context.membership.permissions;
  const scope: SettingsScope = isScope(scopeId) ? scopeId : 'business';
  const guard = useDraftGuard();
  const page = resolvePage(scope, pageId, permissions);
  const pages = pagesFor(scope, permissions);
  const canManage = permissions.includes('business:manage');
  const content = useRef<HTMLDivElement>(null);
  const { markDraft, leave } = guard;

  const pageKey = `${scope}/${page?.id ?? ''}`;
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [pageKey]);

  const role = context.membership.role;
  const membershipId = context.membership.id;
  const { locale, timeZone } = context.business;
  const go = (id: string) => leave(() => onNavigate({ zone: 'settings', child: 'business', target: id }));
  const env: SettingsPageEnv = useMemo(
    () => ({ client, slug, canManage, markDraft, onSessionEnded, onSaved: onContextChanged, me: { membershipId, role, permissions }, businessName: name, locale, timeZone, onLeft, go }),
    // `go` and the callbacks change identity every render; the page reads them when it acts, never to decide what to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, slug, canManage, markDraft, onSessionEnded, membershipId, role, permissions, name, locale, timeZone, onContextChanged, onLeft],
  );

  return (
    <ZoneFrame zone="Settings" business={name} user={user.name || user.email} leave={guard.leave} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>
      <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-10">
        <nav aria-label={scope === 'account' ? 'Account settings' : 'Business settings'} className="min-w-0 lg:w-56 lg:shrink-0">
          <p className="mb-2 hidden truncate text-small font-semibold lg:block">{scope === 'account' ? 'Account' : name}</p>
          <ul className="flex gap-1 overflow-x-auto border-b border-line lg:flex-col lg:overflow-visible lg:border-b-0">
            {pages.map((p) => {
              const active = p.id === page?.id;
              return (
                <li key={p.id}>
                  <button type="button" aria-current={active ? 'page' : undefined} onClick={() => leave(() => onNavigate({ zone: 'settings', child: scope, target: p.id }))}
                    className={cn('relative flex min-h-11 w-full items-center px-3 text-left text-small font-medium whitespace-nowrap lg:rounded-lg', active ? 'text-foreground lg:bg-accent' : 'text-muted-foreground hover:text-foreground lg:hover:bg-accent', focusRing)}>
                    {p.label}
                    {active ? <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 bg-ring lg:hidden" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div ref={content} className="min-w-0 max-w-5xl flex-1">
          {page?.id === 'preferences' ? <AccountPreferences key={pageKey} user={user} /> : null}
          {page?.id === 'profile' ? <BusinessProfilePage key={`${pageKey}|${slug}`} env={env} /> : null}
          {page?.id === 'regional' ? <RegionalSettingsPage key={`${pageKey}|${slug}`} env={env} /> : null}
          {page?.id === 'members' ? <MembersPage key={`${pageKey}|${slug}`} env={env} /> : null}
          {page?.id === 'invitations' ? <InvitationsPage key={`${pageKey}|${slug}`} env={env} /> : null}
          {page?.id === 'zones' ? <ZoneConfigurationPage key={`${pageKey}|${slug}`} env={{ ...env, open: (route) => leave(() => onNavigate(route)) }} /> : null}
          {page?.id === 'ownership' ? <OwnershipPage key={`${pageKey}|${slug}`} env={env} /> : null}
        </div>
      </div>
      {guard.dialog}
    </ZoneFrame>
  );
}
