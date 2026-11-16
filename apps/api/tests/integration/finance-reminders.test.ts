import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Finance F6-3 (docs/finance-billing-f6.md §10): payment reminder policies, holds, planning, the
 * pre-dispatch balance check, the C2-C outbox boundary, idempotency, leases, concurrency, permissions,
 * database guards and tenant isolation, through the real route handlers and worker steps against
 * PostgreSQL with the migrations and privileged SQL applied as in production. Nothing is ever sent:
 * the outbox used here is an in-memory fake that records what it was handed.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addCalendarDays, dueReminderStage, ListRemindersResponse, InvoiceReminderScheduleResponse, ReminderPolicyResponse, todayInZone } from '@business-os/contracts';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as invoiceVoid from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/void/route';
import * as invoiceCredit from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/credit-notes/route';
import * as invoiceReminders from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/reminders/route';
import * as creditIssue from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/issue/route';
import * as applicationsRoute from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/applications/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as allocationsRoute from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/allocations/route';
import * as paymentReverse from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/reverse/route';
import * as policiesRoute from '@/app/api/v1/b/[slug]/finance/reminder-policies/route';
import * as policyRoute from '@/app/api/v1/b/[slug]/finance/reminder-policies/[policyId]/route';
import * as policyArchive from '@/app/api/v1/b/[slug]/finance/reminder-policies/[policyId]/archive/route';
import * as customerSettings from '@/app/api/v1/b/[slug]/finance/customers/[customerId]/reminder-settings/route';
import * as holdsRoute from '@/app/api/v1/b/[slug]/finance/reminder-holds/route';
import * as holdRelease from '@/app/api/v1/b/[slug]/finance/reminder-holds/[holdId]/release/route';
import * as remindersRoute from '@/app/api/v1/b/[slug]/finance/reminders/route';
import * as reminderDismiss from '@/app/api/v1/b/[slug]/finance/reminders/[reminderId]/dismiss/route';
import * as jobRoute from '@/app/api/internal/jobs/finance-reminders/route';
import { runReminderPass } from '@/app/api/_lib/reminder-worker';
import { withTenant } from '@/core/db';
import {
  claimReminder, confirmReminderBeforeSend, configuredReminderOutbox, executeReminder, failReminder, planDueReminders, recordReminderOutboundState,
  type ReminderDispatchRequest, type ReminderOutbox,
} from '@/modules/finance';
import { devOutbox } from '@/core/email';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await admin.connect();
  await app.connect();
});
afterAll(async () => {
  await admin.end();
  await app.end();
});

