// Whole-migration rehearsal for 20261206000000_search_indexes under concurrent writes
// (docs/search-index-migration.md; docs/global-search-gs1.md §11.4; ChatGPT audit of PR #93, M2).
//
// Runs ONLY against a disposable database: a local database or a temporary Neon branch. Never production.
// It seeds synthetic data, writes continuously to every indexed table, and applies the migration with the
// real runner (`prisma migrate deploy`) while measuring write latency, lock waits and the migration's own
// duration. With --drill it first proves the failure path: a held write makes the migration hit its
// lock_timeout, Prisma records the migration as failed, no index is left behind, and the documented
// forward recovery (`prisma migrate resolve --rolled-back`, then deploy again) succeeds.
//
//   REHEARSAL_DATABASE_URL=postgresql://<owner role>@host/db        # runs the migration, as in production
//   REHEARSAL_APP_DATABASE_URL=postgresql://<app role>@host/db      # the writers, as the application (forced RLS)
//   REHEARSAL_ADMIN_DATABASE_URL=postgresql://<admin role>@host/db  # seeding and pg_stat_activity sampling
//   # a Neon branch also needs, so the guard can verify it through the Neon API (scripts/lib/rehearsal-guard.mjs):
//   NEON_API_KEY=… NEON_PROJECT_ID=… REHEARSAL_NEON_BRANCH_ID=<branch named rehearsal-search-indexes-…>
//   node scripts/search-index-rehearsal.mjs [--seed] [--scale 1] [--writers 8] [--drill] [--out report.json]
//
// All three URLs must point at the same disposable database: a local one, or a temporary Neon branch the
// guard positively verifies (never the default branch, never protected, never an endpoint of production). The writers set app.business_id per
// transaction, exactly as withTenant does, so forced RLS applies to them.
// Exit code 0 only when the rehearsal ran to the end; the report says whether the result is acceptable.
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { RehearsalTargetError, verifyRehearsalTarget } from './lib/rehearsal-guard.mjs';

const MIGRATION = '20261206000000_search_indexes';
const TABLES = ['customers', 'contacts', 'opportunities', 'projects', 'project_tasks', 'finance_documents', 'finance_catalog_items', 'people_employees'];
const VERSIONED = new Set(['opportunities', 'projects', 'project_tasks', 'finance_documents', 'finance_catalog_items', 'people_employees']);
const API_DIR = resolve(import.meta.dirname, '..');

