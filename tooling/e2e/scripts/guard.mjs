// Safety guards for the E2E harness. Pure functions so they can be self-tested (tests/guard.e2e.test.ts).
// The suite creates roles and databases, so it must only ever talk to a disposable local PostgreSQL.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Throws unless `url` is a postgres URL for a loopback host. Returns the parsed URL. */
export function assertLocalPostgres(url, label = 'database URL') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new Error(`${label} must be a postgresql:// URL`);
  // node-postgres lets `?host=`, `?hostaddr=`, `?port=` and similar options override the URL's authority, so a
  // loopback hostname proves nothing when a query string is present. No connection options are accepted at all.
  if (url.includes('?') || url.includes('#') || parsed.search !== '' || parsed.hash !== '') throw new Error(`${label} must not carry query options or a fragment (they can override the host the driver connects to)`);
  if (!LOOPBACK.has(parsed.hostname)) {
    throw new Error(`${label} points at "${parsed.hostname}". The E2E harness only runs against a loopback PostgreSQL (127.0.0.1 or localhost); it creates roles and databases.`);
  }
  return parsed;
}

/**
 * The explicit driver configuration for a validated URL. Every connection the harness opens uses this object
 * (never a connection string), so the host that was checked is the host that is used.
 */
export function pgConfig(url, label = 'database URL') {
  const parsed = assertLocalPostgres(url, label);
  return {
    host: parsed.hostname === '[::1]' ? '::1' : parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
}

/** Disposable database names are `e2e_` plus 16 hex characters, so a drop can never hit another database. */
export const DB_NAME = /^e2e_[0-9a-f]{16}$/;
export function assertDisposableName(name) {
  if (!DB_NAME.test(name)) throw new Error(`refusing to touch database "${name}": not an e2e_<16 hex> disposable name`);
  return name;
}

/** Variables that must never reach the API process or the tests (production and owner credentials). */
export const FORBIDDEN_ENV = [/^MIGRATION_/, /^SHADOW_/, /^ADMIN_DATABASE_URL$/, /^RESEND_/, /^STRIPE_/, /^VERCEL/, /^NEON_/, /^COMMUNICATIONS_CREDENTIAL_KEYS$/, /^(GOOGLE|MICROSOFT)_OAUTH_/, /^CRON_SECRET$/];

/** The runtime environment of the API server, built from scratch; nothing is inherited from the shell. */
export function serverEnv({ appUrl, authUrl, secret, baseUrl, path }) {
  return {
    PATH: path,
    NODE_ENV: 'production',
    DATABASE_URL: appUrl,
    AUTH_DATABASE_URL: authUrl,
    AUTH_SECRET: secret,
    EMAIL_TRANSPORT: 'log', // emails stay in memory; nothing is sent
    APP_BASE_URL: baseUrl,
    REGION: 'e2e',
    DATABASE_REGION: 'e2e',
    CORS_ALLOWED_ORIGINS: '',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

export function assertCleanEnv(env) {
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_ENV.some((re) => re.test(key))) throw new Error(`forbidden variable ${key} in the server environment`);
  }
}

/**
 * Next.js (`next build`, `next start`) and Prisma (`dotenv/config`) load .env files from their working directory
 * and fill in every variable the process environment does not already define, whatever the clean child
 * environment says. Forbidden or unknown variables could therefore arrive from a developer's file.
 * Fail closed: every key in every such file must be one the harness itself sets (and so shadows).
 */
export const DOTENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local'];

export function dotenvKeys(text) {
  const keys = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(raw);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** `files` is [{ name, text }] read from one directory. Returns the offending keys (never their values). */
export function injectableKeys(files, allowed) {
  const out = [];
  for (const { name, text } of files) {
    for (const key of dotenvKeys(text)) if (!allowed.has(key)) out.push(`${name}: ${key}`);
  }
  return out;
}

export function assertNoDotenvInjection(dir, allowed, readDir, readFile) {
  const present = readDir(dir).filter((f) => DOTENV_FILES.includes(f));
  const bad = injectableKeys(present.map((name) => ({ name, text: readFile(`${dir}/${name}`) })), allowed);
  if (bad.length) {
    throw new Error(`${dir} has environment files that would inject variables the harness does not control (${bad.join(', ')}). Move them aside for this run; values are never printed.`);
  }
}