let ip = 1;
const IP_BLOCK = Number(process.env.REMINDERS_TEST_IP_BLOCK ?? 130);
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${IP_BLOCK}.${Math.floor(ip / 250)}.${ip++ % 250}`, ...(opts.headers ?? {}) });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(req('GET', `${link.pathname}${link.search}`, { origin: null }));
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

async function invite(slug: string, owner: User, user: User, role: string) {
  await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
  const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
  const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
  expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
}

const ZONE = 'Australia/Perth';
async function team(label: string, roles: string[] = ['ADMIN', 'MANAGER', 'MEMBER']) {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: ZONE, locale: 'en-AU', currency: 'AUD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of roles) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invite(slug, owner, user, role);
    people[role] = user;
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string };
}
type Team = Awaited<ReturnType<typeof team>>;

const api = (who: User, slug: string) => {
  const F = `/api/v1/b/${slug}/finance`;
  type R = { POST?: unknown; GET?: unknown; PATCH?: unknown; PUT?: unknown };
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', route: R, path: string, params: Record<string, string>, body?: unknown, headers?: Record<string, string>) =>
    (route[method] as (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>)(
      req(method, path, { cookie: who.cookie, body: method === 'GET' ? undefined : (body ?? {}), headers }), ctx({ slug, ...params }),
    ).then(json);
  return {
    createCustomer: (body: unknown) => call('POST', customersRoute, `/api/v1/b/${slug}/customers`, {}, body),
    createInvoice: (body: unknown) => call('POST', invoicesRoute, `${F}/invoices`, {}, body),
    issue: (id: string, body: unknown) => call('POST', invoiceIssue, `${F}/invoices/${id}/issue`, { documentId: id }, body),
    void: (id: string, body: unknown) => call('POST', invoiceVoid, `${F}/invoices/${id}/void`, { documentId: id }, body),
    credit: (id: string, body: unknown) => call('POST', invoiceCredit, `${F}/invoices/${id}/credit-notes`, { documentId: id }, body),
    issueCredit: (id: string, body: unknown) => call('POST', creditIssue, `${F}/credit-notes/${id}/issue`, { documentId: id }, body),
    applyCredit: (id: string, applications: unknown) => call('POST', applicationsRoute, `${F}/credit-notes/${id}/applications`, { documentId: id }, { applications }),
    record: (body: unknown) => call('POST', paymentsRoute, `${F}/payments`, {}, body, { 'idempotency-key': `pay-${randomUUID()}` }),
    allocate: (paymentId: string, allocations: unknown) => call('POST', allocationsRoute, `${F}/payments/${paymentId}/allocations`, { paymentId }, { allocations }),
    reversePayment: (paymentId: string, body: unknown) => call('POST', paymentReverse, `${F}/payments/${paymentId}/reverse`, { paymentId }, body),
    policies: (qs = '') => call('GET', policiesRoute, `${F}/reminder-policies${qs}`, {}),
    createPolicy: (body: unknown) => call('POST', policiesRoute, `${F}/reminder-policies`, {}, body),
    policy: (policyId: string) => call('GET', policyRoute, `${F}/reminder-policies/${policyId}`, { policyId }),
    patchPolicy: (policyId: string, body: unknown) => call('PATCH', policyRoute, `${F}/reminder-policies/${policyId}`, { policyId }, body),
    archivePolicy: (policyId: string, version: number) => call('POST', policyArchive, `${F}/reminder-policies/${policyId}/archive`, { policyId }, { version }),
    settings: (customerId: string) => call('GET', customerSettings, `${F}/customers/${customerId}/reminder-settings`, { customerId }),
    putSettings: (customerId: string, body: unknown) => call('PUT', customerSettings, `${F}/customers/${customerId}/reminder-settings`, { customerId }, body),
    holds: (qs = '') => call('GET', holdsRoute, `${F}/reminder-holds${qs}`, {}),
    hold: (body: unknown) => call('POST', holdsRoute, `${F}/reminder-holds`, {}, body),
    release: (holdId: string) => call('POST', holdRelease, `${F}/reminder-holds/${holdId}/release`, { holdId }),
    reminders: (qs = '') => call('GET', remindersRoute, `${F}/reminders${qs}`, {}),
    dismiss: (reminderId: string) => call('POST', reminderDismiss, `${F}/reminders/${reminderId}/dismiss`, { reminderId }),
    schedule: (documentId: string) => call('GET', invoiceReminders, `${F}/invoices/${documentId}/reminders`, { documentId }),
  };
};

const TODAY = todayInZone(ZONE);
const day = (n: number) => addCalendarDays(TODAY, n);
const STAGES = [{ offsetDays: -3, label: 'Due soon' }, { offsetDays: 7, label: 'Overdue' }, { offsetDays: 21, label: 'Final notice' }];

/** Creates and issues an invoice for `amount` due on `dueDate` (issued 30 days before it, or today if that is earlier). */
async function openInvoice(t: Team, customerId: string, amount: string, dueDate: string) {
  const own = api(t.people.OWNER!, t.slug);
  const draft = await own.createInvoice({ customerId, lines: [{ description: 'Work', quantity: '1', unitPrice: amount }] });
  expect(draft.status).toBe(201);
  const issueDate = addCalendarDays(dueDate, -30) < TODAY ? addCalendarDays(dueDate, -30) : TODAY;
  const issued = await own.issue(draft.body.document.id, { version: 1, issueDate, dueDate });
  expect(issued.status).toBe(200);
  return { id: issued.body.document.id as string, version: issued.body.document.version as number, number: issued.body.document.number as string };
}
async function pay(t: Team, customerId: string, invoiceId: string, amount: string) {
  const own = api(t.people.OWNER!, t.slug);
  const p = await own.record({ customerId, amount, receivedOn: TODAY, method: 'BANK_TRANSFER' });
  expect(p.status).toBe(201);
  expect((await own.allocate(p.body.payment.id, [{ invoiceId, amount }])).status).toBe(200);
  return p.body.payment.id as string;
}
async function customer(t: Team, name: string, email: string | null = `${name.toLowerCase()}@example.com`) {
  const res = await api(t.people.OWNER!, t.slug).createCustomer({ displayName: name, ...(email ? { email } : {}) });
  expect(res.status).toBe(201);
  return res.body.customer.id as string;
}

const sys = (businessId: string) => ({ businessId, userId: null });
const plan = (t: Team) => withTenant(sys(t.businessId), (db) => planDueReminders(db));
/** Claims and checks every due reminder of the business, as the worker does (one transaction each). */
async function work(t: Team, outbox: ReminderOutbox | null = null) {
  const outcomes: string[] = [];
  for (let n = 0; n < 500; n++) {
    const c = await withTenant(sys(t.businessId), (db) => claimReminder(db, { leaseSeconds: 60 }));
    if (!c) break;
    try {
      outcomes.push(await withTenant(sys(t.businessId), (db) => executeReminder(db, c, outbox)));
    } catch {
      outcomes.push(`error:${await withTenant(sys(t.businessId), (db) => failReminder(db, c))}`);
    }
  }
  return outcomes;
}
const rowsOf = async (invoiceId: string) =>
  (await admin.query(
    `SELECT id, offset_days, stage_label, status, outcome_code, checked_outstanding::text, outbound_id, outbound_state, attempts, scheduled_on::text, policy_id
       FROM finance_reminders WHERE invoice_id = $1 ORDER BY offset_days`, [invoiceId])).rows;
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;
/** Makes every waiting reminder of a business due for its next check now. */
const dueNow = (t: Team) => admin.query(`UPDATE finance_reminders SET run_after = now() - interval '1 second' WHERE business_id = $1 AND status IN ('PENDING', 'READY')`, [t.businessId]);

/** An in-memory stand-in for C2-C's outbox: idempotent on the key, records every request, sends nothing. */
function fakeOutbox(mode: 'queue' | 'refuse' | 'throw' = 'queue') {
  const calls: ReminderDispatchRequest[] = [];
  const ids = new Map<string, string>();
  const outbox: ReminderOutbox = {
    enqueue: async (_db, request) => {
      calls.push(request);
      if (mode === 'throw') throw new Error('outbox store unavailable');
      if (mode === 'refuse') return { status: 'refused', code: 'no_sending_mailbox' };
      const id = ids.get(request.idempotencyKey) ?? randomUUID();
      ids.set(request.idempotencyKey, id);
      return { status: 'queued', outboundId: id };
    },
  };
  return { outbox, calls };
}

let A: Team;
let B: Team;
let policyA: { id: string; version: number };

beforeAll(async () => {
  A = await team('ra');
  B = await team('rb', []);
  const created = await api(A.people.OWNER!, A.slug).createPolicy({ name: 'Standard', stages: STAGES, isDefault: true });
  expect(created.status).toBe(201);
  policyA = { id: created.body.policy.id, version: created.body.policy.version };
}, 180_000);

describe('policies: permissions, validation, default', () => {
  it('OWNER and ADMIN manage policies; MANAGER reads them; MEMBER has no finance access', async () => {
    const admin_ = api(A.people.ADMIN!, A.slug);
    const created = await admin_.createPolicy({ name: 'Gentle', stages: [{ offsetDays: 14, label: 'Friendly nudge' }] });
    expect(created.status).toBe(201);
    expect(ReminderPolicyResponse.parse(created.body).policy).toMatchObject({ status: 'ACTIVE', isDefault: false, assignedCustomers: 0, version: 1 });
    const manager = api(A.people.MANAGER!, A.slug);
    expect((await manager.policy(created.body.policy.id)).status).toBe(200);
    expect((await manager.policies()).body.policies.map((p: { id: string }) => p.id)).toContain(policyA.id);
    expect((await manager.createPolicy({ name: 'x', stages: STAGES })).status).toBe(403);
    expect((await manager.patchPolicy(policyA.id, { version: 1, name: 'x' })).status).toBe(403);
    expect((await manager.hold({ customerId: randomUUID(), reason: 'OTHER' })).status).toBe(403);
    const member = api(A.people.MEMBER!, A.slug);
    expect((await member.policies()).status).toBe(403);
    expect((await member.reminders()).status).toBe(403);
    expect((await audits(created.body.policy.id)).map((a) => [a.action, a.actor_user_id])).toEqual([['finance.reminder_policy.created', A.people.ADMIN!.id]]);
  });

  it('stages must be in order, within range, at most eight; the database refuses bad stages too', async () => {
    const own = api(A.people.OWNER!, A.slug);
    expect((await own.createPolicy({ name: 'x', stages: [{ offsetDays: 7, label: 'a' }, { offsetDays: 7, label: 'b' }] })).status).toBe(400);
    expect((await own.createPolicy({ name: 'x', stages: [{ offsetDays: 7, label: 'a' }, { offsetDays: 3, label: 'b' }] })).status).toBe(400);
    expect((await own.createPolicy({ name: 'x', stages: [{ offsetDays: 400, label: 'a' }] })).status).toBe(400);
    expect((await own.createPolicy({ name: 'x', stages: Array.from({ length: 9 }, (_, i) => ({ offsetDays: i, label: `s${i}` })) })).status).toBe(400);
    expect((await own.createPolicy({ name: 'x', stages: [] })).status).toBe(400);
    const bad = async (stages: unknown) => {
      try {
        await admin.query(`INSERT INTO finance_reminder_policies (id, business_id, name, stages) VALUES ($1, $2, 'x', $3)`, [randomUUID(), A.businessId, JSON.stringify(stages)]);
        return 'ok';
      } catch (e) { return (e as { code: string }).code; }
    };
    expect(await bad([{ offsetDays: 7, label: 'a' }, { offsetDays: 7, label: 'b' }])).toBe('23514');
    expect(await bad([{ offsetDays: 1.5, label: 'a' }])).toBe('23514');
    expect(await bad([{ offsetDays: 1, label: 'a', extra: true }])).toBe('23514');
  });

  it('one default per business: making another the default moves it, and the database enforces it', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const other = (await own.createPolicy({ name: 'Other default', stages: STAGES, isDefault: true })).body.policy;
    expect(other.isDefault).toBe(true);
    expect((await own.policy(policyA.id)).body.policy.isDefault).toBe(false);
    const back = await own.patchPolicy(policyA.id, { version: (await own.policy(policyA.id)).body.policy.version, isDefault: true });
    expect(back.status).toBe(200);
    policyA.version = back.body.policy.version;
    expect((await own.policy(other.id)).body.policy.isDefault).toBe(false);
    await expect(admin.query(`UPDATE finance_reminder_policies SET is_default = true WHERE id = $1`, [other.id])).rejects.toMatchObject({ code: '23505' });
    expect((await own.patchPolicy(policyA.id, { version: 1, name: 'stale' })).body).toMatchObject({ error: 'stale' });
  });
});

describe('planning: one due stage per invoice, no floods, idempotent', () => {
  it('plans only the stage due today; superseded, stale and expired stages are never planned; a repeat changes nothing', async () => {
    const acme = await customer(A, 'Acme');
    const soon = await openInvoice(A, acme, '100.00', day(3)); // -3 due today
    const week = await openInvoice(A, acme, '100.00', day(-7)); // +7 due today
    const late = await openInvoice(A, acme, '100.00', day(-25)); // +21 is 4 days past; +7 superseded
    const ancient = await openInvoice(A, acme, '100.00', day(-60)); // +21 is 39 days past: expired
    const justDue = await openInvoice(A, acme, '100.00', day(-1)); // -3 stale, +7 not yet
    const paid = await openInvoice(A, acme, '100.00', day(-7));
    await pay(A, acme, paid.id, '100.00');
    await plan(A);
    expect((await rowsOf(soon.id)).map((r) => [r.offset_days, r.status, r.scheduled_on])).toEqual([[-3, 'PENDING', TODAY]]);
    expect((await rowsOf(week.id)).map((r) => [r.offset_days, r.status])).toEqual([[7, 'PENDING']]);
    expect((await rowsOf(late.id)).map((r) => [r.offset_days, r.status])).toEqual([[21, 'PENDING']]);
    expect(await rowsOf(ancient.id)).toEqual([]);
    expect(await rowsOf(justDue.id)).toEqual([]);
    expect(await rowsOf(paid.id)).toEqual([]);
    const again = await plan(A);
    expect(again.planned).toBe(0);
    expect(await work(A)).toEqual(expect.arrayContaining(['ready']));
    for (const inv of [soon, week, late]) {
      const [r] = await rowsOf(inv.id);
      expect(r).toMatchObject({ status: 'READY', outcome_code: null, checked_outstanding: '100.0000', outbound_id: null, attempts: 0 });
      expect((await audits(r.id)).map((a) => [a.action, a.actor_user_id])).toEqual([['finance.system.reminder.ready', null]]);
    }
    // READY is re-checked later (still READY, no second audit); nothing was planned twice.
    await dueNow(A);
    await plan(A);
    await work(A);
    for (const inv of [soon, week, late]) {
      expect(await rowsOf(inv.id)).toHaveLength(1);
      expect((await audits((await rowsOf(inv.id))[0].id))).toHaveLength(1);
    }
    expect((await rowsOf(soon.id))[0].status).toBe('READY');
  });

  it('the schedule view shows each stage today, eligibility and history; the shared rules agree with the worker', async () => {
    const globex = await customer(A, 'Globex');
    const inv = await openInvoice(A, globex, '250.00', day(-8));
    const own = api(A.people.MANAGER!, A.slug);
    const before = await own.schedule(inv.id);
    expect(before.status).toBe(200);
    const s = InvoiceReminderScheduleResponse.parse(before.body).schedule;
    expect(s).toMatchObject({ eligible: true, reason: null, outstanding: '250.00', dueDate: day(-8), policyId: policyA.id, asOf: TODAY });
    expect(s.stages.map((x) => [x.offsetDays, x.state, x.scheduledOn])).toEqual([[-3, 'superseded', day(-11)], [7, 'due', day(-1)], [21, 'not_yet', day(13)]]);
    expect(dueReminderStage(STAGES, day(-8), TODAY)?.offsetDays).toBe(7);
    await plan(A);
    const after = InvoiceReminderScheduleResponse.parse((await own.schedule(inv.id)).body).schedule;
    expect(after.stages.find((x) => x.offsetDays === 7)!.reminderId).toBe((await rowsOf(inv.id))[0].id);
    expect(after.reminders.map((r) => r.status)).toEqual(['PENDING']);
    const list = ListRemindersResponse.parse((await own.reminders(`?invoiceId=${inv.id}`)).body);
    expect(list.reminders.map((r) => [r.invoiceNumber, r.stageLabel])).toEqual([[inv.number, 'Overdue']]);
  });
});

describe('pre-dispatch balance check (financial correctness)', () => {
  it('checks the exact outstanding amount on the locked invoice: partial payments and credit reduce it; settled, credited or void is skipped', async () => {
    const c = await customer(A, 'Initech');
    const partial = await openInvoice(A, c, '100.00', day(-7));
    const settledLater = await openInvoice(A, c, '80.00', day(-7));
    const credited = await openInvoice(A, c, '60.00', day(-7));
    const voided = await openInvoice(A, c, '40.00', day(-7));
    await plan(A);
    // After planning, before the check: money moves.
    await pay(A, c, partial.id, '33.33');
    await pay(A, c, settledLater.id, '80.00');
    const own = api(A.people.OWNER!, A.slug);
    const cn = await own.credit(credited.id, { lines: [{ description: 'Discount', quantity: '1', unitPrice: '60.00' }] });
    const cnIssued = await own.issueCredit(cn.body.document.id, { version: 1, issueDate: TODAY });
    expect((await own.applyCredit(cnIssued.body.document.id, [{ invoiceId: credited.id, amount: '60.00' }])).status).toBe(200);
    expect((await own.void(voided.id, { version: voided.version, reason: 'Raised in error' })).status).toBe(200);
    await work(A);
    expect((await rowsOf(partial.id))[0]).toMatchObject({ status: 'READY', checked_outstanding: '66.6700' });
    expect((await rowsOf(settledLater.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'settled', checked_outstanding: '0.0000' });
    expect((await rowsOf(credited.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'settled' });
    expect((await rowsOf(voided.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'not_issued' });
    const skippedAudit = await audits((await rowsOf(settledLater.id))[0].id);
    expect(skippedAudit.map((a) => a.action)).toEqual(['finance.system.reminder.skipped']);
    // Exactly these keys: no amounts (or anything else) in the audit log. Matched exactly, not by grepping the
    // JSON, which also contains a random invoice id.
    expect(skippedAudit[0].metadata).toEqual({ invoiceId: settledLater.id, offsetDays: '7', reason: 'settled' });
    // A READY reminder whose invoice is then paid is skipped at its next check.
    await pay(A, c, partial.id, '66.67');
    await dueNow(A);
    await work(A);
    expect((await rowsOf(partial.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'settled' });
  });

  it('a skipped stage is never sent later: reversing the payment does not bring it back', async () => {
    const c = await customer(A, 'Umbrella');
    const inv = await openInvoice(A, c, '120.00', day(-7));
    await plan(A);
    const paymentId = await pay(A, c, inv.id, '120.00');
    await work(A);
    expect((await rowsOf(inv.id))[0]).toMatchObject({ offset_days: 7, status: 'SKIPPED', outcome_code: 'settled' });
    const { rows } = await admin.query('SELECT version FROM finance_payments WHERE id = $1', [paymentId]);
    expect((await api(A.people.OWNER!, A.slug).reversePayment(paymentId, { version: rows[0].version, reason: 'Bounced' })).status).toBe(200);
    await plan(A);
    await work(A);
    expect((await rowsOf(inv.id)).map((r) => [r.offset_days, r.status])).toEqual([[7, 'SKIPPED']]);
    const s = (await api(A.people.OWNER!, A.slug).schedule(inv.id)).body.schedule;
    expect(s).toMatchObject({ eligible: true, outstanding: '120.00' });
  });

  it('no recipient address: skipped with a reason; archived customers are not reminded', async () => {
    const nobody = await customer(A, 'Nomail', null);
    const inv = await openInvoice(A, nobody, '10.00', day(-7));
    await plan(A);
    await work(A);
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'no_recipient' });
  });
});

describe('holds: suppression and exclusion', () => {
  it('a customer hold skips open reminders at once and stages that come due during it; a released hold does not bring them back', async () => {
    const c = await customer(A, 'Hooli');
    const a = await openInvoice(A, c, '50.00', day(-7));
    await plan(A);
    await work(A);
    expect((await rowsOf(a.id))[0].status).toBe('READY');
    const own = api(A.people.OWNER!, A.slug);
    const hold = await own.hold({ customerId: c, reason: 'DISPUTE', note: 'Querying the hours' });
    expect(hold.status).toBe(201);
    expect(hold.body.hold).toMatchObject({ scope: 'CUSTOMER', inEffect: true, untilDate: null, createdById: A.people.OWNER!.id });
    expect((await rowsOf(a.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'on_hold' });
    const b = await openInvoice(A, c, '50.00', day(-7));
    await plan(A);
    await work(A);
    expect((await rowsOf(b.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'on_hold' });
    expect((await own.settings(c)).body.settings.holdsInEffect).toHaveLength(1);
    expect((await own.release(hold.body.hold.id)).body.hold).toMatchObject({ inEffect: false, releasedById: A.people.OWNER!.id });
    expect((await own.release(hold.body.hold.id)).status).toBe(409);
    await plan(A);
    await work(A);
    expect((await rowsOf(b.id)).map((r) => r.status)).toEqual(['SKIPPED']);
    // The next stage of a new invoice is reminded as usual.
    const d = await openInvoice(A, c, '50.00', day(-7));
    await plan(A);
    await work(A);
    expect((await rowsOf(d.id))[0].status).toBe('READY');
    expect((await audits(hold.body.hold.id)).map((x) => x.action)).toEqual(['finance.reminder_hold.placed', 'finance.reminder_hold.released']);
  });

  it('an invoice hold affects only that invoice; a hold ending today is still in effect; the past and drafts are refused', async () => {
    const c = await customer(A, 'Vandelay');
    const held = await openInvoice(A, c, '70.00', day(-7));
    const free = await openInvoice(A, c, '70.00', day(-7));
    const own = api(A.people.OWNER!, A.slug);
    expect((await own.hold({ customerId: c, invoiceId: held.id, reason: 'PAYMENT_PLAN', untilDate: TODAY })).status).toBe(201);
    expect((await own.hold({ customerId: c, invoiceId: held.id, reason: 'OTHER', untilDate: day(-1) })).body).toMatchObject({ error: 'invalid_dates' });
    const draft = await own.createInvoice({ customerId: c, lines: [{ description: 'x', quantity: '1', unitPrice: '1' }] });
    expect((await own.hold({ customerId: c, invoiceId: draft.body.document.id, reason: 'OTHER' })).body).toMatchObject({ error: 'invoice_not_open' });
    const other = await customer(A, 'Kramerica');
    expect((await own.hold({ customerId: other, invoiceId: held.id, reason: 'OTHER' })).status).toBe(404);
    await plan(A);
    await work(A);
    expect((await rowsOf(held.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'on_hold' });
    expect((await rowsOf(free.id))[0].status).toBe('READY');
    expect((await own.holds(`?invoiceId=${held.id}`)).body.holds).toHaveLength(1);
  });

  it('a check waits for a hold being placed at the same moment, and then sees it (customer reminder lock)', async () => {
    const c = await customer(A, 'Pendant');
    const inv = await openInvoice(A, c, '90.00', day(-7));
    await plan(A);
    const claimed = (await withTenant(sys(A.businessId), (db) => claimReminder(db, { leaseSeconds: 60 })))!;
    expect(claimed).not.toBeNull();
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)`, [A.businessId, A.people.OWNER!.id]);
      await app.query(`SELECT pg_advisory_xact_lock(hashtextextended('finance.reminders.customer:' || $1 || ':' || $2, 0))`, [A.businessId, c]);
      let done = false;
      const check = withTenant(sys(A.businessId), (db) => executeReminder(db, claimed, null)).then((o) => { done = true; return o; });
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
      await app.query(`INSERT INTO finance_reminder_holds (id, business_id, scope, customer_id, reason, created_by_id) VALUES ($1, $2, 'CUSTOMER', $3, 'DISPUTE', $4)`,
        [randomUUID(), A.businessId, c, A.people.OWNER!.id]);
      await app.query('COMMIT');
      expect(await check).toBe('skipped');
    } catch (e) {
      await app.query('ROLLBACK');
      throw e;
    }
    expect((await rowsOf(inv.id)).filter((r) => r.status !== 'SKIPPED' || r.outcome_code === 'on_hold')).toHaveLength(1);
  });
});

