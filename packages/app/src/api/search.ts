import { endpointPath, endpoints, SearchResponse, SearchResolveResponse, type SearchBadge, type SearchRequest, type SearchResolveRequest, type SearchRoute, type SearchType } from '@business-os/contracts';
import type { AuthTransport } from './auth';
import { createRequester } from './http';
import { classify, type Outcome } from './tenancy';

/**
 * The only six fields of a search result the client keeps (GS2 §4.5). The parsed response is copied into
 * this view model so a server regression that adds a field cannot reach the DOM, state or recents.
 */
export interface SearchRow {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string | null;
  badges: SearchBadge[];
  route: SearchRoute;
}

export interface SearchGroupView {
  type: SearchType;
  rows: SearchRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SearchView {
  searchedTypes: SearchType[];
  groups: SearchGroupView[];
}

export type SearchOutcome<T> = Outcome<T> | { kind: 'busy' };

export interface SearchClient {
  /** POST /search. The text travels in the body, never the URL. `types` + `cursor` pages one group. */
  search(slug: string, input: Pick<SearchRequest, 'q' | 'types' | 'includeArchived' | 'cursor' | 'limit'>, signal?: AbortSignal): Promise<SearchOutcome<SearchView>>;
  /** POST /search/resolve: re-authorises remembered records; anything not readable any more is left out. */
  resolve(slug: string, items: SearchResolveRequest['items'], signal?: AbortSignal): Promise<SearchOutcome<SearchRow[]>>;
}

/** Copies only the six allow-listed fields. */
function toRow(r: { type: SearchType; id: string; title: string; subtitle: string | null; badges: SearchBadge[]; route: SearchRoute }): SearchRow {
  return { type: r.type, id: r.id, title: r.title, subtitle: r.subtitle, badges: [...r.badges], route: { zone: r.route.zone, ...(r.route.child ? { child: r.route.child } : {}), target: r.route.target } };
}

/**
 * Typed search calls over the shared transport. GS2 §12.1: the client NEVER probes the endpoint to find
 * out whether search is on; callers only reach this module when `RECORD_SEARCH_ENABLED` is true.
 * Every failure here is a temporary error, never a signal to hide the feature.
 */
export function createSearchClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): SearchClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  return {
    async search(slug, input, signal) {
      // The request is checked against the contract first, so a stray field is rejected before it is sent.
      const body = endpoints.search.request.safeParse(input);
      if (!body.success) return { kind: 'invalid_input', message: 'Check the search text.' };
      const raw = await http.request('POST', endpointPath(endpoints.search.path, { slug }), body.data, signal);
      if (raw.kind === 'network') return { kind: 'unreachable' };
      // 429/503 search_busy and 503 search_timeout are temporary (GS1 §5.5, D-GS1-15): shown as "busy", never cached.
      if (raw.status === 429 || raw.status === 503) return { kind: 'busy' };
      const bad = classify(raw.status, raw.json);
      if (bad) return bad;
      const parsed = SearchResponse.safeParse(raw.json);
      if (!parsed.success) return { kind: 'invalid' };
      return {
        kind: 'ok',
        data: {
          searchedTypes: [...parsed.data.searchedTypes],
          groups: parsed.data.groups.map((g) => ({ type: g.type, rows: g.items.map(toRow), hasMore: g.hasMore, nextCursor: g.nextCursor })),
        },
      };
    },
    async resolve(slug, items, signal) {
      const body = endpoints.resolveSearchRecords.request.safeParse({ items });
      if (!body.success) return { kind: 'invalid_input', message: 'Nothing to open.' };
      const raw = await http.request('POST', endpointPath(endpoints.resolveSearchRecords.path, { slug }), body.data, signal);
      if (raw.kind === 'network') return { kind: 'unreachable' };
      const bad = classify(raw.status, raw.json);
      if (bad) return bad;
      const parsed = SearchResolveResponse.safeParse(raw.json);
      return parsed.success ? { kind: 'ok', data: parsed.data.items.map(toRow) } : { kind: 'invalid' };
    },
  };
}
