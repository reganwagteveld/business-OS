import 'server-only';
// Global search service (docs/global-search-gs1.md §5, §6, §7). One request = one tenant unit of work
// (opened by the route with a 3 s transaction timeout and 1 s pool wait), and inside it, in order:
//   1. the transaction-local statement timeout (1 s) and the business id for cursor binding;
//   2. the concurrency slots (2 per user, 8 per business; non-blocking advisory try-locks, §6.9);
//   3. ONE statement: a UNION ALL of the permitted providers' branches (§5.3).
// The search text is never logged, audited or stored (§6.8). The only log line is term-free.
import {
  SEARCH_LIMITS, SearchBadge, type SearchGroup, type SearchResolveRequest, type SearchResolveResponse, type SearchResponse,
  type SearchResult, type SearchType,
} from '@business-os/contracts';
import { joinSql, sql, type AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, SearchBusyError, SearchTimeoutError, sqlState } from '@/core/http/errors';
import { SINGLE_TYPE_DEPTH, type BranchInput, type SearchPosition, type SearchProvider } from '@/core/search';
import { can, type Permission, type Principal } from '@/modules/access';
import { searchApiEnabled } from './availability';
import { decodeSearchCursor, encodeSearchCursor } from './cursor';
import { normalizeQuery } from './normalize';
import { SEARCH_PROVIDERS, TYPE_ORDER } from './registry';

/** Concurrency slots (D-GS1-15, provisional). */
export const USER_SLOTS = 2;
export const BUSINESS_SLOTS = 8;
/** Transaction-local statement timeout for the search statement (§5.5). */
export const STATEMENT_TIMEOUT_MS = 1000;

export interface SearchInput {
  q: string;
  types?: SearchType[];
  limit: number;
  includeArchived: boolean;
  cursor: string | null;
}

type Row = { type: SearchType; id: string; tier: number; demote: number; sort_key: string; title: string; subtitle: string | null; badges: string[]; target: string };

/** Test seams (integration suite only): a different provider list. */
export interface SearchDeps {
  providers?: readonly SearchProvider<Permission>[];
}

const BADGES = new Set<string>(SearchBadge.options);

function permitted(principal: Principal, providers: readonly SearchProvider<Permission>[], types?: readonly SearchType[]) {
  return providers.filter((p) => p.requires.every((key) => can(principal, key)) && (!types || types.includes(p.type)));
}

/** Byte order of UTF-8, the same as COLLATE "C" (§5.3). */
const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const compareRows = (a: Row, b: Row) => a.tier - b.tier || a.demote - b.demote || bytes(a.sort_key, b.sort_key) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function bucket(n: number, edges: number[]): string {
  const edge = edges.find((e) => n <= e);
  return edge === undefined ? `>${edges[edges.length - 1]}` : `<=${edge}`;
}

/** The only search log line: no term, no ids, no titles (§6.8, §6.9). */
function logOutcome(kind: 'search' | 'resolve', outcome: 'ok' | 'slot_refused' | 'timeout', startedAt: number, results = 0) {
  console.info('[search]', JSON.stringify({ kind, outcome, ms: bucket(Date.now() - startedAt, [25, 50, 100, 150, 250, 400, 1000]), results: bucket(results, [0, 5, 25, 50]) }));
}

/** Steps 1 and 2. Returns the business id (for cursor binding). */
async function prepare(db: AppTenantDb, kind: 'search' | 'resolve', startedAt: number): Promise<string> {
  const [settings] = await db.$queryRaw<{ timeout: string; business_id: string }[]>`
    SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}::text, true) AS timeout,
           current_setting('app.business_id', true) AS business_id`;
  if (!settings || (settings.timeout !== String(STATEMENT_TIMEOUT_MS) && settings.timeout !== `${STATEMENT_TIMEOUT_MS}ms` && settings.timeout !== '1s')) {
    throw new Error('search statement timeout was not applied');
  }
  const [slots] = await db.$queryRaw<{ user_slot: number | null; business_slot: number | null }[]>`
    SELECT
      (SELECT n FROM generate_series(0, ${USER_SLOTS - 1}::int) AS n
        WHERE pg_try_advisory_xact_lock(hashtextextended('search.user:' || current_setting('app.business_id', true) || ':' || current_setting('app.user_id', true) || ':' || n, 0))
        LIMIT 1) AS user_slot,
      (SELECT n FROM generate_series(0, ${BUSINESS_SLOTS - 1}::int) AS n
        WHERE pg_try_advisory_xact_lock(hashtextextended('search.business:' || current_setting('app.business_id', true) || ':' || n, 0))
        LIMIT 1) AS business_slot`;
  if (slots?.user_slot === null || slots?.user_slot === undefined || slots.business_slot === null) {
    logOutcome(kind, 'slot_refused', startedAt);
    throw new SearchBusyError('slot');
  }
  return settings.business_id;
}