describe('policy changes apply to stages not yet reached', () => {
  it('removing a stage, reassigning a customer, and archiving skip open reminders; archiving an assigned policy is refused', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const c = await customer(A, 'Wonka');
    const p = (await own.createPolicy({ name: 'Short', stages: [{ offsetDays: 7, label: 'Overdue' }, { offsetDays: 30, label: 'Final' }] })).body.policy;
    const put = await own.putSettings(c, { policyId: p.id });
    expect(put.body.settings).toMatchObject({ policyId: p.id, effectivePolicyId: p.id, version: 1 });
    expect((await own.policy(p.id)).body.policy.assignedCustomers).toBe(1);
    const inv = await openInvoice(A, c, '45.00', day(-7));
    await plan(A);
    expect((await rowsOf(inv.id))[0]).toMatchObject({ offset_days: 7, status: 'PENDING', policy_id: p.id });
    expect((await own.archivePolicy(p.id, p.version)).body).toMatchObject({ error: 'in_use' });
    const edited = await own.patchPolicy(p.id, { version: p.version, stages: [{ offsetDays: 10, label: 'Overdue' }] });
    expect(edited.status).toBe(200);
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'stage_removed' });
    // Back on the default: a new invoice is planned under the default; an open one under the old policy is skipped.
    const inv2 = await openInvoice(A, c, '45.00', day(-10));
    await plan(A);
    expect((await rowsOf(inv2.id))[0]).toMatchObject({ offset_days: 10, status: 'PENDING', policy_id: p.id });
    expect((await own.putSettings(c, { policyId: null })).body).toMatchObject({ error: 'stale' });
    const back = await own.putSettings(c, { policyId: null, version: 1 });
    expect(back.body.settings).toMatchObject({ policyId: null, effectivePolicyId: policyA.id, version: 2 });
    expect((await rowsOf(inv2.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'policy_changed' });
    const archived = await own.archivePolicy(p.id, edited.body.policy.version);
    expect(archived.body.policy).toMatchObject({ status: 'ARCHIVED', isDefault: false });
    expect((await own.putSettings(c, { policyId: p.id, version: 2 })).body).toMatchObject({ error: 'archived' });
    expect((await own.patchPolicy(p.id, { version: archived.body.policy.version, name: 'x' })).body).toMatchObject({ error: 'archived' });
  });

  it('a check waits for a policy change being committed at the same moment, and then sees it (configuration lock)', async () => {
    const T = await team('rp', []);
    const p = (await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true })).body.policy;
    const c = await customer(T, 'Racer');
    const inv = await openInvoice(T, c, '11.00', day(-7));
    await plan(T);
    const claimed = (await withTenant(sys(T.businessId), (db) => claimReminder(db, { leaseSeconds: 60 })))!;
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.business_id', $1, true)`, [T.businessId]);
      await app.query(`SELECT pg_advisory_xact_lock(hashtextextended('finance.reminders.config:' || $1, 0))`, [T.businessId]);
      let done = false;
      const check = withTenant(sys(T.businessId), (db) => executeReminder(db, claimed, fakeOutbox().outbox)).then((o) => { done = true; return o; });
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
      await app.query(`UPDATE finance_reminder_policies SET stages = $2, version = version + 1 WHERE id = $1`, [p.id, JSON.stringify([{ offsetDays: 21, label: 'Final' }])]);
      await app.query('COMMIT');
      expect(await check).toBe('skipped');
    } catch (e) {
      await app.query('ROLLBACK');
      throw e;
    }
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'stage_removed', outbound_id: null });
  });

  it('a person can dismiss a pending or ready reminder (final, audited); not one that was handed over', async () => {
    const c = await customer(A, 'Soylent');
    const inv = await openInvoice(A, c, '15.00', day(-7));
    await plan(A);
    const [r] = await rowsOf(inv.id);
    expect((await api(A.people.MANAGER!, A.slug).dismiss(r.id)).status).toBe(403);
    const d = await api(A.people.ADMIN!, A.slug).dismiss(r.id);
    expect(d.body.reminder).toMatchObject({ status: 'SKIPPED', outcomeCode: 'dismissed', dismissedById: A.people.ADMIN!.id });
    expect((await api(A.people.ADMIN!, A.slug).dismiss(r.id)).body).toMatchObject({ error: 'invalid_state' });
    expect((await audits(r.id)).map((a) => a.action)).toEqual(['finance.reminder.dismissed']);
  });
});

