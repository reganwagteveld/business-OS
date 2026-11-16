import { inviteForSignup, admitFixture } from './support/admission';
/**
 * STAB-01 (docs/stabilisation-checkpoint.md, Phase C): the cross-Zone workflows end to end, through
 * the real route handlers against PostgreSQL with the migrations and privileged SQL applied as in
 * production. Each Zone has its own deep suite; this one checks the joins between Zones:
 *
 * - one customer carried through Customers, Sales, Projects, Finance, Scheduling and Communications;
 * - every cross-Zone link (customer, contact, opportunity, project, user) refuses a record of another
 *   business with a 4xx, never a 500 and never a row;
 * - one person who belongs to two businesses gets each business's own role and data (business switching);
 * - restricted roles are refused by the API directly, not only hidden in the client.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as businessRoute from '@/app/api/v1/b/[slug]/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as customerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/route';
import * as customerProjectsRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/projects/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as activitiesRoute from '@/app/api/v1/b/[slug]/activities/route';
import * as conversationsRoute from '@/app/api/v1/b/[slug]/conversations/route';
import * as messagesRoute from '@/app/api/v1/b/[slug]/conversations/[conversationId]/messages/route';
import * as opportunitiesRoute from '@/app/api/v1/b/[slug]/sales/opportunities/route';
import * as opportunityRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/route';
import * as winRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/win/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as projectRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/route';
import * as tasksRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import * as quoteIssue from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/issue/route';
import * as quoteAccept from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/accept/route';
import * as quoteConvert from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/convert/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as invoiceCreditNotes from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/credit-notes/route';
import * as settlementRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/settlement/route';
import * as creditIssue from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/issue/route';
import * as creditApplications from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/applications/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as balancesRoute from '@/app/api/v1/b/[slug]/finance/customer-balances/route';
import * as reconciliationRoute from '@/app/api/v1/b/[slug]/finance/reconciliation/route';
import * as categoriesRoute from '@/app/api/v1/b/[slug]/finance/expense-categories/route';
import * as expensesRoute from '@/app/api/v1/b/[slug]/finance/expenses/route';
import * as expenseRoute from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/route';
import * as expenseRecord from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/record/route';
import * as expensePaymentsRoute from '@/app/api/v1/b/[slug]/finance/expense-payments/route';
import * as payablesRoute from '@/app/api/v1/b/[slug]/finance/expense-payables/route';
import * as defaultCalendarRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/default/route';
import * as calendarsRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/route';
import * as eventsRoute from '@/app/api/v1/b/[slug]/scheduling/events/route';
import * as eventRoute from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/route';
import * as eventCancel from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/cancel/route';
import * as employeesRoute from '@/app/api/v1/b/[slug]/people/employees/route';
import * as employeeRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/route';
import * as personalRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/personal/route';
import { devOutbox } from '@/core/email';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });

beforeAll(async () => {
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
});

// An address range of its own, so rate-limit counters never collide with the other suites. The start is
// random so that back-to-back runs on one database do not hit the previous run's sign-in limits.
let ip = 1 + Math.floor(Math.random() * 200) * 250;
type User = { email: string; cookie: string; id: string };
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.124.${Math.floor(ip / 250) % 256}.${ip++ % 250}`, origin: ORIGIN });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  // Payments require one; every other route ignores it.
  if (method === 'POST') headers.set('idempotency-key', randomUUID());
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.125.${Math.floor(ip / 250) % 256}.${ip++ % 250}` } }));
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

async function invite(owner: User, slug: string, user: User, role: string) {
  await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
  const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
  const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
  expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
}

async function team(label: string) {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invite(owner, slug, user, role);
    people[role] = user;
  }
  return { slug, people };
}

type Result = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Calls one route handler as `who` in business `slug`. `path` is the part after /b/:slug. */
async function call(who: User, slug: string, handler: Handler, method: string, path: string, params: Record<string, string> = {}, body?: unknown): Promise<Result> {
  const res = await handler(req(method, `/api/v1/b/${slug}${path}`, { cookie: who.cookie, body }), ctx({ slug, ...params }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const line = (overrides: Record<string, unknown> = {}) => ({ description: 'Consulting', quantity: '2', unitPrice: '150.00', ...overrides });
/** A date in the past in every time zone, so "not in the future" rules always pass. */
const PAST = '2026-11-01';

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
/** A's records that B must never see or link to. */
const a = {} as Record<'customer' | 'contact' | 'conversation' | 'opportunity' | 'project' | 'invoice' | 'calendar' | 'event' | 'employee', string>;
/** B's records that A must never link to. */
const b = {} as Record<'customer' | 'contact' | 'opportunity' | 'project', string>;

beforeAll(async () => {
  A = await team('xa');
  B = await team('xb');
  const bo = B.people.OWNER!;
  b.customer = (await call(bo, B.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'B customer' })).body.customer.id;
  b.contact = (await call(bo, B.slug, contactsRoute.POST, 'POST', '/contacts', {}, { firstName: 'Bea', lastName: 'B', customerId: b.customer })).body.contact.id;
  b.opportunity = (await call(bo, B.slug, opportunitiesRoute.POST, 'POST', '/sales/opportunities', {}, { title: 'B deal', customerId: b.customer })).body.opportunity.id;
  b.project = (await call(bo, B.slug, projectsRoute.POST, 'POST', '/projects', {}, { name: 'B project', customerId: b.customer })).body.project.id;
}, 120_000);

describe('one customer across every Zone (business A)', () => {
  it('creates the customer and contact, and their history shows on the customer timeline', async () => {
    const mgr = A.people.MANAGER!;
    const c = await call(mgr, A.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'Acme' });
    expect(c.status).toBe(201);
    a.customer = c.body.customer.id;
    const ct = await call(mgr, A.slug, contactsRoute.POST, 'POST', '/contacts', {}, { firstName: 'Ann', lastName: 'Acme', customerId: a.customer, email: 'ann@acme.example' });
    expect(ct.status).toBe(201);
    a.contact = ct.body.contact.id;
    expect((await call(mgr, A.slug, customerRoute.PATCH, 'PATCH', `/customers/${a.customer}`, { customerId: a.customer }, { primaryContactId: a.contact })).status).toBe(200);
    const note = await call(A.people.MEMBER!, A.slug, activitiesRoute.POST, 'POST', '/activities', {}, { type: 'note', customerId: a.customer, body: 'Met at the expo' });
    expect(note.status).toBe(201);

    const conv = await call(mgr, A.slug, conversationsRoute.POST, 'POST', '/conversations', {}, { channel: 'EMAIL', subject: 'Quote request', customerId: a.customer, contactId: a.contact });
    expect(conv.status).toBe(201);
    a.conversation = conv.body.conversation.id;
    const msg = await call(mgr, A.slug, messagesRoute.POST, 'POST', `/conversations/${a.conversation}/messages`, { conversationId: a.conversation }, {
      direction: 'INBOUND', occurredAt: '2026-10-01T09:00:00Z', subject: 'Quote request', body: 'Could you send a quote?',
      participants: [{ role: 'FROM', displayName: 'Ann', address: 'ann@acme.example' }],
    });
    expect(msg.status).toBe(201);

    const timeline = await call(A.people.MEMBER!, A.slug, activitiesRoute.GET, 'GET', `/activities?customerId=${a.customer}`);
    expect(timeline.status).toBe(200);
    const types = timeline.body.activities.map((x: { type: string }) => x.type);
    expect(types).toEqual(expect.arrayContaining(['customer.created', 'contact.created', 'customer.primary_contact_changed', 'note']));
    expect(types.some((t: string) => t.startsWith('message'))).toBe(true);
  });

  it('carries the customer into a Sales opportunity and wins it', async () => {
    const mem = A.people.MEMBER!;
    const opp = await call(mem, A.slug, opportunitiesRoute.POST, 'POST', '/sales/opportunities', {}, { title: 'Acme fit-out', customerId: a.customer, contactId: a.contact, amount: '429.99' });
    expect(opp.status).toBe(201);
    a.opportunity = opp.body.opportunity.id;
    const listed = await call(mem, A.slug, opportunitiesRoute.GET, 'GET', `/sales/opportunities?customerId=${a.customer}`);
    expect(listed.body.opportunities.map((o: { id: string }) => o.id)).toContain(a.opportunity);
    const won = await call(mem, A.slug, winRoute.POST, 'POST', `/sales/opportunities/${a.opportunity}/win`, { opportunityId: a.opportunity }, {});
    expect(won.status).toBe(200);
    expect(won.body.opportunity.status).toBe('WON');
  });

  it('runs a project with tasks for the customer, listed on the customer', async () => {
    const mgr = A.people.MANAGER!;
    const p = await call(mgr, A.slug, projectsRoute.POST, 'POST', '/projects', {}, { name: 'Acme fit-out', customerId: a.customer, ownerUserId: mgr.id });
    expect(p.status).toBe(201);
    a.project = p.body.project.id;
    const t = await call(A.people.MEMBER!, A.slug, tasksRoute.POST, 'POST', `/projects/${a.project}/tasks`, { projectId: a.project }, { title: 'Measure site', assigneeUserId: A.people.MEMBER!.id });
    expect(t.status).toBe(201);
    const onCustomer = await call(A.people.MEMBER!, A.slug, customerProjectsRoute.GET, 'GET', `/customers/${a.customer}/projects`, { customerId: a.customer });
    expect(onCustomer.status).toBe(200);
    expect(onCustomer.body.projects.map((x: { id: string }) => x.id)).toContain(a.project);
  });

  it('quotes, invoices, takes a payment and a credit note for the customer, and the balances agree', async () => {
    const own = A.people.OWNER!;
    const mgr = A.people.MANAGER!;
    const gst = (await call(own, A.slug, taxRatesRoute.POST, 'POST', '/finance/tax-rates', {}, { name: 'GST', ratePercent: '10' })).body.taxRate.id;
    const q = await call(mgr, A.slug, quotesRoute.POST, 'POST', '/finance/quotes', {}, {
      customerId: a.customer, contactId: a.contact, opportunityId: a.opportunity, projectId: a.project, lines: [line({ taxRateId: gst })],
    });
    expect(q.status).toBe(201);
    expect(q.body.document).toMatchObject({ customerId: a.customer, contactId: a.contact, opportunityId: a.opportunity, projectId: a.project, total: '330.00' });
    const qid = q.body.document.id;
    expect((await call(own, A.slug, quoteIssue.POST, 'POST', `/finance/quotes/${qid}/issue`, { documentId: qid }, { version: 1, issueDate: PAST })).status).toBe(200);
    expect((await call(own, A.slug, quoteAccept.POST, 'POST', `/finance/quotes/${qid}/accept`, { documentId: qid }, { version: 2 })).status).toBe(200);
    const conv = await call(mgr, A.slug, quoteConvert.POST, 'POST', `/finance/quotes/${qid}/convert`, { documentId: qid }, {});
    expect(conv.status).toBe(201);
    const inv = conv.body.document;
    expect(inv).toMatchObject({ kind: 'INVOICE', customerId: a.customer, opportunityId: a.opportunity, projectId: a.project });
    const issued = await call(own, A.slug, invoiceIssue.POST, 'POST', `/finance/invoices/${inv.id}/issue`, { documentId: inv.id }, { version: inv.version, issueDate: PAST, dueDate: '2026-12-31' });
    expect(issued.status).toBe(200);
    a.invoice = inv.id;

    const pay = await call(own, A.slug, paymentsRoute.POST, 'POST', '/finance/payments', {}, {
      customerId: a.customer, amount: '300.00', receivedOn: PAST, method: 'BANK_TRANSFER', allocations: [{ invoiceId: inv.id, amount: '300.00' }],
    });
    expect(pay.status).toBe(201);

    const cn = await call(own, A.slug, invoiceCreditNotes.POST, 'POST', `/finance/invoices/${inv.id}/credit-notes`, { documentId: inv.id }, { lines: [line({ quantity: '1', unitPrice: '30.00' })] });
    expect(cn.status).toBe(201);
    const cnId = cn.body.document.id;
    expect((await call(own, A.slug, creditIssue.POST, 'POST', `/finance/credit-notes/${cnId}/issue`, { documentId: cnId }, { version: 1, issueDate: PAST })).status).toBe(200);
    const applied = await call(own, A.slug, creditApplications.POST, 'POST', `/finance/credit-notes/${cnId}/applications`, { documentId: cnId }, { applications: [{ invoiceId: inv.id, amount: '30.00' }] });
    expect(applied.status).toBe(200);

    const settlement = await call(mgr, A.slug, settlementRoute.GET, 'GET', `/finance/invoices/${inv.id}/settlement`, { documentId: inv.id });
    expect(settlement.status).toBe(200);
    expect(settlement.body.settlement).toMatchObject({ outstanding: '0.00' });
    const balances = await call(mgr, A.slug, balancesRoute.GET, 'GET', `/finance/customer-balances?customerId=${a.customer}`);
    expect(balances.status).toBe(200);
    // Fully settled by the payment and the credit note, so the customer owes nothing and is not listed.
    expect(JSON.stringify(balances.body.balances)).not.toContain(a.customer);
    expect((await call(own, A.slug, reconciliationRoute.GET, 'GET', '/finance/reconciliation')).status).toBe(200);
  });

  it('records an expense against the project and customer, pays it, and it leaves the payables', async () => {
    const own = A.people.OWNER!;
    const cat = await call(own, A.slug, categoriesRoute.POST, 'POST', '/finance/expense-categories', {}, { name: 'Materials' });
    expect(cat.status).toBe(201);
    const e = await call(A.people.MANAGER!, A.slug, expensesRoute.POST, 'POST', '/finance/expenses', {}, {
      categoryId: cat.body.category.id, description: 'Timber', incurredOn: PAST, dueDate: '2026-12-31', taxTreatment: 'NO_TAX', amount: '80.00', projectId: a.project, customerId: a.customer,
    });
    expect(e.status).toBe(201);
    const exp = e.body.expense;
    expect(exp).toMatchObject({ projectId: a.project, customerId: a.customer, total: '80.00' });
    const rec = await call(own, A.slug, expenseRecord.POST, 'POST', `/finance/expenses/${exp.id}/record`, { expenseId: exp.id }, { version: exp.version });
    expect(rec.status).toBe(200);
    const pay = await call(own, A.slug, expensePaymentsRoute.POST, 'POST', '/finance/expense-payments', {}, {
      amount: '80.00', paidOn: PAST, method: 'CARD', allocations: [{ expenseId: exp.id, amount: '80.00' }],
    });
    expect(pay.status).toBe(201);
    const after = await call(own, A.slug, expenseRoute.GET, 'GET', `/finance/expenses/${exp.id}`, { expenseId: exp.id });
    expect(after.body.expense).toMatchObject({ paymentState: 'PAID', outstanding: '0.00' });
    expect((await call(own, A.slug, payablesRoute.GET, 'GET', '/finance/expense-payables')).status).toBe(200);
  });

  it('books, conflicts, moves and cancels a customer appointment', async () => {
    const mem = A.people.MEMBER!;
    const cal = await call(mem, A.slug, defaultCalendarRoute.POST, 'POST', '/scheduling/calendars/default', {}, {});
    expect([200, 201]).toContain(cal.status);
    a.calendar = cal.body.calendar.id;
    const at = (h: number) => ({ at: `2026-12-01T${String(h).padStart(2, '0')}:00:00+08:00` });
    const ev = await call(mem, A.slug, eventsRoute.POST, 'POST', '/scheduling/events', {}, { calendarId: a.calendar, title: 'Site visit', start: at(9), end: at(10), customerId: a.customer });
    expect(ev.status).toBe(201);
    expect(ev.body.event.customer).toMatchObject({ id: a.customer });
    const clash = await call(mem, A.slug, eventsRoute.POST, 'POST', '/scheduling/events', {}, { calendarId: a.calendar, title: 'Clash', start: at(9), end: at(11) });
    expect(clash).toMatchObject({ status: 409, body: { error: 'scheduling_conflict' } });
    const id = ev.body.event.id;
    const moved = await call(mem, A.slug, eventRoute.PATCH, 'PATCH', `/scheduling/events/${id}`, { eventId: id }, { start: at(13), end: at(14), version: ev.body.event.version });
    expect(moved.status).toBe(200);
    const cancelled = await call(mem, A.slug, eventCancel.POST, 'POST', `/scheduling/events/${id}/cancel`, { eventId: id }, { version: moved.body.event.version });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.event.status).toBe('CANCELLED');
    a.event = id;
  });

  it('keeps People work details for managers and personal details for administrators', async () => {
    const adm = A.people.ADMIN!;
    const emp = await call(adm, A.slug, employeesRoute.POST, 'POST', '/people/employees', {}, { givenName: 'Sam', familyName: 'Lee', userId: A.people.MEMBER!.id });
    expect(emp.status).toBe(201);
    a.employee = emp.body.employee.id;
    const id = a.employee;
    expect((await call(adm, A.slug, personalRoute.PATCH, 'PATCH', `/people/employees/${id}/personal`, { employeeId: id }, { homeAddress: '1 Private Lane', version: 0 })).status).toBe(200);
    const asMgr = await call(A.people.MANAGER!, A.slug, employeeRoute.GET, 'GET', `/people/employees/${id}`, { employeeId: id });
    expect(asMgr.status).toBe(200);
    expect(JSON.stringify(asMgr.body)).not.toContain('Private Lane');
    expect((await call(A.people.MANAGER!, A.slug, personalRoute.GET, 'GET', `/people/employees/${id}/personal`, { employeeId: id })).status).toBe(403);
    expect((await call(A.people.MEMBER!, A.slug, employeesRoute.GET, 'GET', '/people/employees')).status).toBe(403);
    expect((await call(adm, A.slug, personalRoute.GET, 'GET', `/people/employees/${id}/personal`, { employeeId: id })).body.personalDetails.homeAddress).toBe('1 Private Lane');
  });
});

