/**
 * People P3-C1: the leave ledger core (docs/people-leave-p3c-ledger-architecture.md §C, §I, §J, §K; plan in
 * docs/people-leave-p3c1.md). Real PostgreSQL with the migrations applied as in production, direct SQL as the
 * real bos_app role (level S) and the internal posting primitive through withTenant (level I). Covers the C1
 * acceptance set: T-C01..T-C09e, T-C10 (system keys), T-C40, T-C41, T-C42c, T-C42d, T-C42e (trigger and
 * deferred-check parts), T-C47, T-C62, T-C63, T-C64, plus the stage gate, the DAYS refusal (revised
 * D-P3C-23), the read-policy drift test and the verifier V-01..V-07.
 *
 * Request and manual kinds are refused by the C1 stage gate, so the few fixtures that need a reservation,
 * an adjustment or a reversed consumption are written by a superuser with only the stage-gate trigger
 * disabled for that one transaction; every other guard and deferred check still runs on them.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/core/db';
import { ROLE_PERMISSIONS } from '@/modules/access/server/permissions';
import {
  bucketTotals, postDerived, takeSeal, transactionsBetweenSeals, verifyLedger, type DerivedPosting, type EntryInput,
} from '@/modules/people/server/leave-ledger';
import { backendPid, waitUntilBlocked } from './support/locks';

const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ownerUrl = process.env.MIGRATION_DATABASE_URL!.replace(/\?.*$/, '');
const MIGRATION = readFileSync(resolve(__dirname, '../../prisma/migrations/20261211000000_people_leave_ledger/migration.sql'), 'utf8');

beforeAll(async () => { await admin.connect(); });
afterAll(async () => { await admin.end(); await app.end(); });

const TABLES = ['people_leave_accounts', 'people_leave_buckets', 'people_leave_transactions', 'people_leave_entries', 'people_leave_authorisations'];
const Y1 = { start: '2025-01-01', end: '2026-01-01' };
const Y2 = { start: '2026-01-01', end: '2027-01-01' };
const Y3 = { start: '2027-01-01', end: '2028-01-01' };

// ---- fixtures ------------------------------------------------------------------------------------

type Fixture = Awaited<ReturnType<typeof business>>;

async function user(label: string) {
  const id = randomUUID();
  await admin.query('INSERT INTO users (id, email, email_verified, name, updated_at) VALUES ($1, $2, true, $3, now())', [id, `${label}-${id}@example.com`, label]);
  return id;
}

async function policy(businessId: string, leaveTypeId: string, rules: Record<string, unknown>) {
  const id = randomUUID();
  const r = { unit: 'HOURS', granularity: 'HOUR', entitlement_method: 'ACCRUAL', entitlement_amount: 152, accrual_frequency: 'MONTHLY',
    year_start: 'CALENDAR', carryover: 'NONE', carryover_cap: null, ...rules };
  await admin.query(
    `INSERT INTO people_leave_policies (id, business_id, leave_type_id, name, unit, granularity, entitlement_method, entitlement_amount,
       accrual_frequency, year_start, carryover, carryover_cap) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, businessId, leaveTypeId, `Policy ${id.slice(0, 8)}`, r.unit, r.granularity, r.entitlement_method, r.entitlement_amount,
      r.accrual_frequency, r.year_start, r.carryover, r.carryover_cap]);
  return id;
}

/** A business with one member per role, an employee linked to a MEMBER ("self"), one unlinked employee,
 *  a suspended ADMIN, an ordinary and a sensitive leave type, and HOURS policies of every carry rule. */
async function business(label: string, timeZone = 'Australia/Perth') {
  const id = randomUUID();
  await admin.query(`INSERT INTO businesses (id, name, slug, country_code, time_zone, locale, currency, home_region)
                     VALUES ($1, $2, $3, 'AU', $4, 'en-AU', 'AUD', 'ci')`, [id, `Ledger ${label}`, `${label}-${id.slice(0, 8)}`, timeZone]);
  const u: Record<string, string> = {};
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'SELF', 'SUSPENDED']) {
    u[role] = await user(`${label}-${role.toLowerCase()}`);
    const dbRole = role === 'SELF' ? 'MEMBER' : role === 'SUSPENDED' ? 'ADMIN' : role;
    await admin.query(
      `INSERT INTO memberships (id, business_id, user_id, role, status, suspended_at, suspended_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), id, u[role], dbRole, role === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE', role === 'SUSPENDED' ? new Date() : null,
        role === 'SUSPENDED' ? u.OWNER : null]);
  }
  const e1 = randomUUID();
  const e2 = randomUUID();
  await admin.query(`INSERT INTO people_employees (id, business_id, given_name, family_name, status, start_date, user_id)
                     VALUES ($1, $3, 'Sam', 'Self', 'ACTIVE', '2024-01-01', $4), ($2, $3, 'Olive', 'Other', 'ACTIVE', '2024-01-01', NULL)`,
  [e1, e2, id, u.SELF]);
  const annual = randomUUID();
  const sick = randomUUID();
  await admin.query(`INSERT INTO people_leave_types (id, business_id, name, category, paid, sensitive)
                     VALUES ($1, $3, 'Annual', 'ANNUAL', true, false), ($2, $3, 'Sick', 'SICK', true, true)`, [annual, sick, id]);
  const pol = {
    capped: await policy(id, annual, { carryover: 'CAPPED', carryover_cap: 100 }),
    none: await policy(id, annual, { entitlement_method: 'GRANT', entitlement_amount: 76, accrual_frequency: null, carryover: 'NONE' }),
    unlimited: await policy(id, annual, { entitlement_method: 'GRANT', entitlement_amount: 76, accrual_frequency: null, carryover: 'UNLIMITED' }),
    days: await policy(id, annual, { unit: 'DAYS', granularity: 'FULL_DAY', entitlement_amount: 20 }),
    noBalance: await policy(id, annual, { entitlement_method: 'NONE', entitlement_amount: null, accrual_frequency: null, year_start: null }),
    sickCapped: await policy(id, sick, { carryover: 'CAPPED', carryover_cap: 100 }),
  };
  return { id, u, e1, e2, annual, sick, pol, timeZone };
}

// ---- database helpers ----------------------------------------------------------------------------

type Ctx = { businessId: string; userId?: string | null };

/** One unit of work as the real bos_app role with transaction-local context, committed unless `rollback`. */
async function as<T>(ctx: Ctx, work: (c: pg.PoolClient) => Promise<T>, opts: { rollback?: boolean } = {}): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [ctx.businessId, ctx.userId ?? '']);
    const out = await work(c);
    await c.query(opts.rollback ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** A superuser unit of work with only the C1 stage gate lifted (fixtures for request and manual kinds). */
async function gated<T>(ctx: Ctx, work: (c: pg.Client) => Promise<T>): Promise<T> {
  await admin.query('BEGIN');
  try {
    await admin.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [ctx.businessId, ctx.userId ?? '']);
    await admin.query('ALTER TABLE people_leave_transactions DISABLE TRIGGER people_leave_transactions_stage_gate');
    const out = await work(admin);
    // Run the deferred checks now: a table with pending trigger events cannot be altered.
    await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
    await admin.query('ALTER TABLE people_leave_transactions ENABLE TRIGGER people_leave_transactions_stage_gate');
    await admin.query('COMMIT');
    return out;
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

const sqlState = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'ok';
};

type Q = pg.ClientBase;
const bump = (c: Q, accountId: string) => c.query('UPDATE people_leave_accounts SET version = version + 1 WHERE id = $1', [accountId]);

interface TxIn { account: string; employee: string; type: string; kind: string; key: string; basis?: string; source?: string;
  related?: string | null; sensitive?: boolean; reason?: string | null; actor?: string }
async function tx(c: Q, t: TxIn): Promise<string> {
  const id = randomUUID();
  const source = t.source ?? ({ ACCRUAL: 'POLICY_ACCRUAL', YEAR_OPEN: 'YEAR_BOUNDARY', CONSUME: 'LEAVE_REQUEST', FREEZE: 'EMPLOYMENT',
    CARRY_PROPAGATION: 'TRANSACTION', RESERVE: 'LEAVE_REQUEST', REVERSE_CONSUMPTION: 'LEAVE_REQUEST' } as Record<string, string>)[t.kind] ?? 'MANUAL';
  await c.query(
    `INSERT INTO people_leave_transactions (id, business_id, account_id, employee_id, leave_type_id, kind, idempotency_key, source_kind,
       related_transaction_id, reason_code, actor_user_id, actor_basis, posted_on, account_version, sensitive)
     VALUES ($1, current_setting('app.business_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, DATE '2000-01-01', 0, $12)`,
    [id, t.account, t.employee, t.type, t.kind, t.key, source, t.related ?? null, t.reason ?? null, t.actor ?? randomUUID(),
      t.basis ?? 'DERIVED', t.sensitive ?? false]);
  return id;
}
async function bucket(c: Q, a: { account: string; employee: string; type: string; year: { start: string; end: string }; state?: string; id?: string; period?: number }) {
  const id = a.id ?? randomUUID();
  await c.query(`INSERT INTO people_leave_buckets (id, business_id, account_id, employee_id, leave_type_id, service_period, year_start, year_end, state)
                 VALUES ($1, current_setting('app.business_id')::uuid, $2, $3, $4, $5, $6, $7, $8)`,
  [id, a.account, a.employee, a.type, a.period ?? 1, a.year.start, a.year.end, a.state ?? 'OPEN']);
  return id;
}
const setState = (c: Q, bucketId: string, state: string) =>
  c.query('UPDATE people_leave_buckets SET state = $2, version = version + 1 WHERE id = $1', [bucketId, state]);

interface EntryRow { id?: string; tx: string; account: string; bucket: string; employee: string; type: string; book?: string; kind: string; hours: string;
  appliesOn: string; leaveDate?: string | null; periodStart?: string | null; periodEnd?: string | null; policy: string; version?: number;
  reverses?: string | null; reservation?: string | null; pair?: string | null; release?: string | null; expiry?: string | null; sensitive?: boolean;
  hoursPerDay?: string | null }
async function entries(c: Q, rows: EntryRow[]): Promise<string[]> {
  const ids = rows.map((r) => r.id ?? randomUUID());
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const v = [ids[i], r.tx, r.account, r.bucket, r.employee, r.type, r.book ?? (['RESERVATION', 'RESERVATION_RELEASE'].includes(r.kind) ? 'RESERVED' : 'BALANCE'),
      r.kind, r.hours, r.appliesOn, r.leaveDate ?? null, r.periodStart ?? null, r.periodEnd ?? null, r.policy, r.version ?? 1, r.reverses ?? null,
      r.reservation ?? null, r.pair ?? null, r.release ?? null, r.expiry ?? null, r.sensitive ?? false, r.hoursPerDay ?? null];
    const base = values.length;
    values.push(...v);
    return `(${v.map((_, j) => `$${base + j + 1}`).join(', ')}, current_setting('app.business_id')::uuid)`;
  });
  await c.query(
    `INSERT INTO people_leave_entries (id, transaction_id, account_id, bucket_id, employee_id, leave_type_id, book, kind, hours, applies_on, leave_date,
       period_start, period_end, policy_id, policy_version, reverses_entry_id, reservation_entry_id, pair_entry_id, release_reason, expiry_reason,
       sensitive, hours_per_day, business_id) VALUES ${tuples.join(', ')}`, values);
  return ids;
}

const own = (f: Fixture): Ctx => ({ businessId: f.id, userId: f.u.OWNER });
const viaApp = <T>(ctx: Ctx, work: Parameters<typeof withTenant<T>>[1]) => withTenant<T>({ businessId: ctx.businessId, userId: ctx.userId ?? null }, work, { timeoutMs: 20_000 });