// ---- arguments and the production guard -------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = process.env.REHEARSAL_DATABASE_URL;
const appUrl = process.env.REHEARSAL_APP_DATABASE_URL;
const adminUrl = process.env.REHEARSAL_ADMIN_DATABASE_URL;
// Fail closed BEFORE any connection, seed, write or migration: the target must be proven disposable
// (scripts/lib/rehearsal-guard.mjs). Nothing below this line runs if it is not.
let target;
try {
  target = await verifyRehearsalTarget({ urls: { owner: url, app: appUrl, admin: adminUrl }, env: process.env });
} catch (error) {
  console.error(`Refusing to rehearse: ${error instanceof RehearsalTargetError ? error.message : 'the target could not be verified.'}`);
  process.exit(2);
}
console.log(`target verified: ${target.mode}${target.mode === 'neon-branch' ? ` (${target.branchName})` : ''}`);
const host = new URL(url).hostname;
// `migrate deploy` never uses a shadow database, but Prisma refuses one equal to the target; this one need not exist.
const shadowUrl = (() => { const u = new URL(url); u.pathname = `${u.pathname}_rehearsal_shadow_unused`; return u.toString(); })();
const scale = Number(option('scale', '1'));
const writerCount = Math.max(8, Number(option('writers', '8'))); // at least one per indexed table
const out = option('out', `search-index-rehearsal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const pool = new pg.Pool({ connectionString: url, max: 2 }); // owner: _prisma_migrations
const admin = new pg.Pool({ connectionString: adminUrl, max: 3 }); // seed, sizes, catalog, lock sampling
const app = new pg.Pool({ connectionString: appUrl, max: writerCount + 1 }); // writers
const report = { startedAt: new Date().toISOString(), target: { mode: target.mode, branchName: target.branchName ?? null, host: host.replace(/^[^.]+/, '<redacted>') }, scale, writers: writerCount };

// ---- helpers ---------------------------------------------------------------------------------------------
async function inBusiness(client, businessId, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.business_id', $1, true)`, [businessId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
function summarise(samples) {
  const byTable = {};
  for (const table of TABLES) {
    const ms = samples.filter((s) => s.table === table && s.ok).map((s) => s.ms).sort((a, b) => a - b);
    byTable[table] = {
      ops: ms.length,
      errors: samples.filter((s) => s.table === table && !s.ok).length,
      p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: ms.length ? ms[ms.length - 1] : null,
    };
  }
  return byTable;
}
function prisma(command) {
  const started = Date.now();
  const result = spawnSync('pnpm', ['exec', 'prisma', ...command], {
    cwd: API_DIR,
    env: { ...process.env, MIGRATION_DATABASE_URL: url, SHADOW_DATABASE_URL: process.env.REHEARSAL_SHADOW_DATABASE_URL ?? shadowUrl },
    encoding: 'utf8',
  });
  return { status: result.status, ms: Date.now() - started, output: `${result.stdout}\n${result.stderr}`.slice(-4000) };
}
function prismaAsync(command) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn('pnpm', ['exec', 'prisma', ...command], {
      cwd: API_DIR,
      env: { ...process.env, MIGRATION_DATABASE_URL: url, SHADOW_DATABASE_URL: process.env.REHEARSAL_SHADOW_DATABASE_URL ?? shadowUrl },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (status) => done({ status, ms: Date.now() - started, startedAt: started, endedAt: Date.now(), output: output.slice(-4000) }));
  });
}
async function searchIndexes() {
  const { rows } = await admin.query(
    `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname LIKE '%\\_search\\_%' ESCAPE '\\' ORDER BY 1`,
  );
  return rows;
}
async function migrationRows() {
  const { rows } = await pool.query(
    `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count, left(coalesce(logs, ''), 300) AS logs
     FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
    [MIGRATION],
  );
  return rows;
}

// ---- preconditions ---------------------------------------------------------------------------------------
const pending = prisma(['migrate', 'status']);
report.statusBefore = pending.output.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
const existing = await migrationRows();
if (existing.some((r) => r.finished)) {
  console.error(`${MIGRATION} is already applied on this database. Use a fresh disposable database.`);
  process.exit(2);
}
if ((await searchIndexes()).length > 0) {
  console.error('Search indexes already exist on this database. Use a fresh disposable database.');
  process.exit(2);
}

// ---- seed (design point + a noisy tenant five times larger, §11.1) ---------------------------------------
const WORDS = ['North', 'Delta', 'Acme', 'Harbour', 'Summit', 'Pacific', 'Granite', 'Silver', 'Coastal', 'Metro', 'Pioneer', 'Atlas',
  'Bright', 'Cedar', 'Eagle', 'Falcon', 'Global', 'Horizon', 'Iron', 'Jade', 'Kestrel', 'Lumen', 'Maple', 'Nova', 'Orbit', 'Prime'];
const DESIGN = { customers: 10000, contacts: 20000, opportunities: 10000, projects: 5000, project_tasks: 100000, finance_documents: 50000, finance_catalog_items: 2000, people_employees: 500 };

async function seedBusiness(label, factor) {
  const n = Object.fromEntries(Object.entries(DESIGN).map(([k, v]) => [k, Math.max(1, Math.round(v * factor * scale))]));
  const client = await admin.connect();
  try {
    const id = randomUUID();
    // Seeding runs as the admin role (the app role cannot create businesses); the context is set anyway.
    await inBusiness(client, id, () => client.query(
      `INSERT INTO businesses (id, name, slug, country_code, time_zone, locale, currency, home_region)
       VALUES ($1, $2, $3, 'AU', 'Australia/Perth', 'en-AU', 'AUD', 'us-east-1')`,
      [id, `Rehearsal ${label}`, `rehearsal-${label}-${Date.now().toString(36)}`],
    ));
    const words = `(ARRAY[${WORDS.map((w) => `'${w}'`).join(',')}])`;
    const word = (salt) => `${words}[1 + ((n * ${salt}) % ${WORDS.length})]`;
    await inBusiness(client, id, async () => {
      await client.query(`INSERT INTO customers (id, business_id, display_name, legal_name, email)
        SELECT gen_random_uuid(), $1, ${word(7)} || ' ' || ${word(13)} || ' ' || n, ${word(17)} || ' Pty Ltd ' || n, 'c' || n || '@example.test'
        FROM generate_series(1, $2) n`, [id, n.customers]);
      await client.query(`INSERT INTO contacts (id, business_id, display_name, email)
        SELECT gen_random_uuid(), $1, ${word(3)} || ' ' || ${word(11)} || ' ' || n, 'p' || n || '@example.test' FROM generate_series(1, $2) n`, [id, n.contacts]);
      const { rows: [p] } = await client.query(`INSERT INTO sales_pipelines (id, business_id, name) VALUES (gen_random_uuid(), $1, 'Rehearsal') RETURNING id`, [id]);
      const { rows: [s] } = await client.query(`INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) VALUES (gen_random_uuid(), $1, $2, 'Open', 0) RETURNING id`, [id, p.id]);
      await client.query(`INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code)
        SELECT gen_random_uuid(), $1, ${word(5)} || ' deal ' || n, $3, $4, 'AUD' FROM generate_series(1, $2) n`, [id, n.opportunities, p.id, s.id]);
      await client.query(`INSERT INTO projects (id, business_id, name)
        SELECT gen_random_uuid(), $1, ${word(19)} || ' project ' || n FROM generate_series(1, $2) n`, [id, n.projects]);
      await client.query(`INSERT INTO project_tasks (id, business_id, project_id, title, position)
        SELECT gen_random_uuid(), $1, pr.a[1 + n % cardinality(pr.a)], ${word(23)} || ' task ' || n, n
        FROM generate_series(1, $2) n, (SELECT array_agg(id) AS a FROM projects WHERE business_id = $1) pr`,
        [id, n.project_tasks]);
      // Finance documents: drafts (unnumbered) and issued numbers are both searched; drafts avoid the issue workflow.
      await client.query(`INSERT INTO finance_documents (id, business_id, kind, customer_id, currency_code, currency_scale)
        SELECT gen_random_uuid(), $1, (CASE WHEN n % 2 = 0 THEN 'QUOTE' ELSE 'INVOICE' END)::"FinanceDocumentKind", c.a[1 + n % cardinality(c.a)], 'AUD', 2
        FROM generate_series(1, $2) n, (SELECT array_agg(id) AS a FROM customers WHERE business_id = $1) c`,
        [id, n.finance_documents]);
      await client.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, code, unit, currency_code, tax_mode)
        SELECT gen_random_uuid(), $1, 'SERVICE', ${word(29)} || ' item ' || n, 'SKU-' || n, 'each', 'AUD', 'NONE' FROM generate_series(1, $2) n`, [id, n.finance_catalog_items]);
      await client.query(`INSERT INTO people_employees (id, business_id, given_name, family_name, employee_number, work_email, job_title)
        SELECT gen_random_uuid(), $1, ${word(31)}, ${word(37)} || n, 'E' || n, 'e' || n || '@example.test', 'Technician' FROM generate_series(1, $2) n`, [id, n.people_employees]);
    });
    return { id, label, counts: n };
  } finally {
    client.release();
  }
}

