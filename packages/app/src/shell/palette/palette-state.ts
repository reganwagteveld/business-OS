import type { SearchType } from '@business-os/contracts';
import type { SearchGroupView, SearchRow, SearchView } from '../../api/search';
import { TYPE_ORDER } from './labels';

/** Pure state machine for the palette's record search (GS2 §4.4): unit-tested without the DOM. */

export const MIN_QUERY = 2;
export const INITIAL_ROWS = 5;
export const PAGE_LIMIT = 25;
/** "Show more" stops after this many loaded rows (GS2 §5.7 rule 9, matches GS1's depth). */
export const MAX_ROWS = 100;

export type PaletteError = 'offline' | 'busy' | 'failed';

export interface GroupState {
  type: SearchType;
  rows: SearchRow[];
  hasMore: boolean;
  nextCursor: string | null;
  /** True once the first expanded page replaced the initial five rows. */
  expanded: boolean;
  paging: 'idle' | 'loading' | 'error';
  capped: boolean;
  /** Rows added by the last settled page, for the live region. */
  lastAdded: number;
}

export interface PaletteState {
  query: string;
  includeArchived: boolean;
  phase: 'idle' | 'loading' | 'results' | 'empty' | 'error';
  error: PaletteError | null;
  searchedTypes: SearchType[];
  groups: GroupState[];
  /** Bumped by every change that makes earlier responses and cursors stale (query, archived, retry). */
  seq: number;
}

export type PaletteAction =
  | { type: 'input'; query: string }
  | { type: 'archived'; value: boolean }
  | { type: 'retry' }
  | { type: 'searched'; seq: number; view: SearchView }
  | { type: 'searchFailed'; seq: number; error: PaletteError }
  | { type: 'pageStart'; seq: number; group: SearchType }
  | { type: 'pageDone'; seq: number; group: SearchType; page: SearchGroupView | null; replace: boolean }
  | { type: 'pageFailed'; seq: number; group: SearchType; resetCursor: boolean };

export const initialPaletteState: PaletteState = { query: '', includeArchived: false, phase: 'idle', error: null, searchedTypes: [], groups: [], seq: 0 };

export function queryReady(query: string): boolean {
  return [...query.normalize('NFC').trim()].length >= MIN_QUERY;
}

const key = (r: SearchRow) => `${r.type}:${r.id}`;

function cap(rows: SearchRow[]): SearchRow[] {
  return rows.slice(0, MAX_ROWS);
}

function fresh(g: SearchGroupView): GroupState {
  return { type: g.type, rows: g.rows, hasMore: g.hasMore, nextCursor: null, expanded: false, paging: 'idle', capped: false, lastAdded: 0 };
}

export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState {
  switch (action.type) {
    case 'input': {
      if (action.query === state.query) return state;
      // Any change to the text discards groups, cursors and expanded state (§5.7 rule 5).
      const ready = queryReady(action.query);
      // Old rows never stay on screen for a different text or scope: they could be selected while not matching it.
      return { ...state, query: action.query, seq: state.seq + 1, phase: ready ? 'loading' : 'idle', error: null, groups: [], searchedTypes: [] };
    }
    case 'archived':
      if (action.value === state.includeArchived) return state;
      return { ...state, includeArchived: action.value, seq: state.seq + 1, phase: queryReady(state.query) ? 'loading' : 'idle', error: null, groups: [], searchedTypes: [] };
    case 'retry':
      return queryReady(state.query) ? { ...state, seq: state.seq + 1, phase: 'loading', error: null, groups: [], searchedTypes: [] } : state;
    case 'searched': {
      if (action.seq !== state.seq) return state;
      const groups = [...action.view.groups].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).map(fresh);
      return { ...state, phase: groups.length ? 'results' : 'empty', error: null, searchedTypes: action.view.searchedTypes, groups };
    }
    case 'searchFailed':
      if (action.seq !== state.seq) return state;
      // The feature is never hidden (§12.1); there are no rows to keep, they were cleared when the request started.
      return { ...state, phase: 'error', error: action.error };
    case 'pageStart':
      if (action.seq !== state.seq) return state;
      return { ...state, groups: state.groups.map((g) => (g.type === action.group && g.paging !== 'loading' ? { ...g, paging: 'loading' } : g)) };
    case 'pageDone': {
      if (action.seq !== state.seq) return state;
      return {
        ...state,
        groups: state.groups.map((g) => {
          if (g.type !== action.group) return g;
          const incoming = action.page?.rows ?? [];
          let rows: SearchRow[];
          if (action.replace) rows = cap(incoming);
          else {
            const seen = new Set(g.rows.map(key));
            rows = cap([...g.rows, ...incoming.filter((r) => !seen.has(key(r)))]);
          }
          const added = action.replace ? rows.length : rows.length - g.rows.length;
          const capped = rows.length >= MAX_ROWS;
          // A page with nothing new ends the group, which guards against a cursor loop (§5.7 rule 7).
          const more = !!action.page?.hasMore && !!action.page.nextCursor && !capped && (action.replace || added > 0);
          return { ...g, rows, expanded: true, hasMore: more, nextCursor: more ? action.page!.nextCursor : null, paging: 'idle', capped, lastAdded: added };
        }),
      };
    }
    case 'pageFailed':
      if (action.seq !== state.seq) return state;
      // A 400 (an unusable cursor) offers "Show more" again from step 1, never loops (§5.7 rule 8).
      return { ...state, groups: state.groups.map((g) => (g.type === action.group ? { ...g, paging: 'error', ...(action.resetCursor ? { nextCursor: null, expanded: false } : {}) } : g)) };
  }
}
