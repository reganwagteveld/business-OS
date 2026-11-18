// Variables set by scripts/run.mjs. A missing one means the suite was started directly instead of through
// `pnpm --filter @business-os/e2e e2e`, which would leave it without a disposable database and server.
function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run the suite with: pnpm --filter @business-os/e2e e2e`);
  return value;
}

export const env = {
  apiUrl: need('E2E_API_URL'),
  /** Superuser on the disposable database. Used for fixtures and assertions only, never by the API. */
  adminDbUrl: need('E2E_ADMIN_DB_URL'),
  /** The application role the API itself runs as (RLS applies). */
  appDbUrl: need('E2E_APP_DB_URL'),
  dbName: need('E2E_DB_NAME'),
};