const seededIds = [];
if (flag('seed')) {
  const t = Date.now();
  const seeded = [await seedBusiness('design', 1), await seedBusiness('noisy', 5)];
  seededIds.push(...seeded.map((b) => b.id));
  report.seeded = seeded.map(({ label, counts }) => ({ label, counts }));
  await admin.query('ANALYZE');
  report.seedMs = Date.now() - t;
  console.log(`seeded businesses: ${seededIds.join(',')}`);
}

report.tableSizes = (await admin.query(
  `SELECT relname AS table, n_live_tup AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
   FROM pg_stat_user_tables WHERE relname = ANY($1) ORDER BY relname`, [TABLES],
)).rows;

// ---- writers ---------------------------------------------------------------------------------------------
// Each writer loops: pick a table, update one random row's updated_at (or insert a customer / task), in its
// own transaction with app.business_id set, exactly as the application writes. Latency is wall time per
// transaction, so it includes any wait on the migration's SHARE locks.
// Forced RLS hides every business from a context-free query, so the writers use the businesses seeded now
// or the ones named with --businesses id,id (seeded by an earlier run on the same branch).
const businesses = (seededIds.length ? seededIds : option('businesses', '').split(',').filter(Boolean)).map((id) => ({ id }));
if (businesses.length === 0) {
  console.error('No rehearsal businesses. Run with --seed, or pass --businesses id,id from an earlier seed.');
  process.exit(2);
}
const ids = {};
{
  const client = await app.connect();
  for (const b of businesses) {
    await inBusiness(client, b.id, async () => {
      for (const table of TABLES) {
        const { rows } = await client.query(`SELECT id FROM ${table} WHERE business_id = $1 ORDER BY random() LIMIT 500`, [b.id]);
        (ids[table] ??= []).push(...rows.map((r) => ({ business: b.id, id: r.id })));
      }
    });
  }
  client.release();
}

