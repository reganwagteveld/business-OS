import 'server-only';
// Global search kernel (docs/global-search-gs1.md §5.3, §6.2, §9). The provider contract and the SQL
// building blocks every Zone's provider uses, so each provider only declares its table, its reviewed
// match and result fields and its record rules. The search module (modules/search) combines providers;
// Zone modules own them. Nothing here reads a request: values are bound parameters, and `rawSql` is
// used only for constant identifiers and expressions written below or in a provider.
import type { SearchType, SearchZone } from '@business-os/contracts';
import { joinSql, rawSql, sql, type SqlFragment } from '@/core/db';

/** The explicit tenant predicate's right-hand side: the unit of work's own verified context (§6.1 layer 4). */
const TENANT = rawSql(`nullif(current_setting('app.business_id', true), '')::uuid`);

/**
 * Candidate cap for the word arm (§5.3). Caps rows, not the GIN work behind them. The arm has no ORDER BY
 * (a GIN index cannot supply one, and sorting every match would remove the bound), so when more than this
 * many records match by word, WHICH ones become candidates is unspecified: it follows the plan's scan order.
 */
export const WORD_ARM_CAP = 200;
/**
 * Cumulative per-type ceiling for single-type paging ("Show more"): at most this many results of one type
 * are reachable across all pages, whatever arms produced them. Each prefix arm also reads at most this many
 * rows (in its own index order) and the word arm at most WORD_ARM_CAP; the merged candidates are then ranked
 * in the result order and cut to this many BEFORE the cursor applies, so page boundaries are cut from one
 * fixed, ranked window and pages neither overlap nor skip within it while the data is unchanged.
 *
 * Search is bounded discovery, not exhaustive retrieval. The window is the best-ranked of the CANDIDATES,
 * not necessarily of every match: past the arm caps, matches may exist that search never reads, and with
 * more than WORD_ARM_CAP word matches the candidate subset is unspecified. Writes between pages can change
 * the window like any keyset list. `hasMore: false` only means nothing more is reachable; the Zone list
 * screens remain the exhaustive view (ChatGPT audit of PR #93, M3).
 */
export const SINGLE_TYPE_DEPTH = 125;

/** One request's normalised text (§9.1). `tsquery` is null when the word arm is disabled (< 3 chars, no tokens). */
export interface NormalizedQuery {
  q: string;
  tsquery: string | null;
}

/** Keyset position inside one type: (tier, demote, sort_key, id), ascending (§5.3). */
export interface SearchPosition {
  tier: number;
  demote: number;
  sortKey: string;
  id: string;
}

export type BranchInput = {
  /** Rows to return, including the extra row that decides hasMore. */
  take: number;
  includeArchived: boolean;
  /** Caller holds customers:read: a customer name may appear under another Zone's record (§6.3). */
  canReadCustomers: boolean;
  /**
   * Test seam for the isolation suite only (§6.6): drops the explicit tenant predicate so the test proves
   * forced RLS alone still returns nothing from another business. The search service never sets it.
   */
  withoutTenantPredicateForIsolationTests?: boolean;
} & (
  | {
      mode: 'text';
      query: NormalizedQuery;
      /** Rows each prefix arm reads. */
      prefixCap: number;
      /** Cumulative ceiling: only the first `depth` ranked candidates are reachable, before `after` applies. */
      depth: number;
      after: SearchPosition | null;
    }
  | { mode: 'ids'; ids: string[] }
);

/** A server-side search provider (§6.2). One per record type, in the module that owns the table. */
export interface SearchProvider<P extends string = string> {
  type: SearchType;
  zone: SearchZone;
  /** ALL must be held; the same key the Zone's own list checks (§6.3). */
  requires: readonly P[];
  /** Reviewed lists, pinned by a snapshot test (§6.4). */
  matchFields: readonly string[];
  resultFields: readonly string[];
  /** One parenthesised UNION ALL branch producing the uniform row shape (see `finalize`). */
  branch(input: BranchInput): SqlFragment;
}

/** An index the search migration creates, declared once so the migration test and the SQL agree (§5.3, §9.2). */
export interface SearchIndex {
  name: string;
  table: string;
  /** The exact `CREATE INDEX` statement in the migration. */
  statement: string;
}

export const prefixIndex = (table: string, column: string, name = `${table}_search_${column}_idx`): SearchIndex => ({
  name, table, statement: `CREATE INDEX "${name}" ON "${table}" ("business_id", (lower("${column}") COLLATE "C"), "id");`,
});
export const wordIndex = (table: string, expression: string, name = `${table}_search_words_idx`): SearchIndex => ({
  name, table, statement: `CREATE INDEX "${name}" ON "${table}" USING gin (to_tsvector('simple'::regconfig, ${expression}));`,
});

const tenantIs = (input: BranchInput, column: string) =>
  input.withoutTenantPredicateForIsolationTests ? sql`TRUE` : sql`${rawSql(column)} = ${TENANT}`;

