// Server-side enablement of the search routes (docs/global-search-gs1.md §12 GS1-A readiness gate;
// docs/global-search-gs2.md §12.1). A reviewed source constant, not an environment variable, database
// value or feature-flag service: while it is false, both search routes answer 404 not_found in every
// deployed environment, so merging GS1-A cannot turn search on. It is flipped only in a PR Regan approves
// after the readiness gate (benchmarks, index migration applied, logging checks L1-L5) has passed.
export const SEARCH_API_ENABLED = false;

/**
 * The test runner (NODE_ENV=test, never set on Vercel) may opt in with SEARCH_API_TEST_ENABLE=1 so the
 * routes can be exercised before they are enabled. Nothing else can turn them on.
 */
export function searchApiEnabled(): boolean {
  return SEARCH_API_ENABLED || (process.env.NODE_ENV === 'test' && process.env.SEARCH_API_TEST_ENABLE === '1');
}
