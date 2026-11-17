// Concurrency probe for the S-CFG-1A rehearsal (docs/sales-configuration-migration.md §4, step 7).
// REHEARSAL BRANCH ONLY. Start it, then run `prisma migrate deploy` against the rehearsal branch in another terminal.
//
// Two PERSISTENT bos_app connections (opened before timing starts, so connection set-up and TLS are never timed),
// each sending one round trip every SCFG_PROBE_INTERVAL_MS (default 100):
//   - reader: count(*) of sales_pipelines, sales_stages and opportunities (ADD COLUMN holds ACCESS EXCLUSIVE on
//     sales_pipelines until COMMIT, so this read waits for the migration's lock window);
//   - writer: a no-op UPDATE of one sales_stages row, rolled back (the index build holds SHARE on sales_stages).
// Each sample is one simple-protocol round trip (BEGIN; set business; statement; COMMIT or ROLLBACK).
// The stall attributable to the migration is the longest sample minus the median (the network round trip).
// Prints counts and milliseconds only: no ids, names or hosts.
//
// Environment (never on the command line):
//   SCFG_PROBE_APP_URL       bos_app URL of the REHEARSAL branch (direct endpoint)
//   SCFG_PROBE_BUSINESS_ID   a business on the rehearsal branch (any; one with a stage exercises the write)
//   SCFG_PROBE_SECONDS       optional, default 30
//   SCFG_PROBE_INTERVAL_MS   optional, default 100
import pg from 'pg';

const url = process.env.SCFG_PROBE_APP_URL;
const biz = process.env.SCFG_PROBE_BUSINESS_ID;
const seconds = Number(process.env.SCFG_PROBE_SECONDS ?? 30);
const interval = Number(process.env.SCFG_PROBE_INTERVAL_MS ?? 100);
const stop = (msg) => {
  console.error(`STOP: ${msg}`);
  process.exit(2);
};
if (!url) stop('SCFG_PROBE_APP_URL is not set');
if (!biz || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(biz)) stop('SCFG_PROBE_BUSINESS_ID is not a uuid');
if (!(seconds > 0) || !(interval > 0)) stop('SCFG_PROBE_SECONDS and SCFG_PROBE_INTERVAL_MS must be positive');

const setBiz = `SELECT set_config('app.business_id', '${biz}', true);`;
const kinds = {
  read: `BEGIN; ${setBiz} SELECT count(*) FROM sales_pipelines; SELECT count(*) FROM sales_stages; SELECT count(*) FROM opportunities; COMMIT;`,
  write: `BEGIN; ${setBiz} UPDATE sales_stages SET name = name WHERE id = (SELECT id FROM sales_stages ORDER BY id LIMIT 1); ROLLBACK;`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

async function run(kind, sql, end) {
  const client = new pg.Client({ connectionString: url, statement_timeout: 60_000 });
  await client.connect();
  const { rows } = await client.query('SELECT rolbypassrls OR rolsuper AS bypass FROM pg_roles WHERE rolname = current_user');
  if (rows[0]?.bypass) stop('the probe must connect as bos_app, not a role that bypasses RLS');
  await client.query(sql); // warm-up, not timed
  const samples = [];
  const starts = [];
  let errors = 0;
  while (Date.now() < end) {
    const t = performance.now();
    const startedAt = Date.now();
    try {
      await client.query(sql);
    } catch {
      errors += 1;
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    }
    const d = performance.now() - t;
    samples.push(d);
    starts.push(startedAt);
    if (d < interval) await sleep(interval - d);
  }
  await client.end();
  const median = quantile(samples, 0.5);
  const max = samples.length ? Math.max(...samples) : 0;
  const at = samples.indexOf(max);
  // Samples clearly above the round trip (median + 100 ms): the window in which the probe was blocked.
  const slow = samples.map((d, i) => ({ d, i })).filter(({ d }) => d > median + 100);
  const window = slow.length
    ? `${new Date(starts[slow[0].i]).toISOString()} to ${new Date(starts[slow.at(-1).i] + slow.at(-1).d).toISOString()}`
    : 'none';
  return {
    kind, rounds: samples.length, errors, median, p99: quantile(samples, 0.99), max, stall: max - median,
    longestAt: at >= 0 ? new Date(starts[at]).toISOString() : 'none', slowCount: slow.length, window,
  };
}

const end = Date.now() + seconds * 1000;
console.log(`probe start ${new Date().toISOString()}, interval ${interval} ms, ${seconds} s (run the deploy now, and record its start and end times in UTC)`);
const results = await Promise.all(Object.entries(kinds).map(([k, sql]) => run(k, sql, end)));
const ms = (x) => `${Math.round(x)} ms`;
for (const r of results) {
  console.log(`probe ${r.kind}: rounds ${r.rounds}, errors ${r.errors}, median ${ms(r.median)}, p99 ${ms(r.p99)}, longest ${ms(r.max)}, longest minus median ${ms(r.stall)}`);
  console.log(`probe ${r.kind}: longest sample started ${r.longestAt}; samples over median + 100 ms: ${r.slowCount}; blocked window: ${r.window}`);
}
if (results.some((r) => r.errors > 0)) stop('probe statements failed; check the URL and business id');
