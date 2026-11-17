import { Alert, AlertDescription, AlertTitle, Button, cn, Skeleton, Spinner } from '@business-os/ui';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import type { BusinessSummary } from '../api/tenancy';
import { useDialog } from '../zones/dialog';
import { MEDIUM, useLayout } from '../zones/use-layout';
import { BusinessOsMark } from './business-os-mark';
import { ROLE_LABEL } from './choose';
import { Icon, type IconName } from './icons';
import { Menu, type MenuEntry } from './menu';
import { useSidebarPreference, useThemePreference, type SidebarMode, type ThemePreference } from './preferences';
import { HOME, type ResolvedNavigation, type ResolvedZone, type ShellRoute } from './registry';

/** A problem with the last business switch, shown once above the content. */
export type ShellNotice = { kind: 'switch-failed'; business: string; current: string } | { kind: 'access-revoked'; business: string; current: string };

export interface AppShellProps {
  /** The active business. Always visible. */
  business: { slug: string; name: string; role?: BusinessSummary['role'] };
  /** Businesses the server lists for this person; the switcher offers exactly these. */
  businesses: readonly BusinessSummary[];
  user: { name: string | null; email: string };
  navigation: ResolvedNavigation;
  route: ShellRoute;
  /** Name for the current page when it is not a registry Zone (a Zone rendered on its own). */
  currentLabel?: string;
  /** A business being opened: the content area shows a loading state, never the previous business's screens. */
  switching?: BusinessSummary | null;
  notice?: ShellNotice | null;
  onDismissNotice?: () => void;
  onNavigate: (route: ShellRoute) => void;
  /** Switch straight to another listed business. Omitted where the shell cannot (a Zone on its own). */
  onSelectBusiness?: (slug: string) => void;
  /** The full business chooser. */
  onChooseBusiness: () => void;
  onCreateBusiness?: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

type Guard = (action: () => void) => void;

interface ShellContextValue {
  /** A Zone hands the shell its unsaved-changes guard; returns the unregister function. */
  registerGuard: (guard: Guard) => () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** True inside an AppShell. */
export function useInShell(): boolean {
  return useContext(ShellContext) !== null;
}

/**
 * Lets a Zone protect unsaved work from shell navigation: every shell action that leaves the screen
 * (another Zone, Home, switching business, signing out) runs through `guard`, which asks first.
 */
export function useShellGuard(guard: Guard | undefined) {
  const shell = useContext(ShellContext);
  useLayoutEffect(() => (shell && guard ? shell.registerGuard(guard) : undefined), [shell, guard]);
}

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const initials = (text: string) => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : (words[0]?.[1] ?? ''))).toUpperCase() || '?';
};

/**
 * The application shell shared by the browser and desktop apps: sidebar with the Zones this person
 * may open, top bar (breadcrumbs, search and notifications entry points, account menu), business
 * switcher and the content workspace. It owns layout and navigation only; it never fetches business
 * data and holds no tenant data of its own.
 *
 * Widths: wide (>= 1024px) shows the sidebar expanded or compact (remembered per device); medium
 * (640-1023px) uses the compact rail; narrow (< 640px) moves navigation into a drawer.
 */