describe('the C2-C outbox boundary (nothing is sent)', () => {
  it('until C2-C there is no outbox: eligible reminders stop at READY', () => {
    expect(configuredReminderOutbox()).toBeNull();
  });

  it('hands each reminder over exactly once, with the locked invoice\'s exact amounts and a system idempotency key', async () => {
    const T = await team('rq', []);
    await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true });
    const c = await customer(T, 'Cyberdyne', 'ap@cyberdyne.example');
    const inv = await openInvoice(T, c, '199.99', day(-7));
    await pay(T, c, inv.id, '0.99');
    await plan(T);
    const { outbox, calls } = fakeOutbox();
    expect(await work(T, outbox)).toEqual(['queued']);
    const [r] = await rowsOf(inv.id);
    expect(r).toMatchObject({ status: 'QUEUED', outbound_state: 'QUEUED', checked_outstanding: '199.0000' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      reminderId: r.id, idempotencyKey: `system reminder ${r.id}`, invoiceId: inv.id, invoiceNumber: inv.number, customerId: c, currencyCode: 'AUD',
      total: '199.99', outstanding: '199.00', dueDate: day(-7), daysPastDue: 7, offsetDays: 7, stageLabel: 'Overdue',
      recipient: { source: 'customer', contactId: null, address: 'ap@cyberdyne.example' },
    });
    expect(r.outbound_id).toBe((await outbox.enqueue(null as never, calls[0]!) as { outboundId: string }).outboundId); // idempotent on the key
    await dueNow(T);
    expect(await work(T, outbox)).toEqual([]); // QUEUED is never claimed again
    const a = await audits(r.id);
    expect(a.map((x) => x.action)).toEqual(['finance.system.reminder.queued']);
    expect(JSON.stringify(a)).not.toMatch(/cyberdyne/);
  });

  it('C2-C\'s check before sending re-reads the invoice: paid in between means not sent and SKIPPED', async () => {
    const T = await team('rs', []);
    await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true });
    const c = await customer(T, 'Tyrell');
    const stillDue = await openInvoice(T, c, '30.00', day(-7));
    const paidMeanwhile = await openInvoice(T, c, '30.00', day(-7));
    await plan(T);
    const { outbox } = fakeOutbox();
    await work(T, outbox);
    const ok = (await rowsOf(stillDue.id))[0];
    const gone = (await rowsOf(paidMeanwhile.id))[0];
    await pay(T, c, paidMeanwhile.id, '30.00');
    const confirm = (reminderId: string, outboundId: string) => withTenant(sys(T.businessId), (db) => confirmReminderBeforeSend(db, { reminderId, outboundId }));
    const yes = await confirm(ok.id, ok.outbound_id);
    expect(yes).toMatchObject({ send: true, request: { outstanding: '30.00', reminderId: ok.id } });
    expect(await confirm(gone.id, gone.outbound_id)).toEqual({ send: false, reason: 'settled' });
    expect((await rowsOf(paidMeanwhile.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'settled', outbound_state: 'QUEUED' });
    expect(await confirm(ok.id, randomUUID())).toEqual({ send: false, reason: 'not_queued' });
    // Later states follow C2's register; UNKNOWN never becomes FAILED and nothing is "delivered".
    const state = (s: string) => withTenant(sys(T.businessId), (db) => recordReminderOutboundState(db, { reminderId: ok.id, outboundId: ok.outbound_id, state: s as never }));
    await state('SENDING');
    expect(await confirm(ok.id, ok.outbound_id)).toEqual({ send: false, reason: 'not_queued' }); // sending started: no longer stoppable
    await state('UNKNOWN');
    await expect(state('FAILED')).rejects.toMatchObject({});
    expect((await rowsOf(stillDue.id))[0]).toMatchObject({ status: 'QUEUED', outbound_state: 'UNKNOWN' });
    await state('ACCEPTED');
    await expect(admin.query(`UPDATE finance_reminders SET outbound_state = 'DELIVERED' WHERE id = $1`, [ok.id])).rejects.toMatchObject({ code: 'FN045' });
    await expect(admin.query(`UPDATE finance_reminders SET outbound_state = NULL WHERE id = $1`, [ok.id])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE finance_reminders SET status = 'SKIPPED', outcome_code = 'dismissed' WHERE id = $1`, [ok.id])).rejects.toMatchObject({ code: 'FN043' });
    expect((await audits(ok.id)).map((x) => x.action)).toEqual([
      'finance.system.reminder.queued', 'finance.system.reminder.outbound_state', 'finance.system.reminder.outbound_state', 'finance.system.reminder.outbound_state',
    ]);
  });

  it('an outbox error rolls the hand-over back and is retried with the same key; a refusal leaves it READY with the code', async () => {
    const T = await team('rt', []);
    await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true });
    const c = await customer(T, 'Oscorp');
    const inv = await openInvoice(T, c, '25.00', day(-7));
    await plan(T);
    const broken = fakeOutbox('throw');
    expect(await work(T, broken.outbox)).toEqual(['error:retrying']);
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'PENDING', outcome_code: 'internal_error', outbound_id: null, attempts: 1 });
    const refusing = fakeOutbox('refuse');
    await dueNow(T);
    expect(await work(T, refusing.outbox)).toEqual(['refused']);
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'READY', outcome_code: 'no_sending_mailbox', outbound_id: null });
    const good = fakeOutbox();
    await dueNow(T);
    expect(await work(T, good.outbox)).toEqual(['queued']);
    expect(new Set([...broken.calls, ...refusing.calls, ...good.calls].map((x) => x.idempotencyKey)).size).toBe(1);
  });
});

describe('concurrency and leases', () => {
  it('two workers at once hand every reminder over exactly once', async () => {
    const T = await team('rc', []);
    await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true });
    const c = await customer(T, 'Massive');
    const invoices = [];
    for (let i = 0; i < 12; i++) invoices.push(await openInvoice(T, c, `${10 + i}.00`, day(-7 - (i % 3))));
    const { outbox, calls } = fakeOutbox();
    const [one, two] = await Promise.all([
      runReminderPass({ deadlineMs: 30_000, outbox, leaseSeconds: 60 }),
      runReminderPass({ deadlineMs: 30_000, outbox, leaseSeconds: 60 }),
    ]);
    // The passes also visit other businesses with due work; count this one's hand-overs.
    const mine = calls.filter((x) => x.customerId === c);
    expect(one.queued + two.queued).toBeGreaterThanOrEqual(12);
    expect(mine).toHaveLength(12);
    expect(new Set(mine.map((x) => x.reminderId)).size).toBe(12);
    const { rows } = await admin.query(`SELECT status, count(*)::int AS n FROM finance_reminders WHERE business_id = $1 GROUP BY 1`, [T.businessId]);
    expect(rows).toEqual([{ status: 'QUEUED', n: 12 }]);
  });

  it('a check waits for a payment being allocated (invoice row lock) and a lost lease changes nothing', async () => {
    const T = await team('rl', []);
    await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true });
    const c = await customer(T, 'Stark');
    const inv = await openInvoice(T, c, '75.00', day(-7));
    await plan(T);
    const claimed = (await withTenant(sys(T.businessId), (db) => claimReminder(db, { leaseSeconds: 60 })))!;
    await app.query('BEGIN');
    let done = false;
    let check: Promise<string>;
    try {
      await app.query(`SELECT set_config('app.business_id', $1, true)`, [T.businessId]);
      await app.query(`SELECT 1 FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE`, [inv.id]);
      check = withTenant(sys(T.businessId), (db) => executeReminder(db, claimed, null)).then((o) => { done = true; return o; });
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
    } finally {
      await app.query('COMMIT');
    }
    expect(await check!).toBe('ready');
    // Lease lost: a worker whose lease expired and was reclaimed changes nothing.
    await dueNow(T);
    const first = (await withTenant(sys(T.businessId), (db) => claimReminder(db, { leaseSeconds: 60 })))!;
    await admin.query(`UPDATE finance_reminders SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [first.reminderId]);
    const second = (await withTenant(sys(T.businessId), (db) => claimReminder(db, { leaseSeconds: 60 })))!;
    expect(second.reminderId).toBe(first.reminderId);
    expect(await withTenant(sys(T.businessId), (db) => executeReminder(db, first, fakeOutbox().outbox))).toBe('lease_lost');
    expect(await withTenant(sys(T.businessId), (db) => failReminder(db, first))).toBe('lease_lost');
    expect(await withTenant(sys(T.businessId), (db) => executeReminder(db, second, null))).toBe('ready');
  });
});