/** An accrual of `hours` for a period inside a year (posted by the primitive). */
function accrual(f: Fixture, a: { bucketId: string; hours: string; periodStart: string; periodEnd: string; policy?: string; create?: { year: typeof Y1; state?: 'OPEN' | 'FUTURE' }; type?: string; employee?: string }): DerivedPosting {
  const appliesOn = new Date(Date.parse(`${a.periodEnd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return {
    employeeId: a.employee ?? f.e1, leaveTypeId: a.type ?? f.annual, kind: 'ACCRUAL',
    idempotencyKey: (acc) => `ac:${acc}:1:${a.periodStart}`,
    bucketChanges: a.create ? [{ create: { id: a.bucketId, servicePeriod: 1, yearStart: a.create.year.start, yearEnd: a.create.year.end, state: a.create.state ?? 'OPEN' } }] : [],
    entries: [{ id: randomUUID(), bucketId: a.bucketId, book: 'BALANCE', kind: 'ACCRUAL', hours: a.hours, appliesOn, periodStart: a.periodStart,
      periodEnd: a.periodEnd, policyId: a.policy ?? f.pol.capped, policyVersion: 1 }],
  };
}

/** YEAR_OPEN closing `from` into a new OPEN year `to` with a carry pair (if carry ≠ 0) and a lapse (if lapse ≠ 0). */
function yearOpen(f: Fixture, a: { from: string; to: string; toYear: typeof Y2; carry: string; lapse?: string; policy?: string; type?: string; employee?: string; toExists?: boolean }): DerivedPosting {
  const policyId = a.policy ?? f.pol.capped;
  const out = randomUUID();
  const inn = randomUUID();
  const e: EntryInput[] = [];
  const outDay = new Date(Date.parse(`${a.toYear.start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (Number(a.carry) !== 0) {
    e.push({ id: out, bucketId: a.from, book: 'BALANCE', kind: 'CARRY_OUT', hours: neg(a.carry), appliesOn: outDay, pairEntryId: inn, policyId, policyVersion: 1 });
    e.push({ id: inn, bucketId: a.to, book: 'BALANCE', kind: 'CARRY_IN', hours: a.carry, appliesOn: a.toYear.start, pairEntryId: out, policyId, policyVersion: 1 });
  }
  if (a.lapse) e.push({ id: randomUUID(), bucketId: a.from, book: 'BALANCE', kind: 'EXPIRY', expiryReason: 'CARRY_CAP', hours: a.lapse, appliesOn: outDay, policyId, policyVersion: 1 });
  return {
    employeeId: a.employee ?? f.e1, leaveTypeId: a.type ?? f.annual, kind: 'YEAR_OPEN', idempotencyKey: `yo:${a.to}`,
    bucketChanges: [{ bucketId: a.from, to: 'CLOSED' },
      a.toExists ? { bucketId: a.to, to: 'OPEN' } : { create: { id: a.to, servicePeriod: 1, yearStart: a.toYear.start, yearEnd: a.toYear.end, state: 'OPEN' } }],
    entries: e,
  };
}
const neg = (h: string) => (h.startsWith('-') ? h.slice(1) : `-${h}`);

/** Year 1 with `closing` hours accrued, closed into year 2 under the capped policy (cap 100). */
async function closedYear(f: Fixture, closing: string, opts: { type?: string; policy?: string; employee?: string } = {}) {
  const y1 = randomUUID();
  const y2 = randomUUID();
  const ctx = own(f);
  await viaApp(ctx, (db) => postDerived(db, accrual(f, { bucketId: y1, hours: closing, periodStart: '2025-12-01', periodEnd: '2026-01-01', create: { year: Y1 },
    policy: opts.policy, type: opts.type, employee: opts.employee })));
  const c = Number(closing);
  const carry = String(Math.min(c, 100));
  const lapse = c > 100 ? String(100 - c) : undefined;
  const yo = await viaApp(ctx, (db) => postDerived(db, yearOpen(f, { from: y1, to: y2, toYear: Y2, carry, lapse, policy: opts.policy, type: opts.type, employee: opts.employee })));
  return { y1, y2, accountId: yo.accountId, yearOpenTx: yo.transactionId };
}

/** Reservation dates posted by a gated RESERVE (C3 kind) fixture, returning the reservation entry ids. */
async function reserve(f: Fixture, a: { account: string; bucket: string; dates: [string, string][]; policy?: string; type?: string; employee?: string; createYear?: typeof Y1; state?: string }) {
  return gated(own(f), async (c) => {
    await bump(c, a.account);
    const t = await tx(c, { account: a.account, employee: a.employee ?? f.e1, type: a.type ?? f.annual, kind: 'RESERVE', key: `rs:${randomUUID()}`, basis: 'LEAVE_MANAGER' });
    if (a.createYear) await bucket(c, { id: a.bucket, account: a.account, employee: a.employee ?? f.e1, type: a.type ?? f.annual, year: a.createYear, state: a.state ?? 'OPEN' });
    return entries(c, a.dates.map(([d, h]) => ({ tx: t, account: a.account, bucket: a.bucket, employee: a.employee ?? f.e1, type: a.type ?? f.annual,
      kind: 'RESERVATION', hours: h, appliesOn: '2025-01-01', leaveDate: d, policy: a.policy ?? f.pol.capped })));
  });
}

/** The same business with a fresh linked employee (and its own MEMBER user) and a fresh unlinked one, so every
 *  test starts from empty leave accounts: a leave year of one account and service period may not overlap. */
async function refresh(f: Fixture): Promise<Fixture> {
  const self = await user('self');
  await admin.query(`INSERT INTO memberships (id, business_id, user_id, role, status) VALUES ($1, $2, $3, 'MEMBER', 'ACTIVE')`, [randomUUID(), f.id, self]);
  const e1 = randomUUID();
  const e2 = randomUUID();
  await admin.query(`INSERT INTO people_employees (id, business_id, given_name, family_name, status, start_date, user_id)
                     VALUES ($1, $3, 'Sam', 'Self', 'ACTIVE', '2024-01-01', $4), ($2, $3, 'Olive', 'Other', 'ACTIVE', '2024-01-01', NULL)`,
  [e1, e2, f.id, self]);
  return { ...f, u: { ...f.u, SELF: self }, e1, e2 };
}

let A0: Fixture;
let B0: Fixture;
let A: Fixture;
let B: Fixture;
beforeAll(async () => {
  A0 = await business('lla');
  B0 = await business('llb', 'America/New_York');
}, 60_000);
beforeEach(async () => {
  A = await refresh(A0);
  B = await refresh(B0);
});

// ---- T-C01, T-C41: schema, RLS, grants ---------------------------------------------------------------

describe('schema, row-level security and least privilege (T-C01, T-C41)', () => {
  it('every ledger table forces RLS with tenant_isolation and a restrictive read policy, and leads its indexes with business_id', async () => {
    const forced = await admin.query('SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity', [TABLES]);
    expect(forced.rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    const policies = await admin.query(`SELECT tablename, policyname, permissive, cmd FROM pg_policies WHERE tablename = ANY($1) ORDER BY 1, 2`, [TABLES]);
    for (const t of TABLES) {
      expect(policies.rows.filter((p) => p.tablename === t).map((p) => [p.policyname, p.permissive, p.cmd])).toEqual([
        ['leave_read', 'RESTRICTIVE', 'SELECT'], ['tenant_isolation', 'PERMISSIVE', 'ALL']]);
    }
    const idx = await admin.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1) AND indexname NOT LIKE '%_pkey'`, [TABLES]);
    for (const r of idx.rows) expect(r.indexdef, r.indexname).toMatch(/\(business_id[,)]/);
  });

  it('bos_app has SELECT/INSERT only, UPDATE only on the listed columns, no DELETE or TRUNCATE; bos_jobs nothing', async () => {
    const t = await admin.query(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
                                  WHERE grantee = 'bos_app' AND table_name = ANY($1) ORDER BY 1, 2`, [TABLES]);
    expect(t.rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([
      'people_leave_accounts:INSERT', 'people_leave_accounts:SELECT', 'people_leave_authorisations:SELECT',
      'people_leave_buckets:INSERT', 'people_leave_buckets:SELECT', 'people_leave_entries:INSERT', 'people_leave_entries:SELECT',
      'people_leave_transactions:INSERT', 'people_leave_transactions:SELECT']);
    const cols = await admin.query(`SELECT table_name, column_name FROM information_schema.column_privileges
                                     WHERE grantee = 'bos_app' AND privilege_type = 'UPDATE' AND table_name = ANY($1) ORDER BY 1, 2`, [TABLES]);
    expect(cols.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'people_leave_accounts.updated_at', 'people_leave_accounts.version',
      'people_leave_buckets.closed_at', 'people_leave_buckets.opened_at', 'people_leave_buckets.state', 'people_leave_buckets.version']);
    const jobs = await admin.query(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee IN ('bos_jobs', 'bos_auth') AND table_name = ANY($1)`, [TABLES]);
    expect(jobs.rows[0].n).toBe(0);
  });

  it('read-policy drift: the business-wide branch names exactly the roles holding people:manage and people:read_sensitive', async () => {
    const roles = Object.entries(ROLE_PERMISSIONS).filter(([, p]) => p.has('people:manage') && p.has('people:read_sensitive')).map(([r]) => r).sort();
    expect(roles).toEqual(['ADMIN', 'OWNER']);
    const def = (await admin.query("SELECT pg_get_functiondef('people_leave_can_read(uuid, uuid, boolean, text)'::regprocedure) AS d")).rows[0].d as string;
    expect(def).toContain(`IF v_role IN (${roles.reverse().map((r) => `'${r}'`).join(', ')}) THEN`);
    expect(def.match(/v_role IN/g)).toHaveLength(1);
  });
});

// ---- T-C02, T-C03, T-C04: constraints, immutability --------------------------------------------------

describe('constraints (T-C02, T-C03) and immutability (T-C04)', () => {
  /** Inserts one entry as a superuser with user triggers off, so only FKs and CHECKs decide (rolled back). */
  async function raw(fixture: Fixture, patch: (base: Record<string, unknown>) => Record<string, unknown>) {
    const f = await refresh(fixture); // fresh accounts per attempt: each posts the same derived key
    const ctx = own(f);
    const y1 = randomUUID();
    const post = await viaApp(ctx, (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const other = await viaApp(ctx, (db) => postDerived(db, accrual(f, { bucketId: randomUUID(), hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01',
      create: { year: Y1 }, employee: f.e2 })));
    const otherBucket = (await admin.query('SELECT id FROM people_leave_buckets WHERE account_id = $1', [other.accountId])).rows[0].id;
    const base: Record<string, unknown> = { id: randomUUID(), business_id: f.id, transaction_id: post.transactionId, account_id: post.accountId, bucket_id: y1,
      employee_id: f.e1, leave_type_id: f.annual, book: 'BALANCE', kind: 'ADJUSTMENT', hours: '1', applies_on: '2025-03-01', policy_id: f.pol.capped,
      policy_version: 1, sensitive: false };
    const row = patch({ ...base, _other: { account: other.accountId, bucket: otherBucket, tx: other.transactionId } });
    delete row._other;
    const keys = Object.keys(row);
    await admin.query('BEGIN');
    try {
      await admin.query('ALTER TABLE people_leave_entries DISABLE TRIGGER USER');
      return await sqlState(admin.query(`INSERT INTO people_leave_entries (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => row[k])));
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  const other = (r: Record<string, unknown>) => r._other as { account: string; bucket: string; tx: string };

  it('composite FKs refuse cross-employee, cross-type, cross-account and cross-policy-type links (T-C02)', async () => {
    expect(await raw(A, (r) => r)).toBe('ok');
    expect(await raw(A, (r) => ({ ...r, employee_id: A.e2 }))).toBe('23503');
    expect(await raw(A, (r) => ({ ...r, leave_type_id: A.sick }))).toBe('23503');
    expect(await raw(A, (r) => ({ ...r, bucket_id: other(r).bucket }))).toBe('23503');
    expect(await raw(A, (r) => ({ ...r, transaction_id: other(r).tx }))).toBe('23503');
    expect(await raw(A, (r) => ({ ...r, policy_id: A.pol.sickCapped }))).toBe('23503');
    expect(await raw(A, (r) => ({ ...r, policy_version: 99 }))).toBe('23503');
    expect(await raw(A, (r) => ({ ...r, policy_id: B.pol.capped }))).toBe('23503');
  });

  it('kind/book/sign CHECKs; zero refused; positive EXPIRY refused (T-C03)', async () => {
    expect(await raw(A, (r) => ({ ...r, hours: '0' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, book: 'RESERVED' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, kind: 'GRANT', hours: '-1' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, kind: 'EXPIRY', expiry_reason: 'MANUAL', hours: '1' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, kind: 'EXPIRY', hours: '-1' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, kind: 'CONSUMPTION', hours: '-1' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, kind: 'ACCRUAL', hours: '1' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, leave_date: '2025-03-01' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, kind: 'CARRY_IN' }))).toBe('23514');
    expect(await raw(A, (r) => ({ ...r, hours: '100000000' }))).toBe('22003');
  });

  it('a leave date outside its year is refused by the guard (T-C03)', async () => {
    const y1 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const [r] = await reserve(A, { account: res.accountId, bucket: y1, dates: [['2025-03-03', '7.6']] });
    expect(await sqlState(reserve(A, { account: res.accountId, bucket: y1, dates: [['2026-01-02', '7.6']] }))).toBe('PE016');
    expect(r).toBeDefined();
  });

  it('transactions and entries refuse UPDATE and DELETE; accounts and buckets keep their identity (T-C04)', async () => {
    const y1 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const ctx = own(A);
    expect(await sqlState(as(ctx, (c) => c.query('UPDATE people_leave_entries SET hours = 99 WHERE transaction_id = $1', [res.transactionId])))).toBe('42501');
    expect(await sqlState(as(ctx, (c) => c.query('UPDATE people_leave_transactions SET sensitive = true WHERE id = $1', [res.transactionId])))).toBe('42501');
    expect(await sqlState(as(ctx, (c) => c.query('DELETE FROM people_leave_entries WHERE transaction_id = $1', [res.transactionId])))).toBe('42501');
    expect(await sqlState(as(ctx, (c) => c.query('DELETE FROM people_leave_transactions WHERE id = $1', [res.transactionId])))).toBe('42501');
    expect(await sqlState(as(ctx, (c) => c.query('DELETE FROM people_leave_accounts WHERE id = $1', [res.accountId])))).toBe('42501');
    expect(await sqlState(as(ctx, (c) => c.query('UPDATE people_leave_accounts SET employee_id = $2 WHERE id = $1', [res.accountId, A.e2])))).toBe('42501');
    // The owner role is not bound by grants; the guards still refuse.
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      for (const stmt of ['UPDATE people_leave_entries SET hours = 99 WHERE transaction_id = $1', 'UPDATE people_leave_transactions SET sensitive = true WHERE id = $1']) {
        await owner.query('BEGIN');
        await owner.query('ALTER TABLE people_leave_entries NO FORCE ROW LEVEL SECURITY');
        await owner.query('ALTER TABLE people_leave_transactions NO FORCE ROW LEVEL SECURITY');
        expect(await sqlState(owner.query(stmt, [res.transactionId]))).toBe('PE013');
        await owner.query('ROLLBACK');
      }
    } finally {
      await owner.end();
    }
  });

  it('bucket state machine: CLOSED and FROZEN are final; transitions need their transaction kind; years never overlap (T-C04)', async () => {
    const ctx = own(A);
    const { y1, y2, accountId } = await closedYear(A, '40', { employee: A.e2 });
    const base = { account: accountId, employee: A.e2, type: A.annual };
    // CLOSED → OPEN refused, even inside a YEAR_OPEN.
    expect(await sqlState(as(ctx, async (c) => {
      await bump(c, accountId);
      await tx(c, { ...base, kind: 'YEAR_OPEN', key: `yo:${randomUUID()}` });
      await setState(c, y1, 'OPEN');
    }))).toBe('PE016');
    // OPEN → CLOSED outside a YEAR_OPEN refused.
    expect(await sqlState(as(ctx, async (c) => {
      await bump(c, accountId);
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${accountId}:1:2026-02-01` });
      await setState(c, y2, 'CLOSED');
    }))).toBe('PE016');
    // Overlapping year refused; a year created outside a ledger transaction refused.
    expect(await sqlState(as(ctx, async (c) => {
      await bump(c, accountId);
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${accountId}:1:2026-03-01` });
      await bucket(c, { ...base, year: { start: '2026-06-01', end: '2027-06-01' }, state: 'FUTURE' });
    }))).toBe('PE016');
    expect(await sqlState(as(ctx, async (c) => {
      await bump(c, accountId);
      await bucket(c, { ...base, year: Y3, state: 'FUTURE' });
    }))).toBe('PE016');
    // A second OPEN year of the same service period refused by the unique index.
    expect(await sqlState(as(ctx, async (c) => {
      await bump(c, accountId);
      await tx(c, { ...base, kind: 'YEAR_OPEN', key: `yo:${randomUUID()}` });
      await bucket(c, { ...base, year: Y3, state: 'OPEN' });
    }))).toBe('23505');
  });
});

