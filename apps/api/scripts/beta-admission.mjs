// Private beta operator tool (docs/private-beta-lockdown.md §Operator admission). Platform operators
// only: it needs the ADMINISTRATIVE database connection, which the running app never has, and it
// calls app_private.operator_* functions that no runtime role can execute. Every change is audited in
// app_private.beta_admission_events with the operator's name and a reason.
//
//   ADMIN_DATABASE_URL=... pnpm db:beta-admission find <email>                  (read-only)
//   ADMIN_DATABASE_URL=... pnpm db:beta-admission list                          (read-only)
//   ADMIN_DATABASE_URL=... pnpm db:beta-admission history [user-id]             (read-only)
//   ADMIN_DATABASE_URL=... OPERATOR="Name" pnpm db:beta-admission admit <user-id> --reason "..."
//   ADMIN_DATABASE_URL=... OPERATOR="Name" pnpm db:beta-admission revoke <user-id> --reason "..."
//   ADMIN_DATABASE_URL=... OPERATOR="Name" pnpm db:beta-admission allow-create <user-id> --reason "..."
//   ADMIN_DATABASE_URL=... OPERATOR="Name" pnpm db:beta-admission deny-create <user-id> --reason "..."
//
// Users are identified by their stable id only; `find` shows the id for an email so it can be checked
// before anything changes. Admission never grants business creation: that is `allow-create`.
import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const [command, arg, ...rest] = process.argv.slice(2);
const reasonIndex = rest.indexOf('--reason');
const reason = reasonIndex >= 0 ? rest[reasonIndex + 1] : undefined;
const url = process.env.ADMIN_DATABASE_URL;
const operator = process.env.OPERATOR;

function usage(message) {
  console.error(`${message}\nCommands: find <email> | list | history [user-id] | admit|revoke|allow-create|deny-create <user-id> --reason "..." (OPERATOR required)`);
  process.exit(2);
}
if (!url) usage('Set ADMIN_DATABASE_URL (the administrative role).');

const mutations = {
  admit: (c, id) => c.query('SELECT app_private.operator_admit_user($1::uuid, $2, $3) AS result', [id, operator, reason]),
  revoke: (c, id) => c.query('SELECT app_private.operator_revoke_user($1::uuid, $2, $3) AS result', [id, operator, reason]),
  'allow-create': (c, id) => c.query('SELECT app_private.operator_set_business_creation($1::uuid, true, $2, $3) AS result', [id, operator, reason]),
  'deny-create': (c, id) => c.query('SELECT app_private.operator_set_business_creation($1::uuid, false, $2, $3) AS result', [id, operator, reason]),
};

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (command === 'find') {
    if (!arg) usage('find needs an email address.');
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      `SELECT u.id, u.email_verified, u.deactivated_at, u.created_at, a.admitted_at, a.revoked_at, a.can_create_business
         FROM public.users u LEFT JOIN app_private.beta_admissions a ON a.user_id = u.id
        WHERE u.email = lower(btrim($1))`, [arg]);
    await client.query('ROLLBACK');
    console.table(rows);
  } else if (command === 'list') {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      `SELECT a.user_id, a.source, a.admitted_at, a.revoked_at, a.can_create_business, u.deactivated_at
         FROM app_private.beta_admissions a JOIN public.users u ON u.id = a.user_id ORDER BY a.admitted_at`);
    await client.query('ROLLBACK');
    console.table(rows);
  } else if (command === 'history') {
    if (arg && !UUID.test(arg)) usage('history takes an optional user id (uuid).');
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      `SELECT occurred_at, user_id, action, operator, reason FROM app_private.beta_admission_events
        WHERE $1::uuid IS NULL OR user_id = $1::uuid ORDER BY occurred_at`, [arg ?? null]);
    await client.query('ROLLBACK');
    console.table(rows);
  } else if (mutations[command]) {
    if (!arg || !UUID.test(arg)) usage(`${command} needs a user id (uuid). Use \`find <email>\` to look it up.`);
    if (!operator || !reason) usage('Set OPERATOR and pass --reason "...": every change is audited.');
    await client.query('BEGIN');
    const { rows } = await mutations[command](client, arg);
    await client.query('COMMIT');
    console.log(`${command} ${arg}: ${rows[0].result}`);
  } else {
    usage(`Unknown command: ${command ?? '(none)'}`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