describe('lock order: holds and policy changes never deadlock with a dispatch (§10.6)', () => {
  /** Waits (database-observed, not a timer) until at least `n` lock requests of `locktype` are waiting. */
  async function waitingOn(locktype: 'advisory' | 'transactionid' | 'tuple', n = 1) {
    for (let i = 0; i < 200; i++) {
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = $1`, [locktype]);
      if (rows[0].n >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no transaction is waiting on a ${locktype} lock`);
  }
  /** True when nobody holds the reminder row: proves a waiting dispatch has not locked it yet (level 4 comes last). */
  async function reminderRowFree(id: string) {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT 1 FROM finance_reminders WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === '55P03') return false;
      throw e;
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  /** An outbox whose enqueue waits for `open()`: the dispatch then holds every lock it takes, at its widest point. */
  function gatedOutbox() {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const fake = fakeOutbox();
    const outbox: ReminderOutbox = { enqueue: async (db, request) => { entered(); await gate; return fake.outbox.enqueue(db, request); } };
    return { outbox, open, inside };
  }
  async function setup(label: string) {
    const T = await team(label, []);
    const p = (await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true })).body.policy;
    const c = await customer(T, `Lock${label}`);
    const inv = await openInvoice(T, c, '64.00', day(-7));
    await plan(T);
    const claimed = (await withTenant(sys(T.businessId), (db) => claimReminder(db, { leaseSeconds: 60 })))!;
    expect(claimed).not.toBeNull();
    return { T, p, c, inv, claimed, own: api(T.people.OWNER!, T.slug) };
  }

  it('hold first: a dispatch waits for the hold without locking the reminder, then skips it (on_hold); neither aborts', async () => {
    const { T, c, inv, claimed, own } = await setup('dh1');
    // Pause the real hold path inside its customer lock: it waits for this invoice row (lockDocuments).
    await admin.query('BEGIN');
    await admin.query(`SELECT 1 FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE`, [inv.id]);
    const hold = own.hold({ customerId: c, invoiceId: inv.id, reason: 'DISPUTE' });
    await waitingOn('transactionid');
    const dispatch = withTenant(sys(T.businessId), (db) => executeReminder(db, claimed, fakeOutbox().outbox));
    await waitingOn('advisory'); // the dispatch waits for the hold's customer lock …
    expect(await reminderRowFree(claimed.reminderId)).toBe(true); // … holding no reminder row
    await admin.query('COMMIT');
    const [h, outcome] = await Promise.all([hold, dispatch]);
    expect(h.status).toBe(201);
    expect(outcome).toBe('skipped');
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'on_hold', outbound_id: null });
  });

  it('dispatch first: the hold waits for the hand-over, then C2-C\'s pre-send check refuses to send (on_hold); neither aborts', async () => {
    const { T, c, inv, claimed, own } = await setup('dh2');
    const g = gatedOutbox();
    const dispatch = withTenant(sys(T.businessId), (db) => executeReminder(db, claimed, g.outbox));
    await g.inside; // config, customer and invoice locked, and the reminder row too
    const hold = own.hold({ customerId: c, reason: 'DISPUTE' });
    await waitingOn('advisory');
    g.open();
    const [outcome, h] = await Promise.all([dispatch, hold]);
    expect(outcome).toBe('queued');
    expect(h.status).toBe(201);
    const row = (await rowsOf(inv.id))[0];
    expect(row).toMatchObject({ status: 'QUEUED', outbound_state: 'QUEUED' });
    expect(await withTenant(sys(T.businessId), (db) => confirmReminderBeforeSend(db, { reminderId: row.id, outboundId: row.outbound_id })))
      .toEqual({ send: false, reason: 'on_hold' });
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'on_hold' });
  });

  it('policy change first: a dispatch waits without locking the reminder, then skips the removed stage; neither aborts', async () => {
    const { T, p, inv, claimed, own } = await setup('dp1');
    // Pause the real policy update inside its configuration lock: it waits for the policy row.
    await admin.query('BEGIN');
    await admin.query(`SELECT 1 FROM finance_reminder_policies WHERE id = $1 FOR UPDATE`, [p.id]);
    const patch = own.patchPolicy(p.id, { version: p.version, stages: [{ offsetDays: -3, label: 'Due soon' }, { offsetDays: 21, label: 'Final notice' }] });
    await waitingOn('transactionid');
    const dispatch = withTenant(sys(T.businessId), (db) => executeReminder(db, claimed, fakeOutbox().outbox));
    await waitingOn('advisory');
    expect(await reminderRowFree(claimed.reminderId)).toBe(true);
    await admin.query('COMMIT');
    const [res, outcome] = await Promise.all([patch, dispatch]);
    expect(res.status).toBe(200);
    expect(outcome).toBe('skipped');
    expect((await rowsOf(inv.id))[0]).toMatchObject({ status: 'SKIPPED', outcome_code: 'stage_removed', outbound_id: null });
  });

  it('dispatch first: the policy change waits for the hand-over, then the pre-send check refuses (stage_removed); neither aborts', async () => {
    const { T, p, inv, claimed, own } = await setup('dp2');
    const g = gatedOutbox();
    const dispatch = withTenant(sys(T.businessId), (db) => executeReminder(db, claimed, g.outbox));
    await g.inside;
    const patch = own.patchPolicy(p.id, { version: p.version, stages: [{ offsetDays: -3, label: 'Due soon' }, { offsetDays: 21, label: 'Final notice' }] });
    await waitingOn('advisory');
    g.open();
    const [outcome, res] = await Promise.all([dispatch, patch]);
    expect(outcome).toBe('queued');
    expect(res.status).toBe(200);
    const row = (await rowsOf(inv.id))[0];
    expect(await withTenant(sys(T.businessId), (db) => confirmReminderBeforeSend(db, { reminderId: row.id, outboundId: row.outbound_id })))
      .toEqual({ send: false, reason: 'stage_removed' });
  });

  it('a pre-send check waiting on a hold holds no reminder row either', async () => {
    const { T, c, inv, claimed, own } = await setup('dh3');
    expect(await withTenant(sys(T.businessId), (db) => executeReminder(db, claimed, fakeOutbox().outbox))).toBe('queued');
    const row = (await rowsOf(inv.id))[0];
    await admin.query('BEGIN');
    await admin.query(`SELECT 1 FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE`, [inv.id]);
    const hold = own.hold({ customerId: c, invoiceId: inv.id, reason: 'DISPUTE' });
    await waitingOn('transactionid');
    const confirm = withTenant(sys(T.businessId), (db) => confirmReminderBeforeSend(db, { reminderId: row.id, outboundId: row.outbound_id }));
    await waitingOn('advisory');
    expect(await reminderRowFree(row.id)).toBe(true);
    await admin.query('COMMIT');
    const [h, result] = await Promise.all([hold, confirm]);
    expect(h.status).toBe(201);
    expect(result).toEqual({ send: false, reason: 'on_hold' });
  });
});