// ---- T-C05, T-C47: lock proof and provenance --------------------------------------------------------

describe('lock proof (T-C05) and provenance (T-C47)', () => {
  it('a transaction or entry without the account bump in this database transaction is refused', async () => {
    const y1 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const base = { account: res.accountId, employee: A.e1, type: A.annual };
    // No bump at all.
    expect(await sqlState(as(own(A), (c) => tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-02-01` })))).toBe('PE014');
    // FOR UPDATE alone is not the bump.
    expect(await sqlState(as(own(A), async (c) => {
      await c.query('SELECT 1 FROM people_leave_accounts WHERE id = $1 FOR UPDATE', [res.accountId]);
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-02-01` });
    }))).toBe('PE014');
    // A bump inside a savepoint carries a subtransaction id: refused (fail closed).
    expect(await sqlState(as(own(A), async (c) => {
      await c.query('SAVEPOINT s');
      await bump(c, res.accountId);
      await c.query('RELEASE SAVEPOINT s');
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-02-01` });
    }))).toBe('PE014');
    // A bump without a transaction cannot commit (V-06 at write time); two transactions on one bump neither.
    expect(await sqlState(as(own(A), (c) => bump(c, res.accountId)))).toBe('PE017');
    expect(await sqlState(as(own(A), async (c) => {
      await bump(c, res.accountId);
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-02-01` });
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-03-01` });
    }))).toBe('23505');
    // Entries cannot be appended to a transaction committed earlier.
    expect(await sqlState(as(own(A), async (c) => {
      await bump(c, res.accountId);
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-02-01` });
      await entries(c, [{ tx: res.transactionId, account: res.accountId, bucket: y1, employee: A.e1, type: A.annual, kind: 'ACCRUAL', hours: '1',
        appliesOn: '2025-02-28', periodStart: '2025-02-01', periodEnd: '2025-03-01', policy: A.pol.capped }]);
    }))).toBe('PE016');
  });

  it('actor, business date, recorded xid and account version come from the database; a missing app.user_id fails closed', async () => {
    const y1 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const row = (await admin.query(`SELECT actor_user_id, actor_basis, posted_on::text, account_version, recorded_xid::text,
                                           (now() AT TIME ZONE 'Australia/Perth')::date::text AS today FROM people_leave_transactions WHERE id = $1`, [res.transactionId])).rows[0];
    expect(row).toMatchObject({ actor_user_id: A.u.OWNER, actor_basis: 'DERIVED', account_version: 2, posted_on: row.today });
    expect(row.recorded_xid).toMatch(/^\d+$/);
    // The statement's actor (a random id in the tx helper) is ignored.
    const res2 = await as(own(A), async (c) => {
      await bump(c, res.accountId);
      const id = await tx(c, { account: res.accountId, employee: A.e1, type: A.annual, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-02-01`, actor: A.u.MEMBER });
      await entries(c, [{ tx: id, account: res.accountId, bucket: y1, employee: A.e1, type: A.annual, kind: 'ACCRUAL', hours: '1', appliesOn: '2025-02-28',
        periodStart: '2025-02-01', periodEnd: '2025-03-01', policy: A.pol.capped }]);
      return id;
    });
    expect((await admin.query('SELECT actor_user_id FROM people_leave_transactions WHERE id = $1', [res2])).rows[0].actor_user_id).toBe(A.u.OWNER);
    expect(await sqlState(viaApp({ businessId: A.id, userId: null }, (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-03-01', periodEnd: '2025-04-01' })))))
      .not.toBe('ok');
    expect(await sqlState(as({ businessId: A.id, userId: null }, async (c) => {
      await c.query("SELECT set_config('app.user_id', $1, true)", [A.u.OWNER]);
      await bump(c, res.accountId);
      await c.query("SELECT set_config('app.user_id', '', true)");
      await tx(c, { account: res.accountId, employee: A.e1, type: A.annual, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-03-01` });
    }))).toBe('PE019');
  });
});

// ---- T-C09c: kind/basis matrix and stage gate -------------------------------------------------------

