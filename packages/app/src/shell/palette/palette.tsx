import { cn, Dialog, DialogContent, DialogDescription, DialogTitle } from '@business-os/ui';
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import type { SearchType } from '@business-os/contracts';
import type { SearchClient, SearchOutcome, SearchRow } from '../../api/search';
import { Icon, type IconName } from '../icons';
import { HOME, type ResolvedNavigation, type ShellRoute } from '../registry';
import { badgeLabels, TYPE_HEADING, TYPE_NOUN, TYPE_ORDER, ZONE_OF } from './labels';
import { highlight } from './highlight';
import { INITIAL_ROWS, initialPaletteState, PAGE_LIMIT, paletteReducer, queryReady, type GroupState, type PaletteError } from './palette-state';

/**
 * The global search palette (docs/global-search-gs2.md). Rendered only while open, so a closed palette
 * holds no state and makes no request. Every result row is drawn from the six allow-listed fields by
 * one explicit renderer; there is no generic key/value path (GS2 §4.5).
 */

const DEBOUNCE_MS = 150;
const BUSY_RETRY_MS = 1000;
const COMMAND_CAP = 5;

const ERROR_COPY: Record<PaletteError, string> = {
  offline: "You're offline. Commands still work; record search needs a connection.",
  busy: 'Search is busy. Try again.',
  failed: "Search didn't finish. Try again.",
};

const ZONE_ICON: Record<string, IconName> = { customers: 'customers', sales: 'sales', projects: 'projects', finance: 'finance', people: 'people' };

export interface RecentRef { type: SearchType; id: string }

export interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: SearchClient;
  slug: string;
  navigation: ResolvedNavigation;
  /** Called with the chosen route; the shell runs it through its unsaved-changes guard. */
  onOpenRoute: (route: ShellRoute) => void;
  onOpenRecord: (row: SearchRow, query: string) => void;
  /** 401 / 403: the session or membership changed. Results and recents are dropped by the caller. */
  onAccessLost: () => void;
  recents: readonly RecentRef[];
  /** Text to start with (the person cancelled a guarded navigation, GS2 D-GS2-12). */
  initialQuery?: string;
}