describe('cross-tenant links are refused with a 4xx and no row', () => {
  const refused = (r: Result) => {
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
  };

  it.each([
    ['contact → B customer', () => call(A.people.OWNER!, A.slug, contactsRoute.POST, 'POST', '/contacts', {}, { firstName: 'X', lastName: 'Y', customerId: b.customer })],
    ['note → B customer', () => call(A.people.OWNER!, A.slug, activitiesRoute.POST, 'POST', '/activities', {}, { type: 'note', customerId: b.customer, body: 'x' })],
    ['conversation → B customer', () => call(A.people.OWNER!, A.slug, conversationsRoute.POST, 'POST', '/conversations', {}, { channel: 'EMAIL', customerId: b.customer })],
    ['conversation → B contact', () => call(A.people.OWNER!, A.slug, conversationsRoute.POST, 'POST', '/conversations', {}, { channel: 'EMAIL', contactId: b.contact })],
    ['opportunity → B customer', () => call(A.people.OWNER!, A.slug, opportunitiesRoute.POST, 'POST', '/sales/opportunities', {}, { title: 'X', customerId: b.customer })],
    ['opportunity → B contact', () => call(A.people.OWNER!, A.slug, opportunitiesRoute.POST, 'POST', '/sales/opportunities', {}, { title: 'X', contactId: b.contact })],
    ['opportunity → owner outside A', () => call(A.people.OWNER!, A.slug, opportunitiesRoute.POST, 'POST', '/sales/opportunities', {}, { title: 'X', ownerUserId: B.people.OWNER!.id })],
    ['project → B customer', () => call(A.people.OWNER!, A.slug, projectsRoute.POST, 'POST', '/projects', {}, { name: 'X', customerId: b.customer })],
    ['task → assignee outside A', () => call(A.people.OWNER!, A.slug, tasksRoute.POST, 'POST', `/projects/${a.project}/tasks`, { projectId: a.project }, { title: 'X', assigneeUserId: B.people.OWNER!.id })],
    ['task → B project', () => call(A.people.OWNER!, A.slug, tasksRoute.POST, 'POST', `/projects/${b.project}/tasks`, { projectId: b.project }, { title: 'X' })],
    ['quote → B customer', () => call(A.people.OWNER!, A.slug, quotesRoute.POST, 'POST', '/finance/quotes', {}, { customerId: b.customer })],
    ['quote → B opportunity', () => call(A.people.OWNER!, A.slug, quotesRoute.POST, 'POST', '/finance/quotes', {}, { customerId: a.customer, opportunityId: b.opportunity })],
    ['quote → B project', () => call(A.people.OWNER!, A.slug, quotesRoute.POST, 'POST', '/finance/quotes', {}, { customerId: a.customer, projectId: b.project })],
    ['invoice → B contact', () => call(A.people.OWNER!, A.slug, invoicesRoute.POST, 'POST', '/finance/invoices', {}, { customerId: a.customer, contactId: b.contact })],
    ['payment → B customer', () => call(A.people.OWNER!, A.slug, paymentsRoute.POST, 'POST', '/finance/payments', {}, { customerId: b.customer, amount: '1.00', receivedOn: PAST, method: 'CASH' })],
    ['event → B customer', () => call(A.people.OWNER!, A.slug, eventsRoute.POST, 'POST', '/scheduling/events', {}, {
      calendarId: a.calendar, title: 'X', start: { at: '2026-12-02T09:00:00Z' }, end: { at: '2026-12-02T10:00:00Z' }, customerId: b.customer,
    })],
    ['employee → user outside A', () => call(A.people.OWNER!, A.slug, employeesRoute.POST, 'POST', '/people/employees', {}, { givenName: 'X', familyName: 'Y', userId: B.people.OWNER!.id })],
  ])('%s', async (_label, attempt) => {
    refused(await attempt());
  });

  it('expense → B project and B customer', async () => {
    const own = A.people.OWNER!;
    const cat = (await call(own, A.slug, categoriesRoute.GET, 'GET', '/finance/expense-categories')).body.categories[0].id;
    const base = { categoryId: cat, description: 'X', incurredOn: PAST, taxTreatment: 'NO_TAX', amount: '1.00' };
    refused(await call(own, A.slug, expensesRoute.POST, 'POST', '/finance/expenses', {}, { ...base, projectId: b.project }));
    refused(await call(own, A.slug, expensesRoute.POST, 'POST', '/finance/expenses', {}, { ...base, customerId: b.customer }));
  });

  it('wrote no A row that points at a B record', async () => {
    const ids = Object.values(b);
    const { rows } = await admin.query(
      `SELECT 'contacts' t FROM contacts WHERE business_id <> (SELECT business_id FROM customers WHERE id = contacts.customer_id) AND customer_id = ANY($1::uuid[])
       UNION ALL SELECT 'opportunities' FROM opportunities o JOIN businesses x ON x.id = o.business_id WHERE x.slug = $2 AND (o.customer_id = ANY($1::uuid[]) OR o.contact_id = ANY($1::uuid[]))
       UNION ALL SELECT 'projects' FROM projects p JOIN businesses x ON x.id = p.business_id WHERE x.slug = $2 AND p.customer_id = ANY($1::uuid[])
       UNION ALL SELECT 'finance_documents' FROM finance_documents d JOIN businesses x ON x.id = d.business_id WHERE x.slug = $2
         AND (d.customer_id = ANY($1::uuid[]) OR d.opportunity_id = ANY($1::uuid[]) OR d.project_id = ANY($1::uuid[]) OR d.contact_id = ANY($1::uuid[]))`,
      [ids, A.slug],
    );
    expect(rows).toEqual([]);
  });
});