describe('kind/basis matrix and the C1 stage gate (T-C09c)', () => {
  it('request and manual kinds are refused; DERIVED on a manual kind and a manual basis on a derived kind are refused', async () => {
    const y1 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const base = { account: res.accountId, employee: A.e1, type: A.annual };
    const attempt = (t: Partial<TxIn>) => sqlState(as(own(A), async (c) => {
      await bump(c, res.accountId);
      await tx(c, { ...base, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-05-01`, ...t });
    }));
    for (const kind of ['RESERVE', 'RELEASE', 'REVERSE_CONSUMPTION']) expect(await attempt({ kind, key: `k:${randomUUID()}`, basis: 'LINE_MANAGER', reason: 'LEAVE_NOT_TAKEN' })).toBe('PE015');
    for (const kind of ['ADJUSTMENT', 'CORRECTION', 'EXPIRY', 'OPENING_BALANCE', 'IMPORT']) {
      expect(await attempt({ kind, key: `k:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'GOODWILL' })).toBe('PE015');
    }
    expect(await attempt({ kind: 'ADJUSTMENT', key: `k:${randomUUID()}`, basis: 'DERIVED', reason: 'GOODWILL' })).toBe('PE016');
    expect(await attempt({ basis: 'LEAVE_MANAGER' })).toBe('PE016');
    expect(await attempt({ basis: 'SELF' })).toBe('PE016');
    // Derived keys have their derived shape and name this account.
    expect(await attempt({ key: `ac:${randomUUID()}:1:2025-05-01` })).toBe('PE016');
    expect(await attempt({ key: 'free-form' })).toBe('PE016');
    expect(await attempt({ source: 'MANUAL' })).toBe('PE016');
    expect(await attempt({ kind: 'CARRY_PROPAGATION', key: `cp:${randomUUID()}:${randomUUID()}` })).toBe('PE016');
  });

  it('an entry kind the transaction kind may not contain is refused; WRITE_OFF and POLICY_EXPIRY are not enabled', async () => {
    const y1 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const post = (kind: string, e: Partial<EntryRow>, key = `ac:${res.accountId}:1:2025-06-01`) => sqlState(as(own(A), async (c) => {
      await bump(c, res.accountId);
      const id = await tx(c, { account: res.accountId, employee: A.e1, type: A.annual, kind, key });
      await entries(c, [{ tx: id, account: res.accountId, bucket: y1, employee: A.e1, type: A.annual, kind: 'ACCRUAL', hours: '1', appliesOn: '2025-06-30',
        periodStart: '2025-06-01', periodEnd: '2025-07-01', policy: A.pol.capped, ...e }]);
    }));
    expect(await post('ACCRUAL', {})).toBe('ok');
    expect(await post('ACCRUAL', { kind: 'GRANT', periodStart: null, periodEnd: null, policy: A.pol.none, appliesOn: Y1.start }, `ac:${res.accountId}:1:2025-07-01`)).toBe('PE016');
    expect(await post('ACCRUAL', { kind: 'EXPIRY', expiry: 'MANUAL', hours: '-1', periodStart: null, periodEnd: null }, `ac:${res.accountId}:1:2025-07-01`)).toBe('PE016');
    expect(await post('ACCRUAL', { kind: 'EXPIRY', expiry: 'POLICY_EXPIRY', hours: '-1', periodStart: null, periodEnd: null }, `ac:${res.accountId}:1:2025-07-01`)).toBe('PE015');
    expect(await post('YEAR_OPEN', { kind: 'WRITE_OFF', periodStart: null, periodEnd: null }, `yo:${y1}`)).toBe('PE015');
    // The accrual key names this period start.
    expect(await post('ACCRUAL', { periodStart: '2025-07-01', periodEnd: '2025-08-01', appliesOn: '2025-07-31' }, `ac:${res.accountId}:1:2025-08-01`)).toBe('PE016');
    // A period crossing the year's end, or applying on another day, is refused.
    expect(await post('ACCRUAL', { periodStart: '2025-12-01', periodEnd: '2026-01-02', appliesOn: '2026-01-01' }, `ac:${res.accountId}:1:2025-12-01`)).toBe('PE016');
    expect(await post('ACCRUAL', { periodStart: '2025-11-01', periodEnd: '2025-12-01', appliesOn: '2025-11-15' }, `ac:${res.accountId}:1:2025-11-01`)).toBe('PE016');
  });

  it('DAYS policies, days bases, NONE policies and a method mismatch are refused (revised D-P3C-23: no days↔hours assumption)', async () => {
    const y1 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y1, hours: '8', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const post = (e: Partial<EntryRow>) => sqlState(as(own(A), async (c) => {
      await bump(c, res.accountId);
      const id = await tx(c, { account: res.accountId, employee: A.e1, type: A.annual, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-09-01` });
      await entries(c, [{ tx: id, account: res.accountId, bucket: y1, employee: A.e1, type: A.annual, kind: 'ACCRUAL', hours: '7.6', appliesOn: '2025-09-30',
        periodStart: '2025-09-01', periodEnd: '2025-10-01', policy: A.pol.capped, ...e }]);
    }));
    expect(await post({ policy: A.pol.days })).toBe('PE015');
    expect(await post({ hoursPerDay: '7.6' })).toBe('PE015');
    expect(await post({ policy: A.pol.noBalance })).toBe('PE016');
    expect(await post({ policy: A.pol.none })).toBe('PE016');
  });

  it('correction authorisations cannot be written in C1', async () => {
    expect(await sqlState(as(own(A), (c) => c.query(`INSERT INTO people_leave_authorisations (id, business_id, user_id, capability, granted_by_id)
      VALUES (gen_random_uuid(), $1, $2, 'LEAVE_CORRECT', $3)`, [A.id, A.u.MANAGER, A.u.OWNER])))).toBe('42501');
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      expect(await sqlState(owner.query(`INSERT INTO people_leave_authorisations (id, business_id, user_id, capability, granted_by_id)
        VALUES (gen_random_uuid(), $1, $2, 'LEAVE_CORRECT', $3)`, [A.id, A.u.MANAGER, A.u.OWNER]))).toBe('PE015');
    } finally {
      await owner.end();
    }
  });
});

// ---- T-C06, T-C09, T-C09b: settlement and reversal ---------------------------------------------------

describe('settlement (T-C06, T-C09) and reversal (T-C09b)', () => {
  async function reserved(f: Fixture, dates: [string, string][]) {
    const y1 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '76', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const ids = await reserve(f, { account: res.accountId, bucket: y1, dates });
    return { y1, accountId: res.accountId, ids };
  }
  const consume = (f: Fixture, r: { y1: string; accountId: string }, settle: { reservation: string; date: string; hours: string; withRelease?: boolean; releaseHours?: string; consumption?: boolean }[]) =>
    viaApp(own(f), (db) => postDerived(db, {
      employeeId: f.e1, leaveTypeId: f.annual, kind: 'CONSUME', idempotencyKey: `cs:${r.accountId}:${settle[0]!.date}:${settle.at(-1)!.date}`,
      entries: settle.flatMap((s) => [
        ...(s.consumption === false ? [] : [{ id: randomUUID(), bucketId: r.y1, book: 'BALANCE' as const, kind: 'CONSUMPTION' as const, hours: neg(s.hours), appliesOn: s.date, leaveDate: s.date,
          reservationEntryId: s.reservation, policyId: f.pol.capped, policyVersion: 1 }]),
        ...(s.withRelease === false ? [] : [{ id: randomUUID(), bucketId: r.y1, book: 'RESERVED' as const, kind: 'RESERVATION_RELEASE' as const, hours: neg(s.releaseHours ?? s.hours),
          appliesOn: s.date, leaveDate: s.date, reservationEntryId: s.reservation, releaseReason: 'CONSUMED' as const, policyId: f.pol.capped, policyVersion: 1 }]),
      ]),
    }));

  it('consume per date: balance down, reserved down, available unchanged (I-1, I-2, I-3)', async () => {
    const r = await reserved(A, [['2025-03-03', '7.6'], ['2025-03-04', '7.6']]);
    const before = await viaApp(own(A), (db) => bucketTotals(db, A.e1, A.annual));
    expect(before.find((b) => b.bucketId === r.y1)).toMatchObject({ balance: '76.0000', reserved: '15.2000', available: '60.8000' });
    await consume(A, r, [{ reservation: r.ids[0]!, date: '2025-03-03', hours: '7.6' }, { reservation: r.ids[1]!, date: '2025-03-04', hours: '7.6' }]);
    const after = await viaApp(own(A), (db) => bucketTotals(db, A.e1, A.annual));
    expect(after.find((b) => b.bucketId === r.y1)).toMatchObject({ balance: '60.8000', reserved: '0.0000', available: '60.8000' });
    // As of a date before the consumption, the as-of view still shows the reservation (applies_on axis).
    const asOf = await viaApp(own(A), (db) => bucketTotals(db, A.e1, A.annual, '2025-03-03'));
    expect(asOf.find((b) => b.bucketId === r.y1)).toMatchObject({ balance: '68.4000', reserved: '7.6000' });
    // A second settlement of the same date is refused.
    expect(await sqlState(consume(A, r, [{ reservation: r.ids[0]!, date: '2025-03-03', hours: '7.6' }]))).not.toBe('ok');
  });

  it('consumption without its release, and a release for consumption without its consumption, fail at commit (T-C09)', async () => {
    const r = await reserved(A, [['2025-04-01', '8'], ['2025-04-02', '8']]);
    const raw = (rows: Partial<EntryRow>[]) => sqlState(as(own(A), async (c) => {
      await bump(c, r.accountId);
      const t = await tx(c, { account: r.accountId, employee: A.e1, type: A.annual, kind: 'CONSUME', key: `cs:${r.accountId}:2025-04-01:2025-04-01` });
      await entries(c, rows.map((e) => ({ tx: t, account: r.accountId, bucket: r.y1, employee: A.e1, type: A.annual, kind: 'CONSUMPTION', hours: '-8', appliesOn: '2025-04-01',
        leaveDate: '2025-04-01', reservation: r.ids[0], policy: A.pol.capped, ...e })));
    }));
    expect(await raw([{}])).toBe('PE017');
    expect(await raw([{ kind: 'RESERVATION_RELEASE', release: 'CONSUMED' }])).toBe('PE017');
    // Mismatched hours, date or reservation are refused immediately.
    expect(await raw([{ hours: '-7' }, { kind: 'RESERVATION_RELEASE', release: 'CONSUMED', hours: '-7' }])).toBe('PE016');
    expect(await raw([{ leaveDate: '2025-04-02', appliesOn: '2025-04-02' }, { kind: 'RESERVATION_RELEASE', release: 'CONSUMED', leaveDate: '2025-04-02', appliesOn: '2025-04-02' }])).toBe('PE016');
    // A CONSUME cannot contain a CANCELLED release.
    expect(await raw([{ kind: 'RESERVATION_RELEASE', release: 'CANCELLED' }])).toBe('PE016');
    // The pair commits.
    expect(await raw([{}, { kind: 'RESERVATION_RELEASE', release: 'CONSUMED' }])).toBe('ok');
  });

  it('a leave date in the future cannot be consumed', async () => {
    const y2 = randomUUID();
    const res = await viaApp(own(A), (db) => postDerived(db, accrual(A, { bucketId: y2, hours: '8', periodStart: '2026-01-01', periodEnd: '2026-02-01', create: { year: Y2 }, employee: A.e2 })));
    const [rid] = await reserve(A, { account: res.accountId, bucket: y2, dates: [['2026-12-30', '8']], employee: A.e2 });
    expect(await sqlState(as(own(A), async (c) => {
      await bump(c, res.accountId);
      const t = await tx(c, { account: res.accountId, employee: A.e2, type: A.annual, kind: 'CONSUME', key: `cs:${res.accountId}:2026-12-30:2026-12-30` });
      await entries(c, [{ tx: t, account: res.accountId, bucket: y2, employee: A.e2, type: A.annual, kind: 'CONSUMPTION', hours: '-8', appliesOn: '2026-12-30', leaveDate: '2026-12-30', reservation: rid, policy: A.pol.capped },
        { tx: t, account: res.accountId, bucket: y2, employee: A.e2, type: A.annual, kind: 'RESERVATION_RELEASE', release: 'CONSUMED', hours: '-8', appliesOn: '2026-12-30', leaveDate: '2026-12-30', reservation: rid, policy: A.pol.capped }]);
    }))).toBe('PE016');
  });

  it('reversal mirrors; a second reversal is refused; a reversal of a consumption keeps its date (T-C06, T-C09b)', async () => {
    const r = await reserved(A, [['2025-05-05', '6']]);
    await consume(A, r, [{ reservation: r.ids[0]!, date: '2025-05-05', hours: '6' }]);
    const consumption = (await admin.query("SELECT id FROM people_leave_entries WHERE reservation_entry_id = $1 AND kind = 'CONSUMPTION'", [r.ids[0]])).rows[0].id;
    const reverse = (e: Partial<EntryRow>) => sqlState(gated(own(A), async (c) => {
      await bump(c, r.accountId);
      const t = await tx(c, { account: r.accountId, employee: A.e1, type: A.annual, kind: 'REVERSE_CONSUMPTION', key: `rc:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'LEAVE_NOT_TAKEN' });
      await entries(c, [{ tx: t, account: r.accountId, bucket: r.y1, employee: A.e1, type: A.annual, kind: 'REVERSAL', hours: '6', appliesOn: '2025-05-05', leaveDate: '2025-05-05',
        reverses: consumption, policy: A.pol.capped, ...e }]);
    }));
    expect(await reverse({ hours: '5' })).toBe('PE016');
    expect(await reverse({ leaveDate: null })).toBe('PE016');
    expect(await reverse({ leaveDate: '2025-05-06' })).toBe('PE016');
    expect(await reverse({})).toBe('ok');
    expect(await reverse({})).toBe('23505');
    const totals = await viaApp(own(A), (db) => bucketTotals(db, A.e1, A.annual));
    expect(totals.find((b) => b.bucketId === r.y1)).toMatchObject({ balance: '76.0000', reserved: '0.0000' });
  });
});

// ---- T-C09a, T-C09d, T-C09e: year closing, carry pairs and lapse ------------------------------------

describe('year closing, carry pairs and the lapse (T-C09a, T-C09d, T-C09e)', () => {
  it('closing 110 with cap 100: CARRY_OUT −100, EXPIRY −10; the closed year sums to zero; the new year holds 100', async () => {
    const { y1, y2 } = await closedYear(A, '110', { employee: A.e2 });
    const totals = await viaApp(own(A), (db) => bucketTotals(db, A.e2, A.annual));
    expect(totals.map((b) => [b.bucketId, b.state, b.balance])).toEqual([[y1, 'CLOSED', '0.0000'], [y2, 'OPEN', '100.0000']]);
  });

  it('a negative closing balance carried in full (CARRY_OUT +5, CARRY_IN −5) commits; WRITE_OFF is refused (T-C09a)', async () => {
    const f = await business('llneg');
    const y1 = randomUUID();
    const y2 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '1', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const [rid] = await reserve(f, { account: res.accountId, bucket: y1, dates: [['2025-06-02', '6']] });
    await viaApp(own(f), (db) => postDerived(db, {
      employeeId: f.e1, leaveTypeId: f.annual, kind: 'CONSUME', idempotencyKey: `cs:${res.accountId}:2025-06-02:2025-06-02`,
      entries: [{ id: randomUUID(), bucketId: y1, book: 'BALANCE', kind: 'CONSUMPTION', hours: '-6', appliesOn: '2025-06-02', leaveDate: '2025-06-02', reservationEntryId: rid, policyId: f.pol.capped, policyVersion: 1 },
        { id: randomUUID(), bucketId: y1, book: 'RESERVED', kind: 'RESERVATION_RELEASE', hours: '-6', appliesOn: '2025-06-02', leaveDate: '2025-06-02', reservationEntryId: rid, releaseReason: 'CONSUMED', policyId: f.pol.capped, policyVersion: 1 }],
    }));
    expect(await sqlState(viaApp(own(f), (db) => postDerived(db, yearOpen(f, { from: y1, to: y2, toYear: Y2, carry: '-4' }))))).not.toBe('ok');
    await viaApp(own(f), (db) => postDerived(db, yearOpen(f, { from: y1, to: y2, toYear: Y2, carry: '-5' })));
    const totals = await viaApp(own(f), (db) => bucketTotals(db, f.e1, f.annual));
    expect(totals.map((b) => [b.state, b.balance])).toEqual([['CLOSED', '0.0000'], ['OPEN', '-5.0000']]);
  });

  it('unpaired, unequal, non-mutual or misplaced carries and a closed year not summing to zero fail (T-C09a)', async () => {
    const f = await business('llcarry');
    const y1 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '50', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const attempt = (mutate: (p: DerivedPosting) => void) => {
      const p = yearOpen(f, { from: y1, to: randomUUID(), toYear: Y2, carry: '50' });
      mutate(p);
      return sqlState(viaApp(own(f), (db) => postDerived(db, p)));
    };
    const codeOf = async (p: Promise<string>) => (await p).replace(/^[\s\S]*(PE0\d\d)[\s\S]*$/, '$1');
    expect(await codeOf(attempt((p) => { p.entries[1]!.hours = '49'; }))).not.toBe('ok');
    expect(await codeOf(attempt((p) => { p.entries[1]!.pairEntryId = p.entries[0]!.id; p.entries.splice(0, 1); }))).not.toBe('ok');
    expect(await codeOf(attempt((p) => { p.entries[0]!.hours = '-40'; p.entries[1]!.hours = '40'; }))).not.toBe('ok');
    expect(await codeOf(attempt((p) => { p.bucketChanges!.splice(0, 1); }))).not.toBe('ok');
    // Raw SQL to read the exact SQLSTATE of the deferred checks.
    const raw = (out: string, inn: string, closeFirst = true) => sqlState(as(own(f), async (c) => {
      await bump(c, res.accountId);
      const y2 = randomUUID();
      const t = await tx(c, { account: res.accountId, employee: f.e1, type: f.annual, kind: 'YEAR_OPEN', key: `yo:${y2}` });
      if (closeFirst) await setState(c, y1, 'CLOSED');
      await bucket(c, { id: y2, account: res.accountId, employee: f.e1, type: f.annual, year: Y2 });
      const o = randomUUID();
      const i = randomUUID();
      await entries(c, [{ id: o, tx: t, account: res.accountId, bucket: y1, employee: f.e1, type: f.annual, kind: 'CARRY_OUT', hours: out, appliesOn: '2025-12-31', pair: i, policy: f.pol.unlimited },
        { id: i, tx: t, account: res.accountId, bucket: y2, employee: f.e1, type: f.annual, kind: 'CARRY_IN', hours: inn, appliesOn: Y2.start, pair: o, policy: f.pol.unlimited }]);
    }));
    expect(await raw('-50', '49')).toBe('PE017');
    expect(await raw('-40', '40')).toBe('PE017');
    // Without closing the old year first, the new OPEN year collides with it (one OPEN year per service period).
    expect(await raw('-50', '50', false)).toBe('23505');
    expect(await raw('-50', '50')).toBe('ok');
  });

  it('a correction into a closed year propagates as a lapse reversal and a new lapse; carry unchanged (T-C09d)', async () => {
    const f = await business('lllapse');
    const { y1, y2, accountId } = await closedYear(f, '110');
    // ADJUSTMENT −5 into the closed year (a C5 kind, so a gated fixture) and its propagation in one unit.
    const lapse = (await admin.query("SELECT id FROM people_leave_entries WHERE bucket_id = $1 AND kind = 'EXPIRY'", [y1])).rows[0].id;
    const run = (adjust: string, prop: (c: pg.Client, adj: string) => Promise<void>) => sqlState(gated(own(f), async (c) => {
      await bump(c, accountId);
      const adj = await tx(c, { account: accountId, employee: f.e1, type: f.annual, kind: 'ADJUSTMENT', key: `adj:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'DATA_ENTRY_ERROR' });
      await entries(c, [{ tx: adj, account: accountId, bucket: y1, employee: f.e1, type: f.annual, kind: 'ADJUSTMENT', hours: adjust, appliesOn: '2025-12-31', policy: f.pol.capped }]);
      await bump(c, accountId);
      await prop(c, adj);
    }));
    const propagate = (rows: (adj: string, t: string) => EntryRow[], kind = 'CARRY_PROPAGATION') => async (c: pg.Client, adj: string) => {
      const t = await tx(c, { account: accountId, employee: f.e1, type: f.annual, kind, key: `cp:${adj}:${y1}`, related: adj });
      await entries(c, rows(adj, t));
    };
    const e = (t: string, x: Partial<EntryRow>): EntryRow => ({ tx: t, account: accountId, bucket: y1, employee: f.e1, type: f.annual, kind: 'REVERSAL', hours: '10',
      appliesOn: '2025-12-31', policy: f.pol.capped, ...x });
    // Refused: no propagation (the year no longer sums to zero).
    expect(await run('-5', async () => { await bump(admin, accountId).catch(() => undefined); })).not.toBe('ok');
    // Refused: lapse not equal to closing − carry (reversal without replacement leaves carry 100 < closing 105).
    expect(await run('-5', propagate((_a, t) => [e(t, { reverses: lapse })]))).toBe('PE017');
    // Refused: replacement without reversal leaves two unreversed lapses.
    expect(await run('-5', propagate((_a, t) => [e(t, { kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '5' })]))).toBe('23514');
    // Refused: a positive EXPIRY in any transaction.
    expect(await run('-5', propagate((_a, t) => [e(t, { reverses: lapse }), e(t, { kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '-4' })]))).toBe('PE017');
    // Accepted: REVERSAL +10, EXPIRY −5, carry unchanged.
    expect(await run('-5', propagate((_a, t) => [e(t, { reverses: lapse }), e(t, { kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '-5' })]))).toBe('ok');
    const totals = await viaApp(own(f), (db) => bucketTotals(db, f.e1, f.annual));
    expect(totals.map((b) => [b.bucketId, b.balance])).toEqual([[y1, '0.0000'], [y2, '100.0000']]);
    const unreversed = await admin.query(`SELECT count(*)::int AS n FROM people_leave_entries l WHERE l.bucket_id = $1 AND l.kind = 'EXPIRY'
      AND NOT EXISTS (SELECT 1 FROM people_leave_entries r WHERE r.reverses_entry_id = l.id)`, [y1]);
    expect(unreversed.rows[0].n).toBe(1);
  });

  it('lapse grows, disappears and reappears with carry deltas; a lapse reversal inside a CORRECTION is refused (T-C09e)', async () => {
    const f = await business('lllapse2');
    const { y1, y2, accountId } = await closedYear(f, '105');
    const lapseId = async () => (await admin.query(`SELECT l.id FROM people_leave_entries l WHERE l.bucket_id = $1 AND l.kind = 'EXPIRY'
      AND NOT EXISTS (SELECT 1 FROM people_leave_entries r WHERE r.reverses_entry_id = l.id)`, [y1])).rows[0]?.id as string | undefined;
    const step = (adjust: string, build: (t: string, lapse: string | undefined) => EntryRow[], propKind = 'CARRY_PROPAGATION') => sqlState(gated(own(f), async (c) => {
      const lapse = await lapseId();
      await bump(c, accountId);
      const adj = await tx(c, { account: accountId, employee: f.e1, type: f.annual, kind: 'ADJUSTMENT', key: `adj:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'DATA_ENTRY_ERROR' });
      await entries(c, [{ tx: adj, account: accountId, bucket: y1, employee: f.e1, type: f.annual, kind: 'ADJUSTMENT', hours: adjust, appliesOn: '2025-12-31', policy: f.pol.capped }]);
      await bump(c, accountId);
      const t = propKind === 'CARRY_PROPAGATION'
        ? await tx(c, { account: accountId, employee: f.e1, type: f.annual, kind: 'CARRY_PROPAGATION', key: `cp:${adj}:${y1}`, related: adj })
        : await tx(c, { account: accountId, employee: f.e1, type: f.annual, kind: propKind, key: `corr:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'DATA_ENTRY_ERROR' });
      await entries(c, build(t, lapse));
    }));
    const row = (t: string, x: Partial<EntryRow>): EntryRow => ({ tx: t, account: accountId, bucket: y1, employee: f.e1, type: f.annual, kind: 'REVERSAL', hours: '5',
      appliesOn: '2025-12-31', policy: f.pol.capped, ...x });
    const pair = (t: string, out: string) => {
      const o = randomUUID();
      const i = randomUUID();
      return [row(t, { id: o, kind: 'CARRY_OUT', hours: out, pair: i }), row(t, { id: i, kind: 'CARRY_IN', hours: neg(out), pair: o, bucket: y2, appliesOn: Y2.start })];
    };
    // 105 → 110: REVERSAL +5, EXPIRY −10.
    expect(await step('5', (t, l) => [row(t, { reverses: l }), row(t, { kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '-10' })])).toBe('ok');
    // A lapse reversal inside a CORRECTION is refused.
    expect(await step('-15', (t, l) => [row(t, { reverses: l, hours: '10' })], 'CORRECTION')).toBe('PE016');
    // 110 → 95: lapse disappears (REVERSAL +10), carry falls by 5 (CARRY_OUT +5 / CARRY_IN −5).
    expect(await step('-15', (t, l) => [row(t, { reverses: l, hours: '10' }), ...pair(t, '5')])).toBe('ok');
    // 95 → 110: lapse reappears (EXPIRY −10) and carry rises back to the cap (CARRY_OUT −5 / CARRY_IN +5).
    expect(await step('15', (t) => [row(t, { kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '-10' }), ...pair(t, '-5')])).toBe('ok');
    // A carry above the cap with no lapse is refused.
    expect(await step('10', (t) => [...pair(t, '-10')])).toBe('PE017');
    const totals = await viaApp(own(f), (db) => bucketTotals(db, f.e1, f.annual));
    expect(totals.map((b) => [b.bucketId, b.balance])).toEqual([[y1, '0.0000'], [y2, '100.0000']]);
  });

  it('carry NONE closes with a full lapse and UNLIMITED never lapses', async () => {
    const f = await business('llrules');
    const ctx = own(f);
    const grant = (bucketId: string, policyId: string, hours: string, employee: string): DerivedPosting => ({
      employeeId: employee, leaveTypeId: f.annual, kind: 'YEAR_OPEN', idempotencyKey: `yo:${bucketId}`,
      bucketChanges: [{ create: { id: bucketId, servicePeriod: 1, yearStart: Y1.start, yearEnd: Y1.end, state: 'OPEN' } }],
      entries: [{ id: randomUUID(), bucketId, book: 'BALANCE', kind: 'GRANT', hours, appliesOn: Y1.start, policyId, policyVersion: 1 }],
    });
    const n1 = randomUUID();
    await viaApp(ctx, (db) => postDerived(db, grant(n1, f.pol.none, '76', f.e1)));
    expect(await sqlState(viaApp(ctx, (db) => postDerived(db, yearOpen(f, { from: n1, to: randomUUID(), toYear: Y2, carry: '10', lapse: '-66', policy: f.pol.none }))))).not.toBe('ok');
    await viaApp(ctx, (db) => postDerived(db, yearOpen(f, { from: n1, to: randomUUID(), toYear: Y2, carry: '0', lapse: '-76', policy: f.pol.none })));
    const u1 = randomUUID();
    await viaApp(ctx, (db) => postDerived(db, grant(u1, f.pol.unlimited, '76', f.e2)));
    expect(await sqlState(viaApp(ctx, (db) => postDerived(db, yearOpen(f, { from: u1, to: randomUUID(), toYear: Y2, carry: '70', lapse: '-6', policy: f.pol.unlimited, employee: f.e2 }))))).not.toBe('ok');
    await viaApp(ctx, (db) => postDerived(db, yearOpen(f, { from: u1, to: randomUUID(), toYear: Y2, carry: '76', policy: f.pol.unlimited, employee: f.e2 })));
    // A grant goes into the year its opening names, once.
    expect(await sqlState(viaApp(ctx, (db) => postDerived(db, { ...grant(randomUUID(), f.pol.none, '1', f.e2), idempotencyKey: `yo:${randomUUID()}` })))).not.toBe('ok');
  });
});

// ---- FREEZE ---------------------------------------------------------------------------------------

describe('freeze', () => {
  it('releases future reservations FROZEN and freezes open and future years; nothing posts into a frozen year', async () => {
    const f = await business('llfreeze');
    const y2 = randomUUID();
    const y3 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y2, hours: '40', periodStart: '2026-01-01', periodEnd: '2026-02-01', create: { year: Y2 } })));
    const [r2] = await reserve(f, { account: res.accountId, bucket: y2, dates: [['2026-12-21', '8']] });
    const [r3] = await reserve(f, { account: res.accountId, bucket: y3, dates: [['2027-01-04', '8']], createYear: Y3, state: 'FUTURE' });
    await viaApp(own(f), (db) => postDerived(db, {
      employeeId: f.e1, leaveTypeId: f.annual, kind: 'FREEZE', idempotencyKey: (a) => `fz:${a}:1`,
      bucketChanges: [{ bucketId: y2, to: 'FROZEN' }, { bucketId: y3, to: 'FROZEN' }],
      entries: [[y2, r2, '2026-12-21'], [y3, r3, '2027-01-04']].map(([b, r, d]) => ({ id: randomUUID(), bucketId: b!, book: 'RESERVED' as const, kind: 'RESERVATION_RELEASE' as const,
        hours: '-8', appliesOn: '2026-11-17', leaveDate: d!, reservationEntryId: r!, releaseReason: 'FROZEN' as const, policyId: f.pol.capped, policyVersion: 1 })),
    }));
    const totals = await viaApp(own(f), (db) => bucketTotals(db, f.e1, f.annual, '2027-12-31'));
    expect(totals.map((b) => [b.state, b.balance, b.reserved])).toEqual([['FROZEN', '40.0000', '0.0000'], ['FROZEN', '0.0000', '0.0000']]);
    expect(await sqlState(viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y2, hours: '1', periodStart: '2026-02-01', periodEnd: '2026-03-01' }))))).not.toBe('ok');
    // FREEZE with no entries is allowed (state changes only); any other kind needs an entry.
    expect((await admin.query("SELECT count(*)::int AS n FROM people_leave_transactions WHERE account_id = $1 AND kind = 'FREEZE'", [res.accountId])).rows[0].n).toBe(1);
  });
});

// ---- T-C07: precision ------------------------------------------------------------------------------

describe('precision (T-C07)', () => {
  it('4-dp hours, exact sums over many entries, the primitive refuses floats beyond 4 places', async () => {
    const f = await business('llprec');
    const y1 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '0.0001', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const dates: [string, string][] = [];
    for (let d = Date.parse('2025-01-01T00:00:00Z'); dates.length < 300; d += 86_400_000) dates.push([new Date(d).toISOString().slice(0, 10), '7.6001']);
    const ids = await reserve(f, { account: res.accountId, bucket: y1, dates });
    const totals = await viaApp(own(f), (db) => bucketTotals(db, f.e1, f.annual, '2025-12-31'));
    expect(totals[0]).toMatchObject({ balance: '0.0001', reserved: '2280.0300', available: '-2280.0299' });
    expect(ids).toHaveLength(300);
    expect(await sqlState(viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '1.00001', periodStart: '2025-02-01', periodEnd: '2025-03-01' }))))).not.toBe('ok');
    expect(await sqlState(viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '0', periodStart: '2025-02-01', periodEnd: '2025-03-01' }))))).not.toBe('ok');
  });
});

// ---- T-C10: idempotency ------------------------------------------------------------------------------

describe('idempotency of system keys (T-C10)', () => {
  it('the same derived key twice posts once; concurrent posters of one key: one posted, the rest duplicates', async () => {
    const f = await business('llidem');
    const y1 = randomUUID();
    const p = accrual(f, { bucketId: y1, hours: '12.6667', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } });
    const first = await viaApp(own(f), (db) => postDerived(db, p));
    const again = await viaApp(own(f), (db) => postDerived(db, { ...p, bucketChanges: [] }));
    expect(again).toEqual({ ...first, status: 'duplicate' });
    const q = accrual(f, { bucketId: y1, hours: '12.6666', periodStart: '2025-02-01', periodEnd: '2025-03-01' });
    const results = await Promise.all([1, 2, 3, 4].map(() => viaApp(own(f), (db) => postDerived(db, q))));
    expect(results.filter((r) => r.status === 'posted')).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    // Concurrent first postings on a new account create it once.
    const g = accrual(f, { bucketId: randomUUID(), hours: '1', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 }, employee: f.e2 });
    const created = await Promise.allSettled([1, 2].map(() => viaApp(own(f), (db) => postDerived(db, g))));
    expect(created.filter((r) => r.status === 'fulfilled' && r.value.status === 'posted')).toHaveLength(1);
    const v = await admin.query('SELECT version FROM people_leave_accounts WHERE business_id = $1 ORDER BY version', [f.id]);
    expect(v.rows.map((r) => r.version)).toEqual([2, 3]);
    expect(await viaApp(own(f), (db) => verifyLedger(db))).toEqual([]);
  });

  it('a retry of a posted key with a different payload is refused, never a silent duplicate; the same payload with new entry ids is a duplicate', async () => {
    const f = await business('llreplay');
    const y1 = randomUUID();
    const p = accrual(f, { bucketId: y1, hours: '12.6667', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } });
    const first = await viaApp(own(f), (db) => postDerived(db, p));
    const retry = (change: (e: EntryInput) => EntryInput, extra: Partial<DerivedPosting> = {}) =>
      viaApp(own(f), (db) => postDerived(db, { ...p, bucketChanges: [], ...extra, entries: p.entries.map((e) => change({ ...e, id: randomUUID() })) }));
    // Same meaning, new caller-chosen ids and an equivalent decimal spelling: a duplicate.
    expect(await retry((e) => ({ ...e, hours: '012.6667' }))).toEqual({ ...first, status: 'duplicate' });
    // Different hours, period, policy version or an extra entry: refused, nothing written.
    const refused = async (q: Promise<unknown>) => (await q.then(() => 'ok', (error: Error) => error.name));
    expect(await refused(retry((e) => ({ ...e, hours: '12.6666' })))).toBe('LedgerIdempotencyConflict');
    expect(await refused(retry((e) => ({ ...e, hours: '-12.6667' })))).toBe('LedgerIdempotencyConflict');
    expect(await refused(retry((e) => ({ ...e, appliesOn: '2025-01-30' })))).toBe('LedgerIdempotencyConflict');
    expect(await refused(retry((e) => ({ ...e, policyVersion: 2 })))).toBe('LedgerIdempotencyConflict');
    expect(await refused(viaApp(own(f), (db) => postDerived(db, { ...p, bucketChanges: [], entries: [...p.entries, { ...p.entries[0]!, id: randomUUID() }] }))))
      .toBe('LedgerIdempotencyConflict');
    expect(await refused(retry((e) => e, { kind: 'FREEZE' }))).toBe('LedgerIdempotencyConflict');
    const rows = await admin.query('SELECT count(*)::int AS n, sum(hours)::text AS h FROM people_leave_entries WHERE transaction_id = $1', [first.transactionId]);
    expect(rows.rows[0]).toEqual({ n: 1, h: '12.6667' });
    expect((await admin.query('SELECT version FROM people_leave_accounts WHERE id = $1', [first.accountId])).rows[0].version).toBe(2);
  });

  it('a raw duplicate key is refused by the unique index', async () => {
    const f = await business('llidem2');
    const y1 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '1', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    expect(await sqlState(as(own(f), async (c) => {
      await bump(c, res.accountId);
      await tx(c, { account: res.accountId, employee: f.e1, type: f.annual, kind: 'ACCRUAL', key: `ac:${res.accountId}:1:2025-01-01` });
    }))).toBe('23505');
  });

  it('a second posting of one account waits on the account row (one serialisation point per account)', async () => {
    const f = await business('llrace');
    const y1 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '1', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const holder = await app.connect();
    const waiter = await app.connect();
    try {
      for (const c of [holder, waiter]) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [f.id, f.u.OWNER]);
      }
      await bump(holder, res.accountId);
      const waiting = bump(waiter, res.accountId);
      expect(await waitUntilBlocked(admin, await backendPid(holder))).toBe(true);
      await holder.query('ROLLBACK');
      await waiting;
      await waiter.query('ROLLBACK');
    } finally {
      holder.release();
      waiter.release();
    }
  });
});

// ---- T-C40, T-C42c: isolation and fail-closed reads -------------------------------------------------

describe('tenant isolation (T-C40) and fail-closed read policies (T-C42c)', () => {
  let rowsOfA: { accountId: string; e1y: string };
  let F: Fixture;
  beforeAll(async () => {
    F = await refresh(A0);
    const e1y = randomUUID();
    const r = await viaApp(own(F), (db) => postDerived(db, accrual(F, { bucketId: e1y, hours: '3', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 }, type: F.sick, policy: F.pol.sickCapped })));
    await viaApp(own(F), (db) => postDerived(db, accrual(F, { bucketId: randomUUID(), hours: '3', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 }, type: F.sick, policy: F.pol.sickCapped, employee: F.e2 })));
    rowsOfA = { accountId: r.accountId, e1y };
  });
  const counts = (ctx: Ctx) => as(ctx, async (c) => {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    out.e1 = (await c.query('SELECT count(*)::int AS n FROM people_leave_entries WHERE employee_id = $1', [F.e1])).rows[0].n;
    out.e2 = (await c.query('SELECT count(*)::int AS n FROM people_leave_entries WHERE employee_id = $1', [F.e2])).rows[0].n;
    return out;
  }, { rollback: true });

  it('another business sees none of the rows and cannot write them', async () => {
    const seen = await counts({ businessId: B.id, userId: B.u.OWNER });
    expect(seen.e1! + seen.e2!).toBe(0);
    expect(await sqlState(as({ businessId: B.id, userId: B.u.OWNER }, (c) => c.query(
      `INSERT INTO people_leave_accounts (id, business_id, employee_id, leave_type_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [F.id, F.e2, F.annual])))).toBe('42501');
    expect(await sqlState(as({ businessId: B.id, userId: B.u.OWNER }, (c) => bump(c, rowsOfA.accountId).then((r) => { if (r.rowCount !== 0) throw new Error('updated'); })))).toBe('ok');
  });

  it('OWNER and ADMIN see everything; the linked employee only their own; MANAGER, MEMBER, suspended and no user see nothing', async () => {
    const owner = await counts(own(F));
    expect(owner.e1).toBeGreaterThan(0);
    expect(owner.e2).toBeGreaterThan(0);
    expect(await counts({ businessId: F.id, userId: F.u.ADMIN })).toEqual(owner);
    const self = await counts({ businessId: F.id, userId: F.u.SELF });
    expect(self.e1).toBe(owner.e1);
    expect(self.e2).toBe(0);
    expect(self.people_leave_transactions).toBeGreaterThan(0);
    for (const who of [F.u.MANAGER, F.u.MEMBER, F.u.SUSPENDED, null]) {
      const seen = await counts({ businessId: F.id, userId: who });
      expect(Object.values(seen).every((n) => n === 0), String(who)).toBe(true);
    }
  });

  it('a writer who cannot read the whole account cannot post to it (PE019), not even through the primitive', async () => {
    expect(await sqlState(as({ businessId: F.id, userId: F.u.MANAGER }, (c) => c.query(
      `INSERT INTO people_leave_accounts (id, business_id, employee_id, leave_type_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [F.id, F.e2, F.annual])))).toBe('PE019');
    expect(await sqlState(as({ businessId: F.id, userId: F.u.SELF }, (c) => c.query(
      `INSERT INTO people_leave_accounts (id, business_id, employee_id, leave_type_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [F.id, F.e2, F.annual])))).toBe('PE019');
    expect(await sqlState(viaApp({ businessId: F.id, userId: F.u.MANAGER }, (db) => postDerived(db, accrual(F, { bucketId: rowsOfA.e1y, hours: '1', periodStart: '2025-02-01', periodEnd: '2025-03-01', type: F.sick, policy: F.pol.sickCapped })))))
      .not.toBe('ok');
  });
});

// ---- T-C42d, T-C42e: sensitivity ------------------------------------------------------------------

describe('sensitivity is computed and monotonic (T-C42d, T-C42e trigger and deferred parts)', () => {
  it('a transaction of a sensitive type is stored sensitive whatever the INSERT says, and stays so after the type is made non-sensitive', async () => {
    const f = await business('llsens');
    const y1 = randomUUID();
    const res = await viaApp(own(f), (db) => postDerived(db, { ...accrual(f, { bucketId: y1, hours: '4', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 }, type: f.sick, policy: f.pol.sickCapped }), sensitive: false }));
    const row = async () => (await admin.query(`SELECT t.sensitive AS t, bool_and(e.sensitive) AS e FROM people_leave_transactions t
      JOIN people_leave_entries e ON e.transaction_id = t.id WHERE t.id = $1 GROUP BY t.sensitive`, [res.transactionId])).rows[0];
    expect(await row()).toEqual({ t: true, e: true });
    await admin.query('UPDATE people_leave_types SET sensitive = false, version = version + 1 WHERE id = $1', [f.sick]);
    expect(await row()).toEqual({ t: true, e: true });
  });

  it('rows citing a sensitive row inherit it even when the type is no longer sensitive and the INSERT passes false', async () => {
    const f = await business('llsens2');
    // Year closed under a sensitive type with a lapse; then the type is made non-sensitive.
    const { y1, accountId } = await closedYear(f, '110', { type: f.sick, policy: f.pol.sickCapped });
    await admin.query('UPDATE people_leave_types SET sensitive = false, version = version + 1 WHERE id = $1', [f.sick]);
    const lapse = (await admin.query("SELECT id, sensitive FROM people_leave_entries WHERE bucket_id = $1 AND kind = 'EXPIRY'", [y1])).rows[0];
    expect(lapse.sensitive).toBe(true);
    // A later adjustment (non-sensitive now) and its propagation reversing the sensitive lapse.
    const ids = await gated(own(f), async (c) => {
      await bump(c, accountId);
      const adj = await tx(c, { account: accountId, employee: f.e1, type: f.sick, kind: 'ADJUSTMENT', key: `adj:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'DATA_ENTRY_ERROR' });
      await entries(c, [{ tx: adj, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'ADJUSTMENT', hours: '-5', appliesOn: '2025-12-31', policy: f.pol.sickCapped }]);
      await bump(c, accountId);
      const cp = await tx(c, { account: accountId, employee: f.e1, type: f.sick, kind: 'CARRY_PROPAGATION', key: `cp:${adj}:${y1}`, related: adj, sensitive: true });
      const [rev, rep] = await entries(c, [
        { tx: cp, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'REVERSAL', hours: '10', appliesOn: '2025-12-31', reverses: lapse.id, policy: f.pol.sickCapped, sensitive: false },
        { tx: cp, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '-5', appliesOn: '2025-12-31', policy: f.pol.sickCapped, sensitive: false }]);
      return { adj, cp, rev, rep };
    });
    const s = (await admin.query('SELECT id, sensitive FROM people_leave_entries WHERE id = ANY($1)', [[ids.rev, ids.rep]])).rows;
    // The reversal inherits from the reversed lapse; the replacement from its (sensitive) transaction.
    expect(Object.fromEntries(s.map((r) => [r.id, r.sensitive]))).toEqual({ [ids.rev!]: true, [ids.rep!]: true });
    // A propagation that does not raise the transaction flag around a sensitive entry fails at commit.
    expect(await sqlState(gated(own(f), async (c) => {
      const lapse2 = (await c.query(`SELECT l.id FROM people_leave_entries l WHERE l.bucket_id = $1 AND l.kind = 'EXPIRY'
        AND NOT EXISTS (SELECT 1 FROM people_leave_entries r WHERE r.reverses_entry_id = l.id)`, [y1])).rows[0].id;
      await bump(c, accountId);
      const adj = await tx(c, { account: accountId, employee: f.e1, type: f.sick, kind: 'ADJUSTMENT', key: `adj:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'DATA_ENTRY_ERROR' });
      await entries(c, [{ tx: adj, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'ADJUSTMENT', hours: '-1', appliesOn: '2025-12-31', policy: f.pol.sickCapped }]);
      await bump(c, accountId);
      const cp = await tx(c, { account: accountId, employee: f.e1, type: f.sick, kind: 'CARRY_PROPAGATION', key: `cp:${adj}:${y1}`, related: adj, sensitive: false });
      await entries(c, [
        { tx: cp, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'REVERSAL', hours: '5', appliesOn: '2025-12-31', reverses: lapse2, policy: f.pol.sickCapped },
        { tx: cp, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '-4', appliesOn: '2025-12-31', policy: f.pol.sickCapped }]);
    }))).toBe('PE017');
    // The propagation transaction inherits from a sensitive related transaction.
    const related = await gated(own(f), async (c) => {
      await bump(c, accountId);
      const adj = await tx(c, { account: accountId, employee: f.e1, type: f.sick, kind: 'ADJUSTMENT', key: `adj:${randomUUID()}`, basis: 'LEAVE_MANAGER', reason: 'GOODWILL', sensitive: true });
      await entries(c, [{ tx: adj, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'ADJUSTMENT', hours: '-1', appliesOn: '2025-12-31', policy: f.pol.sickCapped }]);
      const lapse3 = (await c.query(`SELECT l.id FROM people_leave_entries l WHERE l.bucket_id = $1 AND l.kind = 'EXPIRY'
        AND NOT EXISTS (SELECT 1 FROM people_leave_entries r WHERE r.reverses_entry_id = l.id)`, [y1])).rows[0].id;
      await bump(c, accountId);
      const cp = await tx(c, { account: accountId, employee: f.e1, type: f.sick, kind: 'CARRY_PROPAGATION', key: `cp:${adj}:${y1}`, related: adj, sensitive: false });
      await entries(c, [
        { tx: cp, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'REVERSAL', hours: '5', appliesOn: '2025-12-31', reverses: lapse3, policy: f.pol.sickCapped },
        { tx: cp, account: accountId, bucket: y1, employee: f.e1, type: f.sick, kind: 'EXPIRY', expiry: 'CARRY_CAP', hours: '-4', appliesOn: '2025-12-31', policy: f.pol.sickCapped }]);
      return cp;
    });
    expect((await admin.query('SELECT sensitive FROM people_leave_transactions WHERE id = $1', [related])).rows[0].sensitive).toBe(true);
  });

  it('a non-sensitive transaction around an entry the statement marks sensitive fails at commit', async () => {
    const f = await business('llsens3');
    const y1 = randomUUID();
    const p = accrual(f, { bucketId: y1, hours: '4', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } });
    p.entries[0]!.sensitive = true;
    expect(await sqlState(viaApp(own(f), (db) => postDerived(db, p)))).not.toBe('ok');
    expect(await sqlState(viaApp(own(f), (db) => postDerived(db, { ...p, sensitive: true })))).toBe('ok');
  });

  it('a cited row in another account is not visible to the guard: refused (PE018)', async () => {
    const f = await business('llref');
    const a1 = await closedYear(f, '110');
    const other = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: randomUUID(), hours: '1', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 }, employee: f.e2 })));
    expect(await sqlState(as(own(f), async (c) => {
      await bump(c, a1.accountId);
      await tx(c, { account: a1.accountId, employee: f.e1, type: f.annual, kind: 'CARRY_PROPAGATION', key: `cp:${other.transactionId}:${a1.y1}`, related: other.transactionId });
    }))).toBe('PE018');
  });
});

