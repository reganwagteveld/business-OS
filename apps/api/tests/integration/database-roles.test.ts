/**
 * Phase 1a: the owner and runtime roles exist with the intended privileges, and the
 * app's DATABASE_URL connects as the runtime role (docs/data-model.md §5.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!appUrl || !ownerUrl) throw new Error('Integration tests need DATABASE_URL and MIGRATION_DATABASE_URL (see .env.example)');

const app = new pg.Client({ connectionString: appUrl });
const owner = new pg.Client({ connectionString: ownerUrl });

beforeAll(async () => {
  await app.connect();
  await owner.connect();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

async function attributes(client: pg.Client) {
  const { rows } = await client.query<{
    rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean;
  }>('SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user');
  return rows[0];
}

describe('runtime role (DATABASE_URL)', () => {
  it('connects as bos_app', async () => {
    expect((await attributes(app))?.rolname).toBe('bos_app');
  });

  it('has no superuser, BYPASSRLS, CREATEROLE or CREATEDB attributes', async () => {
    expect(await attributes(app)).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('is not a member of the owner role', async () => {
    const { rows } = await app.query<{ member: boolean }>("SELECT pg_has_role(current_user, 'bos_owner', 'MEMBER') AS member");
    expect(rows[0]?.member).toBe(false);
  });

  it('cannot create objects in the public schema', async () => {
    await expect(app.query('CREATE TABLE public.should_not_exist (id int)')).rejects.toThrow(/permission denied/);
  });
});

describe('migration role (MIGRATION_DATABASE_URL)', () => {
  it('connects as bos_owner without superuser or BYPASSRLS', async () => {
    expect(await attributes(owner)).toMatchObject({ rolname: 'bos_owner', rolsuper: false, rolbypassrls: false });
  });

  it('can create tables in the public schema', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('CREATE TABLE public.migration_probe (id int)');
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