describe('business B cannot read or change business A', () => {
  it.each([
    ['customer', () => call(B.people.OWNER!, B.slug, customerRoute.GET, 'GET', `/customers/${a.customer}`, { customerId: a.customer })],
    ['opportunity', () => call(B.people.OWNER!, B.slug, opportunityRoute.GET, 'GET', `/sales/opportunities/${a.opportunity}`, { opportunityId: a.opportunity })],
    ['project', () => call(B.people.OWNER!, B.slug, projectRoute.GET, 'GET', `/projects/${a.project}`, { projectId: a.project })],
    ['invoice', () => call(B.people.OWNER!, B.slug, invoiceRoute.GET, 'GET', `/finance/invoices/${a.invoice}`, { documentId: a.invoice })],
    ['event', () => call(B.people.OWNER!, B.slug, eventRoute.GET, 'GET', `/scheduling/events/${a.event}`, { eventId: a.event })],
    ['employee', () => call(B.people.OWNER!, B.slug, employeeRoute.GET, 'GET', `/people/employees/${a.employee}`, { employeeId: a.employee })],
    ['employee personal details', () => call(B.people.OWNER!, B.slug, personalRoute.GET, 'GET', `/people/employees/${a.employee}/personal`, { employeeId: a.employee })],
    ['customer update', () => call(B.people.OWNER!, B.slug, customerRoute.PATCH, 'PATCH', `/customers/${a.customer}`, { customerId: a.customer }, { displayName: 'Hijacked' })],
  ])('%s by id through B is 404', async (_label, attempt) => {
    expect((await attempt()).status).toBe(404);
  });

  it("B's lists never include A's records", async () => {
    const bo = B.people.OWNER!;
    const lists = await Promise.all([
      call(bo, B.slug, customersRoute.GET, 'GET', '/customers'),
      call(bo, B.slug, opportunitiesRoute.GET, 'GET', '/sales/opportunities'),
      call(bo, B.slug, projectsRoute.GET, 'GET', '/projects'),
      call(bo, B.slug, invoicesRoute.GET, 'GET', '/finance/invoices'),
      call(bo, B.slug, calendarsRoute.GET, 'GET', '/scheduling/calendars'),
      call(bo, B.slug, employeesRoute.GET, 'GET', '/people/employees'),
      call(bo, B.slug, activitiesRoute.GET, 'GET', '/activities'),
    ]);
    for (const l of lists) expect(l.status).toBe(200);
    const all = JSON.stringify(lists.map((l) => l.body));
    for (const id of Object.values(a)) expect(all).not.toContain(id);
  });

  it("an outsider using A's slug gets 404 everywhere, never A's data", async () => {
    const bo = B.people.OWNER!;
    for (const [handler, path] of [
      [customersRoute.GET, '/customers'], [opportunitiesRoute.GET, '/sales/opportunities'], [invoicesRoute.GET, '/finance/invoices'],
      [employeesRoute.GET, '/people/employees'], [calendarsRoute.GET, '/scheduling/calendars'], [activitiesRoute.GET, '/activities'],
    ] as const) {
      expect((await call(bo, A.slug, handler as Handler, 'GET', path)).status).toBe(404);
    }
  });
});

