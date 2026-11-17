// Public API of the global search module (docs/global-search-gs1.md §6.2, §7). It combines the Zone
// modules' providers; it owns no tables.
export { resolveRecords, runSearch, BUSINESS_SLOTS, STATEMENT_TIMEOUT_MS, USER_SLOTS } from './server/service';
export type { SearchDeps, SearchInput } from './server/service';
export { SEARCH_API_ENABLED, searchApiEnabled } from './server/availability';
export { normalizeQuery, toTsquery } from './server/normalize';
export { decodeSearchCursor, encodeSearchCursor } from './server/cursor';
export { SEARCH_INDEXES, SEARCH_PROVIDERS } from './server/registry';