export function AppShell(props: AppShellProps) {
  const { business, navigation, route, switching, notice, onDismissNotice, children } = props;
  const layout = useLayout();
  const [preference, setPreference] = useSidebarPreference();
  const mode: SidebarMode = layout === 'wide' ? preference : 'compact';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);

  // The current Zone's unsaved-changes guard (at most one Zone is open at a time).
  const guardRef = useRef<Guard | null>(null);
  const context = useMemo<ShellContextValue>(() => ({
    registerGuard: (guard) => {
      guardRef.current = guard;
      return () => {
        if (guardRef.current === guard) guardRef.current = null;
      };
    },
  }), []);
  const guarded = useCallback((action: () => void) => (guardRef.current ? guardRef.current(action) : action()), []);

  // The drawer only exists on narrow screens.
  const narrow = layout === 'narrow';
  // Leaving the narrow layout (rotating a tablet, widening a window) closes the drawer: the state is
  // reset from the media-query change event, never during render. `drawerShown` also keeps the
  // drawer out of any render where the layout is already wider, so it can never show on desktop.
  useEffect(() => {
    if (!drawerOpen || typeof window === 'undefined' || !window.matchMedia) return;
    const wider = window.matchMedia(MEDIUM);
    const onChange = () => {
      if (wider.matches) setDrawerOpen(false);
    };
    wider.addEventListener('change', onChange);
    return () => wider.removeEventListener('change', onChange);
  }, [drawerOpen]);
  const drawerShown = narrow && drawerOpen;

  const zone = route.zone === 'home' ? null : navigation.available.find((z) => z.id === route.zone) ?? null;
  const pageLabel = route.zone === 'home' ? 'Home' : zone?.name ?? props.currentLabel ?? 'Zone';
  const childItem = zone && route.zone !== 'home' && route.child ? zone.children?.find((c) => c.id === route.child) : undefined;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = `${childItem ? `${childItem.label} · ` : ''}${pageLabel} · ${switching ? switching.name : business.name} · Business OS`;
  }, [pageLabel, childItem, business.name, switching]);

  const shared: NavProps = { ...props, mode, guarded, pageZone: route.zone, onAfterNavigate: () => setDrawerOpen(false) };

  return (
    <ShellContext.Provider value={context}>
      <div data-shell="" className="bos-atmosphere flex h-dvh overflow-hidden text-foreground" data-atmosphere="calm">
        <a href="#bos-content" className={cn('sr-only z-50 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only focus:absolute focus:top-3 focus:left-3', focusRing)}>Skip to content</a>
        {narrow ? null : <Sidebar {...shared} onToggle={layout === 'wide' ? () => setPreference(mode === 'expanded' ? 'compact' : 'expanded') : undefined} />}
        <div className="flex min-w-0 flex-1 flex-col" inert={drawerShown || undefined}>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b bg-background/70 px-3 sm:px-6">
            {narrow ? (
              <button ref={menuButton} type="button" aria-label="Open navigation" aria-expanded={drawerShown} aria-controls="bos-drawer" onClick={() => setDrawerOpen(true)} className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-accent', focusRing)}>
                <Icon name="menu" />
              </button>
            ) : null}
            {narrow ? <BusinessSwitcher {...shared} variant="bar" /> : <Breadcrumbs {...shared} pageLabel={pageLabel} />}
            <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
              <Unavailable icon="search" label="Search" compact={layout !== 'wide'} />
              <Unavailable icon="bell" label="Notifications" compact />
              <AccountMenu {...shared} showName={layout === 'wide'} />
            </div>
          </header>
          {narrow ? <div className="shrink-0 border-b bg-background/70 px-4 py-2"><Breadcrumbs {...shared} pageLabel={pageLabel} /></div> : null}
          {zone?.children?.length && !switching ? <SecondaryNav zone={zone} {...shared} /> : null}
          <main ref={content} id="bos-content" tabIndex={-1} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none">
            <div className="mx-auto max-w-7xl px-4 pt-6 pb-20 sm:px-6 sm:pt-8">
              {notice ? <NoticeBanner notice={notice} onDismiss={onDismissNotice} /> : null}
              {switching ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-3" aria-busy="true">
                  <h1 className="sr-only">Opening {switching.name}</h1>
                  <Spinner label={`Opening ${switching.name}…`} />
                </div>
              ) : children}
            </div>
          </main>
        </div>
        {drawerShown ? <Drawer {...shared} onClose={() => setDrawerOpen(false)} /> : null}
      </div>
    </ShellContext.Provider>
  );
}

interface NavProps extends AppShellProps {
  mode: SidebarMode;
  guarded: Guard;
  pageZone: ShellRoute['zone'];
  /**
   * Closes the drawer. Called only once a navigation actually goes ahead (inside the guarded
   * action), so cancelling at "Discard unsaved changes?" leaves the drawer open where it was.
   */
  onAfterNavigate: () => void;
}

