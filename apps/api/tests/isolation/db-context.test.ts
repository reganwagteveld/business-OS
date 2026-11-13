/**
 * Phase 1b RLS spike (docs/data-model.md §5.4, ADR 0004): tests S1 to S13 against real PostgreSQL
 * behind a transaction-mode pooler (PgBouncer in CI). These tests stay in the repo and re-run on
 * any Prisma, driver adapter or pooler upgrade.
 *
 * Connections (all CI/dev-only credentials; see .github/workflows/ci.yml and docker/pgbouncer):
 *   SPIKE_ADMIN_URL       administrative role, DIRECT: rebuilds the fixture schema and seeds rows
 *   SPIKE_OWNER_URL       bos_owner, DIRECT: S9 (composite FKs with RLS bypassed)
 *   SPIKE_APP_URL         bos_app through the pooler (transaction mode)
 *   SPIKE_APP_SINGLE_URL  bos_app through a pooler database with pool_size=1 (S4, S5, S10)
 *   SPIKE_JOBS_URL        bos_jobs through the pooler (S13)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { createWithTenant, TenantContextError, TenantScopeError } from '@/core/db/with-tenant';

const env = {
  admin: process.env.SPIKE_ADMIN_URL,
  owner: process.env.SPIKE_OWNER_URL,
  app: process.env.SPIKE_APP_URL,
  appSingle: process.env.SPIKE_APP_SINGLE_URL,
  jobs: process.env.SPIKE_JOBS_URL,
};
const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  throw new Error(`RLS spike needs SPIKE_* connection URLs (missing: ${missing.join(', ')}). See the header of this file.`);
}

const MODELS = { business: 'id', customer: 'businessId', contact: 'businessId' } as const;

function prisma(url: string, max: number) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });
}

const admin = new pg.Client({ connectionString: env.admin });
const owner = new pg.Client({ connectionString: env.owner });
const app = prisma(env.app!, 5); // S6: pool size 5 behind the pooler
const appSingle = prisma(env.appSingle!, 1); // S4/S5/S10: pool size 1, pooler pool_size 1
const jobs = prisma(env.jobs!, 2);

const withTenant = createWithTenant({ clients: { app, jobs }, models: MODELS });
const withTenantSingle = createWithTenant({ clients: { app: appSingle }, models: MODELS });
const withRlsOnly = createWithTenant({ clients: { app }, models: MODELS, disableScopeGuardForIsolationTests: true });

// Seed: three active businesses, one purgeable (archived 40 days ago), one archived too recently.
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const PURGEABLE = randomUUID();
const RECENT = randomUUID();
const CUSTOMERS: Record<string, string[]> = {};
const COUNTS: Record<string, number> = { [A]: 3, [B]: 4, [C]: 5, [PURGEABLE]: 2, [RECENT]: 2 };
const ctx = (businessId: string) => ({ businessId, userId: randomUUID() });

async function seed() {
  await admin.query(readFileSync(resolve(__dirname, 'fixtures/spike-schema.sql'), 'utf8'));
  const businesses: [string, string, string | null][] = [
    [A, 'a', null], [B, 'b', null], [C, 'c', null],
    [PURGEABLE, 'purgeable', "now() - interval '40 days'"], [RECENT, 'recent', "now() - interval '10 days'"],
  ];
  for (const [id, slug, archived] of businesses) {
    await admin.query(`INSERT INTO businesses (id, slug, name, archived_at) VALUES ($1, $2, $3, ${archived ?? 'NULL'})`, [id, slug, `Business ${slug}`]);
    CUSTOMERS[id] = [];
    for (let i = 0; i < COUNTS[id]!; i++) {
      const customerId = randomUUID();
      CUSTOMERS[id]!.push(customerId);
      await admin.query('INSERT INTO customers (id, business_id, display_name) VALUES ($1, $2, $3)', [customerId, id, `${slug}-customer-${i}`]);
      await admin.query('INSERT INTO contacts (id, business_id, customer_id, display_name) VALUES ($1, $2, $3, $4)', [randomUUID(), id, customerId, `${slug}-contact-${i}`]);
    }
  }
}

async function rowExists(table: 'customers' | 'contacts', id: string) {
  const { rowCount } = await admin.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return rowCount === 1;
}

type Clean = { setting: string | null; pid: number; visible: number };
/** A query with NO tenant context on the single pooled connection (S4, S5, S10). */
async function inspectSingleConnection(): Promise<Clean> {
  const rows = await appSingle.$queryRaw<{ setting: string | null; pid: number; visible: bigint }[]>`
    SELECT current_setting('app.business_id', true) AS setting, pg_backend_pid() AS pid,
           (SELECT count(*) FROM customers) AS visible`;
  return { setting: rows[0]!.setting, pid: rows[0]!.pid, visible: Number(rows[0]!.visible) };
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

beforeAll(async () => {
  await admin.connect();
  await owner.connect();
  await seed();
}, 60_000);

afterAll(async () => {
  await Promise.all([app.$disconnect(), appSingle.$disconnect(), jobs.$disconnect()]);
  await admin.end();
  await owner.end();
});

describe('RLS spike (data-model §5.4)', () => {
  it('S1: set_config via $queryRaw returns the intended values; one connection and transaction for the whole unit of work', async () => {
    const user = randomUUID();
    const marker = randomUUID();
    const result = withTenant({ businessId: A, userId: user }, async (db) => {
      const probe = () => db.$queryRaw<{ business: string; user: string; txid: bigint; pid: number }[]>`
        SELECT current_setting('app.business_id') AS business, current_setting('app.user_id') AS user,
               txid_current() AS txid, pg_backend_pid() AS pid`;
      const first = (await probe())[0]!;
      // Model query, then raw: a row written by the model is visible to raw SQL only inside the same transaction.
      await db.customer.create({ data: { id: marker, businessId: A, displayName: 'S1 marker' } });
      const second = (await probe())[0]!;
      const seenRaw = await db.$queryRaw<{ id: string; same_tx: boolean }[]>`
        SELECT id::text, (xmin::text = (txid_current() % 4294967296)::text) AS same_tx FROM customers WHERE id = ${marker}::uuid`;
      const seenModel = await db.customer.findMany();
      const third = (await probe())[0]!;
      return { first, second, third, seenRaw, seenModelCount: seenModel.length };
    });
    const r = await result;
    expect(r.first).toMatchObject({ business: A, user });
    for (const later of [r.second, r.third]) {
      expect(later.business).toBe(A);
      expect(later.txid).toBe(r.first.txid);
      expect(later.pid).toBe(r.first.pid);
    }
    expect(r.seenRaw).toEqual([{ id: marker, same_tx: true }]);
    expect(r.seenModelCount).toBe(COUNTS[A]! + 1);
    await admin.query('DELETE FROM customers WHERE id = $1', [marker]);
  });

  it('S1: rejects a context that is not a server-verified UUID before touching the database', async () => {
    await expect(withTenant({ businessId: "x' OR 1=1 --" }, async () => 1)).rejects.toBeInstanceOf(TenantContextError);
  });

  it('S2: as bos_app with no context, every tenant table returns 0 rows and INSERT is rejected by RLS', async () => {
    const counts = await app.$queryRaw<{ businesses: bigint; customers: bigint; contacts: bigint }[]>`
      SELECT (SELECT count(*) FROM businesses) AS businesses, (SELECT count(*) FROM customers) AS customers,
             (SELECT count(*) FROM contacts) AS contacts`;
    expect(counts[0]).toEqual({ businesses: BigInt(0), customers: BigInt(0), contacts: BigInt(0) });
    expect(await app.customer.findMany()).toEqual([]);
    expect(await app.business.findMany()).toEqual([]);
    await expect(app.customer.create({ data: { id: randomUUID(), businessId: A, displayName: 'no context' } })).rejects.toThrow(/row-level security/i);
    await expect(app.$queryRaw`INSERT INTO contacts (id, business_id, display_name) VALUES (${randomUUID()}::uuid, ${A}::uuid, 'x') RETURNING id`).rejects.toThrow(/row-level security/i);
  });

  it('S4: no carry-over: after a unit of work, a query on the same pooled connection has no setting and sees 0 rows', async () => {
    const pidInside = await withTenantSingle(ctx(A), async (db) => {
      const rows = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(await db.customer.count()).toBe(COUNTS[A]);
      return rows[0]!.pid;
    });
    const after = await inspectSingleConnection();
    expect(after.pid).toBe(pidInside); // the same server connection, through the pooler
    expect(after.setting ?? '').toBe('');
    expect(after.visible).toBe(0);
  });

  it('S5: a unit of work that throws mid-way rolls back: no setting left behind, no partial writes', async () => {
    const id = randomUUID();
    let pidInside = 0;
    await expect(
      withTenantSingle(ctx(A), async (db) => {
        pidInside = (await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await db.customer.create({ data: { id, businessId: A, displayName: 'S5 partial' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await inspectSingleConnection();
    expect(after.pid).toBe(pidInside);
    expect(after.setting ?? '').toBe('');
    expect(after.visible).toBe(0);
    expect(await rowExists('customers', id)).toBe(false);
  });

  it('S6 + S12: 2,000 interleaved units of work across 3 businesses, pool size 5 behind the pooler, default statement handling: 0 leaks', async () => {
    const tenants = [A, B, C];
    const total = 2_000;
    const concurrency = 25;
    let next = 0;
    let leaks = 0;
    let completed = 0;
    const failures: string[] = [];
    async function worker() {
      while (next < total) {
        const i = next++;
        const businessId = tenants[i % tenants.length]!;
        try {
          await withTenant(ctx(businessId), async (db) => {
            const customers = await db.customer.findMany();
            if (i % 7 === 0) await db.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.002)`; // widen the interleaving window
            const raw = await db.$queryRaw<{ business_id: string }[]>`SELECT business_id::text FROM contacts`;
            const own = await db.business.findMany();
            const seen = [...customers.map((c) => c.businessId), ...raw.map((r) => r.business_id), ...own.map((b) => b.id)];
            leaks += seen.filter((id) => id !== businessId).length;
            if (customers.length !== COUNTS[businessId] || raw.length !== COUNTS[businessId] || own.length !== 1) {
              failures.push(`unit ${i}: expected ${COUNTS[businessId]} rows, saw ${customers.length}/${raw.length}/${own.length}`);
            }
          });
          completed++;
        } catch (error) {
          failures.push(`unit ${i}: ${(error as Error).message.trim().slice(0, 300)}`);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    expect(failures.slice(0, 5)).toEqual([]);
    expect(completed).toBe(total);
    expect(leaks).toBe(0);
  }, 180_000);

  it('S7: tagged $queryRaw inside withTenant is filtered by RLS exactly like model queries', async () => {
    await withTenant(ctx(A), async (db) => {
      const all = await db.$queryRaw<{ business_id: string }[]>`SELECT business_id::text FROM customers`;
      expect(all).toHaveLength(COUNTS[A]!);
      expect(new Set(all.map((r) => r.business_id))).toEqual(new Set([A]));
      const explicitOther = await db.$queryRaw<unknown[]>`SELECT id FROM customers WHERE business_id = ${B}::uuid`;
      expect(explicitOther).toEqual([]);
      const byId = await db.$queryRaw<unknown[]>`SELECT id FROM customers WHERE id = ${CUSTOMERS[B]![0]!}::uuid`;
      expect(byId).toEqual([]);
      expect(await db.customer.count()).toBe(all.length);
    });
  });

  it('S8: a write with another business id is rejected by the app-layer scope', async () => {
    await expect(
      withTenant(ctx(A), (db) => db.customer.create({ data: { id: randomUUID(), businessId: B, displayName: 'cross' } })),
    ).rejects.toBeInstanceOf(TenantScopeError);
    await expect(
      withTenant(ctx(A), (db) => db.customer.updateMany({ where: { businessId: B }, data: { displayName: 'cross' } })),
    ).rejects.toBeInstanceOf(TenantScopeError);
    await expect(
      withTenant(ctx(A), (db) => db.customer.update({ where: { id: CUSTOMERS[A]![0]! }, data: { businessId: B } })),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('S8: with the app-layer scope DISABLED, RLS alone rejects cross-tenant inserts, updates and deletes', async () => {
    const target = CUSTOMERS[B]![0]!;
    await expect(
      withRlsOnly(ctx(A), (db) => db.customer.create({ data: { id: randomUUID(), businessId: B, displayName: 'cross' } })),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      withRlsOnly(ctx(A), (db) => db.$queryRaw`INSERT INTO customers (id, business_id, display_name) VALUES (${randomUUID()}::uuid, ${B}::uuid, 'x') RETURNING id`),
    ).rejects.toThrow(/row-level security/i);
    // Moving an own row to another business violates WITH CHECK.
    await expect(
      withRlsOnly(ctx(A), (db) => db.customer.update({ where: { id: CUSTOMERS[A]![0]! }, data: { businessId: B } })),
    ).rejects.toThrow(/row-level security/i);
    // Another business's rows are invisible, so updates and deletes match nothing.
    const result = await withRlsOnly(ctx(A), async (db) => ({
      updated: await db.customer.updateMany({ where: { id: target }, data: { displayName: 'hijacked' } }),
      rawUpdated: await db.$queryRaw<unknown[]>`UPDATE customers SET display_name = 'hijacked' WHERE business_id = ${B}::uuid RETURNING id`,
      deleted: await db.contact.deleteMany({ where: { businessId: B } }),
      rawDeleted: await db.$queryRaw<unknown[]>`DELETE FROM customers WHERE id = ${target}::uuid RETURNING id`,
    }));
    expect(result).toEqual({ updated: { count: 0 }, rawUpdated: [], deleted: { count: 0 }, rawDeleted: [] });
    const { rows } = await admin.query('SELECT display_name FROM customers WHERE id = $1', [target]);
    expect(rows[0]?.display_name).toBe('b-customer-0');
  });

  it('S9: composite FKs reject linking a contact to another business’s customer even as bos_owner with RLS bypassed', async () => {
    await owner.query('BEGIN');
    try {
      // The owner bypasses RLS once FORCE is removed; prove it sees every business before the attack.
      await owner.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
      await owner.query('ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY');
      const { rows } = await owner.query<{ n: string }>('SELECT count(DISTINCT business_id) AS n FROM customers');
      expect(Number(rows[0]!.n)).toBe(5);
      await owner.query('SAVEPOINT attack');
      await expect(
        owner.query('INSERT INTO contacts (id, business_id, customer_id, display_name) VALUES ($1, $2, $3, $4)', [randomUUID(), A, CUSTOMERS[B]![0], 'cross-link']),
      ).rejects.toMatchObject({ code: '23503' });
      await owner.query('ROLLBACK TO SAVEPOINT attack');
      await expect(
        owner.query('UPDATE contacts SET customer_id = $1 WHERE business_id = $2', [CUSTOMERS[B]![0], A]),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await owner.query('ROLLBACK');
    }
    // The same holds for an administrative role that bypasses RLS entirely.
    await expect(
      admin.query('INSERT INTO contacts (id, business_id, customer_id, display_name) VALUES ($1, $2, $3, $4)', [randomUUID(), A, CUSTOMERS[B]![0], 'cross-link']),
    ).rejects.toMatchObject({ code: '23503' });
    const { rows } = await admin.query("SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('customers', 'contacts')");
    expect(rows.every((r) => r.forced)).toBe(true);
  });

  it('S10: a unit of work exceeding its timeout rolls back and the connection returns clean', async () => {
    const id = randomUUID();
    let pidInside = 0;
    await expect(
      withTenantSingle(
        ctx(A),
        async (db) => {
          pidInside = (await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
          await db.customer.create({ data: { id, businessId: A, displayName: 'S10 partial' } });
          await db.$queryRaw`SELECT 1 AS slept FROM pg_sleep(1.5)`;
          await db.customer.create({ data: { id: randomUUID(), businessId: A, displayName: 'S10 after timeout' } });
        },
        { timeoutMs: 500 },
      ),
    ).rejects.toThrow(/transaction|timeout|expired|closed/i);
    const after = await inspectSingleConnection();
    expect(after.pid).toBe(pidInside);
    expect(after.setting ?? '').toBe('');
    expect(after.visible).toBe(0);
    expect(await rowExists('customers', id)).toBe(false);
  });

  it('S11: measures added latency of withTenant vs a bare query (recorded in ADR 0004)', async () => {
    const rounds = 400;
    const bare: number[] = [];
    const wrapped: number[] = [];
    for (let i = 0; i < 20; i++) {
      await app.customer.findFirst();
      await withTenant(ctx(A), (db) => db.customer.findFirst());
    }
    for (let i = 0; i < rounds; i++) {
      let t = performance.now();
      await app.customer.findFirst();
      bare.push(performance.now() - t);
      t = performance.now();
      await withTenant(ctx(A), (db) => db.customer.findFirst());
      wrapped.push(performance.now() - t);
    }
    bare.sort((x, y) => x - y);
    wrapped.sort((x, y) => x - y);
    const report = {
      rounds,
      bareP50: percentile(bare, 50), bareP95: percentile(bare, 95),
      withTenantP50: percentile(wrapped, 50), withTenantP95: percentile(wrapped, 95),
      addedP50: percentile(wrapped, 50) - percentile(bare, 50),
      addedP95: percentile(wrapped, 95) - percentile(bare, 95),
    };
    console.log(`S11 overhead (ms): ${JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, Math.round(v * 1000) / 1000])))}`);
    // Target: < 2 ms p95 added. Reported for decision, not asserted (data-model §5.4).
    expect(report.rounds).toBe(rounds);
  }, 120_000);

  it('S13: the jobs role runs as bos_jobs and can read and delete only a purgeable business’s rows', async () => {
    const who = await withTenant({ businessId: PURGEABLE }, (db) => db.$queryRaw<{ u: string }[]>`SELECT current_user AS u`, { role: 'jobs' });
    expect(who[0]!.u).toBe('bos_jobs');

    // Active and recently archived businesses: nothing visible, nothing deletable.
    for (const businessId of [A, RECENT]) {
      const seen = await withTenant({ businessId }, async (db) => ({
        customers: await db.customer.count(),
        contacts: await db.contact.count(),
        business: await db.business.count(),
        deleted: (await db.contact.deleteMany({})).count + (await db.customer.deleteMany({})).count,
      }), { role: 'jobs' });
      expect(seen).toEqual({ customers: 0, contacts: 0, business: 0, deleted: 0 });
    }

    // No INSERT or UPDATE, even for a purgeable business.
    await expect(
      withTenant({ businessId: PURGEABLE }, (db) => db.customer.create({ data: { id: randomUUID(), businessId: PURGEABLE, displayName: 'job write' } }), { role: 'jobs' }),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant({ businessId: PURGEABLE }, (db) => db.customer.updateMany({ data: { displayName: 'job write' } }), { role: 'jobs' }),
    ).rejects.toThrow(/permission denied/i);

    // Purgeable business: readable and deletable, and only its own rows.
    const purged = await withTenant({ businessId: PURGEABLE }, async (db) => {
      const visible = await db.customer.findMany();
      const contacts = await db.contact.deleteMany({});
      const customers = await db.customer.deleteMany({});
      const business = await db.business.deleteMany({});
      return { visible: visible.map((c) => c.businessId), contacts: contacts.count, customers: customers.count, business: business.count };
    }, { role: 'jobs' });
    expect(purged).toEqual({
      visible: Array(COUNTS[PURGEABLE]).fill(PURGEABLE),
      contacts: COUNTS[PURGEABLE],
      customers: COUNTS[PURGEABLE],
      business: 1,
    });
    const { rows } = await admin.query<{ business_id: string; n: string }>('SELECT business_id::text, count(*) AS n FROM customers GROUP BY business_id');
    const remaining = Object.fromEntries(rows.map((r) => [r.business_id, Number(r.n)]));
    expect(remaining).toEqual({ [A]: COUNTS[A], [B]: COUNTS[B], [C]: COUNTS[C], [RECENT]: COUNTS[RECENT] });
  });
});
