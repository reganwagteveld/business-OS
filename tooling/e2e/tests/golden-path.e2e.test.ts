/**
 * WP-T1 golden path, over real HTTP against the built API and a disposable PostgreSQL:
 *
 *   business -> customer + contact -> opportunity -> project -> quote (issued, accepted) -> invoice
 *   (converted, issued) -> partial payment -> idempotent replay -> final payment -> settled
 *
 * The existing integration suites call route handlers in-process (tests/integration/cross-zone.test.ts is the
 * closest). This one adds what they cannot: the production server build, real cookies and headers, the
 * runtime database role without owner credentials, and read-back of what was actually persisted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTeam, type Team } from '../src/actors';
import { admin, closeAdmin, connectAdmin, one } from '../src/db';
import { ids, line, money, PAST } from '../src/util';

let t: Team;
const own = () => t.people.OWNER;
const mgr = () => t.people.MANAGER;
const path = (p = '') => `/api/v1/b/${t.slug}${p}`;
const S: Record<string, string> = {};

beforeAll(async () => {
  await connectAdmin();
  t = await newTeam('gp');
}, 180_000);
afterAll(closeAdmin);

describe('golden path: enquiry to cash', () => {
  it('has created the business with the creator as owner, in the e2e region, and no other tenant data', async () => {
    const res = await own().get(path());
    expect(res.status).toBe(200);
    expect(res.body.business).toMatchObject({ slug: t.slug, currency: 'AUD', countryCode: 'AU' });
    expect(res.body.membership.role).toBe('OWNER');
    const row = await one('SELECT home_region, currency FROM businesses WHERE id = $1', [t.businessId]);
    expect(row).toMatchObject({ home_region: 'e2e', currency: 'AUD' });
    const roles = await admin.query('SELECT role, count(*)::int AS n FROM memberships WHERE business_id = $1 GROUP BY role ORDER BY role', [t.businessId]);
    expect(Object.fromEntries(roles.rows.map((r) => [r.role, r.n]))).toEqual({ OWNER: 1, ADMIN: 1, MANAGER: 1, MEMBER: 1 });
  });

  it('creates the customer and contact and links the primary contact', async () => {
    const c = await mgr().post(path('/customers'), { displayName: 'Harbour Joinery' });
    expect(c.status).toBe(201);
    S.customer = c.body.customer.id;
    const ct = await mgr().post(path('/contacts'), { firstName: 'Mia', lastName: 'Harbour', customerId: S.customer, email: 'mia@harbour.example' });
    expect(ct.status).toBe(201);
    S.contact = ct.body.contact.id;
    expect((await mgr().patch(path(`/customers/${S.customer}`), { primaryContactId: S.contact })).status).toBe(200);
    const row = await one('SELECT business_id, primary_contact_id FROM customers WHERE id = $1', [S.customer]);
    expect(row).toEqual({ business_id: t.businessId, primary_contact_id: S.contact });
  });

  it('carries the customer into a Sales opportunity and a Projects project', async () => {
    const opp = await t.people.MEMBER.post(path('/sales/opportunities'), { title: 'Showroom fit-out', customerId: S.customer, contactId: S.contact, amount: '1200.00' });
    expect(opp.status).toBe(201);
    S.opportunity = opp.body.opportunity.id;
    const proj = await mgr().post(path('/projects'), { name: 'Showroom fit-out', customerId: S.customer, ownerUserId: mgr().id });
    expect(proj.status).toBe(201);
    S.project = proj.body.project.id;
    const task = await t.people.MEMBER.post(path(`/projects/${S.project}/tasks`), { title: 'Site measure', assigneeUserId: t.people.MEMBER.id });
    expect(task.status).toBe(201);
    const listed = await t.people.MEMBER.get(path(`/customers/${S.customer}/projects`));
    expect(ids(listed.body.projects)).toContain(S.project);
    const opps = await t.people.MEMBER.get(path(`/sales/opportunities?customerId=${S.customer}`));
    expect(ids(opps.body.opportunities)).toContain(S.opportunity);
  });

  it('quotes the opportunity and project with tax, issues and has it accepted', async () => {
    const gst = await own().post(path('/finance/tax-rates'), { name: 'GST', ratePercent: '10' });
    expect(gst.status).toBe(201);
    S.tax = gst.body.taxRate.id;
    const q = await mgr().post(path('/finance/quotes'), {
      customerId: S.customer, contactId: S.contact, opportunityId: S.opportunity, projectId: S.project,
      lines: [line({ taxRateId: S.tax }), line({ description: 'Materials', quantity: '1', unitPrice: '700.00', taxRateId: S.tax })],
    });
    expect(q.status).toBe(201);
    // 2 x 150 + 700 = 1000.00, GST 100.00, total 1100.00
    expect(q.body.document).toMatchObject({ kind: 'QUOTE', status: 'DRAFT', subtotal: '1000.00', taxTotal: '100.00', total: '1100.00', opportunityId: S.opportunity, projectId: S.project });
    S.quote = q.body.document.id;
    const issued = await own().post(path(`/finance/quotes/${S.quote}/issue`), { version: q.body.document.version, issueDate: PAST });
    expect(issued.status).toBe(200);
    expect(issued.body.document).toMatchObject({ status: 'ISSUED' });
    expect(issued.body.document.number).toMatch(/\d/);
    const accepted = await own().post(path(`/finance/quotes/${S.quote}/accept`), { version: issued.body.document.version });
    expect(accepted.status).toBe(200);
    expect(accepted.body.document.status).toBe('ACCEPTED');
    const won = await t.people.MEMBER.post(path(`/sales/opportunities/${S.opportunity}/win`), {});
    expect(won.status).toBe(200);
    expect(won.body.opportunity.status).toBe('WON');
  });

  it('converts the accepted quote into an invoice that keeps every cross-Zone link, then issues it', async () => {
    const conv = await mgr().post(path(`/finance/quotes/${S.quote}/convert`), {});
    expect(conv.status).toBe(201);
    const inv = conv.body.document;
    expect(inv).toMatchObject({ kind: 'INVOICE', status: 'DRAFT', customerId: S.customer, opportunityId: S.opportunity, projectId: S.project, total: '1100.00' });
    S.invoice = inv.id;
    const issued = await own().post(path(`/finance/invoices/${S.invoice}/issue`), { version: inv.version, issueDate: PAST, dueDate: '2026-12-31' });
    expect(issued.status).toBe(200);
    expect(issued.body.document).toMatchObject({ status: 'ISSUED', total: '1100.00' });

    const row = await one('SELECT status, source_quote_id, opportunity_id, project_id, customer_id, total, content_sha256, number FROM finance_documents WHERE id = $1', [S.invoice]);
    expect(row).toMatchObject({ status: 'ISSUED', source_quote_id: S.quote, opportunity_id: S.opportunity, project_id: S.project, customer_id: S.customer });
    expect(money(row.total)).toBe(1100);
    expect(row.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.number).toBeTruthy();
    const quote = await one('SELECT status FROM finance_documents WHERE id = $1', [S.quote]);
    expect(quote.status).toBe('ACCEPTED');
  });

  it('settles the invoice in two payments; the state, allocations and balances agree at each step', async () => {
    const first = await own().post(path('/finance/payments'), { customerId: S.customer, amount: '400.00', receivedOn: PAST, method: 'BANK_TRANSFER', allocations: [{ invoiceId: S.invoice, amount: '400.00' }] }, 'e2e-gp-pay-1');
    expect(first.status).toBe(201);
    S.pay1 = first.body.payment.id;

    let st = (await mgr().get(path(`/finance/invoices/${S.invoice}/settlement`))).body.settlement;
    expect(st).toMatchObject({ settlementState: 'PARTIALLY_PAID', allocatedTotal: '400.00', outstanding: '700.00' });
    let bal = (await mgr().get(path(`/finance/customer-balances?customerId=${S.customer}`))).body.balances;
    expect(bal).toHaveLength(1);
    expect(bal[0]).toMatchObject({ customerId: S.customer, receivable: '700.00' });

    // The same Idempotency-Key and body replays the stored result: one payment, one allocation.
    const replay = await own().post(path('/finance/payments'), { customerId: S.customer, amount: '400.00', receivedOn: PAST, method: 'BANK_TRANSFER', allocations: [{ invoiceId: S.invoice, amount: '400.00' }] }, 'e2e-gp-pay-1');
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.payment.id).toBe(S.pay1);
    expect((await one("SELECT count(*)::int AS n FROM finance_payments WHERE business_id = $1", [t.businessId])).n).toBe(1);

    const second = await own().post(path('/finance/payments'), { customerId: S.customer, amount: '700.00', receivedOn: PAST, method: 'CARD', allocations: [{ invoiceId: S.invoice, amount: '700.00' }] });
    expect(second.status).toBe(201);
    st = (await mgr().get(path(`/finance/invoices/${S.invoice}/settlement`))).body.settlement;
    expect(st).toMatchObject({ settlementState: 'PAID', allocatedTotal: '1100.00', outstanding: '0.00', overdue: false });
    bal = (await mgr().get(path(`/finance/customer-balances?customerId=${S.customer}`))).body.balances;
    expect(bal.filter((b: { customerId: string; receivable: string }) => b.customerId === S.customer && money(b.receivable) > 0)).toEqual([]);
    expect((await own().get(path('/finance/reconciliation'))).status).toBe(200);
  });

  it('persisted a consistent ledger: allocations add up to the invoice, payments and the customer', async () => {
    const inv = await one('SELECT total, allocated_total, credit_applied_total FROM finance_documents WHERE id = $1', [S.invoice]);
    const alloc = await one('SELECT sum(amount) AS s, count(*)::int AS n FROM finance_payment_allocations WHERE invoice_id = $1 AND reversed_at IS NULL', [S.invoice]);
    expect(alloc.n).toBe(2);
    expect(money(alloc.s)).toBe(money(inv.total));
    expect(money(inv.allocated_total)).toBe(money(inv.total));
    const pays = await one("SELECT sum(amount) AS paid, sum(allocated_total) AS alloc FROM finance_payments WHERE business_id = $1 AND status = 'RECORDED'", [t.businessId]);
    expect(money(pays.paid)).toBe(1100);
    expect(money(pays.alloc)).toBe(1100);
    // Every row the journey wrote belongs to this one tenant and nothing else.
    const strays = await admin.query(
      `SELECT 'finance_documents' AS t FROM finance_documents WHERE (customer_id = $2 OR id = ANY($3::uuid[])) AND business_id <> $1
       UNION ALL SELECT 'finance_payment_allocations' FROM finance_payment_allocations WHERE invoice_id = $4 AND business_id <> $1
       UNION ALL SELECT 'opportunities' FROM opportunities WHERE id = $5 AND business_id <> $1`,
      [t.businessId, S.customer, [S.quote, S.invoice], S.invoice, S.opportunity],
    );
    expect(strays.rows).toEqual([]);
  });

  it('left a customer timeline and audit trail that name the actors', async () => {
    const tl = await t.people.MEMBER.get(path(`/activities?customerId=${S.customer}`));
    expect(tl.status).toBe(200);
    expect(tl.body.activities.map((a: { type: string }) => a.type)).toEqual(expect.arrayContaining(['customer.created', 'contact.created', 'customer.primary_contact_changed']));
    const audit = await admin.query('SELECT DISTINCT action FROM audit_events WHERE business_id = $1 ORDER BY action', [t.businessId]);
    const actions: string[] = audit.rows.map((r) => r.action);
    console.info(`[e2e] audit actions: ${actions.join(', ')}`);
    expect(actions.length).toBeGreaterThan(5);
    const actorless = await one('SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND actor_user_id IS NULL', [t.businessId]);
    expect(actorless.n).toBe(0);
  });
});