/*
 * The Pixa Rail (UI V2-B2 Direction A, §6.2): the sidebar as a dark-scope island. The rail element
 * carries the `dark` class, so every colour inside it resolves to the dark semantic tokens in both
 * themes (no new colours; every text pair is already contrast-tested in V2-B1). Geometry follows
 * §4 rule 4: rectangular controls, 8 px controls, 6 px small squares, 4 px labels, square markers,
 * no pills.
 */
function Sidebar(props: NavProps & { onToggle?: () => void; inDrawer?: boolean; onClose?: () => void; closeRef?: Ref<HTMLButtonElement> }) {
  const { mode, onToggle, inDrawer, onClose, closeRef } = props;
  const compact = mode === 'compact';
  return (
    <div
      data-rail=""
      className={cn(
        'dark flex h-full shrink-0 flex-col bg-canvas text-fg',
        inDrawer ? 'w-full' : cn('border-r border-line transition-[width] duration-slow ease-standard motion-reduce:transition-none', compact ? 'w-(--sidebar-w-compact)' : 'w-(--sidebar-w)'),
      )}
    >
      <div className={cn('flex h-16 shrink-0 items-center gap-3', compact ? 'justify-center px-2' : 'px-4')}>
        <BusinessOsMark className="size-8 shrink-0" />
        {compact ? null : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-semibold text-fg">Business OS</p>
            <p className="truncate text-caption text-fg-subtle">Powered by Pixakova</p>
          </div>
        )}
        {inDrawer ? (
          <button ref={closeRef} type="button" aria-label="Close navigation" onClick={onClose} className="focus-ring state-interactive flex size-11 items-center justify-center rounded-control text-fg-muted hover:text-fg">
            <Icon name="close" />
          </button>
        ) : null}
      </div>
      <div className={cn('shrink-0 pb-3', compact ? 'px-2' : 'px-3')}>
        <BusinessSwitcher {...props} variant={compact ? 'rail' : 'panel'} />
      </div>
      <ZoneNav {...props} />
      {onToggle ? (
        <div className={cn('shrink-0 border-t border-line p-2', compact ? 'flex justify-center' : 'px-3')}>
          <button type="button" onClick={onToggle} aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'} title={compact ? 'Expand sidebar' : 'Collapse sidebar'} className={cn('focus-ring state-interactive flex h-10 items-center gap-3 rounded-control px-3 text-small text-fg-muted hover:text-fg', compact ? 'w-10 justify-center px-0' : 'w-full')}>
            <Icon name={compact ? 'expand' : 'collapse'} className="size-5 shrink-0" />
            {compact ? null : <span>Collapse</span>}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ZoneNav({ navigation, mode, pageZone, route, guarded, onNavigate, onAfterNavigate, switching }: NavProps) {
  const compact = mode === 'compact';
  const go = (next: ShellRoute) => {
    guarded(() => {
      onAfterNavigate();
      onNavigate(next);
    });
  };
  const state = switching ? 'loading' : navigation.state;
  return (
    <nav aria-label="Zones" className={cn('min-h-0 flex-1 overflow-y-auto pb-4', compact ? 'px-2' : 'px-3')}>
      <ul className="space-y-0.5">
        <li><NavItem icon="home" label="Home" active={pageZone === 'home'} compact={compact} onClick={() => go(HOME)} /></li>
      </ul>
      {compact ? <div aria-hidden="true" className="mx-2 my-3 h-px bg-line" /> : <p className="px-3 pt-5 pb-1.5 text-caption font-medium text-fg-subtle">Zones</p>}
      {state === 'loading' ? (
        <div role="status" aria-label="Loading your Zones" className="space-y-2 px-1">
          {[0, 1, 2].map((i) => <Skeleton key={i} className={cn('h-9 rounded-control', compact ? 'mx-auto w-9' : 'w-full')} />)}
        </div>
      ) : state === 'failed' ? (
        <p role="alert" className={cn('text-caption text-fg-muted', compact ? 'sr-only' : 'px-3')}>Your Zones could not be loaded.</p>
      ) : navigation.available.length === 0 ? (
        <p className={cn('text-caption text-fg-muted', compact ? 'sr-only' : 'px-3')}>No Zones are open to your role in this business.</p>
      ) : (
        <ul className="space-y-0.5">
          {navigation.available.map((zone) => {
            const open = pageZone === zone.id;
            const onChild = open && route.zone !== 'home' && !!route.child;
            return (
              <li key={zone.id}>
                <NavItem icon={zone.icon} label={zone.name} badge={zone.status?.label} active={open && !onChild} inZone={onChild} compact={compact} onClick={() => go({ zone: zone.id })} />
                {!compact && open && zone.children?.length ? (
                  <ul className="mt-0.5 mb-1.5 space-y-px">
                    {zone.children.map((child) => (
                      <li key={child.id}>
                        <NavItem label={child.label} active={route.zone === zone.id && route.child === child.id} compact={false} child onClick={() => go({ zone: zone.id, child: child.id })} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

/**
 * One rail row. Current page: selected background, `aria-current="page"` and, for a Zone, a 4 x 16 px
 * accent bar on the inner edge. A Zone whose child page is open keeps the bar (no background), so the
 * current Zone stays visible while the child holds `aria-current`. Children show a 6 px square marker
 * in the icon column: hollow, or filled with the accent when current.
 */
function NavItem({ icon, label, badge, active, inZone, compact, child, onClick }: { icon?: IconName; label: string; badge?: string; active: boolean; inZone?: boolean; compact: boolean; child?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={compact ? label : undefined}
      className={cn(
        'focus-ring group relative flex w-full items-center gap-3 rounded-control transition-colors duration-fast motion-reduce:transition-none',
        child ? 'min-h-8 px-3 py-1.5 text-small' : 'min-h-10 py-2 text-body font-medium',
        !child && (compact ? 'justify-center px-0' : 'px-3'),
        active ? cn('state-selected text-fg', child && 'font-semibold') : inZone ? 'state-interactive text-fg' : 'state-interactive text-fg-muted hover:text-fg',
      )}
    >
      {!child && (active || inZone) ? <span aria-hidden="true" className="absolute top-1/2 left-0 h-4 w-1 -translate-y-1/2 bg-fg-accent forced-colors:bg-[CanvasText]" /> : null}
      {icon ? <Icon name={icon} className="size-5 shrink-0" /> : null}
      {child ? (
        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
          <span className={cn('size-1.5 rounded-[1.5px] border', active ? 'border-fg-accent bg-fg-accent forced-colors:bg-[CanvasText]' : 'border-fg-subtle')} />
        </span>
      ) : null}
      <span className={cn('truncate', compact && 'sr-only')}>{label}</span>
      {badge && !compact ? <span className="ml-auto rounded-[4px] bg-muted px-1.5 py-0.5 text-[11px] leading-4 font-semibold text-fg-muted">{badge}</span> : null}
    </button>
  );
}

function BusinessSwitcher({ business, businesses, switching, guarded, onSelectBusiness, onChooseBusiness, onCreateBusiness, onAfterNavigate, variant }: NavProps & { variant: 'panel' | 'rail' | 'bar' }) {
  const shown = switching ?? business;
  const inRail = variant !== 'bar';
  if (switching) {
    return (
      <div role="status" className={cn('flex min-h-11 min-w-0 items-center gap-3 text-sm', inRail ? 'rounded-control' : 'rounded-xl', variant === 'panel' && 'border border-line bg-surface px-2.5 py-2', variant === 'rail' && 'justify-center')}>
        <span aria-hidden="true" className={cn('flex size-8 shrink-0 animate-pulse items-center justify-center bg-muted text-xs font-bold motion-reduce:animate-none', inRail ? 'rounded-[6px]' : 'rounded-lg')}>{initials(shown.name)}</span>
        <span className={cn('min-w-0 truncate text-muted-foreground', variant === 'rail' && 'sr-only')}>Switching to {shown.name}…</span>
      </div>
    );
  }
  const run = (action: () => void) => guarded(() => {
    onAfterNavigate();
    action();
  });
  const entries: MenuEntry[] = [];
  if (onSelectBusiness && businesses.length > 0) {
    entries.push({ kind: 'heading', id: 'h', label: 'Your businesses' });
    for (const b of businesses) {
      entries.push({
        kind: 'item', id: `b:${b.slug}`, label: b.name, hint: ROLE_LABEL[b.role], checked: b.slug === business.slug,
        onSelect: () => (b.slug === business.slug ? undefined : run(() => onSelectBusiness(b.slug))),
      });
    }
    entries.push({ kind: 'separator', id: 's' });
  }
  entries.push({ kind: 'item', id: 'all', label: 'All businesses…', icon: <Icon name="swap" className="size-4" />, onSelect: () => run(onChooseBusiness) });
  if (onCreateBusiness) entries.push({ kind: 'item', id: 'new', label: 'Create another business', icon: <Icon name="plus" className="size-4" />, onSelect: () => run(onCreateBusiness) });

  const role = business.role ? ROLE_LABEL[business.role] : null;
  const badge = <span aria-hidden="true" className={cn('flex size-8 shrink-0 items-center justify-center bg-primary text-xs font-bold text-primary-foreground', inRail ? 'rounded-[6px]' : 'rounded-lg')}>{initials(business.name)}</span>;
  return (
    <Menu
      label={`Switch business, current business ${business.name}`}
      menuLabel="Businesses"
      placement={variant === 'rail' ? 'right-start' : 'bottom-start'}
      className={variant === 'bar' ? 'min-w-0' : undefined}
      triggerClassName={cn(
        'flex min-h-11 w-full min-w-0 items-center gap-3 text-left text-sm',
        inRail ? 'focus-ring rounded-control' : cn('rounded-xl hover:bg-accent', focusRing),
        variant === 'panel' && 'border border-line bg-surface px-2.5 py-2 hover:border-line-strong hover:bg-raised',
        variant === 'rail' && 'state-interactive justify-center p-1.5',
        variant === 'bar' && 'max-w-[55vw] px-2 py-1',
      )}
      trigger={
        <>
          {badge}
          {variant === 'rail' ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{business.name}</span>
                {variant === 'panel' && role ? <span className="block truncate text-xs text-muted-foreground">{role}</span> : null}
              </span>
              <Icon name="chevronDown" className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </>
      }
      entries={entries}
    />
  );
}

function Breadcrumbs({ route, navigation, pageZone, guarded, onNavigate, pageLabel }: NavProps & { pageLabel: string }) {
  const zone = route.zone === 'home' ? null : navigation.available.find((z) => z.id === route.zone);
  const child = zone && route.zone !== 'home' && route.child ? zone.children?.find((c) => c.id === route.child) : undefined;
  const crumb = 'rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground';
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {pageZone === 'home' ? (
          <li><span aria-current="page" className="px-1.5 font-semibold">Home</span></li>
        ) : (
          <>
            <li className="shrink-0"><button type="button" className={cn(crumb, focusRing)} onClick={() => guarded(() => onNavigate(HOME))}>Home</button></li>
            <li aria-hidden="true" className="text-muted-foreground/60"><Icon name="chevronRight" className="size-3.5" /></li>
            {child && zone ? (
              <>
                <li className="min-w-0 truncate"><button type="button" className={cn(crumb, focusRing)} onClick={() => guarded(() => onNavigate({ zone: zone.id }))}>{zone.name}</button></li>
                <li aria-hidden="true" className="text-muted-foreground/60"><Icon name="chevronRight" className="size-3.5" /></li>
                <li className="min-w-0 truncate"><span aria-current="page" className="px-1.5 font-semibold">{child.label}</span></li>
              </>
            ) : (
              <li className="min-w-0 truncate"><span aria-current="page" className="px-1.5 font-semibold">{pageLabel}</span></li>
            )}
          </>
        )}
      </ol>
    </nav>
  );
}

function SecondaryNav({ zone, route, guarded, onNavigate }: NavProps & { zone: ResolvedZone }) {
  const current = route.zone === zone.id ? route.child : undefined;
  return (
    <nav aria-label={`${zone.name} sections`} className="shrink-0 overflow-x-auto border-b bg-background/50 px-3 sm:px-6">
      <ul className="flex gap-1">
        {zone.children!.map((child, index) => {
          const active = current === child.id || (!current && index === 0);
          return (
            <li key={child.id}>
              <button type="button" aria-current={active ? 'page' : undefined} onClick={() => guarded(() => onNavigate({ zone: zone.id, child: child.id }))}
                className={cn('relative min-h-11 px-3 text-sm font-medium whitespace-nowrap', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground', focusRing)}>
                {child.label}
                {active ? <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ring" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** An entry point for a feature with no backend yet: visibly unavailable, focusable, and explained. */
function Unavailable({ icon, label, compact }: { icon: IconName; label: string; compact: boolean }) {
  return (
    <button
      type="button"
      aria-disabled="true"
      aria-label={`${label} (not available yet)`}
      title={`${label} is not available yet`}
      onClick={(e) => e.preventDefault()}
      className={cn('flex h-10 items-center gap-2 rounded-lg text-sm text-muted-foreground opacity-70', compact ? 'w-10 justify-center' : 'w-56 border bg-background/40 px-3', 'cursor-not-allowed', focusRing)}
    >
      <Icon name={icon} className="size-[18px] shrink-0" />
      {compact ? null : (
        <>
          <span className="flex-1 text-left">{label}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold">Soon</span>
        </>
      )}
    </button>
  );
}

const THEMES: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

function AccountMenu({ user, guarded, onSignOut, showName }: NavProps & { showName: boolean }) {
  const [theme, setTheme] = useThemePreference();
  const name = user.name || user.email;
  const entries: MenuEntry[] = [
    { kind: 'heading', id: 'who', label: <span className="block truncate normal-case tracking-normal">{user.name ? `${user.name} · ${user.email}` : user.email}</span> },
    { kind: 'separator', id: 's0' },
    { kind: 'heading', id: 'theme', label: 'Theme' },
    ...THEMES.map((t): MenuEntry => ({ kind: 'item', id: `theme:${t.value}`, label: t.label, icon: <Icon name={t.icon} className="size-4" />, checked: theme === t.value, onSelect: () => setTheme(t.value) })),
    { kind: 'separator', id: 's1' },
    { kind: 'item', id: 'sign-out', label: 'Sign out', icon: <Icon name="signOut" className="size-4" />, onSelect: () => guarded(onSignOut) },
  ];
  return (
    <Menu
      label={`Account menu for ${name}`}
      menuLabel="Account"
      placement="bottom-end"
      triggerClassName={cn('flex h-10 items-center gap-2 rounded-lg px-1 text-sm hover:bg-accent', showName && 'pr-3', focusRing)}
      trigger={
        <>
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">{initials(name)}</span>
          {showName ? <span className="max-w-40 truncate font-medium">{name}</span> : null}
        </>
      }
      entries={entries}
    />
  );
}

function NoticeBanner({ notice, onDismiss }: { notice: ShellNotice; onDismiss?: () => void }) {
  const title = notice.kind === 'switch-failed' ? `Couldn't open ${notice.business}` : `You no longer have access to ${notice.business}`;
  const body = notice.kind === 'switch-failed'
    ? `Business OS didn't respond. You're still in ${notice.current}; try switching again in a moment.`
    : `The server no longer lists you as a member of ${notice.business}. You're in ${notice.current}.`;
  return (
    <Alert tone="warning" className="mb-6 flex items-start justify-between gap-4">
      <div>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{body}</AlertDescription>
      </div>
      {onDismiss ? <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button> : null}
    </Alert>
  );
}

/** Narrow screens: the sidebar as a modal drawer with focus trap, Escape and backdrop dismissal, scroll lock and focus restore. */
function Drawer(props: NavProps & { onClose: () => void }) {
  const { onClose } = props;
  const { ref, onKeyDown } = useDialog(true, onClose, { trap: true });
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, []);
  return (
    <div className="fixed inset-0 z-30">
      <div aria-hidden="true" className="absolute inset-0 bg-overlay" onClick={onClose} data-testid="drawer-backdrop" />
      <div ref={ref} id="bos-drawer" role="dialog" aria-modal="true" aria-label="Navigation" onKeyDown={onKeyDown} className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] border-r shadow-card">
        <Sidebar {...props} mode="expanded" inDrawer onClose={onClose} closeRef={closeRef} />
      </div>
    </div>
  );
}