/** A prefix arm: an exact match takes `exactTier`, any other prefix `prefixTier` (§9.3). */
export interface PrefixArm {
  /** Column of the provider's table (unqualified; the index is on lower(column) COLLATE "C"). */
  column: string;
  exactTier: number;
  prefixTier: number;
}

export interface TableSpec {
  /** Constant table name. */
  table: string;
  /** Constant column list the provider's projection needs (must include `id`). */
  columns: string;
  /** Constant predicate that is true for a record shown by default (e.g. not archived). */
  live: string;
  /** Optional constant predicate always applied (e.g. a document kind). */
  scope?: string;
  arms: PrefixArm[];
  /** Constant tsvector source expression, identical to the GIN index expression; omitted = no word arm. */
  words?: string;
}

/** Arms over one table (§5.3). Returns the CTE list that ends in `m`: one row per record at its best tier. */
export function candidates(spec: TableSpec, input: BranchInput, extraArms: SqlFragment[] = []): SqlFragment {
  const cols = rawSql(spec.columns);
  const table = rawSql(spec.table);
  const live = input.includeArchived ? sql`TRUE` : rawSql(`(${spec.live})`);
  const scope = spec.scope ? rawSql(`(${spec.scope})`) : sql`TRUE`;
  const base = sql`${tenantIs(input, 'business_id')} AND ${live} AND ${scope}`;
  const arms: SqlFragment[] = [];
  if (input.mode === 'ids') {
    arms.push(sql`SELECT ${cols}, 0 AS tier FROM ${table} WHERE ${base} AND id = ANY(${input.ids}::uuid[])`);
  } else {
    const { q, tsquery } = input.query;
    for (const arm of spec.arms) {
      const key = rawSql(`lower(${arm.column}) COLLATE "C"`);
      arms.push(sql`SELECT * FROM (SELECT ${cols}, CASE WHEN lower(${rawSql(arm.column)}) = lower(${q}) THEN ${arm.exactTier}::int ELSE ${arm.prefixTier}::int END AS tier
        FROM ${table}
        WHERE ${base}
          AND ${key} >= lower(${q}) COLLATE "C"
          AND ${key} < (lower(${q}) || chr(1114111)) COLLATE "C"
        ORDER BY ${key}, id
        LIMIT ${input.prefixCap}) a`);
    }
    if (spec.words && tsquery) {
      arms.push(sql`SELECT * FROM (SELECT ${cols}, 3 AS tier FROM ${table}
        WHERE ${base} AND to_tsvector('simple'::regconfig, ${rawSql(spec.words)}) @@ to_tsquery('simple'::regconfig, ${tsquery})
        LIMIT ${WORD_ARM_CAP}) w`);
    }
    arms.push(...extraArms);
  }
  return sql`m AS (SELECT DISTINCT ON (id) * FROM (${joinSql(arms.map((a) => sql`(${a})`), ' UNION ALL ')}) x ORDER BY id, tier)`;
}

/**
 * Wraps a provider's projection into its branch. The projection must select, in this order and type:
 * type text, id uuid, tier int, demote int, sort_key text, title text, subtitle text, badges text[], target text.
 * Ordering is fully deterministic (§5.3): tier, demote, sort key in byte order, id; the keyset cursor continues it.
 * In text mode the ranked candidates are first cut to `depth` (the cumulative per-type ceiling), then the
 * cursor and page size apply inside that window.
 */
export function finalize(ctes: SqlFragment, projection: SqlFragment, input: BranchInput): SqlFragment {
  const after = input.mode === 'text' && input.after
    ? sql`WHERE (r.tier, r.demote, r.sort_key COLLATE "C", r.id) > (${input.after.tier}::int, ${input.after.demote}::int, ${input.after.sortKey}::text COLLATE "C", ${input.after.id}::uuid)`
    : sql``;
  const source = input.mode === 'text'
    ? sql`(SELECT * FROM (${projection}) w ORDER BY w.tier, w.demote, w.sort_key COLLATE "C", w.id LIMIT ${input.depth})`
    : sql`(${projection})`;
  return sql`(WITH ${ctes}
    SELECT r.type, r.id::text AS id, r.tier, r.demote, r.sort_key, left(r.title, 200) AS title, left(r.subtitle, 160) AS subtitle, r.badges, r.target
    FROM ${source} r
    ${after}
    ORDER BY r.tier, r.demote, r.sort_key COLLATE "C", r.id
    LIMIT ${input.take})`;
}

/** The explicit tenant predicate for a related table joined in a projection (by its own primary key). */
export const tenantOf = (input: BranchInput, column: string) => tenantIs(input, column);

/** `a · b`, skipping empty parts; null when nothing is left. Subtitles are composed on the server only (GS2 §4.5 rule 5). */
export const joinParts = (...parts: string[]) => rawSql(`nullif(concat_ws(' · ', ${parts.map((p) => `nullif(${p}, '')`).join(', ')}), '')`);
