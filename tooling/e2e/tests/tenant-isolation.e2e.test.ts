/**
 * Cross-tenant isolation over real HTTP and at the database, for the same records the golden path creates.
 * tests/integration/{tenancy,cross-zone}.test.ts and tests/isolation cover handlers and RLS in-process; here the
 * built server answers real requests and the runtime role (bos_app, no owner credentials) is probed directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newTeam, newUser, type Team } from '../src/actors';
import { admin, closeAdmin, connectAdmin, one } from '../src/db';
import { pgConfig } from '../scripts/guard.mjs';
import { env } from '../src/env';
import { ids, line, PAST, DUE } from '../src/util';

let A: Team;
let B: Team;
const a: Record<'customer' | 'contact' | 'opportunity' | 'project' | 'quote' | 'invoice' | 'payment', string> = {} as never;
const b: Record<'customer' | 'contact' | 'opportunity' | 'project' | 'invoice', string> = {} as never;
const pa = (p = '') => `/api/v1/b/${A.slug}${p}`;
const pb = (p = '') => `/api/v1/b/${B.slug}${p}`;

async function seed(t: Team, p: (x?: string) => string, into: Record<string, string>, withPayment: boolean) {
  const o = t.people.OWNER;
  into.customer = (await o.post(p('/customers'), { displayName: 'Customer ' + t.slug })).body.customer.id;
  into.contact = (await o.post(p('/contacts'), { firstName: 'Con', lastName: 'Tact', customerId: into.customer })).body.contact.id;
  into.opportunity = (await o.post(p('/sales/opportunities'), { title: 'Deal', customerId: into.customer, amount: '500.00' })).body.opportunity.id;
  into.project = (await o.post(p('/projects'), { name: 'Project', customerId: into.customer })).body.project.id;
  const q = await o.post(p('/finance/quotes'), { customerId: into.customer, opportunityId: into.opportunity, projectId: into.project, lines: [line()] });
  into.quote = q.body.document.id;
  const inv = await o.post(p('/finance/invoices'), { customerId: into.customer, opportunityId: into.opportunity, projectId: into.project, lines: [line({ quantity: '1', unitPrice: '500.00' })] });
  const issued = await o.post(p(`/finance/invoices/${inv.body.document.id}/issue`), { version: inv.body.document.version, issueDate: PAST, dueDate: DUE });
  expect(issued.status).toBe(200);
  into.invoice = inv.body.document.id;
  if (withPayment) {
    const pay = await o.post(p('/finance/payments'), { customerId: into.customer, amount: '100.00', receivedOn: PAST, method: 'CASH', allocations: [{ invoiceId: into.invoice, amount: '100.00' }] });
    expect(pay.status).toBe(201);
    into.payment = pay.body.payment.id;
  }
}

beforeAll(async () => {
  await connectAdmin();
  A = await newTeam('ia');
  B = await newTeam('ib');
  await seed(A, pa, a, true);
  await seed(B, pb, b, false);
}, 240_000);
afterAll(closeAdmin);

describe("business B cannot reach business A's records over HTTP", () => {
  it.each([
    ['customer', () => `/customers/${a.customer}`],
    ['contact', () => `/contacts/${a.contact}`],
    ['opportunity', () => `/sales/opportunities/${a.opportunity}`],
    ['project', () => `/projects/${a.project}`],
    ['quote', () => `/finance/quotes/${a.quote}`],
    ['invoice', () => `/finance/invoices/${a.invoice}`],
    ['invoice settlement', () => `/finance/invoices/${a.invoice}/settlement`],
    ['payment', () => `/finance/payments/${a.payment}`],
  ])('A %s by id through B\'s slug is 404', async (_label, p) => {
    expect((await B.people.OWNER.get(pb(p()))).status).toBe(404);
  });

  it("A's slug is 404 for B's owner on every Zone, and 404 (not 403) so membership is not revealed", async () => {
    for (const p of ['/customers', '/sales/opportunities', '/projects', '/finance/invoices', '/finance/payments', '/activities', '/people/employees']) {
      expect((await B.people.OWNER.get(pa(p))).status, p).toBe(404);
    }
  });

  it("B's lists never contain A's ids", async () => {
    const o = B.people.OWNER;
    const lists = {
      customers: (await o.get(pb('/customers'))).body.customers,
      opportunities: (await o.get(pb('/sales/opportunities'))).body.opportunities,
      projects: (await o.get(pb('/projects'))).body.projects,
      invoices: (await o.get(pb('/finance/invoices'))).body.documents,
      quotes: (await o.get(pb('/finance/quotes'))).body.documents,
      payments: (await o.get(pb('/finance/payments'))).body.payments,
    };
    const own = { customers: b.customer, opportunities: b.opportunity, projects: b.project, invoices: b.invoice };
    for (const [name, rows] of Object.entries(lists)) {
      expect(Array.isArray(rows), name).toBe(true);
      const got = ids(rows);
      for (const id of Object.values(a)) expect(got, name).not.toContain(id);
      if (name in own) expect(got, name).toContain(own[name as keyof typeof own]);
    }
  });

  it('writes by id through B change nothing in A', async () => {
    const o = B.people.OWNER;
    const before = await one('SELECT display_name, updated_at FROM customers WHERE id = $1', [a.customer]);
    expect((await o.patch(pb(`/customers/${a.customer}`), { displayName: 'Hijacked' })).status).toBe(404);
    const pay = await o.post(pb('/finance/payments'), { customerId: a.customer, amount: '1.00', receivedOn: PAST, method: 'CASH', allocations: [{ invoiceId: a.invoice, amount: '1.00' }] });
    expect(pay.status).toBeGreaterThanOrEqual(400);
    expect(pay.status).toBeLessThan(500);
    expect((await o.post(pb(`/finance/invoices/${a.invoice}/void`), { version: 2, reason: 'hostile' })).status).toBe(404);
    expect(await one('SELECT display_name, updated_at FROM customers WHERE id = $1', [a.customer])).toEqual(before);
    const inv = await one('SELECT status, allocated_total FROM finance_documents WHERE id = $1', [a.invoice]);
    expect(inv.status).toBe('ISSUED');
    expect(Number(inv.allocated_total)).toBe(100);
  });

  it("creating records in B that link A's records is refused and writes nothing", async () => {
    const o = B.people.OWNER;
    const attempts = [
      o.post(pb('/sales/opportunities'), { title: 'x', customerId: a.customer }),
      o.post(pb('/projects'), { name: 'x', customerId: a.customer }),
      o.post(pb('/finance/quotes'), { customerId: b.customer, opportunityId: a.opportunity }),
      o.post(pb('/finance/quotes'), { customerId: b.customer, projectId: a.project }),
      o.post(pb('/finance/invoices'), { customerId: a.customer, lines: [line()] }),
      o.post(pb('/finance/payments'), { customerId: b.customer, amount: '1.00', receivedOn: PAST, method: 'CASH', allocations: [{ invoiceId: a.invoice, amount: '1.00' }] }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    const stray = await admin.query(
      `SELECT 'finance_documents' AS t FROM finance_documents WHERE business_id = $1 AND (customer_id = ANY($2::uuid[]) OR opportunity_id = ANY($2::uuid[]) OR project_id = ANY($2::uuid[]))
       UNION ALL SELECT 'payments' FROM finance_payments WHERE business_id = $1 AND customer_id = ANY($2::uuid[])
       UNION ALL SELECT 'allocations' FROM finance_payment_allocations WHERE business_id = $1 AND invoice_id = ANY($2::uuid[])
       UNION ALL SELECT 'opportunities' FROM opportunities WHERE business_id = $1 AND customer_id = ANY($2::uuid[])
       UNION ALL SELECT 'projects' FROM projects WHERE business_id = $1 AND customer_id = ANY($2::uuid[])`,
      [B.businessId, Object.values(a)],
    );
    expect(stray.rows).toEqual([]);
  });

  it('one person in two businesses gets each business its own role and data on one session', async () => {
    const both = await newUser('ibx');
    for (const [team, role] of [[A, 'MEMBER'], [B, 'ADMIN']] as const) {
      expect((await team.people.OWNER.post(`/api/v1/b/${team.slug}/invitations`, { email: both.email, role })).status).toBe(201);
      const { planInvitationToken } = await import('../src/db');
      const token = await planInvitationToken(both.email, team.slug);
      expect((await both.post('/api/v1/invitations/accept', { token })).status).toBe(200);
    }
    expect((await both.get(pa())).body.membership.role).toBe('MEMBER');
    expect((await both.get(pb())).body.membership.role).toBe('ADMIN');
    expect((await both.get(pa('/finance/invoices'))).status).toBe(403);
    expect((await both.get(pb('/finance/invoices'))).status).toBe(200);
    expect(ids((await both.get(pa('/customers'))).body.customers)).toEqual([a.customer]);
    expect(ids((await both.get(pb('/customers'))).body.customers)).toEqual([b.customer]);
  });
});

describe('the runtime database role is confined by row-level security', () => {
  const asApp = async <T>(businessId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const pool = new pg.Pool({ ...pgConfig(env.appDbUrl, 'E2E_APP_DB_URL'), max: 1 });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (businessId) await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [businessId, '00000000-0000-4000-8000-000000000001']);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
      await pool.end();
    }
  };

  it('every table with a business_id column has row-level security enabled and forced', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'business_id' AND NOT a.attisdropped)
        ORDER BY c.relname`,
    );
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.filter((r) => !r.enabled || !r.forced).map((r) => r.relname)).toEqual([]);
  });

  it('with no tenant context the role sees no tenant rows at all', async () => {
    await asApp(null, async (c) => {
      for (const table of ['customers', 'opportunities', 'projects', 'finance_documents', 'finance_payments', 'finance_payment_allocations', 'activities', 'audit_events']) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  it("with A's context it sees A's rows and none of B's", async () => {
    await asApp(A.businessId, async (c) => {
      const mine = await c.query('SELECT id, business_id FROM finance_documents');
      expect(mine.rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(mine.rows.map((r) => r.business_id))).toEqual(new Set([A.businessId]));
      expect((await c.query('SELECT 1 FROM finance_documents WHERE id = $1', [b.invoice])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM customers WHERE id = $1', [b.customer])).rowCount).toBe(0);
    });
  });

  it("with B's context it can neither update A's rows nor insert a row for A", async () => {
    await asApp(B.businessId, async (c) => {
      const upd = await c.query("UPDATE customers SET display_name = 'x' WHERE id = $1", [a.customer]);
      expect(upd.rowCount).toBe(0);
      await c.query('SAVEPOINT s');
      await expect(
        c.query(`INSERT INTO customers (id, business_id, display_name, updated_at) VALUES (gen_random_uuid(), $1, 'planted', now())`, [A.businessId]),
      ).rejects.toThrow(/row-level security|violates/i);
      await c.query('ROLLBACK TO SAVEPOINT s');
    });
    expect((await one("SELECT count(*)::int AS n FROM customers WHERE display_name = 'planted'")).n).toBe(0);
  });

  it('even in the right tenant, an issued invoice cannot be rewritten and the privileged schema is closed', async () => {
    await asApp(A.businessId, async (c) => {
      await c.query('SAVEPOINT s');
      await expect(c.query("UPDATE finance_documents SET total = '1.0000' WHERE id = $1", [a.invoice])).rejects.toThrow();
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query('SAVEPOINT s2');
      await expect(c.query('SELECT * FROM app_private.beta_admissions')).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK TO SAVEPOINT s2');
    });
    expect(Number((await one('SELECT total FROM finance_documents WHERE id = $1', [a.invoice])).total)).toBe(500);
  });
});