describe('database guards', () => {
  it('no DELETE; identity and final states are fixed; inserts start pending on an issued invoice of the customer', async () => {
    const T = await team('rg', []);
    const p = (await api(T.people.OWNER!, T.slug).createPolicy({ name: 'Std', stages: STAGES, isDefault: true })).body.policy;
    const c = await customer(T, 'Guarded');
    const inv = await openInvoice(T, c, '5.00', day(-7));
    await plan(T);
    const [r] = await rowsOf(inv.id);
    const code = async (sql: string, params: unknown[]) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.business_id', $1, true)`, [T.businessId]);
        await app.query(sql, params);
        await app.query('ROLLBACK');
        return 'ok';
      } catch (e) {
        await app.query('ROLLBACK');
        return (e as { code: string }).code;
      }
    };
    expect(await code('DELETE FROM finance_reminders WHERE id = $1', [r.id])).toBe('42501');
    expect(await code('DELETE FROM finance_reminder_policies WHERE id = $1', [p.id])).toBe('42501');
    expect(await code(`UPDATE finance_reminders SET offset_days = 8, scheduled_on = scheduled_on + 1 WHERE id = $1`, [r.id])).toBe('42501'); // no column grant
    expect(await code(`UPDATE finance_reminders SET status = 'QUEUED', outbound_id = $2, outbound_state = 'QUEUED', checked_at = now(), checked_outstanding = 5 WHERE id = $1`, [r.id, randomUUID()])).toBe('FN043');
    expect(await code(`INSERT INTO finance_reminders (id, business_id, invoice_id, customer_id, policy_id, policy_version, offset_days, stage_label, due_date, scheduled_on, status)
                       VALUES ($1, $2, $3, $4, $5, 1, 21, 'x', $6, $6::date + 21, 'READY')`, [randomUUID(), T.businessId, inv.id, c, p.id, day(-7)])).toBe('FN043');
    const other = await customer(T, 'Other');
    expect(await code(`INSERT INTO finance_reminders (id, business_id, invoice_id, customer_id, policy_id, policy_version, offset_days, stage_label, due_date, scheduled_on)
                       VALUES ($1, $2, $3, $4, $5, 1, 21, 'x', $6, $6::date + 21)`, [randomUUID(), T.businessId, inv.id, other, p.id, day(-7)])).toBe('FN044');
    expect(await code(`INSERT INTO finance_reminders (id, business_id, invoice_id, customer_id, policy_id, policy_version, offset_days, stage_label, due_date, scheduled_on)
                       VALUES ($1, $2, $3, $4, $5, 1, 7, 'x', $6, $6::date + 7)`, [randomUUID(), T.businessId, inv.id, c, p.id, day(-7)])).toBe('23505');
    await admin.query(`UPDATE finance_reminders SET status = 'SKIPPED', outcome_code = 'dismissed' WHERE id = $1`, [r.id]);
    expect(await code(`UPDATE finance_reminders SET status = 'PENDING', outcome_code = NULL WHERE id = $1`, [r.id])).toBe('FN043');
    const hold = (await api(T.people.OWNER!, T.slug).hold({ customerId: c, reason: 'OTHER' })).body.hold;
    expect(await code(`UPDATE finance_reminder_holds SET until_date = now()::date + 30 WHERE id = $1`, [hold.id])).toBe('42501');
    expect(await code(`UPDATE finance_reminder_holds SET released_at = now() WHERE id = $1`, [hold.id])).toBe('23514');
    await api(T.people.OWNER!, T.slug).release(hold.id);
    expect(await code(`UPDATE finance_reminder_holds SET released_by_id = $2 WHERE id = $1`, [hold.id, T.people.OWNER!.id])).toBe('FN042');
    await admin.query(`UPDATE finance_reminder_policies SET status = 'ARCHIVED', is_default = false WHERE id = $1`, [p.id]);
    expect(await code(`UPDATE finance_reminder_policies SET status = 'ACTIVE' WHERE id = $1`, [p.id])).toBe('FN040');
  });
});