/** Step 3: one statement. A statement timeout here, and only here, becomes 503 search_timeout (§5.5). */
async function runBranches(db: AppTenantDb, branches: ReturnType<SearchProvider['branch']>[], kind: 'search' | 'resolve', startedAt: number): Promise<Row[]> {
  try {
    return await db.$queryRaw<Row[]>(sql`${joinSql(branches, ' UNION ALL ')}`);
  } catch (error) {
    if (sqlState(error) === '57014') {
      logOutcome(kind, 'timeout', startedAt);
      throw new SearchTimeoutError();
    }
    throw error;
  }
}

function toResult(provider: SearchProvider<Permission>, row: Row): SearchResult {
  return {
    type: provider.type,
    id: row.id,
    title: row.title.slice(0, 200),
    subtitle: row.subtitle === null ? null : row.subtitle.slice(0, 160),
    badges: row.badges.filter((b): b is SearchBadge => BADGES.has(b)).slice(0, 4),
    route: { zone: provider.zone, target: row.target },
  };
}

export async function runSearch(db: AppTenantDb, principal: Principal, input: SearchInput, deps: SearchDeps = {}): Promise<SearchResponse> {
  if (!searchApiEnabled()) throw new RecordNotFoundError();
  const startedAt = Date.now();
  const query = normalizeQuery(input.q);
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), SEARCH_LIMITS.maxLimit);
  if (input.cursor !== null && input.types?.length !== 1) throw new RuleViolationError('invalid_cursor', 'This page position is not valid. Start again from the first page.');
  const providers = permitted(principal, deps.providers ?? SEARCH_PROVIDERS, input.types);
  const searchedTypes = providers.map((p) => p.type);
  if (providers.length === 0) return { searchedTypes, groups: [] };

  const businessId = await prepare(db, 'search', startedAt);
  // A single-type request reads a deeper, fixed candidate set so every page of "Show more" continues the same order (§7.2).
  const single = input.types?.length === 1;
  const binding = (type: SearchType) => ({ businessId, type, q: query.q, includeArchived: input.includeArchived });
  let after: SearchPosition | null = null;
  if (input.cursor !== null) {
    // Only reached for exactly one requested type; if the caller cannot read it, there is nothing to page.
    after = decodeSearchCursor(binding(input.types![0]!), input.cursor);
  }
  const canReadCustomers = can(principal, 'customers:read');
  const branchInput: BranchInput = {
    mode: 'text', query, take: limit + 1, includeArchived: input.includeArchived, canReadCustomers,
    prefixCap: single ? SINGLE_TYPE_DEPTH + 1 : limit + 1, after,
  };
  const rows = await runBranches(db, providers.map((p) => p.branch(branchInput)), 'search', startedAt);

  const groups: (SearchGroup & { best: number })[] = [];
  for (const provider of providers) {
    const own = rows.filter((r) => r.type === provider.type).sort(compareRows);
    if (own.length === 0) continue;
    const page = own.slice(0, limit);
    const hasMore = own.length > limit;
    const last = page[page.length - 1]!;
    groups.push({
      type: provider.type, zone: provider.zone, items: page.map((r) => toResult(provider, r)), hasMore,
      nextCursor: single && hasMore ? encodeSearchCursor(binding(provider.type), { tier: last.tier, demote: last.demote, sortKey: last.sort_key, id: last.id }) : null,
      best: Math.min(...page.map((r) => r.tier)),
    });
  }
  // §9.4: best tier present first, then the fixed Zone/type order. The context boost is client-side.
  groups.sort((a, b) => a.best - b.best || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  logOutcome('search', 'ok', startedAt, total);
  return { searchedTypes, groups: groups.map((g) => ({ type: g.type, zone: g.zone, items: g.items, hasMore: g.hasMore, nextCursor: g.nextCursor })) };
}

/** §7.3: re-authorises recent records. Items the caller can no longer see are silently left out. */
export async function resolveRecords(db: AppTenantDb, principal: Principal, input: SearchResolveRequest, deps: SearchDeps = {}): Promise<SearchResolveResponse> {
  if (!searchApiEnabled()) throw new RecordNotFoundError();
  const startedAt = Date.now();
  const providers = permitted(principal, deps.providers ?? SEARCH_PROVIDERS);
  const wanted = new Map<SearchType, string[]>();
  for (const item of input.items) {
    if (!providers.some((p) => p.type === item.type)) continue;
    wanted.set(item.type, [...(wanted.get(item.type) ?? []), item.id.toLowerCase()]);
  }
  if (wanted.size === 0) return { items: [] };
  await prepare(db, 'resolve', startedAt);
  const canReadCustomers = can(principal, 'customers:read');
  const branches = providers.filter((p) => wanted.has(p.type)).map((p) => p.branch({
    mode: 'ids', ids: wanted.get(p.type)!, take: wanted.get(p.type)!.length, includeArchived: false, canReadCustomers,
  }));
  const rows = await runBranches(db, branches, 'resolve', startedAt);
  const items: SearchResult[] = [];
  for (const item of input.items) {
    const row = rows.find((r) => r.type === item.type && r.id === item.id.toLowerCase());
    const provider = providers.find((p) => p.type === item.type);
    if (row && provider && !items.some((i) => i.type === row.type && i.id === row.id)) items.push(toResult(provider, row));
  }
  logOutcome('resolve', 'ok', startedAt, items.length);
  return { items };
}
