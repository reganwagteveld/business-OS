/**
 * Sales Zone backend (PR 15): pipelines, stages and opportunities through the real route handlers,
 * against PostgreSQL with the migrations and privileged SQL applied as in production. Two independent
 * businesses and every membership role (docs/sales-data-model.md).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as membersRoute from '@/app/api/v1/b/[slug]/members/route';
import * as memberRoute from '@/app/api/v1/b/[slug]/members/[membershipId]/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as archiveCustomerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/archive/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as contactRoute from '@/app/api/v1/b/[slug]/contacts/[contactId]/route';
import * as archiveContactRoute from '@/app/api/v1/b/[slug]/contacts/[contactId]/archive/route';
import * as pipelinesRoute from '@/app/api/v1/b/[slug]/sales/pipelines/route';
import * as defaultPipelineRoute from '@/app/api/v1/b/[slug]/sales/pipelines/default/route';
import * as outcomesRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/outcomes/route';
import * as stagesRoute from '@/app/api/v1/b/[slug]/sales/stages/route';
import * as opportunitiesRoute from '@/app/api/v1/b/[slug]/sales/opportunities/route';
import * as opportunityRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/route';
import * as winRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/win/route';
import * as loseRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/lose/route';
import * as reopenRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/reopen/route';
import * as archiveRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/archive/route';
import * as restoreRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/restore/route';
import { devOutbox } from '@/core/email';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await Promise.all([admin.connect(), app.connect()]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

// A separate address range from the other suites, so rate-limit counters do not collide.
let ip = 1;
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `198.19.${Math.floor(ip / 250)}.${ip++ % 250}` });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(req('GET', `${link.pathname}${link.search}`, { origin: null }));
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

/** A business with an OWNER and one member of each other role. */
async function team(label: string, currency = 'AUD') {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: currency === 'JPY' ? 'JP' : 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
    const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
    const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
    expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
    people[role] = user;
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string };
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const api = (who: User, slug: string) => {
  const o = (opportunityId: string) => ctx({ slug, opportunityId });
  const base = `/api/v1/b/${slug}/sales`;
  return {
    pipelines: () => pipelinesRoute.GET(req('GET', `${base}/pipelines`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createPipeline: (body: unknown) => pipelinesRoute.POST(req('POST', `${base}/pipelines`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    stages: (qs = '') => stagesRoute.GET(req('GET', `${base}/stages${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    list: (qs = '') => opportunitiesRoute.GET(req('GET', `${base}/opportunities${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    create: (body: unknown) => opportunitiesRoute.POST(req('POST', `${base}/opportunities`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    get: (id: string) => opportunityRoute.GET(req('GET', `${base}/opportunities/${id}`, { cookie: who.cookie }), o(id)).then(json),
    init: () => defaultPipelineRoute.POST(req('POST', `${base}/pipelines/default`, { cookie: who.cookie }), ctx({ slug })).then(json),
    outcomes: (id: string) => outcomesRoute.GET(req('GET', `${base}/opportunities/${id}/outcomes`, { cookie: who.cookie }), o(id)).then(json),
    /** PATCH exactly as given (the body must carry the version it was based on). */
    patch: (id: string, body: unknown) => opportunityRoute.PATCH(req('PATCH', `${base}/opportunities/${id}`, { cookie: who.cookie, body }), o(id)).then(json),
    /** PATCH based on the current version: read it first, as a client showing fresh data would. */
    update: async (id: string, body: Record<string, unknown>) => {
      const current = await opportunityRoute.GET(req('GET', `${base}/opportunities/${id}`, { cookie: who.cookie }), o(id)).then(json);
      const version = current.body.opportunity?.version ?? 1;
      return opportunityRoute.PATCH(req('PATCH', `${base}/opportunities/${id}`, { cookie: who.cookie, body: { version, ...body } }), o(id)).then(json);
    },
    win: (id: string) => winRoute.POST(req('POST', `${base}/opportunities/${id}/win`, { cookie: who.cookie }), o(id)).then(json),
    lose: (id: string, body: unknown = {}) => loseRoute.POST(req('POST', `${base}/opportunities/${id}/lose`, { cookie: who.cookie, body }), o(id)).then(json),
    reopen: (id: string, body: unknown = {}) => reopenRoute.POST(req('POST', `${base}/opportunities/${id}/reopen`, { cookie: who.cookie, body }), o(id)).then(json),
    archive: (id: string) => archiveRoute.POST(req('POST', `${base}/opportunities/${id}/archive`, { cookie: who.cookie }), o(id)).then(json),
    restore: (id: string) => restoreRoute.POST(req('POST', `${base}/opportunities/${id}/restore`, { cookie: who.cookie }), o(id)).then(json),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    archiveCustomer: (customerId: string) => archiveCustomerRoute.POST(req('POST', `/api/v1/b/${slug}/customers/${customerId}/archive`, { cookie: who.cookie }), ctx({ slug, customerId })).then(json),
    createContact: (body: unknown) => contactsRoute.POST(req('POST', `/api/v1/b/${slug}/contacts`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    updateContact: (contactId: string, body: unknown) => contactRoute.PATCH(req('PATCH', `/api/v1/b/${slug}/contacts/${contactId}`, { cookie: who.cookie, body }), ctx({ slug, contactId })).then(json),
    archiveContact: (contactId: string) => archiveContactRoute.POST(req('POST', `/api/v1/b/${slug}/contacts/${contactId}/archive`, { cookie: who.cookie }), ctx({ slug, contactId })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
beforeAll(async () => {
  A = await team('sa');
  B = await team('sb');
}, 120_000);

describe('default pipeline and stages', () => {
  it('reading never creates anything; explicit, idempotent initialisation creates the default once, per business', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    expect((await owner.pipelines()).body).toEqual({ pipelines: [] });
    expect((await owner.stages()).status).toBe(404);
    expect((await admin.query('SELECT count(*)::int AS n FROM sales_pipelines WHERE business_id = $1', [A.businessId])).rows[0].n).toBe(0);
    const first = await owner.init();
    expect(first.status).toBe(201);
    expect(first.body.pipeline).toMatchObject({ isDefault: true, name: 'Sales pipeline', archivedAt: null });
    expect(first.body.stages.map((s: { name: string; position: number; defaultProbability: number }) => [s.name, s.position, s.defaultProbability]))
      .toEqual([['New', 1000, 10], ['Qualified', 2000, 25], ['Proposal', 3000, 50], ['Negotiation', 4000, 75]]);
    const again = await api(A.people.MEMBER!, A.slug).init();
    expect(again.status).toBe(200);
    expect(again.body.pipeline.id).toBe(first.body.pipeline.id);
    expect((await owner.pipelines()).body.pipelines.map((p: { id: string }) => p.id)).toEqual([first.body.pipeline.id]);
    expect((await owner.stages()).body.pipeline.id).toBe(first.body.pipeline.id);
    const other = await api(B.people.OWNER!, B.slug).init();
    expect(other.status).toBe(201);
    expect(other.body.pipeline.id).not.toBe(first.body.pipeline.id);
    expect((await audits(first.body.pipeline.id)).map((e) => e.action)).toEqual(['sales.pipeline.initialized']);
  });

  it('concurrent initialisation creates exactly one default pipeline, one set of stages and one audit entry', async () => {
    const fresh = await team('sc');
    const people = Object.values(fresh.people);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api(people[i % people.length]!, fresh.slug).init()));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.pipeline.id)).size).toBe(1);
    expect(results.every((r) => r.body.stages.length === 4)).toBe(true);
    const { rows } = await admin.query(
      `SELECT (SELECT count(*)::int FROM sales_pipelines WHERE business_id = $1) AS pipelines,
              (SELECT count(*)::int FROM sales_stages WHERE business_id = $1) AS stages,
              (SELECT count(*)::int FROM audit_events WHERE business_id = $1 AND action = 'sales.pipeline.initialized') AS audits`, [fresh.businessId]);
    expect(rows[0]).toEqual({ pipelines: 1, stages: 4, audits: 1 });
  });

  it('creating the first opportunity (a write) initialises the default too, concurrency-safe', async () => {
    const fresh = await team('sd');
    const people = Object.values(fresh.people);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => api(people[i]!, fresh.slug).create({ title: `First ${i}` })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.opportunity.pipelineId)).size).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM sales_pipelines WHERE business_id = $1', [fresh.businessId])).rows[0].n).toBe(1);
  });

  it('initialising needs sales:write; a read-only request cannot run it', async () => {
    const anon = await defaultPipelineRoute.POST(req('POST', `/api/v1/b/${A.slug}/sales/pipelines/default`), ctx({ slug: A.slug }));
    expect(anon.status).toBe(401);
    expect((await api(B.people.OWNER!, A.slug).init()).status).toBe(404);
  });

  it('creating a pipeline needs sales:manage (OWNER, ADMIN) and gets the standard or given stages', async () => {
    const custom = await api(A.people.ADMIN!, A.slug).createPipeline({ name: 'Renewals', stages: [{ name: 'Due' }, { name: 'Quoted', defaultProbability: 60 }] });
    expect(custom.status).toBe(201);
    expect(custom.body.stages.map((s: { name: string; position: number }) => [s.name, s.position])).toEqual([['Due', 1000], ['Quoted', 2000]]);
    expect(custom.body.pipeline.isDefault).toBe(false);
    expect((await api(A.people.OWNER!, A.slug).createPipeline({ name: 'Projects' })).body.stages).toHaveLength(4);
    for (const role of ['MANAGER', 'MEMBER']) expect((await api(A.people[role]!, A.slug).createPipeline({ name: 'x' })).status, role).toBe(403);
    expect((await api(A.people.OWNER!, A.slug).createPipeline({ name: '' })).status).toBe(400);
    expect((await api(A.people.OWNER!, A.slug).createPipeline({ name: 'x', businessId: B.businessId })).status).toBe(400);
    expect((await audits(custom.body.pipeline.id)).map((a) => a.action)).toEqual(['sales.pipeline.created']);
    expect((await api(A.people.MEMBER!, A.slug).stages(`?pipelineId=${custom.body.pipeline.id}`)).body.stages).toHaveLength(2);
    expect((await api(B.people.OWNER!, B.slug).stages(`?pipelineId=${custom.body.pipeline.id}`)).status).toBe(404);
  });
});

describe('opportunities: create, money and currency', () => {
  it('defaults to the default pipeline, its first stage and the business currency; never invents an amount', async () => {
    const res = await api(A.people.MEMBER!, A.slug).create({ title: 'Office fit-out' });
    expect(res.status).toBe(201);
    const stages = (await api(A.people.MEMBER!, A.slug).stages()).body;
    expect(res.body.opportunity).toMatchObject({
      title: 'Office fit-out', pipelineId: stages.pipeline.id, stageId: stages.stages[0].id, currencyCode: 'AUD', amount: null,
      status: 'OPEN', closedAt: null, createdById: A.people.MEMBER!.id, archivedAt: null,
    });
  });

  it('stores exact decimals in the currency’s own minor unit, beyond float precision', async () => {
    const a = api(A.people.OWNER!, A.slug);
    expect((await a.create({ title: 'Big', amount: '99999999999999.99' })).body.opportunity.amount).toBe('99999999999999.99'); // > 2^53 cents
    expect((await a.create({ title: 'Cents', amount: '1250.5' })).body.opportunity.amount).toBe('1250.50');
    expect((await a.create({ title: 'Yen', amount: '150000', currencyCode: 'JPY' })).body.opportunity).toMatchObject({ amount: '150000', currencyCode: 'JPY' });
    expect((await a.create({ title: 'Dinar', amount: '12.125', currencyCode: 'KWD' })).body.opportunity.amount).toBe('12.125');
    const yen = await a.create({ title: 'Bad yen', amount: '1000.5', currencyCode: 'JPY' });
    expect(yen).toMatchObject({ status: 400, body: { error: 'invalid_amount' } });
    expect((await a.create({ title: 'AUD 3dp', amount: '1.005' })).body.error).toBe('invalid_amount');
    expect((await a.create({ title: 'Unknown', currencyCode: 'XQZ' })).body.error).toBe('invalid_currency');
    for (const amount of [1250.5, '-5', '1e3', '1,000', '0.12345', '123456789012345']) {
      expect((await a.create({ title: 'Bad', amount })).status, String(amount)).toBe(400);
    }
    const { rows } = await admin.query("SELECT amount::text FROM opportunities WHERE title = 'Big'");
    expect(rows[0].amount).toBe('99999999999999.9900');
  });

  it('changing currency re-checks the existing amount; probability and dates are validated', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const o = (await a.create({ title: 'FX', amount: '10.50' })).body.opportunity;
    expect((await a.update(o.id, { currencyCode: 'JPY' })).body.error).toBe('invalid_amount');
    expect((await a.update(o.id, { currencyCode: 'EUR' })).body.opportunity).toMatchObject({ currencyCode: 'EUR', amount: '10.50' });
    expect((await a.create({ title: 'P', probability: 101 })).status).toBe(400);
    expect((await a.create({ title: 'D', expectedCloseDate: '2026-02-30' })).status).toBe(400);
    expect((await a.create({ title: 'D', expectedCloseDate: '2027-03-31' })).body.opportunity.expectedCloseDate).toBe('2027-03-31');
  });

  it('strict bodies: no business id, author, status or close date from the client', async () => {
    const a = api(A.people.OWNER!, A.slug);
    for (const extra of [{ businessId: B.businessId }, { createdById: A.people.MEMBER!.id }, { status: 'WON' }, { closedAt: new Date().toISOString() }, { lossReason: 'x' }]) {
      expect((await a.create({ title: 'x', ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    const o = (await a.create({ title: 'Strict' })).body.opportunity;
    expect((await a.update(o.id, { status: 'WON' })).status).toBe(400);
    expect((await a.update(o.id, {})).status).toBe(400);
    expect((await a.patch(o.id, { title: 'No version' })).status).toBe(400); // the version is required
    expect((await a.create({ title: '' })).status).toBe(400);
  });
});

describe('Customer Zone linkage', () => {
  it('links existing customers and contacts; a contact’s customer is filed too; mismatches are refused', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const c1 = (await a.createCustomer({ displayName: 'Linked Co' })).body.customer;
    const c2 = (await a.createCustomer({ displayName: 'Other Co' })).body.customer;
    const k1 = (await a.createContact({ firstName: 'K1', customerId: c1.id })).body.contact;
    const loose = (await a.createContact({ firstName: 'Loose' })).body.contact;
    expect((await a.create({ title: 'Both', customerId: c1.id, contactId: k1.id })).body.opportunity).toMatchObject({ customerId: c1.id, contactId: k1.id });
    expect((await a.create({ title: 'Contact only', contactId: k1.id })).body.opportunity.customerId).toBe(c1.id);
    expect((await a.create({ title: 'Loose contact', customerId: c2.id, contactId: loose.id })).status).toBe(201);
    expect((await a.create({ title: 'Mismatch', customerId: c2.id, contactId: k1.id })).body.error).toBe('contact_customer_mismatch');
    const o = (await a.create({ title: 'Move', customerId: c1.id, contactId: k1.id })).body.opportunity;
    expect((await a.update(o.id, { customerId: c2.id })).body.error).toBe('contact_customer_mismatch');
    expect((await a.update(o.id, { customerId: c2.id, contactId: null })).body.opportunity).toMatchObject({ customerId: c2.id, contactId: null });
    expect((await a.list(`?customerId=${c1.id}`)).body.opportunities.map((x: { title: string }) => x.title).sort()).toEqual(['Both', 'Contact only']);
  });

  it('archived customers and contacts cannot be attached, but existing opportunities stay readable and editable', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const cust = (await a.createCustomer({ displayName: 'Soon archived' })).body.customer;
    const k = (await a.createContact({ firstName: 'Soon', customerId: cust.id })).body.contact;
    const o = (await a.create({ title: 'Historic', customerId: cust.id, contactId: k.id })).body.opportunity;
    await a.archiveContact(k.id);
    await a.archiveCustomer(cust.id);
    expect((await a.get(o.id)).body.opportunity).toMatchObject({ customerId: cust.id, contactId: k.id });
    expect((await a.update(o.id, { title: 'Historic (renamed)' })).status).toBe(200);
    expect((await a.create({ title: 'New', customerId: cust.id })).body.error).toBe('archived_reference');
    const live = (await a.createCustomer({ displayName: 'Live' })).body.customer;
    const o2 = (await a.create({ title: 'Re-link', customerId: live.id })).body.opportunity;
    expect((await a.update(o2.id, { customerId: cust.id })).body.error).toBe('archived_reference');
    const archivedLoose = (await a.createContact({ firstName: 'Gone' })).body.contact;
    await a.archiveContact(archivedLoose.id);
    expect((await a.update(o2.id, { contactId: archivedLoose.id })).body.error).toBe('archived_reference');
  });

  it('Customer Zone regression: a contact linked to an opportunity can still move to another customer', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const c1 = (await a.createCustomer({ displayName: 'From' })).body.customer;
    const c2 = (await a.createCustomer({ displayName: 'To' })).body.customer;
    const k = (await a.createContact({ firstName: 'Mover', customerId: c1.id })).body.contact;
    const o = (await a.create({ title: 'Kept', customerId: c1.id, contactId: k.id })).body.opportunity;
    expect((await a.updateContact(k.id, { customerId: c2.id })).status).toBe(200);
    expect((await a.get(o.id)).body.opportunity).toMatchObject({ customerId: c1.id, contactId: k.id }); // history is not rewritten
  });

  it('the owner must be an active member of this business; removing the member clears ownership', async () => {
    const temp = await team('so');
    const owner = api(temp.people.OWNER!, temp.slug);
    expect((await owner.create({ title: 'x', ownerUserId: B.people.OWNER!.id })).body.error).toBe('invalid_owner');
    const o = (await owner.create({ title: 'Assigned', ownerUserId: temp.people.MANAGER!.id })).body.opportunity;
    const members = await (await membersRoute.GET(req('GET', `/api/v1/b/${temp.slug}/members`, { cookie: temp.people.OWNER!.cookie }), ctx({ slug: temp.slug }))).json();
    const membershipId = members.members.find((m: { userId: string }) => m.userId === temp.people.MANAGER!.id).id;
    expect((await memberRoute.DELETE(req('DELETE', `/api/v1/b/${temp.slug}/members/${membershipId}`, { cookie: temp.people.OWNER!.cookie }), ctx({ slug: temp.slug, membershipId }))).status).toBe(200);
    expect((await owner.get(o.id)).body.opportunity.ownerUserId).toBeNull();
  });
});

describe('lifecycle and audit', () => {
  it('stage moves, assignment, win, reopen, lose and archive are audited with structured facts only', async () => {
    const a = api(A.people.MANAGER!, A.slug);
    const stages = (await a.stages()).body.stages;
    const o = (await a.create({ title: 'Secret title', description: 'Confidential details', amount: '5000' })).body.opportunity;
    expect((await a.update(o.id, { stageId: stages[2].id, ownerUserId: A.people.MEMBER!.id })).body.opportunity).toMatchObject({ stageId: stages[2].id, ownerUserId: A.people.MEMBER!.id });
    const won = await a.win(o.id);
    expect(won.body.opportunity).toMatchObject({ status: 'WON', stageId: stages[2].id });
    expect(won.body.opportunity.closedAt).not.toBeNull();
    expect((await a.win(o.id)).body.error).toBe('not_open');
    expect((await a.lose(o.id)).body.error).toBe('not_open');
    expect((await a.update(o.id, { stageId: stages[3].id })).body.error).toBe('not_open');
    expect((await a.update(o.id, { title: 'Still editable when won' })).status).toBe(200);
    expect((await a.reopen(o.id, { stageId: stages[1].id })).body.opportunity).toMatchObject({ status: 'OPEN', closedAt: null, stageId: stages[1].id });
    expect((await a.reopen(o.id)).body.error).toBe('not_closed');
    expect((await a.lose(o.id, { lossReason: 'Went with a competitor' })).body.opportunity).toMatchObject({ status: 'LOST', lossReason: 'Went with a competitor' });
    expect((await a.reopen(o.id)).body.opportunity).toMatchObject({ status: 'OPEN', lossReason: null, stageId: stages[1].id });
    expect((await a.archive(o.id)).status).toBe(200);
    expect((await a.update(o.id, { title: 'x' })).body.error).toBe('archived');
    expect((await a.win(o.id)).body.error).toBe('archived');
    expect((await a.archive(o.id)).body.error).toBe('archived');
    expect((await a.restore(o.id)).status).toBe(200);
    expect((await a.restore(o.id)).body.error).toBe('not_archived');

    const log = await audits(o.id);
    expect(log.map((e) => e.action).sort()).toEqual([
      'sales.opportunity.archived', 'sales.opportunity.assigned', 'sales.opportunity.created', 'sales.opportunity.lost',
      'sales.opportunity.reopened', 'sales.opportunity.reopened', 'sales.opportunity.restored', 'sales.opportunity.stage_changed',
      'sales.opportunity.updated', 'sales.opportunity.updated', 'sales.opportunity.won',
    ]);
    const by = (action: string) => log.filter((e) => e.action === action);
    expect(log.every((e) => e.actor_user_id === A.people.MANAGER!.id && e.business_id === A.businessId)).toBe(true);
    expect(by('sales.opportunity.stage_changed')[0].metadata).toMatchObject({ fromStageId: stages[0].id, toStageId: stages[2].id });
    expect(by('sales.opportunity.assigned')[0].metadata).toEqual({ from: null, to: A.people.MEMBER!.id });
    expect(by('sales.opportunity.won')[0].metadata).toEqual({ stageId: stages[2].id, amount: '5000.00', currencyCode: 'AUD' });
    expect(by('sales.opportunity.lost')[0].metadata).toMatchObject({ hasReason: 'true' });
    expect(by('sales.opportunity.reopened').map((e) => e.metadata.previousStatus)).toEqual(['WON', 'LOST']);
    expect(by('sales.opportunity.updated')[0].metadata.fields).toEqual(['ownerUserId', 'stageId']);
    expect(JSON.stringify(log)).not.toMatch(/Secret title|Confidential|competitor/);
  });

  it('concurrent wins: exactly one succeeds, the rest get 409, and only one outcome is recorded', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const o = (await a.create({ title: 'Race' })).body.opportunity;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a.win(o.id) : a.lose(o.id))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const outcomes = (await audits(o.id)).filter((e) => e.action === 'sales.opportunity.won' || e.action === 'sales.opportunity.lost');
    expect(outcomes).toHaveLength(1);
  });

  it('a stage of another pipeline is refused by the service and by the database', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const other = (await a.createPipeline({ name: `Other ${randomUUID().slice(0, 4)}` })).body;
    const o = (await a.create({ title: 'Wrong stage' })).body.opportunity;
    expect((await a.update(o.id, { stageId: other.stages[0].id })).body.error).toBe('invalid_stage');
    expect((await a.update(o.id, { pipelineId: other.pipeline.id })).status).toBe(400); // a pipeline change needs a stage
    expect((await a.update(o.id, { pipelineId: other.pipeline.id, stageId: other.stages[1].id })).body.opportunity).toMatchObject({ pipelineId: other.pipeline.id, stageId: other.stages[1].id });
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.OWNER!.id]);
      const def = (await a.stages()).body.stages[0].id;
      await expect(app.query('UPDATE opportunities SET stage_id = $1 WHERE id = $2', [def, o.id])).rejects.toThrow(/foreign key/);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('a mutation and its audit entry commit or roll back together (database level)', async () => {
    const stages = (await api(A.people.OWNER!, A.slug).stages()).body;
    const id = randomUUID();
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.OWNER!.id]);
    await app.query("INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES ($1, $2, 'Atomic', $3, $4, 'AUD')", [id, A.businessId, stages.pipeline.id, stages.stages[0].id]);
    await expect(app.query("INSERT INTO audit_events (id, business_id, actor_user_id, action, target_type, target_id) VALUES ($1, $2, $3, 'sales.opportunity.created', 'opportunity', $4)", [randomUUID(), B.businessId, A.people.OWNER!.id, id])).rejects.toThrow(/row-level security/);
    await app.query('ROLLBACK');
    expect((await admin.query('SELECT count(*)::int AS n FROM opportunities WHERE id = $1', [id])).rows[0].n).toBe(0);
  });
});

describe('lists', () => {
  it('filters by status, archive state, pipeline, stage, customer and owner; searches titles; pages with a bound cursor', async () => {
    const temp = await team('sl');
    const a = api(temp.people.OWNER!, temp.slug);
    const stages = (await a.init()).body.stages;
    const cust = (await a.createCustomer({ displayName: 'Filter Co' })).body.customer;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await a.create({ title: `Deal ${i}`, ...(i < 2 ? { customerId: cust.id } : {}), ...(i === 3 ? { ownerUserId: temp.people.MEMBER!.id } : {}) })).body.opportunity.id);
    await a.win(ids[0]!);
    await a.lose(ids[1]!);
    await a.archive(ids[2]!);
    await a.update(ids[4]!, { stageId: stages[1].id });
    const titles = async (qs: string) => (await a.list(qs)).body.opportunities.map((o: { title: string }) => o.title);
    expect(await titles('?status=open')).toEqual(['Deal 6', 'Deal 5', 'Deal 4', 'Deal 3']);
    expect(await titles('?status=won')).toEqual(['Deal 0']);
    expect(await titles('?status=lost')).toEqual(['Deal 1']);
    expect(await titles('?archived=archived')).toEqual(['Deal 2']);
    expect(await titles(`?customerId=${cust.id}`)).toEqual(['Deal 1', 'Deal 0']);
    expect(await titles(`?ownerUserId=${temp.people.MEMBER!.id}`)).toEqual(['Deal 3']);
    expect(await titles(`?stageId=${stages[1].id}`)).toEqual(['Deal 4']);
    expect(await titles('?q=deal%205')).toEqual(['Deal 5']);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { opportunities: { title: string }[]; nextCursor: string | null } } = await a.list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.body.opportunities.map((o) => o.title));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['Deal 6', 'Deal 5', 'Deal 4', 'Deal 3', 'Deal 1', 'Deal 0']);
    expect((await a.list('?cursor=abc')).body.error).toBe('invalid_cursor');
    expect((await a.list('?status=pending')).status).toBe(400);
  });
});

