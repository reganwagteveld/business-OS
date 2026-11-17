// Orchestrates one full-stack E2E run (WP-T1):
//   1. connect to a LOOPBACK PostgreSQL as its superuser and create a disposable database `e2e_<hex>` with the
//      application roles and fresh random test-only passwords (never the dev/CI defaults, never a real secret);
//   2. apply the committed migrations as the owner role and the privileged SQL as the administrative role,
//      exactly like production's order;
//   3. build the API (unless E2E_SKIP_BUILD=1) and serve it with `next start` using ONLY runtime credentials
//      (bos_app and bos_auth; no owner, admin, email-provider or payment variables);
//   4. run the vitest suite against the real HTTP server, then stop the server and drop the database.
// Everything else is configured by E2E_ADMIN_URL (default: the disposable cluster from tooling/e2e/README.md).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import pg from 'pg';
import { readdirSync } from 'node:fs';
import { assertCleanEnv, assertDisposableName, assertLocalPostgres, assertNoDotenvFiles, pgConfig, serverEnv } from './guard.mjs';

const root = resolve(import.meta.dirname, '../../..');
const e2eDir = resolve(import.meta.dirname, '..');
const admin0 = process.env.E2E_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55432/postgres';
const adminBase = assertLocalPostgres(admin0, 'E2E_ADMIN_URL');
const log = (m) => console.log(`[e2e] ${m}`);
const ROLE_MARK = 'e2e-harness (tooling/e2e)';
const pwd = () => randomBytes(18).toString('hex');

const dbName = assertDisposableName(`e2e_${randomBytes(8).toString('hex')}`);
const passwords = { owner: pwd(), app: pwd(), auth: pwd(), jobs: pwd() };
const url = (user, password, db = dbName) => {
  const u = new URL(adminBase.href);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  u.search = '';
  return u.href;
};
const adminUrl = (db) => {
  const u = new URL(adminBase.href);
  u.pathname = `/${db}`;
  u.search = '';
  return u.href;
};
const urls = {
  admin: adminUrl(dbName),
  owner: url('bos_owner', passwords.owner),
  app: url('bos_app', passwords.app),
  auth: url('bos_auth', passwords.auth),
};

let server;
let created = false;
async function teardown() {
  if (server && !server.killed) server.kill('SIGTERM');
  if (!created || process.env.E2E_KEEP_DB === '1') {
    if (created) log(`kept database ${dbName} (E2E_KEEP_DB=1)`);
    return;
  }
  const c = new pg.Client(pgConfig(adminUrl('postgres'), 'admin URL'));
  try {
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${assertDisposableName(dbName)} WITH (FORCE)`);
    log(`dropped ${dbName}`);
  } catch (e) {
    console.error(`[e2e] could not drop ${dbName}: ${e.message}`);
  } finally {
    await c.end().catch(() => {});
  }
}

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function provision() {
  const c = new pg.Client(pgConfig(adminUrl('postgres'), 'admin URL'));
  await c.connect();
  try {
    const existing = await c.query(
      "SELECT rolname, shobj_description(oid, 'pg_authid') AS note FROM pg_roles WHERE rolname IN ('bos_owner','bos_app','bos_auth','bos_jobs','bos_definer','bos_maint')",
    );
    // Role passwords are cluster-wide. Roles this harness made carry a marker comment and are reused (fresh
    // passwords every run); roles from anything else, such as a developer's own stack, are never touched.
    if (existing.rows.some((r) => r.note !== ROLE_MARK)) {
      throw new Error('This PostgreSQL already has application roles (bos_*). Use a disposable cluster as described in tooling/e2e/README.md; there is no override.');
    }
    const have = new Set(existing.rows.map((r) => r.rolname));
    const attrs = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
    const role = async (name, login, password, extra = '') => {
      if (have.has(name)) {
        if (login) await c.query(`ALTER ROLE ${name} LOGIN PASSWORD '${password}'`);
        return;
      }
      await c.query(`CREATE ROLE ${name} ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'} ${attrs} ${extra}`);
    };
    await role('bos_owner', true, passwords.owner);
    await role('bos_app', true, passwords.app);
    await role('bos_jobs', true, passwords.jobs, 'NOINHERIT');
    await role('bos_auth', true, passwords.auth, 'NOINHERIT');
    await role('bos_definer', false);
    await role('bos_maint', false);
    for (const name of ['bos_owner', 'bos_app', 'bos_jobs', 'bos_auth', 'bos_definer', 'bos_maint']) await c.query(`COMMENT ON ROLE ${name} IS '${ROLE_MARK}'`);
    await c.query(`CREATE DATABASE ${dbName} OWNER bos_owner`);
    created = true;
    await c.query(`GRANT CONNECT ON DATABASE ${dbName} TO bos_owner, bos_app, bos_auth`);
  } finally {
    await c.end();
  }
  const d = new pg.Client(pgConfig(urls.admin, 'admin URL'));
  await d.connect();
  try {
    await d.query('GRANT USAGE, CREATE ON SCHEMA public TO bos_owner');
    await d.query('GRANT USAGE ON SCHEMA public TO bos_app, bos_auth');
    await d.query('ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app');
  } finally {
    await d.end();
  }
}

async function waitHealthy(base, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API server exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API server did not become healthy within 90 s');
}

let exitCode = 1;
try {
  // Before any connection or DDL: nothing on disk may inject variables into the build, server or Prisma.
  for (const dir of [resolve(root, 'apps/api'), e2eDir]) assertNoDotenvFiles(dir, readdirSync);
  log(`provisioning disposable database ${dbName} on ${adminBase.hostname}:${adminBase.port}`);
  await provision();

  const apiDir = resolve(root, 'apps/api');
  const migrateEnv = { PATH: process.env.PATH, HOME: process.env.HOME, MIGRATION_DATABASE_URL: urls.owner };
  log('prisma migrate deploy (owner role)');
  sh('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: apiDir, env: migrateEnv });
  log('privileged SQL (administrative role)');
  sh('node', ['scripts/apply-privileged.mjs'], { cwd: apiDir, env: { PATH: process.env.PATH, ADMIN_DATABASE_URL: urls.admin, DEPLOYMENT_REGION: 'e2e' } });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = serverEnv({ appUrl: urls.app, authUrl: urls.auth, secret: randomBytes(32).toString('hex'), baseUrl: base, path: process.env.PATH });
  assertCleanEnv(env);
  if (process.env.E2E_SKIP_BUILD !== '1') {
    log('next build (runtime credentials only)');
    sh('pnpm', ['exec', 'next', 'build'], { cwd: apiDir, env: { ...env, NODE_ENV: 'production', HOME: process.env.HOME } });
  }
  log(`next start on ${base}`);
  server = spawn('pnpm', ['exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: apiDir, env: { ...env, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitHealthy(base, server);

  log('running the suite');
  const args = ['exec', 'vitest', 'run', ...process.argv.slice(2)];
  const r = spawnSync('pnpm', args, {
    cwd: e2eDir,
    stdio: 'inherit',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: process.env.CI, E2E_REPORT_JSON: process.env.E2E_REPORT_JSON, E2E_API_URL: base, E2E_ADMIN_DB_URL: urls.admin, E2E_APP_DB_URL: urls.app, E2E_OWNER_DB_URL: urls.owner, E2E_DB_NAME: dbName },
  });
  exitCode = r.status ?? 1;
} catch (e) {
  console.error(`[e2e] ${e.message}`);
} finally {
  await teardown();
}
process.exit(exitCode);
