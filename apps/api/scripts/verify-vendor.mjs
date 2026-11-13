// Phase 1a vendor verification (docs/deployment.md §5, ADR 0002). Runs against ANY PostgreSQL,
// local Docker or the Neon project, and prints PASS/FAIL per capability that ADR 0004 needs.
//
//   VERIFY_ADMIN_URL  direct (non-pooled) connection as an administrative role that can create
//                     roles (on Neon: the project's default owner role). Never committed.
//   VERIFY_APP_URL    the runtime role's URL (bos_app), pooled endpoint on Neon.
//
// Everything it creates lives in one transaction that is rolled back, so it leaves nothing behind.
// It never prints connection strings. Backup/PITR region cannot be checked from SQL: confirm it in
// the vendor console and record it in docs/phase-1a-verification.md.
import pg from 'pg';

const adminUrl = process.env.VERIFY_ADMIN_URL;
const appUrl = process.env.VERIFY_APP_URL;
if (!adminUrl || !appUrl) {
  console.error('Set VERIFY_ADMIN_URL and VERIFY_APP_URL (see the header of this script).');
  process.exit(2);
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const attempt = async (name, fn) => {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
};

const admin = new pg.Client({ connectionString: adminUrl });
const app = new pg.Client({ connectionString: appUrl });
await admin.connect();
await app.connect();

try {
  await attempt('PostgreSQL 16 or later', async () => {
    const { rows } = await admin.query("SELECT current_setting('server_version_num')::int AS v, version() AS full");
    if (rows[0].v < 160000) throw new Error(`server_version_num ${rows[0].v}`);
    return rows[0].full.split(' on ')[0];
  });

  await attempt('runtime role bos_app: no superuser, no BYPASSRLS, no CREATEROLE/CREATEDB', async () => {
    const { rows } = await app.query(
      'SELECT current_user AS u, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
    );
    const r = rows[0];
    if (r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb) throw new Error(`unsafe attributes on ${r.u}`);
    return r.u;
  });

  await attempt('runtime role cannot create objects in public', async () => {
    try {
      await app.query('CREATE TABLE public.__bos_verify_should_fail (id int)');
    } catch {
      return 'denied as expected';
    }
    await app.query('DROP TABLE public.__bos_verify_should_fail');
    throw new Error('bos_app was able to create a table');
  });

  await attempt('transaction-local set_config stays on one connection and is discarded at commit (pooler)', async () => {
    await app.query('BEGIN');
    const set = await app.query("SELECT set_config('app.business_id', 'tenant-a', true) AS v");
    const read = await app.query("SELECT current_setting('app.business_id', true) AS v");
    await app.query('COMMIT');
    const after = await app.query("SELECT current_setting('app.business_id', true) AS v");
    if (set.rows[0].v !== 'tenant-a' || read.rows[0].v !== 'tenant-a') throw new Error('setting not visible inside the transaction');
    if (after.rows[0].v) throw new Error(`setting leaked past commit: ${after.rows[0].v}`);
    return 'set, read, then empty after commit';
  });

  // Everything below creates objects, then rolls back.
  await admin.query('BEGIN');
  try {
    await attempt('administrative role can create roles with NOBYPASSRLS', async () => {
      await admin.query('CREATE ROLE __bos_v_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
      await admin.query('CREATE ROLE __bos_v_definer NOLOGIN NOSUPERUSER NOBYPASSRLS');
      await admin.query('GRANT __bos_v_app TO CURRENT_USER');
    });
    await attempt('FORCE ROW LEVEL SECURITY and CREATE POLICY ... TO <role> are supported', async () => {
      await admin.query('CREATE SCHEMA __bos_v');
      await admin.query('CREATE TABLE __bos_v.items (business_id text NOT NULL, name text NOT NULL)');
      await admin.query('ALTER TABLE __bos_v.items ENABLE ROW LEVEL SECURITY');
      await admin.query('ALTER TABLE __bos_v.items FORCE ROW LEVEL SECURITY');
      await admin.query(
        "CREATE POLICY tenant_isolation ON __bos_v.items TO __bos_v_app USING (business_id = current_setting('app.business_id', true)) WITH CHECK (business_id = current_setting('app.business_id', true))",
      );
      await admin.query('GRANT USAGE ON SCHEMA __bos_v TO __bos_v_app');
      await admin.query('GRANT SELECT, INSERT ON __bos_v.items TO __bos_v_app');
    });
    await attempt('RLS isolates tenants, blocks cross-tenant writes and fails closed with no context', async () => {
      await admin.query('SET LOCAL ROLE __bos_v_app');
      await admin.query("SELECT set_config('app.business_id', 'a', true)");
      await admin.query("INSERT INTO __bos_v.items VALUES ('a', 'row-a')");
      await admin.query('SAVEPOINT cross_tenant');
      let blocked = false;
      try {
        await admin.query("INSERT INTO __bos_v.items VALUES ('b', 'row-b')");
      } catch {
        blocked = true;
      }
      await admin.query('ROLLBACK TO SAVEPOINT cross_tenant');
      if (!blocked) throw new Error('write for another tenant was allowed');
      await admin.query("SELECT set_config('app.business_id', 'b', true)");
      const other = await admin.query('SELECT count(*)::int AS n FROM __bos_v.items');
      if (other.rows[0].n !== 0) throw new Error('tenant b can see tenant a rows');
      await admin.query("SELECT set_config('app.business_id', '', true)");
      const none = await admin.query('SELECT count(*)::int AS n FROM __bos_v.items');
      if (none.rows[0].n !== 0) throw new Error('rows visible with no tenant context');
      await admin.query('RESET ROLE');
      return 'own rows visible, other tenant and no context see nothing';
    });
    await attempt('SECURITY DEFINER function owned by a NOLOGIN role, with fixed search_path and no PUBLIC execute', async () => {
      await admin.query('GRANT USAGE, CREATE ON SCHEMA __bos_v TO __bos_v_definer');
      await admin.query('GRANT __bos_v_definer TO CURRENT_USER');
      await admin.query('SET LOCAL ROLE __bos_v_definer');
      await admin.query(
        "CREATE FUNCTION __bos_v.whoami() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT current_user::text $$",
      );
      await admin.query('RESET ROLE');
      await admin.query('REVOKE EXECUTE ON FUNCTION __bos_v.whoami() FROM PUBLIC');
      await admin.query('GRANT EXECUTE ON FUNCTION __bos_v.whoami() TO __bos_v_app');
      const { rows } = await admin.query(
        "SELECT prosecdef, pg_get_userbyid(proowner) AS owner, proconfig, has_function_privilege('public', oid, 'EXECUTE') AS public_exec FROM pg_proc WHERE proname = 'whoami' AND pronamespace = '__bos_v'::regnamespace",
      );
      const f = rows[0];
      if (!f.prosecdef || f.owner !== '__bos_v_definer') throw new Error('definer or owner wrong');
      if (!String(f.proconfig).includes('search_path=')) throw new Error('search_path not fixed');
      if (f.public_exec) throw new Error('PUBLIC can still execute');
      await admin.query('SET LOCAL ROLE __bos_v_app');
      const call = await admin.query('SELECT __bos_v.whoami() AS who');
      await admin.query('RESET ROLE');
      if (call.rows[0].who !== '__bos_v_definer') throw new Error(`ran as ${call.rows[0].who}`);
      return 'runs as the definer, not the caller';
    });
  } finally {
    await admin.query('ROLLBACK');
  }
} finally {
  await admin.end();
  await app.end();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Nothing was left behind (all changes rolled back).`);
console.log('Manual: confirm backup/PITR region in the vendor console (cannot be checked from SQL).');
process.exit(failed ? 1 : 0);