describe('one person in two businesses (business switching)', () => {
  it('gets each business its own role, permissions and data with the same session', async () => {
    const both = await newUser('xboth');
    await invite(A.people.OWNER!, A.slug, both, 'MEMBER');
    await invite(B.people.OWNER!, B.slug, both, 'ADMIN');
    const inA = await call(both, A.slug, businessRoute.GET, 'GET', '');
    const inB = await call(both, B.slug, businessRoute.GET, 'GET', '');
    expect(inA.status).toBe(200);
    expect(inB.status).toBe(200);
    expect(JSON.stringify(inA.body)).toContain('"MEMBER"');
    expect(JSON.stringify(inB.body)).toContain('"ADMIN"');
    // Finance: refused as a MEMBER of A, allowed as an ADMIN of B, on the same cookie.
    expect((await call(both, A.slug, invoicesRoute.GET, 'GET', '/finance/invoices')).status).toBe(403);
    expect((await call(both, B.slug, invoicesRoute.GET, 'GET', '/finance/invoices')).status).toBe(200);
    // Data follows the business in the URL.
    const custA = JSON.stringify((await call(both, A.slug, customersRoute.GET, 'GET', '/customers')).body);
    const custB = JSON.stringify((await call(both, B.slug, customersRoute.GET, 'GET', '/customers')).body);
    expect(custA).toContain(a.customer);
    expect(custA).not.toContain(b.customer);
    expect(custB).toContain(b.customer);
    expect(custB).not.toContain(a.customer);
  });
});