// ---- T-C62: all or nothing ------------------------------------------------------------------------

describe('fault injection (T-C62)', () => {
  it('a failure at any step leaves nothing behind', async () => {
    const f = await business('llfault');
    const y1 = randomUUID();
    await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '50', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const snapshot = async () => (await admin.query(`SELECT (SELECT version FROM people_leave_accounts WHERE business_id = $1) AS v,
      (SELECT count(*)::int FROM people_leave_transactions WHERE business_id = $1) AS t, (SELECT count(*)::int FROM people_leave_entries WHERE business_id = $1) AS e,
      (SELECT string_agg(state, ',' ORDER BY year_start) FROM people_leave_buckets WHERE business_id = $1) AS b`, [f.id])).rows[0];
    const before = await snapshot();
    const good = () => yearOpen(f, { from: y1, to: randomUUID(), toYear: Y2, carry: '50' });
    // After the transaction row, after the bucket changes, at the last entry, and at COMMIT (deferred).
    const failures: ((p: DerivedPosting) => void)[] = [
      (p) => { p.bucketChanges = [{ bucketId: randomUUID(), to: 'CLOSED' }]; },
      (p) => { p.entries[1]!.policyVersion = 99; },
      (p) => { p.entries[1]!.hours = '49'; p.entries[0]!.hours = '-49'; },
    ];
    for (const breakIt of failures) {
      const p = good();
      breakIt(p);
      expect(await sqlState(viaApp(own(f), (db) => postDerived(db, p)))).not.toBe('ok');
      expect(await snapshot()).toEqual(before);
    }
    expect(await sqlState(viaApp(own(f), async (db) => { await postDerived(db, good()); throw new Error('after the posting'); }))).not.toBe('ok');
    expect(await snapshot()).toEqual(before);
    await viaApp(own(f), (db) => postDerived(db, good()));
    expect((await snapshot()).b).toBe('CLOSED,OPEN');
  });
});