describe('tenant isolation', () => {
  it('another business sees none of it: routes answer 404, RLS hides rows, and the worker never plans its invoices', async () => {
    const c = await customer(A, 'Isolated');
    const inv = await openInvoice(A, c, '60.00', day(-7));
    await plan(A);
    const [r] = await rowsOf(inv.id);
    const hold = (await api(A.people.OWNER!, A.slug).hold({ customerId: c, invoiceId: inv.id, reason: 'OTHER' })).body.hold;
    const b = api(B.people.OWNER!, B.slug);
    expect((await b.policy(policyA.id)).status).toBe(404);
    expect((await b.patchPolicy(policyA.id, { version: policyA.version, name: 'mine' })).status).toBe(404);
    expect((await b.archivePolicy(policyA.id, policyA.version)).status).toBe(404);
    expect((await b.settings(c)).status).toBe(404);
    expect((await b.putSettings(c, { policyId: null })).status).toBe(404);
    expect((await b.hold({ customerId: c, reason: 'OTHER' })).status).toBe(404);
    expect((await b.release(hold.id)).status).toBe(404);
    expect((await b.dismiss(r.id)).status).toBe(404);
    expect((await b.schedule(inv.id)).status).toBe(404);
    expect((await b.policies()).body.policies).toEqual([]);
    expect((await b.reminders()).body.reminders).toEqual([]);
    expect((await b.holds('?state=all')).body.holds).toEqual([]);
    const bPolicy = (await b.createPolicy({ name: 'B', stages: STAGES, isDefault: true })).body.policy;
    expect((await api(A.people.OWNER!, A.slug).putSettings(c, { policyId: bPolicy.id })).status).toBe(404);
    // RLS: bos_app scoped to B sees no row of A's reminder tables, and cannot write one.
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.business_id', $1, true)`, [B.businessId]);
      for (const t of ['finance_reminders', 'finance_reminder_holds', 'finance_reminder_customer_policies']) {
        expect((await app.query(`SELECT count(*)::int AS n FROM ${t} WHERE business_id = $1`, [A.businessId])).rows[0].n).toBe(0);
      }
      await expect(app.query(`INSERT INTO finance_reminder_holds (id, business_id, scope, customer_id, reason, created_by_id) VALUES ($1, $2, 'CUSTOMER', $3, 'OTHER', $4)`,
        [randomUUID(), A.businessId, c, B.people.OWNER!.id])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.query('ROLLBACK');
    }
    // Cross-tenant references are refused by the composite keys, even for a privileged writer.
    const bCustomer = await customer(B, 'Bone');
    await expect(admin.query(`INSERT INTO finance_reminders (id, business_id, invoice_id, customer_id, policy_id, policy_version, offset_days, stage_label, due_date, scheduled_on)
      VALUES ($1, $2, $3, $4, $5, 1, 7, 'x', $6, $6::date + 7)`, [randomUUID(), B.businessId, inv.id, bCustomer, bPolicy.id, day(-7)])).rejects.toMatchObject({});
    // B's overdue invoice is reminded only under B's own policy, never touched by A's.
    const bInv = await openInvoice(B, bCustomer, '9.00', day(-7));
    await plan(A);
    expect(await rowsOf(bInv.id)).toEqual([]);
    await plan(B);
    expect((await rowsOf(bInv.id))[0]).toMatchObject({ policy_id: bPolicy.id });
  });
});