let running = false;
const samples = [];
// Writer k always writes to TABLES[k % 8], so every indexed table has its own continuous write stream and a
// blocked table cannot starve the measurement of the others.
async function writer(k) {
  const client = await app.connect();
  const table = TABLES[k % TABLES.length];
  const pickFrom = ids[table];
  let i = k;
  try {
    while (running) {
      i += 1;
      const target = pickFrom[(i * 7919) % pickFrom.length];
      const started = performance.now();
      const at = Date.now();
      try {
        await inBusiness(client, target.business, async () => {
          if (table === 'customers' && i % 5 === 0) {
            await client.query(`INSERT INTO customers (id, business_id, display_name) VALUES (gen_random_uuid(), $1, 'Rehearsal write ' || $2)`, [target.business, String(i)]);
          } else {
            // Versioned tables' guard triggers require version + 1 on every change, as the application does.
            const bump = VERSIONED.has(table) ? ', version = version + 1' : '';
            await client.query(`UPDATE ${table} SET updated_at = now()${bump} WHERE business_id = $1 AND id = $2`, [target.business, target.id]);
          }
        });
        samples.push({ table, at, ms: performance.now() - started, ok: true });
      } catch (error) {
        samples.push({ table, at, ms: performance.now() - started, ok: false, error: String(error.message).slice(0, 120) });
      }
    }
  } finally {
    client.release();
  }
}
async function withWriters(fn) {
  running = true;
  const loops = Array.from({ length: writerCount }, (_, k) => writer(k));
  try {
    return await fn();
  } finally {
    running = false;
    await Promise.all(loops);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lock-wait sampler: the longest any session has been waiting on a lock, every 100 ms.
async function sampleLocks(untilFn) {
  const client = await admin.connect();
  let maxWaitMs = 0;
  let maxWaiters = 0;
  try {
    while (!untilFn()) {
      const { rows: [r] } = await client.query(
        `SELECT count(*)::int AS waiters, coalesce(max(extract(epoch FROM now() - state_change) * 1000), 0)::int AS longest
         FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      maxWaiters = Math.max(maxWaiters, r.waiters);
      maxWaitMs = Math.max(maxWaitMs, r.longest);
      await sleep(100);
    }
  } finally {
    client.release();
  }
  return { maxWaiters, maxWaitMs };
}

// ---- 1. baseline writes, no indexes ----------------------------------------------------------------------
await withWriters(() => sleep(10000));
report.baselineWrites = summarise(samples.splice(0));

// ---- 2. failure drill (optional) -------------------------------------------------------------------------
if (flag('drill')) {
  const holder = await app.connect();
  const { business, id } = ids.customers[0];
  await holder.query('BEGIN');
  await holder.query(`SELECT set_config('app.business_id', $1, true)`, [business]);
  await holder.query(`UPDATE customers SET updated_at = now() WHERE business_id = $1 AND id = $2`, [business, id]);
  const failed = prisma(['migrate', 'deploy']); // blocks on customers for lock_timeout (3 s), then fails
  await holder.query('ROLLBACK');
  holder.release();
  const afterFailure = { indexes: await searchIndexes(), migration: await migrationRows() };
  const resolved = prisma(['migrate', 'resolve', '--rolled-back', MIGRATION]);
  report.drill = {
    deployExit: failed.status,
    deployMs: failed.ms,
    // Prisma reports the follow-on "current transaction is aborted" error rather than the lock timeout itself;
    // a failure no earlier than lock_timeout (3 s) after start is the expected signature.
    failedAfterLockTimeout: failed.status !== 0 && failed.ms >= 3000,
    deployOutput: failed.output.split('\n').filter((l) => l.trim()).slice(-6).join('\n'),
    indexesLeftBehind: afterFailure.indexes.length,
    migrationRowAfterFailure: afterFailure.migration,
    resolveExit: resolved.status,
    migrationRowAfterResolve: await migrationRows(),
  };
}

// ---- 3. the real run under concurrent writes -------------------------------------------------------------
let deploying = true;
const run = await withWriters(async () => {
  await sleep(2000); // writers warm
  const locks = sampleLocks(() => !deploying);
  const deploy = await prismaAsync(['migrate', 'deploy']);
  deploying = false;
  const lockStats = await locks;
  await sleep(2000);
  return { deploy, lockStats };
});
const during = samples.filter((s) => s.at >= run.deploy.startedAt && s.at <= run.deploy.endedAt);
report.migration = {
  exit: run.deploy.status,
  durationMs: run.deploy.ms,
  output: run.deploy.output.split('\n').filter((l) => l.trim()).slice(-8).join('\n'),
  lockWaits: run.lockStats,
  writesDuringMigration: summarise(during),
  writeErrorsDuringMigration: [...new Set(during.filter((s) => !s.ok).map((s) => s.error))].slice(0, 5),
};
samples.splice(0);
report.indexesAfter = await searchIndexes();
report.migrationRowAfter = await migrationRows();

// ---- 4. write overhead after the indexes -----------------------------------------------------------------
await withWriters(() => sleep(10000));
report.afterWrites = summarise(samples.splice(0));

// ---- verdict inputs --------------------------------------------------------------------------------------
report.checks = {
  migrationSucceeded: run.deploy.status === 0,
  all22IndexesValid: report.indexesAfter.length === 22 && report.indexesAfter.every((i) => i.valid && i.ready),
  migrationRecordedFinished: report.migrationRowAfter.some((r) => r.finished),
  drillLeftNothingBehind: report.drill ? report.drill.indexesLeftBehind === 0 && report.drill.resolveExit === 0 : 'not run',
  longestWriteDuringMigrationMs: Math.max(0, ...Object.values(report.migration.writesDuringMigration).map((t) => t.max ?? 0)),
};
report.finishedAt = new Date().toISOString();
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.checks, null, 2));
console.log(`report: ${out}`);
await Promise.all([pool.end(), admin.end(), app.end()]);