// ---- T-C63: sealing --------------------------------------------------------------------------------

describe('commit-aware seals (T-C63)', () => {
  it('a transaction that starts before seal S1 and commits after it is absent from S1, present in S2, never twice', async () => {
    const f = await business('llseal');
    const y1 = randomUUID();
    await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: y1, hours: '1', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 } })));
    const s0 = await viaApp(own(f), (db) => takeSeal(db));
    const inflight = await app.connect();
    try {
      await inflight.query('BEGIN');
      await inflight.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [f.id, f.u.OWNER]);
      const acc = (await inflight.query('SELECT id FROM people_leave_accounts')).rows[0].id;
      await bump(inflight, acc);
      const late = await tx(inflight, { account: acc, employee: f.e1, type: f.annual, kind: 'ACCRUAL', key: `ac:${acc}:1:2025-02-01` });
      await entries(inflight, [{ tx: late, account: acc, bucket: y1, employee: f.e1, type: f.annual, kind: 'ACCRUAL', hours: '1', appliesOn: '2025-02-28',
        periodStart: '2025-02-01', periodEnd: '2025-03-01', policy: f.pol.capped }]);
      const s1 = await viaApp(own(f), (db) => takeSeal(db));
      await inflight.query('COMMIT');
      const s2 = await viaApp(own(f), (db) => takeSeal(db));
      const inS1 = await viaApp(own(f), (db) => transactionsBetweenSeals(db, s0, s1));
      const inS2 = await viaApp(own(f), (db) => transactionsBetweenSeals(db, s1, s2));
      expect(inS1).not.toContain(late);
      expect(inS2).toEqual([late]);
      // Re-reading S1 later gives the same set; every transaction is in exactly one window.
      expect(await viaApp(own(f), (db) => transactionsBetweenSeals(db, s0, s1))).toEqual(inS1);
      const all = await viaApp(own(f), (db) => transactionsBetweenSeals(db, null, s2));
      const before = await viaApp(own(f), (db) => transactionsBetweenSeals(db, null, s0));
      expect([...before, ...inS1, ...inS2].sort()).toEqual([...all].sort());
    } finally {
      inflight.release();
    }
  });
});

