import { cn } from '@business-os/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SearchClient, SearchRow } from '../../api/search';
import { Icon } from '../icons';
import { canOpen, HOME, type ResolvedNavigation, type ShellRoute } from '../registry';
import { SearchPalette, type RecentRef } from './palette';

/** What the shell hands the search entry. Present only when the host wires a client (see AppShell). */
export interface ShellSearch {
  client: SearchClient;
  /** 401 / 403 from search: the same session-ended / membership refresh flow every Zone uses. */
  onSessionEnded: () => void;
}

const MAX_RECENTS = 8;
const EMPTY: RecentRef[] = [];
const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Editable targets keep their own Ctrl+K (GS2 §4.1), except the palette's own input. */
function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-search-palette]')) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * The top-bar search button and its shortcut. Business, role or session changes remount the palette (the
 * `key`), which drops every result, cursor and recent in the same render (GS2 §5.6).
 */
export function SearchEntry({ search, slug, navigation, route, guarded, onNavigate, compact }: {
  search: ShellSearch;
  slug: string;
  navigation: ResolvedNavigation;
  route: ShellRoute;
  guarded: (action: () => void) => void;
  onNavigate: (route: ShellRoute) => void;
  compact: boolean;
}) {
  const contextKey = `${slug}|${navigation.available.map((z) => z.id).join(',')}`;
  const [open, setOpen] = useState(false);
  // Recents and a remembered input belong to the context (and, for the input, the screen) they were made in;
  // anything from another one is ignored in the same render, so nothing stale can show (GS2 §5.6).
  const routeKey = JSON.stringify(route);
  const [recentState, setRecentState] = useState<{ key: string; items: RecentRef[] }>({ key: contextKey, items: [] });
  const [restoreState, setRestoreState] = useState<{ key: string; text: string }>({ key: '', text: '' });
  const recents = recentState.key === contextKey ? recentState.items : EMPTY;
  const restore = restoreState.key === `${contextKey}|${routeKey}` ? restoreState.text : '';
  const mac = useMemo(() => isMacPlatform(), []);
  const hint = mac ? '⌘K' : 'Ctrl K';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return;
      if (e.defaultPrevented) return;
      if (inEditable(e.target)) return;
      // Another modal (a Zone dialog, the unsaved-changes prompt) owns the keyboard.
      if (!open && document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"]')) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onAccessLost = useCallback(() => {
    setOpen(false);
    setRecentState({ key: contextKey, items: [] });
    search.onSessionEnded();
  }, [search, contextKey]);

  const go = (target: ShellRoute) => {
    const safe = canOpen(target, navigation) ? target : HOME;
    guarded(() => onNavigate(safe));
  };

  return (
    <>
      <button
        type="button"
        aria-label={`Search or jump to (${hint})`}
        aria-haspopup="dialog"
        title={`Search or jump to (${hint})`}
        onClick={() => setOpen(true)}
        className={cn('flex h-10 items-center gap-2 rounded-lg text-sm text-muted-foreground hover:bg-accent', compact ? 'w-10 justify-center' : 'w-56 border bg-background/40 px-3', focusRing)}
      >
        <Icon name="search" className="size-[18px] shrink-0" />
        {compact ? null : (
          <>
            <span className="flex-1 text-left">Search or jump to…</span>
            <kbd className="rounded-sm border px-1.5 py-0.5 text-caption">{hint}</kbd>
          </>
        )}
      </button>
      <SearchPalette
        key={contextKey}
        open={open}
        onOpenChange={setOpen}
        client={search.client}
        slug={slug}
        navigation={navigation}
        recents={recents}
        initialQuery={restore}
        onAccessLost={onAccessLost}
        onOpenRoute={go}
        onOpenRecord={(row: SearchRow, query: string) => {
          setRecentState({ key: contextKey, items: [{ type: row.type, id: row.id }, ...recents.filter((r) => !(r.type === row.type && r.id === row.id))].slice(0, MAX_RECENTS) });
          setOpen(false);
          // If the unsaved-changes guard is cancelled, the next open starts from the same text (D-GS2-12).
          setRestoreState({ key: `${contextKey}|${routeKey}`, text: query });
          go({ zone: row.route.zone, ...(row.route.child ? { child: row.route.child } : {}), target: row.route.target });
        }}
      />
    </>
  );
}
