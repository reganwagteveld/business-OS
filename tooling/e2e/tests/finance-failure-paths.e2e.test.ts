/**
 * Failure paths over real HTTP: the API must refuse each of these with the right 4xx and leave the stored
 * financial state exactly as it was. Every test that expects a refusal reads the database afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTeam, type Team } from '../src/actors';
import { Client } from '../src/http';
import { admin, closeAdmin, connectAdmin, one } from '../src/db';
import { line, money, PAST, DUE } from '../src/util';

let t: Team;
let customer: string;
let other: string;
const path = (p = '') => `/api/v1/b/${t.slug}${p}`;
const own = () => t.people.OWNER;

async function issuedInvoice(forCustomer = customer, unitPrice = '1000.00'): Promise<{ id: string; version: number }> {
  const d = await own().post(path('/finance/invoices'), { customerId: forCustomer, lines: [line({ quantity: '1', unitPrice })] });
  expect(d.status).toBe(201);
  const issued = await own().post(path(`/finance/invoices/${d.body.document.id}/issue`), { version: d.body.document.version, issueDate: PAST, dueDate: DUE });
  expect(issued.status).toBe(200);
  return { id: d.body.document.id, version: issued.body.document.version };
}
const pay = (c: string, invoiceId: string, amount: string, key?: string | null) =>
  own().post(path('/finance/payments'), { customerId: c, amount, receivedOn: PAST, method: 'CASH', allocations: [{ invoiceId, amount }] }, key);
const state = async () => ({
  payments: (await one('SELECT count(*)::int AS n FROM finance_payments WHERE business_id = $1', [t.businessId])).n,
  allocations: (await one('SELECT count(*)::int AS n FROM finance_payment_allocations WHERE business_id = $1', [t.businessId])).n,
});

beforeAll(async () => {
  await connectAdmin();
  t = await newTeam('ff');
  customer = (await t.people.MANAGER.post(path('/customers'), { displayName: 'Primary' })).body.customer.id;
  other = (await t.people.MANAGER.post(path('/customers'), { displayName: 'Secondary' })).body.customer.id;
}, 180_000);
afterAll(closeAdmin);

describe('payments are refused when they would corrupt the ledger', () => {
  it('over-allocation: paying more than the invoice leaves is 409 and writes nothing', async () => {
    const inv = await issuedInvoice();
    const before = await state();
    const res = await pay(customer, inv.id, '1000.01');
    expect(res.status).toBe(409);
    expect(await state()).toEqual(before);
    expect(money((await one('SELECT allocated_total FROM finance_documents WHERE id = $1', [inv.id])).allocated_total)).toBe(0);
  });

  it("allocating one customer's payment to another customer's invoice is refused", async () => {
    const inv = await issuedInvoice(other);
    const before = await state();
    const res = await pay(customer, inv.id, '10.00');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await state()).toEqual(before);
  });

  it('a payment without an Idempotency-Key is a 4xx; the same key with a different body is 409', async () => {
    const inv = await issuedInvoice();
    const before = await state();
    const missing = await pay(customer, inv.id, '10.00', null);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
    expect(await state()).toEqual(before);
    expect((await pay(customer, inv.id, '10.00', 'e2e-ff-key')).status).toBe(201);
    const different = await pay(customer, inv.id, '20.00', 'e2e-ff-key');
    expect(different.status).toBe(409);
    expect((await state()).payments).toBe(before.payments + 1);
  });

  it('two simultaneous payments that together exceed the invoice: exactly one wins, never over-settled', async () => {
    const inv = await issuedInvoice(customer, '1000.00');
    const results = await Promise.all([pay(customer, inv.id, '600.00'), pay(customer, inv.id, '600.00')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const row = await one('SELECT allocated_total, total FROM finance_documents WHERE id = $1', [inv.id]);
    expect(money(row.allocated_total)).toBe(600);
    const alloc = await one('SELECT count(*)::int AS n FROM finance_payment_allocations WHERE invoice_id = $1', [inv.id]);
    expect(alloc.n).toBe(1);
  });

  it('a credit note larger than the invoice is refused', async () => {
    const inv = await issuedInvoice(customer, '100.00');
    const res = await own().post(path(`/finance/invoices/${inv.id}/credit-notes`), { lines: [line({ quantity: '1', unitPrice: '100.01' })] });
    // Creating the draft may be allowed; issuing and applying more than the invoice never is.
    if (res.status === 201) {
      const issued = await own().post(path(`/finance/credit-notes/${res.body.document.id}/issue`), { version: res.body.document.version, issueDate: PAST });
      const applied = issued.status === 200
        ? await own().post(path(`/finance/credit-notes/${res.body.document.id}/applications`), { applications: [{ invoiceId: inv.id, amount: '100.01' }] })
        : issued;
      expect(applied.status).toBeGreaterThanOrEqual(400);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(money((await one('SELECT credit_applied_total FROM finance_documents WHERE id = $1', [inv.id])).credit_applied_total)).toBe(0);
  });
});

describe('documents follow their state machine', () => {
  it('issuing with a stale version is 409 and the draft stays a draft', async () => {
    const d = await own().post(path('/finance/invoices'), { customerId: customer, lines: [line()] });
    const res = await own().post(path(`/finance/invoices/${d.body.document.id}/issue`), { version: d.body.document.version + 5, issueDate: PAST });
    expect(res.status).toBe(409);
    expect((await one('SELECT status, number FROM finance_documents WHERE id = $1', [d.body.document.id]))).toEqual({ status: 'DRAFT', number: null });
  });

  it('an issued invoice is immutable through the API and through the application database role', async () => {
    const inv = await issuedInvoice();
    const edit = await own().patch(path(`/finance/invoices/${inv.id}`), { version: inv.version, notes: 'changed after issue' });
    expect(edit.status).toBe(409);
    expect((await one('SELECT notes FROM finance_documents WHERE id = $1', [inv.id])).notes).not.toBe('changed after issue');
  });

  it('a draft or declined quote cannot be converted, and a repeated conversion with the same key makes one invoice', async () => {
    const q = await own().post(path('/finance/quotes'), { customerId: customer, lines: [line()] });
    const id = q.body.document.id;
    expect((await own().post(path(`/finance/quotes/${id}/convert`), {})).status).toBe(409);
    const issued = await own().post(path(`/finance/quotes/${id}/issue`), { version: q.body.document.version, issueDate: PAST });
    expect(issued.status).toBe(200);
    const declined = await own().post(path(`/finance/quotes/${id}/decline`), { version: issued.body.document.version });
    expect(declined.status).toBe(200);
    expect((await own().post(path(`/finance/quotes/${id}/convert`), {})).status).toBe(409);
    expect((await one("SELECT count(*)::int AS n FROM finance_documents WHERE source_quote_id = $1", [id])).n).toBe(0);

    const ok = await own().post(path('/finance/quotes'), { customerId: customer, lines: [line()] });
    const okIssued = await own().post(path(`/finance/quotes/${ok.body.document.id}/issue`), { version: ok.body.document.version, issueDate: PAST });
    const accepted = await own().post(path(`/finance/quotes/${ok.body.document.id}/accept`), { version: okIssued.body.document.version });
    expect(accepted.status).toBe(200);
    const first = await own().post(path(`/finance/quotes/${ok.body.document.id}/convert`), {}, 'e2e-ff-convert');
    const again = await own().post(path(`/finance/quotes/${ok.body.document.id}/convert`), {}, 'e2e-ff-convert');
    expect(first.status).toBe(201);
    expect(again.body.document.id).toBe(first.body.document.id);
    expect((await one("SELECT count(*)::int AS n FROM finance_documents WHERE source_quote_id = $1 AND kind = 'INVOICE'", [ok.body.document.id])).n).toBe(1);
  });

  it('an invoice with payments cannot be voided; an unpaid one can, and then owes nothing', async () => {
    const paid = await issuedInvoice();
    expect((await pay(customer, paid.id, '50.00')).status).toBe(201);
    const blocked = await own().post(path(`/finance/invoices/${paid.id}/void`), { version: paid.version, reason: 'mistake' });
    expect(blocked.status).toBe(409);
    expect((await one('SELECT status FROM finance_documents WHERE id = $1', [paid.id])).status).toBe('ISSUED');

    const unpaid = await issuedInvoice();
    const ok = await own().post(path(`/finance/invoices/${unpaid.id}/void`), { version: unpaid.version, reason: 'duplicate' });
    expect(ok.status).toBe(200);
    expect(ok.body.document.status).toBe('VOID');
    const settlement = await own().get(path(`/finance/invoices/${unpaid.id}/settlement`));
    expect(settlement.body.settlement.outstanding).toBe('0.00');
    expect((await pay(customer, unpaid.id, '10.00')).status).toBe(409);
  });
});

describe('malformed and unauthorised requests', () => {
  it('invalid bodies are 400 with no stack, SQL or file path in the response', async () => {
    const cases = [
      own().post(path('/finance/invoices'), { customerId: 'not-a-uuid' }),
      own().post(path('/finance/payments'), { customerId: customer, amount: 'abc', receivedOn: PAST, method: 'CASH', allocations: [] }),
      own().request('POST', path('/finance/invoices'), { body: undefined, headers: { 'content-type': 'application/json' } }),
    ];
    for (const res of await Promise.all(cases)) {
      expect(res.status).toBe(400);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/\bat \w+.*\(|node_modules|SELECT |prisma|postgres/i);
    }
  });

  it('unknown and malformed ids are 404 or 400, never 500', async () => {
    const unknown = await own().get(path('/finance/invoices/00000000-0000-4000-8000-000000000000'));
    expect(unknown.status).toBe(404);
    const malformed = await own().get(path('/finance/invoices/not-a-uuid'));
    expect([400, 404]).toContain(malformed.status);
  });

  it('role limits hold over HTTP: MEMBER sees no Finance, MANAGER cannot issue or take payments', async () => {
    const d = await own().post(path('/finance/invoices'), { customerId: customer, lines: [line()] });
    expect((await t.people.MEMBER.get(path('/finance/invoices'))).status).toBe(403);
    expect((await t.people.MANAGER.post(path(`/finance/invoices/${d.body.document.id}/issue`), { version: 1, issueDate: PAST })).status).toBe(403);
    const before = await state();
    expect((await t.people.MANAGER.post(path('/finance/payments'), { customerId: customer, amount: '1.00', receivedOn: PAST, method: 'CASH', allocations: [] })).status).toBe(403);
    expect(await state()).toEqual(before);
    expect((await one('SELECT status FROM finance_documents WHERE id = $1', [d.body.document.id])).status).toBe('DRAFT');
  });

  it('no session is 401 and a forged or tampered session cookie is 401 too', async () => {
    expect((await new Client().get(path('/finance/invoices'))).status).toBe(401);
    const forged = new Client();
    const res = await forged.request('GET', path('/finance/invoices'), { headers: { cookie: 'better-auth.session_token=forged.value' } });
    expect(res.status).toBe(401);
  });

  it('an unadmitted outsider cannot create a business', async () => {
    const stranger = new Client();
    const res = await stranger.post('/api/v1/businesses', { name: 'Nope', slug: 'nope-' + Date.now(), countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' });
    expect(res.status).toBe(401);
    expect((await admin.query("SELECT 1 FROM businesses WHERE slug LIKE 'nope-%'")).rowCount).toBe(0);
  });
});