// ---- T-C08, T-C64: revision effective_from and its back-fill ---------------------------------------

describe('policy revision effective_from (T-C08) and its back-fill (T-C64)', () => {
  it('new revisions get the business date and RECORDED from the database; revisions stay append-only', async () => {
    for (const f of [A, B]) {
      await admin.query('UPDATE people_leave_policies SET name = name || $2, version = version + 1 WHERE id = $1', [f.pol.capped, ' ']);
      const r = (await admin.query(`SELECT effective_from::text, effective_from_basis, (now() AT TIME ZONE $2)::date::text AS today
        FROM people_leave_policy_revisions WHERE policy_id = $1 ORDER BY version DESC LIMIT 1`, [f.pol.capped, f.timeZone])).rows[0];
      expect(r).toMatchObject({ effective_from: r.today, effective_from_basis: 'RECORDED' });
    }
    expect(await sqlState(as(own(A), (c) => c.query("UPDATE people_leave_policy_revisions SET effective_from_basis = 'INFERRED' WHERE policy_id = $1", [A.pol.capped])))).toBe('42501');
  });

  /** Puts the revisions table back into its pre-migration shape inside the caller's transaction, as the owner. */
  async function preMigration(owner: pg.Client, rows: { policy: string; recordedAt: string }[]) {
    await owner.query('ALTER TABLE people_leave_policy_revisions ALTER COLUMN effective_from DROP NOT NULL');
    await owner.query('ALTER TABLE people_leave_policy_revisions NO FORCE ROW LEVEL SECURITY');
    await owner.query('ALTER TABLE people_leave_policy_revisions DISABLE TRIGGER people_leave_policy_revisions_guard');
    await owner.query("UPDATE people_leave_policy_revisions SET effective_from = NULL, effective_from_basis = 'RECORDED'");
    for (const r of rows) await owner.query('UPDATE people_leave_policy_revisions SET recorded_at = $2 WHERE policy_id = $1', [r.policy, r.recordedAt]);
    await owner.query('ALTER TABLE people_leave_policy_revisions ENABLE TRIGGER people_leave_policy_revisions_guard');
    await owner.query('ALTER TABLE people_leave_policy_revisions FORCE ROW LEVEL SECURITY');
  }
  const block = /-- >>> backfill-effective-from[^\n]*\n([\s\S]*?)-- <<< backfill-effective-from/.exec(MIGRATION)![1]!;

  it("the migration block back-fills every tenant's rows in their own time zone, marks them INFERRED and restores FORCE and the guard", async () => {
    // Counted before the owner's transaction takes ACCESS EXCLUSIVE on the table.
    const total = (await admin.query('SELECT count(*)::int AS n FROM people_leave_policy_revisions')).rows[0].n;
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      // 20:00 UTC on 1 March is 2 March in Perth and still 1 March in New York.
      await preMigration(owner, [{ policy: A.pol.capped, recordedAt: '2026-03-01T20:00:00Z' }, { policy: B.pol.capped, recordedAt: '2026-03-01T20:00:00Z' }]);
      await owner.query("SET LOCAL lock_timeout = '3s'");
      await owner.query("SET LOCAL statement_timeout = '30s'");
      const started = Date.now();
      await owner.query(block);
      const tookMs = Date.now() - started;
      await owner.query('ALTER TABLE people_leave_policy_revisions NO FORCE ROW LEVEL SECURITY');
      const rows = (await owner.query(`SELECT policy_id, effective_from::text, effective_from_basis FROM people_leave_policy_revisions WHERE policy_id = ANY($1)`, [[A.pol.capped, B.pol.capped]])).rows;
      const byPolicy = (p: string) => rows.filter((r) => r.policy_id === p).map((r) => [r.effective_from, r.effective_from_basis]);
      expect(byPolicy(A.pol.capped)).toContainEqual(['2026-03-02', 'INFERRED']);
      expect(byPolicy(B.pol.capped)).toContainEqual(['2026-03-01', 'INFERRED']);
      const all = (await owner.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE effective_from IS NULL)::int AS missing, count(*) FILTER (WHERE effective_from_basis <> 'INFERRED')::int AS other FROM people_leave_policy_revisions")).rows[0];
      expect(all).toEqual({ n: total, missing: 0, other: 0 });
      await owner.query('ALTER TABLE people_leave_policy_revisions FORCE ROW LEVEL SECURITY');
      const state = (await owner.query(`SELECT (SELECT count(*)::int FROM pg_class WHERE relname IN ('businesses', 'people_leave_policy_revisions') AND relforcerowsecurity) AS forced,
        (SELECT tgenabled FROM pg_trigger WHERE tgname = 'people_leave_policy_revisions_guard') AS guard`)).rows[0];
      expect(state).toEqual({ forced: 2, guard: 'O' });
      expect(tookMs).toBeLessThan(5_000);
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
    // Rolled back: production-shaped rows untouched, column NOT NULL again.
    const nn = (await admin.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'people_leave_policy_revisions' AND column_name = 'effective_from'")).rows[0];
    expect(nn.is_nullable).toBe('NO');
  });

  it('behind a long transaction on businesses the block fails fast on lock_timeout and changes nothing', async () => {
    const reader = await app.connect();
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await reader.query('BEGIN');
      await reader.query("SELECT set_config('app.business_id', $1, true)", [A.id]);
      await reader.query('SELECT name FROM businesses');
      await owner.query('BEGIN');
      await preMigration(owner, []);
      await owner.query("SET LOCAL lock_timeout = '1s'");
      const started = Date.now();
      expect(await sqlState(owner.query(block))).toBe('55P03');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
      await reader.query('ROLLBACK');
      reader.release();
    }
    const missing = (await admin.query('SELECT count(*)::int AS n FROM people_leave_policy_revisions WHERE effective_from IS NULL')).rows[0].n;
    expect(missing).toBe(0);
  });
});