describe('restricted roles are refused by the API itself', () => {
  it.each([
    ['MEMBER reads Finance', 'MEMBER', () => [invoicesRoute.GET, 'GET', '/finance/invoices'] as const],
    ['MEMBER drafts a quote', 'MEMBER', () => [quotesRoute.POST, 'POST', '/finance/quotes', {}, { customerId: a.customer }] as const],
    ['MANAGER issues an invoice', 'MANAGER', () => [invoiceIssue.POST, 'POST', `/finance/invoices/${a.invoice}/issue`, { documentId: a.invoice }, { version: 1 }] as const],
    ['MANAGER records a payment', 'MANAGER', () => [paymentsRoute.POST, 'POST', '/finance/payments', {}, { customerId: a.customer, amount: '1.00', receivedOn: PAST, method: 'CASH' }] as const],
    ['MEMBER creates a calendar', 'MEMBER', () => [calendarsRoute.POST, 'POST', '/scheduling/calendars', {}, { name: 'Mine', timeZone: 'Australia/Perth' }] as const],
    ['MEMBER reads People', 'MEMBER', () => [employeesRoute.GET, 'GET', '/people/employees'] as const],
    ['MANAGER creates an employee', 'MANAGER', () => [employeesRoute.POST, 'POST', '/people/employees', {}, { givenName: 'X', familyName: 'Y' }] as const],
  ])('%s → 403', async (_label, role, make) => {
    const [handler, method, path, params, body] = make() as unknown as [Handler, string, string, Record<string, string>?, unknown?];
    expect((await call(A.people[role]!, A.slug, handler, method, path, params ?? {}, body)).status).toBe(403);
  });

  it('an anonymous request is 401 on every Zone', async () => {
    const anon: User = { email: '', cookie: '', id: '' };
    for (const [handler, path] of [
      [customersRoute.GET, '/customers'], [opportunitiesRoute.GET, '/sales/opportunities'], [projectsRoute.GET, '/projects'],
      [invoicesRoute.GET, '/finance/invoices'], [employeesRoute.GET, '/people/employees'], [calendarsRoute.GET, '/scheduling/calendars'],
      [conversationsRoute.GET, '/conversations'],
    ] as const) {
      expect((await call(anon, A.slug, handler as Handler, 'GET', path)).status).toBe(401);
    }
  });
});
