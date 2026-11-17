import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Administration A-AUD-1: the audit viewer API (docs/administration-audit-viewer.md §4, §5, §11). Runs the real
 * route handler against PostgreSQL with migrations and prisma/privileged applied as in production. Events are
 * seeded as the superuser (so created_at, actors and metadata are exact) and read through the route as real users.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListAuditEventsResponse } from '@business-os/contracts';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as auditRoute from '@/app/api/v1/b/[slug]/audit-events/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
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

let ip = 1;
type User = { email: string; cookie: string; id: string };

function request(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `198.51.100.${ip++ % 250}` });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix = 'user'): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  await authRoute.POST(request('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(request('GET', `${link.pathname}${link.search}`, { origin: null }));
  const res = await authRoute.POST(request('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

/** A business with an OWNER and one member of each other role. */
async function team() {
  const owner = await newUser('owner');
  const slug = `biz-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(request('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: 'Acme Plumbing', slug, countryCode: 'US', timeZone: 'America/Chicago', locale: 'en-US', currency: 'USD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(role.toLowerCase());
    await invitationsRoute.POST(request('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
    const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
    const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
    expect((await acceptRoute.POST(request('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
    people[role] = user;
  }
  const [{ id }] = (await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug])).rows;
  return { slug, id: id as string, people };
}

const list = (by: User | null, slug: string, params: Record<string, string> = {}) =>
  auditRoute.GET(request('GET', `/api/v1/b/${slug}/audit-events?${new URLSearchParams(params)}`, { cookie: by?.cookie }), ctx({ slug }));
async function events(by: User, slug: string, params: Record<string, string> = {}) {
  const res = await list(by, slug, params);
  expect(res.status).toBe(200);
  return ListAuditEventsResponse.parse(await res.json());
}

type Seed = { action: string; actor?: string | null; targetType?: string | null; targetId?: string | null; metadata?: unknown; at?: string; id?: string; ipAddress?: string; userAgent?: string };
async function seed(businessId: string, row: Seed) {
  const id = row.id ?? randomUUID();
  await admin.query(
    `INSERT INTO audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))`,
    [id, businessId, row.actor ?? null, row.action, row.targetType ?? null, row.targetId ?? null, JSON.stringify(row.metadata ?? {}), row.ipAddress ?? null, row.userAgent ?? null, row.at ?? null],
  );
  return id;
}
const daysAgo = (n: number, extraMs = 0) => new Date(Date.now() - n * 86_400_000 + extraMs).toISOString();

describe('audit viewer: access', () => {
  it('OWNER and ADMIN read; MANAGER and MEMBER get 403; a stranger gets 404; no session gets 401', async () => {
    const t = await team();
    for (const role of ['OWNER', 'ADMIN']) expect((await list(t.people[role]!, t.slug)).status).toBe(200);
    for (const role of ['MANAGER', 'MEMBER']) expect((await list(t.people[role]!, t.slug)).status).toBe(403);
    expect((await list(await newUser('stranger'), t.slug)).status).toBe(404);
    expect((await list(null, t.slug)).status).toBe(401);
  });

  it('never shows another business\'s events, with or without filters', async () => {
    const a = await team();
    const b = await team();
    const secret = await seed(b.id, { action: 'customer.created', actor: b.people.OWNER!.id, targetType: 'customer', targetId: randomUUID() });
    for (const params of [{}, { actionPrefix: 'customer' }, { actorUserId: b.people.OWNER!.id }, { actorKind: 'system' }] as Record<string, string>[]) {
      expect((await events(a.people.OWNER!, a.slug, params)).events.map((e) => e.id)).not.toContain(secret);
    }
    expect((await events(b.people.OWNER!, b.slug, { actionPrefix: 'customer' })).events.map((e) => e.id)).toContain(secret);
    expect((await list(b.people.OWNER!, a.slug)).status).toBe(404);
  });

  it('is read-only for the application role: no UPDATE or DELETE on audit_events', async () => {
    await expect(app.query('DELETE FROM audit_events')).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/permission denied/);
  });
});

describe('audit viewer: what is shown (default-deny)', () => {
  it('lists real recorded events with the actor\'s name, a label and only allow-listed metadata', async () => {
    const t = await team();
    const res = await invitationsRoute.POST(request('POST', `/api/v1/b/${t.slug}/invitations`, { cookie: t.people.OWNER!.cookie, body: { email: `later-${randomUUID()}@example.com`, role: 'MEMBER' } }), ctx({ slug: t.slug }));
    expect(res.status).toBe(201);
    const page = await events(t.people.ADMIN!, t.slug);
    const created = page.events.find((e) => e.action === 'invitation.created')!;
    expect(created).toMatchObject({ label: 'Invitation created', group: 'team', actor: { kind: 'member', userId: t.people.OWNER!.id, name: 'owner' }, metadata: { role: 'MEMBER' } });
    expect(created.target).toEqual({ type: 'invitation' });
    expect(page.events.some((e) => e.action === 'business.created')).toBe(true);
  });

  it('drops metadata keys that are not allowed, and never returns ip address, user agent, emails or tokens', async () => {
    const t = await team();
    await seed(t.id, {
      action: 'customer.updated', actor: t.people.OWNER!.id, targetType: 'customer', targetId: randomUUID(),
      metadata: { fields: ['legalName', 'phone'], email: 'leak@example.com', token: 'tok-secret-123', customerId: randomUUID(), nested: { a: 1 }, long: 'x'.repeat(500) },
      ipAddress: '203.0.113.77', userAgent: 'UA-SECRET',
    });
    const payload = await (await list(t.people.OWNER!, t.slug, { actionPrefix: 'customer' })).text();
    for (const leaked of ['leak@example.com', 'tok-secret-123', '203.0.113.77', 'UA-SECRET', 'nested', 'customerId']) expect(payload).not.toContain(leaked);
    const [event] = ListAuditEventsResponse.parse(JSON.parse(payload)).events;
    expect(event!.metadata).toEqual({ fields: ['legalName', 'phone'] });
  });

  it('shows an unknown action with no metadata and only the fixed target type, never an unclassified type or id', async () => {
    const t = await team();
    const target = randomUUID();
    await seed(t.id, { action: 'brand_new.thing_happened', actor: t.people.OWNER!.id, targetType: 'secret_vault_item', targetId: target, metadata: { fields: ['x'], reason: 'free text' } });
    const payload = await (await list(t.people.OWNER!, t.slug, { actionPrefix: 'brand_new' })).text();
    expect(payload).not.toContain('secret_vault_item');
    expect(payload).not.toContain(target);
    const [event] = ListAuditEventsResponse.parse(JSON.parse(payload)).events;
    expect(event).toMatchObject({ action: 'brand_new.thing_happened', label: 'Recorded change', group: 'other', metadata: {}, target: { type: 'record' } });
  });

  it('suppresses target ids for type-only families and hides erasure and mailbox-history targets entirely', async () => {
    const t = await team();
    const employee = randomUUID();
    const erasure = randomUUID();
    const conversation = randomUUID();
    await seed(t.id, { action: 'people.employee.updated', actor: t.people.OWNER!.id, targetType: 'people_employee', targetId: employee, metadata: { fields: ['jobTitle'] } });
    await seed(t.id, { action: 'communications.erasure.requested', actor: t.people.OWNER!.id, targetType: 'erasure', targetId: erasure, metadata: { scope: 'CONTACT', targetType: 'contact', messages: 3 } });
    await seed(t.id, { action: 'conversation.created', actor: t.people.OWNER!.id, targetType: 'conversation', targetId: conversation, metadata: { channel: 'EMAIL', customerId: randomUUID() } });
    const text = await (await list(t.people.OWNER!, t.slug)).text();
    for (const id of [employee, erasure, conversation]) expect(text).not.toContain(id);
    const byAction = Object.fromEntries(ListAuditEventsResponse.parse(JSON.parse(text)).events.map((e) => [e.action, e]));
    expect(byAction['people.employee.updated']).toMatchObject({ target: { type: 'people_employee' }, metadata: { fields: ['jobTitle'] } });
    expect(byAction['communications.erasure.requested']).toMatchObject({ target: null, metadata: { scope: 'CONTACT', messages: 3 } });
    expect(byAction['communications.erasure.requested']!.metadata).not.toHaveProperty('targetType');
    expect(byAction['conversation.created']).toMatchObject({ target: null, metadata: { channel: 'EMAIL' } });
  });

  it('shows who a membership event is about by name, and never the removed member\'s user id', async () => {
    const t = await team();
    const { rows: [m] } = await admin.query('SELECT id FROM memberships WHERE business_id = $1 AND user_id = $2', [t.id, t.people.MANAGER!.id]);
    await seed(t.id, { action: 'membership.suspended', actor: t.people.OWNER!.id, targetType: 'membership', targetId: m.id, metadata: { role: 'MANAGER' } });
    await seed(t.id, { action: 'membership.removed', actor: t.people.OWNER!.id, targetType: 'membership', targetId: randomUUID(), metadata: { role: 'MEMBER', userId: 'user-id-should-not-leak', mailboxesStopped: 2 } });
    const text = await (await list(t.people.OWNER!, t.slug, { actionPrefix: 'membership' })).text();
    expect(text).not.toContain('user-id-should-not-leak');
    const byAction = Object.fromEntries(ListAuditEventsResponse.parse(JSON.parse(text)).events.map((e) => [e.action, e]));
    expect(byAction['membership.suspended']).toMatchObject({ label: 'Member suspended', target: { type: 'membership', id: m.id, name: 'manager' }, metadata: { role: 'MANAGER' } });
    expect(byAction['membership.removed']).toMatchObject({ metadata: { role: 'MEMBER', mailboxesStopped: 2 } });
    expect(byAction['membership.removed']!.target).not.toHaveProperty('name');
  });
});

describe('audit viewer: actors', () => {
  it('names current members, calls a departed actor a former member without any id, and shows system events as System', async () => {
    const t = await team();
    const departed = randomUUID();
    await admin.query("INSERT INTO users (id, email, email_verified, name, updated_at) VALUES ($1, $2, true, 'Departed Dee', now())", [departed, `${departed}@example.com`]);
    await seed(t.id, { action: 'customer.created', actor: departed, targetType: 'customer', targetId: randomUUID() });
    await seed(t.id, { action: 'finance.system.recurring.generated', actor: null, targetType: 'finance_recurring_template', targetId: randomUUID(), metadata: { periodIndex: 3 } });
    const text = await (await list(t.people.OWNER!, t.slug)).text();
    expect(text).not.toContain(departed);
    expect(text).not.toContain('Departed Dee');
    expect(text).not.toContain(`${departed}@example.com`);
    const { events: all } = ListAuditEventsResponse.parse(JSON.parse(text));
    expect(all.find((e) => e.action === 'customer.created')!.actor).toEqual({ kind: 'former_member' });
    expect(all.find((e) => e.action === 'finance.system.recurring.generated')).toMatchObject({ actor: { kind: 'system' }, metadata: { periodIndex: 3 } });
  });

  it('filters by a current member, and answers a departed or unknown person with the same empty page', async () => {
    const t = await team();
    const departed = randomUUID();
    await admin.query("INSERT INTO users (id, email, email_verified, name, updated_at) VALUES ($1, $2, true, 'Departed Dee', now())", [departed, `${departed}@example.com`]);
    await seed(t.id, { action: 'customer.created', actor: departed });
    await seed(t.id, { action: 'customer.updated', actor: t.people.ADMIN!.id });
    const mine = await events(t.people.OWNER!, t.slug, { actorUserId: t.people.ADMIN!.id, actionPrefix: 'customer' });
    expect(mine.events.map((e) => e.action)).toEqual(['customer.updated']);
    const gone = await (await list(t.people.OWNER!, t.slug, { actorUserId: departed })).json();
    const unknown = await (await list(t.people.OWNER!, t.slug, { actorUserId: randomUUID() })).json();
    expect(gone.events).toEqual([]);
    expect(gone.nextCursor).toBeNull();
    expect(Object.keys(gone).sort()).toEqual(Object.keys(unknown).sort());
    expect(unknown.events).toEqual([]);
  });

  it('actorKind=system returns only events without an actor, never a former member, and cannot combine with actorUserId', async () => {
    const t = await team();
    await seed(t.id, { action: 'finance.system.reminder.queued', actor: null });
    await seed(t.id, { action: 'customer.created', actor: t.people.OWNER!.id });
    const departed = randomUUID();
    await admin.query("INSERT INTO users (id, email, email_verified, name, updated_at) VALUES ($1, $2, true, 'Gone', now())", [departed, `${departed}@example.com`]);
    await seed(t.id, { action: 'customer.archived', actor: departed });
    const page = await events(t.people.OWNER!, t.slug, { actorKind: 'system' });
    expect(page.events.map((e) => e.action)).toEqual(['finance.system.reminder.queued']);
    expect(page.events.every((e) => e.actor.kind === 'system')).toBe(true);
    expect((await list(t.people.OWNER!, t.slug, { actorKind: 'system', actorUserId: t.people.OWNER!.id })).status).toBe(400);
    expect((await list(t.people.OWNER!, t.slug, { actorKind: 'member' })).status).toBe(400);
  });
});

describe('audit viewer: filters, windows and paging', () => {
  it('refuses target filters and unknown parameters so a record id cannot be probed', async () => {
    const t = await team();
    const target = randomUUID();
    await seed(t.id, { action: 'people.employee.updated', actor: t.people.OWNER!.id, targetType: 'people_employee', targetId: target });
    for (const params of [{ targetId: target }, { targetId: randomUUID() }, { targetType: 'people_employee' }, { targetType: 'nothing' }, { business: t.id }] as Record<string, string>[]) {
      const res = await list(t.people.OWNER!, t.slug, params);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_query' });
    }
  });

  it('matches an action prefix on a dotted boundary, with wildcards and underscores taken literally', async () => {
    const t = await team();
    for (const action of ['sales.opportunity.won', 'sales', 'salesforce.import', 'a_b.c', 'aXb.c', 'a.b']) await seed(t.id, { action, actor: t.people.OWNER!.id });
    const actions = async (prefix: string) => (await events(t.people.OWNER!, t.slug, { actionPrefix: prefix })).events.map((e) => e.action).sort();
    expect(await actions('sales')).toEqual(['sales', 'sales.opportunity.won']);
    expect(await actions('sales.opportunity')).toEqual(['sales.opportunity.won']);
    expect(await actions('a_b')).toEqual(['a_b.c']);
    for (const bad of ['%', 'sales%', "sales'; drop table audit_events;--", 'Sales', 'sales..x', '.sales', 'sales.', 'a b']) {
      expect((await list(t.people.OWNER!, t.slug, { actionPrefix: bad })).status, bad).toBe(400);
    }
  });

  it('covers at most 92 days: the default window, one-sided bounds, and refusals', async () => {
    const t = await team();
    await seed(t.id, { action: 'customer.created', actor: t.people.OWNER!.id, at: daysAgo(10) });
    const old = await seed(t.id, { action: 'customer.updated', actor: t.people.OWNER!.id, at: daysAgo(100) });
    const older = await seed(t.id, { action: 'customer.archived', actor: t.people.OWNER!.id, at: daysAgo(200) });
    const owner = t.people.OWNER!;

    const base = await events(owner, t.slug);
    expect(Date.parse(base.window.to) - Date.parse(base.window.from)).toBe(92 * 86_400_000);
    expect(base.events.map((e) => e.id)).not.toContain(old);

    // Only `to`: the 92 days before it. Moving the window back reaches older events, slice by slice.
    const back = await events(owner, t.slug, { to: daysAgo(92) });
    expect(Date.parse(back.window.to) - Date.parse(back.window.from)).toBe(92 * 86_400_000);
    expect(back.events.map((e) => e.id)).toContain(old);
    expect(back.events.map((e) => e.id)).not.toContain(older);
    const further = await events(owner, t.slug, { to: daysAgo(184) });
    expect(further.events.map((e) => e.id)).toContain(older);

    // Only `from`: up to 92 days after it, never past now.
    const fromOld = await events(owner, t.slug, { from: daysAgo(101) });
    expect(Date.parse(fromOld.window.to) - Date.parse(fromOld.window.from)).toBe(92 * 86_400_000);
    expect(fromOld.events.map((e) => e.id)).toContain(old);
    const fromRecent = await events(owner, t.slug, { from: daysAgo(5) });
    expect(Date.parse(fromRecent.window.to)).toBeLessThanOrEqual(Date.now() + 1000);

    // Refusals: too wide, reversed, from in the future.
    expect((await list(owner, t.slug, { from: daysAgo(200), to: daysAgo(0) })).status).toBe(400);
    expect((await list(owner, t.slug, { from: daysAgo(1), to: daysAgo(5) })).status).toBe(400);
    const future = await list(owner, t.slug, { from: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    expect(future.status).toBe(400);
    expect(await future.json()).toMatchObject({ error: 'invalid_window' });
  });

  it('pages without gaps or duplicates, including events with the same timestamp, and ends with a null cursor', async () => {
    const t = await team();
    const same = new Date(Date.now() - 3_600_000).toISOString();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seed(t.id, { action: 'customer.created', actor: t.people.OWNER!.id, at: same }));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let first: string | undefined;
    do {
      const page = await events(t.people.OWNER!, t.slug, { actionPrefix: 'customer', limit: '2', ...(cursor ? { cursor } : {}) });
      first ??= page.window.from;
      expect(page.window.from).toBe(first);
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
    // Same timestamp: newest id first (created_at DESC, id DESC).
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it('refuses a tampered, truncated or foreign cursor, and a cursor reused with other filters or another window', async () => {
    const t = await team();
    for (let i = 0; i < 3; i++) await seed(t.id, { action: 'customer.created', actor: t.people.OWNER!.id, at: daysAgo(1, i) });
    const owner = t.people.OWNER!;
    const page = await events(owner, t.slug, { actionPrefix: 'customer', limit: '1' });
    const cursor = page.nextCursor!;
    expect((await list(owner, t.slug, { actionPrefix: 'customer', limit: '1', cursor })).status).toBe(200);
    for (const bad of ['!!!', cursor.slice(0, -4), Buffer.from('{"k":"customers"}').toString('base64url'), Buffer.from('not json').toString('base64url')]) {
      const res = await list(owner, t.slug, { cursor: bad });
      expect(res.status, bad).toBe(400);
    }
    // Other filters, or another window, than the cursor was issued for.
    expect((await list(owner, t.slug, { actionPrefix: 'sales', cursor })).status).toBe(400);
    expect((await list(owner, t.slug, { actionPrefix: 'customer', actorKind: 'system', cursor })).status).toBe(400);
    expect((await list(owner, t.slug, { actionPrefix: 'customer', cursor, to: daysAgo(30) })).status).toBe(400);
    const same = await list(owner, t.slug, { actionPrefix: 'customer', cursor, from: page.window.from, to: page.window.to });
    expect(same.status).toBe(200);
  });

  it('answers in the shape of the contract with 50 rows by default and caps the limit at 100', async () => {
    const t = await team();
    expect((await list(t.people.OWNER!, t.slug, { limit: '0' })).status).toBe(400);
    expect((await list(t.people.OWNER!, t.slug, { limit: '101' })).status).toBe(400);
    const page = await events(t.people.OWNER!, t.slug, { limit: '100' });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.nextCursor).toBeNull();
  });
});