// ---- verifier --------------------------------------------------------------------------------------

describe('verifier V-01..V-07', () => {
  it('is clean on everything the guards accepted, and reports each seeded violation', async () => {
    expect(await viaApp(own(A), (db) => verifyLedger(db))).toEqual([]);
    const f = await business('llverify');
    const { y2, accountId } = await closedYear(f, '110');
    const r = await viaApp(own(f), (db) => postDerived(db, accrual(f, { bucketId: randomUUID(), hours: '1', periodStart: '2025-01-01', periodEnd: '2025-02-01', create: { year: Y1 }, employee: f.e2 })));
    const b2 = (await admin.query('SELECT id FROM people_leave_buckets WHERE account_id = $1', [r.accountId])).rows[0].id;
    const [res1] = await reserve(f, { account: r.accountId, bucket: b2, dates: [['2025-07-07', '8']], employee: f.e2 });
    expect(await viaApp(own(f), (db) => verifyLedger(db))).toEqual([]);
    // Seed violations past the guards (as a restore or a manual repair could), user triggers off.
    await admin.query('BEGIN');
    for (const t of TABLES) await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    const anyTx = (await admin.query('SELECT id FROM people_leave_transactions WHERE account_id = $1 LIMIT 1', [r.accountId])).rows[0].id;
    const ins = (cols: Record<string, unknown>) => {
      const k = Object.keys(cols);
      return admin.query(`INSERT INTO people_leave_entries (${k.join(', ')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(', ')})`, k.map((x) => cols[x]));
    };
    /** A seed the indexes may refuse; a savepoint keeps the rest of the seeding transaction alive. */
    const soft = async (q: () => Promise<unknown>) => {
      await admin.query('SAVEPOINT seed');
      try { await q(); await admin.query('RELEASE SAVEPOINT seed'); } catch { await admin.query('ROLLBACK TO SAVEPOINT seed'); }
    };
    const base = { business_id: f.id, account_id: r.accountId, employee_id: f.e2, leave_type_id: f.annual, policy_id: f.pol.capped, policy_version: 1, transaction_id: anyTx, bucket_id: b2 };
    await ins({ ...base, id: randomUUID(), book: 'RESERVED', kind: 'RESERVATION_RELEASE', hours: -24, applies_on: '2025-07-07', leave_date: '2025-07-07', reservation_entry_id: res1, release_reason: 'CANCELLED' });
    await soft(() => ins({ ...base, id: randomUUID(), book: 'RESERVED', kind: 'RESERVATION_RELEASE', hours: -8, applies_on: '2025-07-07', leave_date: '2025-07-07', reservation_entry_id: res1, release_reason: 'CONSUMED' }));
    await ins({ ...base, id: randomUUID(), book: 'RESERVED', kind: 'RESERVATION', hours: 8, applies_on: '2025-07-07', leave_date: '2027-07-07' });
    await admin.query(`INSERT INTO people_leave_buckets (id, business_id, account_id, employee_id, leave_type_id, service_period, year_start, year_end, state)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, '2026-06-01', '2027-06-01', 'FUTURE')`, [f.id, accountId, f.e1, f.annual]);
    await admin.query("INSERT INTO people_leave_entries (id, business_id, transaction_id, account_id, bucket_id, employee_id, leave_type_id, book, kind, hours, applies_on, policy_id, policy_version) SELECT gen_random_uuid(), business_id, transaction_id, account_id, $2, employee_id, leave_type_id, 'BALANCE', 'ADJUSTMENT', 1, applies_on, policy_id, policy_version FROM people_leave_entries WHERE bucket_id = $1 LIMIT 1", [y2, y2]);
    await admin.query('UPDATE people_leave_accounts SET version = version + 5 WHERE id = $1', [accountId]);
    await admin.query(`INSERT INTO people_leave_transactions (id, business_id, account_id, employee_id, leave_type_id, kind, idempotency_key, source_kind, actor_user_id, actor_basis, posted_on, account_version)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ACCRUAL', 'seeded-empty', 'POLICY_ACCRUAL', $5, 'DERIVED', CURRENT_DATE, 99)`, [f.id, r.accountId, f.e2, f.annual, f.u.OWNER]);
    for (const t of TABLES) await admin.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
    await admin.query('COMMIT');
    const found = new Set((await viaApp(own(f), (db) => verifyLedger(db))).map((x) => x.check));
    expect([...found].sort()).toEqual(['V-01', 'V-03', 'V-05', 'V-06', 'V-07']);
    // Other businesses are untouched and invisible.
    expect(await viaApp(own(A), (db) => verifyLedger(db))).toEqual([]);
  });
});