export function SearchPalette(props: SearchPaletteProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-search-palette=""
        className="top-[10dvh] max-h-[70dvh] w-full max-w-[640px] -translate-y-0 gap-0 overflow-hidden p-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none"
      >
        <PaletteBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

type Option =
  | { kind: 'command'; key: string; label: string; icon: IconName; route: ShellRoute }
  | { kind: 'row'; key: string; row: SearchRow }
  | { kind: 'more'; key: string; group: GroupState };

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const rowKey = (r: { type: string; id: string }) => `row-${r.type}-${r.id}`;
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function PaletteBody({ client, slug, navigation, onOpenRoute, onOpenRecord, onAccessLost, onOpenChange, recents, initialQuery = '' }: SearchPaletteProps) {
  const [state, dispatch] = useReducer(paletteReducer, initialQuery, (q) => (q ? paletteReducer(initialPaletteState, { type: 'input', query: q }) : initialPaletteState));
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [recentRows, setRecentRows] = useState<SearchRow[]>([]);
  const [slowSeq, setSlowSeq] = useState(-1);
  const [pageNote, setPageNote] = useState<{ seq: number; text: string } | null>(null);
  const ids = useId();
  const listId = `${ids}-list`;
  const optionId = (k: string) => `${ids}-${k}`;
  const pageAbort = useRef(new AbortController());
  const latest = useRef({ state, slug, client });
  // Updated in an effect (before the effects below read it), never during render.
  useEffect(() => { latest.current = { state, slug, client }; });

  /** Searchable types: those whose Zone the person can open. The server decides again (GS1 §6). */
  const types = useMemo(() => {
    const zones = new Set<string>(navigation.available.map((z) => z.id));
    return TYPE_ORDER.filter((t) => zones.has(ZONE_OF[t]));
  }, [navigation]);
  const zoneName = useCallback((type: SearchType) => navigation.available.find((z) => z.id === ZONE_OF[type])?.name ?? '', [navigation]);

  const settle = useCallback(<T,>(out: SearchOutcome<T>): { ok: T } | { error: PaletteError } | { lost: true } => {
    if (out.kind === 'ok') return { ok: out.data };
    if (out.kind === 'unauthenticated' || out.kind === 'forbidden' || out.kind === 'unverified') return { lost: true };
    if (out.kind === 'unreachable') return { error: 'offline' };
    if (out.kind === 'busy') return { error: 'busy' };
    return { error: 'failed' };
  }, []);

  // One search per settled input: debounce, abort what it supersedes, one automatic retry when busy.
  useEffect(() => {
    const { state: s, slug: slugNow, client: c } = latest.current;
    if (!queryReady(s.query) || types.length === 0) return;
    const seq = s.seq;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return dispatch({ type: 'searchFailed', seq, error: 'offline' });
      const input = { q: s.query, types: [...types], limit: INITIAL_ROWS, includeArchived: s.includeArchived, cursor: null };
      let out = await c.search(slugNow, input, controller.signal);
      if (out.kind === 'busy' && !controller.signal.aborted) {
        await wait(BUSY_RETRY_MS, controller.signal);
        if (!controller.signal.aborted) out = await c.search(slugNow, input, controller.signal);
      }
      if (controller.signal.aborted) return;
      const r = settle(out);
      if ('lost' in r) return onAccessLost();
      if ('error' in r) return dispatch({ type: 'searchFailed', seq, error: r.error });
      dispatch({ type: 'searched', seq, view: r.ok });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
    // Re-run only when the request is made stale (`seq`), never per render.
  }, [state.seq, types, settle, onAccessLost]);

  // Anything that makes a page request stale also cancels it.
  useEffect(() => {
    const controller = new AbortController();
    pageAbort.current = controller;
    return () => controller.abort();
  }, [state.seq]);

  // Recents: re-authorised through resolve on every open; failure hides the section.
  useEffect(() => {
    if (recents.length === 0) return;
    const controller = new AbortController();
    void client.resolve(slug, recents.map((r) => ({ type: r.type, id: r.id })), controller.signal).then((out) => {
      if (controller.signal.aborted) return;
      if (out.kind === 'ok') setRecentRows(out.data);
      else if (out.kind === 'unauthenticated' || out.kind === 'forbidden') onAccessLost();
    });
    return () => controller.abort();
  }, [client, slug, recents, onAccessLost]);

  // A thin progress bar appears only if the response takes longer than 300 ms.
  useEffect(() => {
    if (state.phase !== 'loading') return;
    const t = setTimeout(() => setSlowSeq(state.seq), 300);
    return () => clearTimeout(t);
  }, [state.phase, state.seq]);
  const slow = state.phase === 'loading' && slowSeq === state.seq;

  // One polite announcement per settled update. Never the term, never a total across Zones.
  const announce = pageNote && pageNote.seq === state.seq ? pageNote.text
    : state.phase === 'results' ? `${state.groups.reduce((n, g) => n + g.rows.length, 0)} results in ${state.groups.length} ${state.groups.length === 1 ? 'group' : 'groups'}`
    : state.phase === 'empty' ? 'No results'
    : state.phase === 'error' ? (state.error === 'offline' ? "You're offline" : "Search didn't finish")
    : '';

  const loadMore = useCallback(async (group: GroupState) => {
    if (group.paging === 'loading' || group.capped) return;
    const { state: s, slug: slugNow, client: c } = latest.current;
    const seq = s.seq;
    const signal = pageAbort.current.signal;
    dispatch({ type: 'pageStart', seq, group: group.type });
    // First expanded page: no cursor, replaces the five rows. Later pages: the returned cursor, appended (§5.7).
    const replace = !group.expanded;
    const input = { q: s.query, types: [group.type], limit: PAGE_LIMIT, includeArchived: s.includeArchived, cursor: replace ? null : group.nextCursor };
    let out = await c.search(slugNow, input, signal);
    if (out.kind === 'busy' && !signal.aborted) {
      await wait(BUSY_RETRY_MS, signal);
      if (!signal.aborted) out = await c.search(slugNow, input, signal);
    }
    if (signal.aborted) return;
    const r = settle(out);
    if ('lost' in r) return onAccessLost();
    if ('error' in r) {
      setPageNote({ seq, text: "Couldn't load more" });
      return dispatch({ type: 'pageFailed', seq, group: group.type, resetCursor: false });
    }
    const page = r.ok.groups.find((g) => g.type === group.type) ?? null;
    dispatch({ type: 'pageDone', seq, group: group.type, page, replace });
    setPageNote({ seq, text: `Loaded ${page?.rows.length ?? 0} more ${TYPE_HEADING[group.type].toLowerCase()}` });
  }, [settle, onAccessLost]);

  const options = useMemo<Option[]>(() => {
    const ready = queryReady(state.query);
    const needle = fold(state.query.trim());
    const commands = [
      { kind: 'command' as const, key: 'cmd-home', label: 'Go to Home', icon: 'home' as IconName, route: HOME },
      ...navigation.available.map((z) => ({ kind: 'command' as const, key: `cmd-${z.id}`, label: `Go to ${z.name}`, icon: z.icon as IconName, route: { zone: z.id } as ShellRoute })),
    ].filter((c) => needle === '' || fold(c.label).includes(needle)).slice(0, needle === '' ? 8 : COMMAND_CAP);
    const out: Option[] = [];
    if (!ready) out.push(...recentRows.map((row): Option => ({ kind: 'row', key: rowKey(row), row })));
    out.push(...commands);
    if (ready) {
      for (const g of state.groups) {
        for (const row of g.rows) out.push({ kind: 'row', key: rowKey(row), row });
        if (g.hasMore || g.capped) out.push({ kind: 'more', key: `more-${g.type}`, group: g });
      }
    }
    return out;
  }, [state.query, state.groups, navigation, recentRows]);

  // The active row follows the record, not the position; if it disappears, the first option takes over.
  const active = options.find((o) => o.key === activeKey) ?? options[0] ?? null;
  const activate = (o: Option | null) => {
    if (!o) return;
    if (o.kind === 'command') { onOpenChange(false); onOpenRoute(o.route); }
    else if (o.kind === 'row') { onOpenRecord(o.row, state.query); }
    else void loadMore(o.group);
  };
  const move = (delta: number) => {
    if (options.length === 0) return;
    const at = active ? options.findIndex((o) => o.key === active.key) : -1;
    setActiveKey(options[Math.min(options.length - 1, Math.max(0, at + delta))]!.key);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActiveKey(options[0]?.key ?? null); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActiveKey(options[options.length - 1]?.key ?? null); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(active); }
  };
  useEffect(() => {
    if (!active) return;
    document.getElementById(optionId(active.key))?.scrollIntoView?.({ block: 'nearest' });
  });

  const ready = queryReady(state.query);
  const searchedZones = [...new Set(state.searchedTypes.map(zoneName).filter(Boolean))];
  const joined = searchedZones.length > 1 ? `${searchedZones.slice(0, -1).join(', ')} and ${searchedZones[searchedZones.length - 1]}` : searchedZones[0] ?? '';
  const stale = state.phase === 'loading' || state.phase === 'error';

  return (
    <div className="flex max-h-[70dvh] flex-col max-sm:h-dvh max-sm:max-h-none" onKeyDown={onKeyDown}>
      <DialogTitle className="sr-only">Search</DialogTitle>
      <DialogDescription className="sr-only">Jump to a page, or search records you can open.</DialogDescription>
      <div className="flex items-center gap-3 border-b px-4">
        <Icon name="search" className="size-[18px] shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active ? optionId(active.key) : undefined}
          aria-autocomplete="list"
          aria-label="Search or jump to"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          placeholder="Search or jump to…"
          value={state.query}
          onChange={(e) => dispatch({ type: 'input', query: e.target.value })}
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        <button type="button" aria-label="Close search" onClick={() => onOpenChange(false)} className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring sm:hidden">
          <Icon name="close" />
        </button>
        <kbd className="hidden rounded-sm border px-1.5 py-0.5 text-caption text-muted-foreground sm:block">esc</kbd>
      </div>
      <div className="h-0.5 shrink-0" aria-hidden="true">{slow ? <div className="h-full w-1/3 animate-pulse bg-primary motion-reduce:animate-none" /> : null}</div>

      <div id={listId} role="listbox" aria-label="Results" className={cn('min-h-0 flex-1 overflow-y-auto px-2 py-2', stale && state.groups.length > 0 && 'opacity-60')}>
        {!ready && recentRows.length > 0 ? (
          <Section heading="Recent" id={`${ids}-recent`}>
            {options.filter((o) => o.kind === 'row').map((o) => o.kind === 'row' && <ResultRow key={o.key} id={optionId(o.key)} row={o.row} query="" active={active?.key === o.key} onPick={() => activate(o)} />)}
          </Section>
        ) : null}
        {options.some((o) => o.kind === 'command') ? (
          <Section heading="Commands" id={`${ids}-commands`}>
            {options.map((o) => o.kind === 'command' && (
              <Item key={o.key} id={optionId(o.key)} active={active?.key === o.key} onPick={() => activate(o)}>
                <Icon name={o.icon} className="size-[18px] shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </Item>
            ))}
          </Section>
        ) : null}
        {ready ? state.groups.map((g) => (
          <Section key={g.type} heading={TYPE_HEADING[g.type]} id={`${ids}-g-${g.type}`}>
            {g.rows.map((row) => <ResultRow key={rowKey(row)} id={optionId(rowKey(row))} row={row} query={state.query} active={active?.key === rowKey(row)} onPick={() => activate({ kind: 'row', key: rowKey(row), row })} />)}
            {g.paging === 'error' ? <p className="px-3 py-2 text-sm text-muted-foreground">Couldn't load more. Try again.</p> : null}
            {g.capped ? <p className="px-3 py-2 text-sm text-muted-foreground">Refine your search to see more.</p> : g.hasMore ? (
              <button
                type="button"
                id={optionId(`more-${g.type}`)}
                aria-label={`Show more ${TYPE_HEADING[g.type].toLowerCase()}`}
                aria-disabled={g.paging === 'loading' || undefined}
                data-active={active?.key === `more-${g.type}` || undefined}
                onClick={() => void loadMore(g)}
                className="ml-auto flex min-h-11 items-center px-3 text-sm font-medium text-primary hover:underline data-[active]:bg-accent focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
              >
                {g.paging === 'loading' ? 'Loading…' : g.paging === 'error' ? 'Try again' : 'Show more'}
              </button>
            ) : null}
          </Section>
        )) : null}
        {ready && state.phase === 'empty' ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            {joined ? <>No records match “{state.query.trim()}” in {joined}.</> : <>No records match “{state.query.trim()}”.</>}
            {!state.includeArchived ? <> <button type="button" className="font-medium text-primary underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => dispatch({ type: 'archived', value: true })}>Include archived</button></> : null}
          </p>
        ) : null}
        {ready && state.phase === 'error' && state.error ? (
          <div className="flex items-center gap-3 px-3 py-4 text-sm text-muted-foreground" role="alert">
            <span className="flex-1">{ERROR_COPY[state.error]}</span>
            {state.error !== 'offline' ? <button type="button" className="font-medium text-primary underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => dispatch({ type: 'retry' })}>Try again</button> : null}
          </div>
        ) : null}
        {!ready && state.query.trim().length > 0 && options.length === 0 ? <p className="px-3 py-6 text-sm text-muted-foreground">Keep typing to search records.</p> : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-caption text-muted-foreground">
        {types.length > 0 ? (
          <label className="flex min-h-6 items-center gap-2">
            <input type="checkbox" checked={state.includeArchived} onChange={(e) => dispatch({ type: 'archived', value: e.target.checked })} />
            Include archived
          </label>
        ) : null}
        <span className="hidden sm:inline">↑↓ move · ↵ open · esc close</span>
        {joined ? <span className="ml-auto">Searched: {joined}</span> : null}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
    </div>
  );
}

function Section({ heading, id, children }: { heading: string; id: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="py-1">
      <h3 id={id} className="px-3 pb-1 text-caption font-semibold tracking-wide text-muted-foreground uppercase">{heading}</h3>
      {children}
    </div>
  );
}

function Item({ id, active, onPick, children }: { id: string; active: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      onClick={onPick}
      onMouseDown={(e) => e.preventDefault()}
      className="flex min-h-11 cursor-pointer items-center gap-3 border-l-2 border-transparent px-3 text-sm sm:min-h-9 data-[active]:border-primary data-[active]:bg-accent forced-colors:data-[active]:bg-[Highlight] forced-colors:data-[active]:text-[HighlightText]"
    >
      {children}
    </div>
  );
}

/** The single explicit renderer: icon for the type, title, subtitle and badge labels. Nothing else (GS2 §4.5 rule 1). */
function ResultRow({ id, row, query, active, onPick }: { id: string; row: SearchRow; query: string; active: boolean; onPick: () => void }) {
  const badges = badgeLabels(row.badges);
  const zone = ZONE_OF[row.type];
  return (
    <Item id={id} active={active} onPick={onPick}>
      <Icon name={ZONE_ICON[zone] ?? 'search'} className="size-[18px] shrink-0 text-muted-foreground" />
      <span className="sr-only">{TYPE_NOUN[row.type]}: </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {highlight(row.title, query).map((s, i) => (s.match ? <strong key={i} className="font-semibold">{s.text}</strong> : <span key={i}>{s.text}</span>))}
        </span>
        {row.subtitle ? <span className="block truncate text-caption text-muted-foreground">{row.subtitle}</span> : null}
      </span>
      {badges.map((b) => <span key={b} className="shrink-0 rounded-sm border px-1.5 py-0.5 text-caption text-muted-foreground">{b}</span>)}
    </Item>
  );
}
