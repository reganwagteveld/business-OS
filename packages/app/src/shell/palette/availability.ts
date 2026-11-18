/**
 * Record search enablement (docs/global-search-gs2.md §12.1). One build-time constant, off by default.
 * It is never inferred from an API response, a probe or an error, and it is not an environment variable,
 * a database value or a feature flag. While false, the shell keeps the disabled "Soon" search button,
 * no search or resolve request is made, and no Records UI can run.
 *
 * Flipping it is its own reviewed PR and deploy, approved by Regan, and only after every gate in §12.1.
 */
export const RECORD_SEARCH_ENABLED = false;