describe('the cron entry point', () => {
  it('refuses without the configured secret, runs a pass with it, and returns counts only', async () => {
    const call = (auth?: string) => jobRoute.GET(new Request(`${BASE}/api/internal/jobs/finance-reminders`, { headers: auth ? { authorization: auth } : {} }));
    const { getEnv } = await import('@/core/config/env');
    const env = getEnv() as { CRON_SECRET?: string };
    const saved = env.CRON_SECRET;
    try {
      env.CRON_SECRET = undefined;
      expect((await call('Bearer anything')).status).toBe(503);
      env.CRON_SECRET = 'x'.repeat(40);
      expect((await call()).status).toBe(401);
      expect((await call(`Bearer ${'y'.repeat(40)}`)).status).toBe(401);
      const ok = await call(`Bearer ${'x'.repeat(40)}`);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(Object.keys(body.summary).sort()).toEqual([
        'businessErrors', 'businesses', 'failed', 'leaseLost', 'planBatches', 'planned', 'queued', 'ready', 'refused', 'retrying', 'skipped', 'stoppedAtDeadline',
      ]);
      expect(body.summary.queued).toBe(0); // no outbox: nothing is ever handed over
      expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    } finally {
      env.CRON_SECRET = saved;
    }
  });

  it('the due-business function reveals business ids only, and is callable by the app role alone', async () => {
    await admin.query('UPDATE finance_reminder_policies SET last_planned_at = NULL WHERE business_id = $1 AND status = \'ACTIVE\'', [A.businessId]);
    const { rows } = await app.query('SELECT * FROM app_private.finance_reminders_due(500)');
    expect(rows.map((r) => r.business_id)).toContain(A.businessId);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0])).toEqual(['business_id']);
    const fn = await admin.query(`SELECT has_function_privilege('bos_auth', 'app_private.finance_reminders_due(integer)', 'EXECUTE') AS auth,
                                         has_function_privilege('bos_app', 'app_private.finance_reminders_due(integer)', 'EXECUTE') AS app`);
    expect(fn.rows[0]).toEqual({ auth: false, app: true });
  });
});
