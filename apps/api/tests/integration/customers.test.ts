/**
 * Customer Zone backend (PR 11): customers, contacts and activities through the real route handlers,
 * against PostgreSQL with the migrations and privileged SQL applied as in production. Two independent
 * businesses and every membership role (data-model §4.5–4.7, implementation plan Phase 1d).
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
import * as customerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/route';
import * as archiveCustomerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/archive/route';
import * as restoreCustomerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/restore/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as contactRoute from '@/app/api/v1/b/[slug]/contacts/[contactId]/route';
import * as archiveContactRoute from '@/app/api/v1/b/[slug]/contacts/[contactId]/archive/route';
import * as restoreContactRoute from '@/app/api/v1/b/[slug]/contacts/[contactId]/restore/route';
import * as activitiesRoute from '@/app/api/v1/b/[slug]/activities/route';
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
type Res = Response;

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `198.18.${Math.floor(ip / 250)}.${ip++ % 250}` });
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
    await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
    const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
    const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
    expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
    people[role] = user;
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string };
}

// ---- thin route callers --------------------------------------------------------------------------
const json = async (res: Res) => ({ status: res.status, body: await res.json() });
const api = (who: User, slug: string) => ({
  createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
  listCustomers: (qs = '') => customersRoute.GET(req('GET', `/api/v1/b/${slug}/customers${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
  getCustomer: (customerId: string) => customerRoute.GET(req('GET', `/api/v1/b/${slug}/customers/${customerId}`, { cookie: who.cookie }), ctx({ slug, customerId })).then(json),
  updateCustomer: (customerId: string, body: unknown) => customerRoute.PATCH(req('PATCH', `/api/v1/b/${slug}/customers/${customerId}`, { cookie: who.cookie, body }), ctx({ slug, customerId })).then(json),
  archiveCustomer: (customerId: string) => archiveCustomerRoute.POST(req('POST', `/api/v1/b/${slug}/customers/${customerId}/archive`, { cookie: who.cookie }), ctx({ slug, customerId })).then(json),
  restoreCustomer: (customerId: string) => restoreCustomerRoute.POST(req('POST', `/api/v1/b/${slug}/customers/${customerId}/restore`, { cookie: who.cookie }), ctx({ slug, customerId })).then(json),
  createContact: (body: unknown) => contactsRoute.POST(req('POST', `/api/v1/b/${slug}/contacts`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
  listContacts: (qs = '') => contactsRoute.GET(req('GET', `/api/v1/b/${slug}/contacts${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
  getContact: (contactId: string) => contactRoute.GET(req('GET', `/api/v1/b/${slug}/contacts/${contactId}`, { cookie: who.cookie }), ctx({ slug, contactId })).then(json),
  updateContact: (contactId: string, body: unknown) => contactRoute.PATCH(req('PATCH', `/api/v1/b/${slug}/contacts/${contactId}`, { cookie: who.cookie, body }), ctx({ slug, contactId })).then(json),
  archiveContact: (contactId: string) => archiveContactRoute.POST(req('POST', `/api/v1/b/${slug}/contacts/${contactId}/archive`, { cookie: who.cookie }), ctx({ slug, contactId })).then(json),
  restoreContact: (contactId: string) => restoreContactRoute.POST(req('POST', `/api/v1/b/${slug}/contacts/${contactId}/restore`, { cookie: who.cookie }), ctx({ slug, contactId })).then(json),
  createActivity: (body: unknown) => activitiesRoute.POST(req('POST', `/api/v1/b/${slug}/activities`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
  listActivities: (qs = '') => activitiesRoute.GET(req('GET', `/api/v1/b/${slug}/activities${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
});

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
beforeAll(async () => {
  A = await team('ca');
  B = await team('cb');
}, 120_000);

describe('customers: create, read, update, archive, restore', () => {
  it('creates a customer with international fields, attributes it, and writes an activity and an audit event in the same unit of work', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const { status, body } = await owner.createCustomer({
      kind: 'COMPANY', displayName: 'Kookaburra Pty Ltd', email: 'Accounts@Kookaburra.EXAMPLE', phone: '+61 8 9000 0000',
      taxNumber: '51 824 753 556', taxNumberType: 'au_abn', addressLine1: '1 Hay St', city: 'Perth', region: 'WA', postalCode: '6000', countryCode: 'AU',
    });
    expect(status).toBe(201);
    expect(body.customer).toMatchObject({ displayName: 'Kookaburra Pty Ltd', email: 'accounts@kookaburra.example', taxNumberType: 'au_abn', countryCode: 'AU', createdById: A.people.OWNER!.id, archivedAt: null });
    const id = body.customer.id;
    expect((await owner.getCustomer(id)).body.customer.id).toBe(id);
    const { rows } = await admin.query(
      `SELECT (SELECT count(*)::int FROM activities WHERE customer_id = $1 AND type = 'customer.created' AND actor_user_id = $2) AS activities,
              (SELECT count(*)::int FROM audit_events WHERE target_id = $1 AND action = 'customer.created' AND actor_user_id = $2) AS audits`, [id, A.people.OWNER!.id]);
    expect(rows[0]).toEqual({ activities: 1, audits: 1 });
  });

  it('updates fields, records which fields changed (not their values), and keeps updatedById', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const { body } = await member.createCustomer({ displayName: 'Wattle & Co' });
    const id = body.customer.id;
    const upd = await member.updateCustomer(id, { phone: '+61 400 000 000', notes: 'Prefers email' });
    expect(upd.status).toBe(200);
    expect(upd.body.customer).toMatchObject({ phone: '+61 400 000 000', notes: 'Prefers email', updatedById: A.people.MEMBER!.id });
    const { rows } = await admin.query("SELECT data FROM activities WHERE customer_id = $1 AND type = 'customer.updated'", [id]);
    expect(rows[0].data).toEqual({ fields: ['notes', 'phone'] });
    // clearing a field with an empty string
    expect((await member.updateCustomer(id, { notes: '' })).body.customer.notes).toBeNull();
  });

  it('archives (hidden by default, read-only) and restores', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const id = (await owner.createCustomer({ displayName: `Archivable ${randomUUID().slice(0, 6)}` })).body.customer.id;
    expect((await owner.archiveCustomer(id)).body.customer.archivedAt).not.toBeNull();
    expect((await owner.archiveCustomer(id)).status).toBe(409);
    expect((await owner.updateCustomer(id, { notes: 'x' })).status).toBe(409);
    const active = (await owner.listCustomers('?limit=100')).body.customers.map((c: { id: string }) => c.id);
    const archived = (await owner.listCustomers('?status=archived&limit=100')).body.customers.map((c: { id: string }) => c.id);
    expect(active).not.toContain(id);
    expect(archived).toContain(id);
    expect((await owner.restoreCustomer(id)).body.customer.archivedAt).toBeNull();
    expect((await owner.restoreCustomer(id)).status).toBe(409);
    const { rows } = await admin.query("SELECT type FROM activities WHERE customer_id = $1 ORDER BY created_at", [id]);
    expect(rows.map((r) => r.type)).toEqual(['customer.created', 'customer.archived', 'customer.restored']);
  });

  it('rejects invalid input and any client-supplied business id, author or timestamp', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    for (const body of [
      {}, { displayName: '' }, { displayName: 'x'.repeat(201) }, { displayName: 'X', countryCode: 'Australia' },
      { displayName: 'X', email: 'not-an-email' }, { displayName: 'X', kind: 'PARTNER' },
      { displayName: 'X', businessId: B.businessId }, { displayName: 'X', createdById: A.people.MEMBER!.id }, { displayName: 'X', archivedAt: null },
    ]) {
      expect((await owner.createCustomer(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await owner.listCustomers('?limit=1000')).status).toBe(400);
    expect((await owner.listCustomers('?cursor=!!')).status).toBe(400);
    expect((await owner.getCustomer('not-a-uuid')).status).toBe(404);
    expect((await owner.getCustomer(randomUUID())).status).toBe(404);
  });

  it('searches by name, email or phone (case-insensitive) and pages with a keyset cursor', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const tag = randomUUID().slice(0, 6);
    for (const n of ['Delta', 'alpha', 'Charlie', 'bravo', 'Echo']) await owner.createCustomer({ displayName: `${n} ${tag}`, email: `${n.toLowerCase()}-${tag}@example.com` });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { status: number; body: { customers: Array<{ displayName: string }>; nextCursor: string | null } } =
        await owner.listCustomers(`?q=${tag}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      expect(page.body.customers.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.customers.map((c) => c.displayName));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // name order follows the database collation (case-insensitive in en_US), across page boundaries
    expect(seen).toEqual(['alpha', 'bravo', 'Charlie', 'Delta', 'Echo'].map((n) => `${n} ${tag}`));
    expect((await owner.listCustomers(`?q=ALPHA-${tag}`)).body.customers).toHaveLength(1); // email, any case
    expect((await owner.listCustomers(`?q=%25`)).status).toBe(200); // a literal % is not a wildcard dump
  });
});

describe('permissions: every role through server-side checks', () => {
  it('OWNER, ADMIN, MANAGER and MEMBER can read and write customers, contacts and activity', async () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const who = api(A.people[role]!, A.slug);
      const c = await who.createCustomer({ displayName: `${role} customer` });
      expect(c.status, role).toBe(201);
      expect((await who.createContact({ firstName: role, customerId: c.body.customer.id })).status, role).toBe(201);
      expect((await who.createActivity({ type: 'note', customerId: c.body.customer.id, body: 'hello' })).status, role).toBe(201);
      expect((await who.archiveCustomer(c.body.customer.id)).status, role).toBe(200);
    }
  });

  it('no session is 401; a cookie request from another origin is 403; a removed member loses access immediately', async () => {
    const anon = await customersRoute.GET(req('GET', `/api/v1/b/${A.slug}/customers`), ctx({ slug: A.slug }));
    expect(anon.status).toBe(401);
    const csrf = await customersRoute.POST(req('POST', `/api/v1/b/${A.slug}/customers`, { cookie: A.people.MEMBER!.cookie, body: { displayName: 'x' }, origin: 'https://evil.example' }), ctx({ slug: A.slug }));
    expect(csrf.status).toBe(403);
    const temp = await team('cr');
    const member = api(temp.people.MEMBER!, temp.slug);
    expect((await member.listCustomers()).status).toBe(200);
    const members = await (await membersRoute.GET(req('GET', `/api/v1/b/${temp.slug}/members`, { cookie: temp.people.OWNER!.cookie }), ctx({ slug: temp.slug }))).json();
    const membershipId = members.members.find((m: { userId: string }) => m.userId === temp.people.MEMBER!.id).id;
    expect((await memberRoute.DELETE(req('DELETE', `/api/v1/b/${temp.slug}/members/${membershipId}`, { cookie: temp.people.OWNER!.cookie }), ctx({ slug: temp.slug, membershipId }))).status).toBe(200);
    expect((await member.listCustomers()).status).toBe(404);
  });

  it('removing a member who owns customers keeps the customers and clears the owner', async () => {
    const temp = await team('co');
    const owner = api(temp.people.OWNER!, temp.slug);
    const c = (await owner.createCustomer({ displayName: 'Owned', ownerUserId: temp.people.MANAGER!.id })).body.customer;
    expect(c.ownerUserId).toBe(temp.people.MANAGER!.id);
    const members = await (await membersRoute.GET(req('GET', `/api/v1/b/${temp.slug}/members`, { cookie: temp.people.OWNER!.cookie }), ctx({ slug: temp.slug }))).json();
    const membershipId = members.members.find((m: { userId: string }) => m.userId === temp.people.MANAGER!.id).id;
    expect((await memberRoute.DELETE(req('DELETE', `/api/v1/b/${temp.slug}/members/${membershipId}`, { cookie: temp.people.OWNER!.cookie }), ctx({ slug: temp.slug, membershipId }))).status).toBe(200);
    expect((await owner.getCustomer(c.id)).body.customer.ownerUserId).toBeNull();
  });
});

describe('contacts and the primary contact', () => {
  it('creates contacts with a computed name and lowercase email, standalone or linked', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Banksia Bakery' })).body.customer;
    const linked = await owner.createContact({ firstName: 'Ada', lastName: 'Lovelace', email: 'Ada@Example.COM', customerId: cust.id });
    expect(linked.status).toBe(201);
    expect(linked.body.contact).toMatchObject({ displayName: 'Ada Lovelace', email: 'ada@example.com', customerId: cust.id });
    const alone = await owner.createContact({ email: 'solo@example.com' });
    expect(alone.body.contact).toMatchObject({ displayName: 'solo@example.com', customerId: null });
    expect((await owner.createContact({ jobTitle: 'Nobody' })).status).toBe(400);
    expect((await owner.listContacts(`?customerId=${cust.id}`)).body.contacts.map((c: { id: string }) => c.id)).toEqual([linked.body.contact.id]);
  });

  it("the primary contact must be one of this customer's own contacts (service and database)", async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const c1 = (await owner.createCustomer({ displayName: 'Primary One' })).body.customer;
    const c2 = (await owner.createCustomer({ displayName: 'Primary Two' })).body.customer;
    const own = (await owner.createContact({ firstName: 'Own', customerId: c1.id })).body.contact;
    const other = (await owner.createContact({ firstName: 'Other', customerId: c2.id })).body.contact;
    expect((await owner.updateCustomer(c1.id, { primaryContactId: other.id })).status).toBe(400);
    expect((await owner.updateCustomer(c1.id, { primaryContactId: own.id })).body.customer.primaryContactId).toBe(own.id);
    // database layer: as bos_app inside the tenant context, pointing at another customer's contact fails at commit
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.OWNER!.id]);
    await app.query('UPDATE customers SET primary_contact_id = $1 WHERE id = $2', [other.id, c1.id]);
    await expect(app.query('COMMIT')).rejects.toThrow(/foreign key/);
  });

  it('moving a primary contact clears the primary, writes activities on both customers and keeps old history', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const from = (await owner.createCustomer({ displayName: 'Move From' })).body.customer;
    const to = (await owner.createCustomer({ displayName: 'Move To' })).body.customer;
    const contact = (await owner.createContact({ firstName: 'Mover', customerId: from.id })).body.contact;
    await owner.updateCustomer(from.id, { primaryContactId: contact.id });
    const call = await owner.createActivity({ type: 'call', contactId: contact.id, subject: 'Before the move', occurredAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(call.body.activity.customerId).toBe(from.id); // filed under the contact's customer at the time
    expect((await owner.updateContact(contact.id, { customerId: to.id })).body.contact.customerId).toBe(to.id);
    expect((await owner.getCustomer(from.id)).body.customer.primaryContactId).toBeNull();
    const fromTimeline = (await owner.listActivities(`?customerId=${from.id}`)).body.activities.map((a: { type: string; subject: string | null }) => a.subject ?? a.type);
    const toTimeline = (await owner.listActivities(`?customerId=${to.id}`)).body.activities.map((a: { type: string }) => a.type);
    expect(fromTimeline).toContain('Before the move'); // history is not rewritten
    expect(fromTimeline).toContain('contact.customer_changed');
    expect(fromTimeline).toContain('customer.primary_contact_changed');
    expect(toTimeline).toContain('contact.customer_changed');
    expect(toTimeline).not.toContain('call');
    // unlinking
    expect((await owner.updateContact(contact.id, { customerId: null })).body.contact.customerId).toBeNull();
    expect((await owner.listActivities(`?customerId=${to.id}`)).body.activities.map((a: { type: string }) => a.type)).toContain('contact.customer_removed');
  });

  it('archiving a primary contact clears the primary; archived contacts are read-only and restorable', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Archive Primary' })).body.customer;
    const contact = (await owner.createContact({ firstName: 'Prime', customerId: cust.id })).body.contact;
    await owner.updateCustomer(cust.id, { primaryContactId: contact.id });
    expect((await owner.archiveContact(contact.id)).status).toBe(200);
    expect((await owner.getCustomer(cust.id)).body.customer.primaryContactId).toBeNull();
    expect((await owner.updateContact(contact.id, { jobTitle: 'x' })).status).toBe(409);
    expect((await owner.updateCustomer(cust.id, { primaryContactId: contact.id })).status).toBe(409);
    expect((await owner.createActivity({ type: 'note', contactId: contact.id, body: 'x' })).status).toBe(409);
    expect((await owner.restoreContact(contact.id)).body.contact.archivedAt).toBeNull();
  });

  it('a contact cannot be linked to an archived customer', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Closed' })).body.customer;
    await owner.archiveCustomer(cust.id);
    expect((await owner.createContact({ firstName: 'Late', customerId: cust.id })).status).toBe(409);
  });
});

describe('activities', () => {
  it('logs notes, calls and meetings attributed to the person, newest first, including back-dated entries', async () => {
    const manager = api(A.people.MANAGER!, A.slug);
    const cust = (await manager.createCustomer({ displayName: 'Timeline Co' })).body.customer;
    const older = await manager.createActivity({ type: 'call', customerId: cust.id, subject: 'Older call', occurredAt: '2026-01-02T03:04:05+08:00' });
    const newer = await manager.createActivity({ type: 'meeting', customerId: cust.id, subject: 'Newer meeting' });
    expect(older.status).toBe(201);
    expect(older.body.activity).toMatchObject({ actorType: 'USER', actorUserId: A.people.MANAGER!.id, occurredAt: '2026-01-01T19:04:05.000Z' });
    const list = (await manager.listActivities(`?customerId=${cust.id}&limit=2`)).body;
    expect(list.activities[0].id).toBe(newer.body.activity.id);
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { activities: Array<{ subject: string | null; type: string }>; nextCursor: string | null } } =
        await manager.listActivities(`?customerId=${cust.id}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      all.push(...page.body.activities.map((a) => a.subject ?? a.type));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(all).toEqual(['Newer meeting', 'customer.created', 'Older call']);
  });

  it('rejects system types, a mismatched customer, unlinked or empty activities, and dates years ahead', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const c1 = (await owner.createCustomer({ displayName: 'Act One' })).body.customer;
    const c2 = (await owner.createCustomer({ displayName: 'Act Two' })).body.customer;
    const contact = (await owner.createContact({ firstName: 'Linked', customerId: c1.id })).body.contact;
    expect((await owner.createActivity({ type: 'customer.created', customerId: c1.id, body: 'x' })).status).toBe(400);
    expect((await owner.createActivity({ type: 'note', contactId: contact.id, customerId: c2.id, body: 'x' })).status).toBe(400);
    expect((await owner.createActivity({ type: 'note', body: 'x' })).status).toBe(400);
    expect((await owner.createActivity({ type: 'note', customerId: c1.id })).status).toBe(400);
    expect((await owner.createActivity({ type: 'note', customerId: c1.id, body: 'x', occurredAt: '2099-01-01T00:00:00Z' })).status).toBe(400);
    expect((await owner.createActivity({ type: 'note', customerId: c1.id, body: 'x', actorUserId: A.people.MEMBER!.id })).status).toBe(400);
    expect((await owner.listActivities(`?customerId=${c1.id}&contactId=${contact.id}`)).status).toBe(400);
  });
});

describe('tenant isolation between two businesses', () => {
  it("one business can never read, change or link to another business's customers, contacts or activity", async () => {
    const a = api(A.people.OWNER!, A.slug);
    const b = api(B.people.OWNER!, B.slug);
    const bCustomer = (await b.createCustomer({ displayName: `B secret ${randomUUID().slice(0, 6)}`, email: 'secret@b.example' })).body.customer;
    const bContact = (await b.createContact({ firstName: 'B', lastName: 'Contact', customerId: bCustomer.id })).body.contact;
    await b.createActivity({ type: 'note', customerId: bCustomer.id, body: 'B only' });

    // read
    expect((await a.getCustomer(bCustomer.id)).status).toBe(404);
    expect((await a.getContact(bContact.id)).status).toBe(404);
    expect((await a.listCustomers('?q=secret@b.example')).body.customers).toEqual([]);
    expect((await a.listContacts(`?customerId=${bCustomer.id}`)).body.contacts).toEqual([]);
    expect((await a.listActivities(`?customerId=${bCustomer.id}`)).body.activities).toEqual([]);
    // write
    expect((await a.updateCustomer(bCustomer.id, { notes: 'hijack' })).status).toBe(404);
    expect((await a.archiveCustomer(bCustomer.id)).status).toBe(404);
    expect((await a.updateContact(bContact.id, { jobTitle: 'hijack' })).status).toBe(404);
    // link across businesses
    const aCustomer = (await a.createCustomer({ displayName: 'A customer' })).body.customer;
    const aContact = (await a.createContact({ firstName: 'A' })).body.contact;
    expect((await a.createContact({ firstName: 'X', customerId: bCustomer.id })).status).toBe(404);
    expect((await a.updateContact(aContact.id, { customerId: bCustomer.id })).status).toBe(404);
    expect((await a.updateCustomer(aCustomer.id, { primaryContactId: bContact.id })).status).toBe(400);
    expect((await a.updateCustomer(aCustomer.id, { ownerUserId: B.people.OWNER!.id })).status).toBe(400);
    expect((await a.createActivity({ type: 'note', customerId: bCustomer.id, body: 'x' })).status).toBe(404);
    expect((await a.createActivity({ type: 'note', contactId: bContact.id, body: 'x' })).status).toBe(404);
    // nothing changed in B
    const { rows } = await admin.query('SELECT notes, archived_at FROM customers WHERE id = $1', [bCustomer.id]);
    expect(rows[0]).toEqual({ notes: null, archived_at: null });
  });

  it('raw SQL as bos_app: cross-business links fail on composite FKs, and rows for another business fail RLS', async () => {
    const b = api(B.people.OWNER!, B.slug);
    const bCustomer = (await b.createCustomer({ displayName: 'B raw' })).body.customer;
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
    // a contact in A pointing at B's customer: composite FK (business_id, customer_id)
    await expect(run("INSERT INTO contacts (id, business_id, customer_id, display_name) VALUES ($1, $2, $3, 'x')", [randomUUID(), A.businessId, bCustomer.id])).rejects.toThrow(/foreign key/);
    // an activity in A pointing at B's customer
    await expect(run("INSERT INTO activities (id, business_id, type, occurred_at, actor_type, actor_user_id, customer_id) VALUES ($1, $2, 'note', now(), 'USER', $3, $4)", [randomUUID(), A.businessId, A.people.OWNER!.id, bCustomer.id])).rejects.toThrow(/foreign key/);
    // a row claiming to belong to B: RLS
    await expect(run("INSERT INTO customers (id, business_id, display_name) VALUES ($1, $2, 'x')", [randomUUID(), B.businessId])).rejects.toThrow(/row-level security/);
    // no hard delete for tenant code
    await expect(run('DELETE FROM customers WHERE id = $1', [bCustomer.id])).rejects.toThrow(/permission denied/);
    // and outside a tenant context bos_app sees nothing at all
    for (const table of ['customers', 'contacts', 'activities']) {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('every Customer Zone table forces row-level security', async () => {
    const { rows } = await admin.query("SELECT relname FROM pg_class WHERE relname IN ('customers','contacts','activities') AND relrowsecurity AND relforcerowsecurity");
    expect(rows).toHaveLength(3);
  });
});