describe('roles, authentication and tenant isolation', () => {
  it('role matrix: every role reads and writes opportunities; only OWNER and ADMIN configure pipelines', async () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const who = api(A.people[role]!, A.slug);
      expect((await who.pipelines()).status, role).toBe(200);
      expect((await who.init()).status, role).toBe(200);
      expect((await who.stages()).status, role).toBe(200);
      const o = await who.create({ title: `${role} deal` });
      expect(o.status, role).toBe(201);
      const id = o.body.opportunity.id;
      for (const res of [await who.get(id), await who.list(), await who.update(id, { probability: 40 }), await who.win(id), await who.reopen(id),
        await who.lose(id), await who.reopen(id), await who.archive(id), await who.restore(id)]) {
        expect(res.status, role).toBe(200);
      }
      expect((await who.createPipeline({ name: `${role} pipeline` })).status, role).toBe(role === 'OWNER' || role === 'ADMIN' ? 201 : 403);
    }
  });

  it('no session is 401; a cookie from another origin is 403; a non-member gets 404 everywhere', async () => {
    const anon = await opportunitiesRoute.GET(req('GET', `/api/v1/b/${A.slug}/sales/opportunities`), ctx({ slug: A.slug }));
    expect(anon.status).toBe(401);
    const csrf = await opportunitiesRoute.POST(req('POST', `/api/v1/b/${A.slug}/sales/opportunities`, { cookie: A.people.MEMBER!.cookie, body: { title: 'x' }, origin: 'https://evil.example' }), ctx({ slug: A.slug }));
    expect(csrf.status).toBe(403);
    const o = (await api(A.people.OWNER!, A.slug).create({ title: 'A only' })).body.opportunity;
    const outsider = api(B.people.OWNER!, A.slug);
    const results = [await outsider.pipelines(), await outsider.stages(), await outsider.init(), await outsider.outcomes(o.id), await outsider.list(), await outsider.create({ title: 'x' }), await outsider.get(o.id),
      await outsider.update(o.id, { title: 'x' }), await outsider.win(o.id), await outsider.lose(o.id), await outsider.reopen(o.id), await outsider.archive(o.id),
      await outsider.restore(o.id), await outsider.createPipeline({ name: 'x' })];
    expect(results.map((r) => r.status)).toEqual(Array(results.length).fill(404));
  });

  it("one business can never read, change or link to another business's opportunities, pipelines, stages, customers or contacts", async () => {
    const a = api(A.people.OWNER!, A.slug);
    const b = api(B.people.OWNER!, B.slug);
    const bCustomer = (await b.createCustomer({ displayName: 'B customer' })).body.customer;
    const bContact = (await b.createContact({ firstName: 'B contact' })).body.contact;
    const bStages = (await b.stages()).body;
    const bOpp = (await b.create({ title: 'B secret', amount: '1' })).body.opportunity;
    expect((await a.get(bOpp.id)).status).toBe(404);
    expect((await a.update(bOpp.id, { title: 'hijack' })).status).toBe(404);
    expect((await a.win(bOpp.id)).status).toBe(404);
    expect((await a.archive(bOpp.id)).status).toBe(404);
    expect((await a.list('?q=B%20secret')).body.opportunities).toEqual([]);
    expect((await a.create({ title: 'x', customerId: bCustomer.id })).status).toBe(404);
    expect((await a.create({ title: 'x', contactId: bContact.id })).status).toBe(404);
    expect((await a.create({ title: 'x', pipelineId: bStages.pipeline.id })).status).toBe(404);
    expect((await a.create({ title: 'x', stageId: bStages.stages[0].id })).body.error).toBe('invalid_stage');
    expect((await a.stages(`?pipelineId=${bStages.pipeline.id}`)).status).toBe(404);
    const { rows } = await admin.query('SELECT title, status FROM opportunities WHERE id = $1', [bOpp.id]);
    expect(rows[0]).toEqual({ title: 'B secret', status: 'OPEN' });
  });

  it('raw SQL as bos_app: composite FKs block cross-business links, RLS blocks other-business rows, no DELETE', async () => {
    const aStages = (await api(A.people.OWNER!, A.slug).stages()).body;
    const bStages = (await api(B.people.OWNER!, B.slug).stages()).body;
    const bCustomer = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'B raw' })).body.customer;
    const run = async (sql: string, params: unknown[]) => {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.OWNER!.id]);
        await app.query(sql, params);
        await app.query('COMMIT');
      } catch (error) {
        await app.query('ROLLBACK');
        throw error;
      }
    };
    const insert = "INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code, customer_id) VALUES ($1, $2, 'x', $3, $4, 'AUD', $5)";
    await expect(run(insert, [randomUUID(), A.businessId, aStages.pipeline.id, aStages.stages[0].id, bCustomer.id])).rejects.toThrow(/foreign key/);
    await expect(run(insert, [randomUUID(), A.businessId, bStages.pipeline.id, bStages.stages[0].id, null])).rejects.toThrow(/foreign key/);
    await expect(run(insert, [randomUUID(), A.businessId, aStages.pipeline.id, bStages.stages[0].id, null])).rejects.toThrow(/foreign key/);
    await expect(run(insert, [randomUUID(), B.businessId, bStages.pipeline.id, bStages.stages[0].id, null])).rejects.toThrow(/row-level security/);
    await expect(run("INSERT INTO sales_pipelines (id, business_id, name, default_slot) VALUES ($1, $2, 'Second default', 'default')", [randomUUID(), A.businessId])).rejects.toThrow(/duplicate key/);
    await expect(run("UPDATE opportunities SET status = 'WON' WHERE business_id = $1", [A.businessId])).rejects.toThrow(/check constraint/); // won needs closed_at
    for (const table of ['opportunities', 'sales_stages', 'sales_pipelines']) {
      await expect(run(`DELETE FROM ${table} WHERE business_id = $1`, [A.businessId]), table).rejects.toThrow(/permission denied/);
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`); // outside any tenant context
      expect(rows[0].n, table).toBe(0);
    }
    const { rows } = await admin.query("SELECT relname FROM pg_class WHERE relname IN ('opportunities','sales_stages','sales_pipelines') AND relrowsecurity AND relforcerowsecurity");
    expect(rows).toHaveLength(3);
  });
});

describe('PR 15 review: concurrent edits and outcome history', () => {
  it('two people editing the same opportunity: the second, based on an old version, is refused, not merged over', async () => {
    const ana = api(A.people.MANAGER!, A.slug);
    const ben = api(A.people.MEMBER!, A.slug);
    const o = (await ana.create({ title: 'Shared', amount: '100' })).body.opportunity;
    expect(o.version).toBe(1);
    const first = await ana.patch(o.id, { version: 1, amount: '150' });
    expect(first.body.opportunity).toMatchObject({ amount: '150.00', version: 2 });
    const second = await ben.patch(o.id, { version: 1, probability: 90 }); // Ben still sees version 1
    expect(second).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await ana.get(o.id)).body.opportunity).toMatchObject({ amount: '150.00', probability: null, version: 2 });
    expect((await ben.patch(o.id, { version: 2, probability: 90 })).body.opportunity).toMatchObject({ amount: '150.00', probability: 90, version: 3 });
  });

  it('simultaneous edits from the same version: exactly one wins, the rest get 409 stale', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const o = (await a.create({ title: 'Race edit' })).body.opportunity;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => a.patch(o.id, { version: 1, title: `Edit ${i}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'stale')).toHaveLength(5);
    const winner = results.find((r) => r.status === 200)!.body.opportunity.title;
    expect((await a.get(o.id)).body.opportunity).toMatchObject({ title: winner, version: 2 });
    expect((await audits(o.id)).filter((e) => e.action === 'sales.opportunity.updated')).toHaveLength(1);
  });

  it('every change bumps the version, so an edit prepared before a win, stage move or archive is refused', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const stages = (await a.stages()).body.stages;
    const o = (await a.create({ title: 'Versioned' })).body.opportunity;
    await a.patch(o.id, { version: 1, stageId: stages[1].id }); // v2
    await a.win(o.id); // v3
    expect((await a.patch(o.id, { version: 2, title: 'From before the win' })).body.error).toBe('stale');
    await a.reopen(o.id); // v4
    await a.archive(o.id); // v5
    expect((await a.patch(o.id, { version: 4, title: 'x' })).body.error).toBe('archived');
    await a.restore(o.id); // v6
    expect((await a.get(o.id)).body.opportunity.version).toBe(6);
    expect((await a.patch(o.id, { version: 6, title: 'Fresh' })).status).toBe(200);
  });

  it('won/lost history survives reopening, with the loss reason kept under RLS and never in the audit log', async () => {
    const a = api(A.people.MEMBER!, A.slug);
    const stages = (await a.stages()).body.stages;
    const o = (await a.create({ title: 'History', amount: '2500' })).body.opportunity;
    await a.lose(o.id, { lossReason: 'Budget frozen until next year' });
    await a.reopen(o.id, { stageId: stages[2].id });
    await a.update(o.id, { amount: '3000' });
    await a.win(o.id);
    const { body } = await a.outcomes(o.id);
    expect(body.outcomes).toHaveLength(2);
    const [won, lost] = body.outcomes;
    expect(won).toMatchObject({ status: 'WON', lossReason: null, stageId: stages[2].id, amount: '3000.00', currencyCode: 'AUD', closedById: A.people.MEMBER!.id, reopenedAt: null });
    expect(lost).toMatchObject({ status: 'LOST', lossReason: 'Budget frozen until next year', stageId: stages[0].id, amount: '2500.00', closedById: A.people.MEMBER!.id, reopenedById: A.people.MEMBER!.id });
    expect(lost.reopenedAt).not.toBeNull();
    expect((await a.get(o.id)).body.opportunity).toMatchObject({ status: 'WON', lossReason: null });
    const log = JSON.stringify(await audits(o.id));
    expect(log).not.toMatch(/Budget frozen/);
    // Another business sees neither the history nor its reason.
    expect((await api(B.people.OWNER!, B.slug).outcomes(o.id)).status).toBe(404);
  });

  it('outcome history is append-only for tenant code: recorded facts cannot be rewritten or deleted', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const o = (await a.create({ title: 'Immutable' })).body.opportunity;
    await a.lose(o.id, { lossReason: 'Original reason' });
    const run = async (sql: string) => {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.OWNER!.id]);
        await app.query(sql, [o.id]);
      } finally {
        await app.query('ROLLBACK');
      }
    };
    await expect(run("UPDATE opportunity_outcomes SET loss_reason = 'Rewritten' WHERE opportunity_id = $1")).rejects.toThrow(/permission denied/);
    await expect(run('DELETE FROM opportunity_outcomes WHERE opportunity_id = $1')).rejects.toThrow(/permission denied/);
    const { rows } = await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'opportunity_outcomes'");
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await admin.query('SELECT loss_reason FROM opportunity_outcomes WHERE opportunity_id = $1', [o.id])).rows[0].loss_reason).toBe('Original reason');
  });

  it('decision: MEMBER may win, lose, reopen and archive (MVP); pipeline configuration stays OWNER/ADMIN', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const o = (await member.create({ title: 'Member closes' })).body.opportunity;
    expect((await member.win(o.id)).status).toBe(200);
    expect((await member.reopen(o.id)).status).toBe(200);
    expect((await member.lose(o.id)).status).toBe(200);
    expect((await member.archive(o.id)).status).toBe(200);
    expect((await member.restore(o.id)).status).toBe(200);
    expect((await member.createPipeline({ name: 'Not allowed' })).status).toBe(403);
  });
});
