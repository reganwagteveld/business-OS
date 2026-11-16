import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Communications C1 (docs/communications-c1.md): the unified activity timeline (restricted notes,
 * logged interactions, note edits and removal) and the read-only history of conversations and
 * messages, through the real route handlers against PostgreSQL with the migrations and privileged SQL
 * applied as in production. Two independent businesses and every membership role.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as archiveCustomerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/archive/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as contactRoute from '@/app/api/v1/b/[slug]/contacts/[contactId]/route';
import * as archiveContactRoute from '@/app/api/v1/b/[slug]/contacts/[contactId]/archive/route';
import * as activitiesRoute from '@/app/api/v1/b/[slug]/activities/route';
import * as activityRoute from '@/app/api/v1/b/[slug]/activities/[activityId]/route';
import * as removeActivityRoute from '@/app/api/v1/b/[slug]/activities/[activityId]/remove/route';
import * as conversationsRoute from '@/app/api/v1/b/[slug]/conversations/route';
import * as conversationRoute from '@/app/api/v1/b/[slug]/conversations/[conversationId]/route';
import * as messagesRoute from '@/app/api/v1/b/[slug]/conversations/[conversationId]/messages/route';
import * as importRoute from '@/app/api/v1/b/[slug]/conversations/[conversationId]/messages/import/route';
import { withTenant } from '@/core/db';
import { backendPid, waitUntilBlocked } from './support/locks';
import { devOutbox } from '@/core/email';
import { listActivities } from '@/modules/activity';
import { checkActivityData } from '@/modules/activity/server/activities';
import {
  ActivityResponse, ConversationResponse, ImportMessagesResponse, ListActivitiesResponse, ListConversationsResponse, ListMessagesResponse, MessageResponse,
} from '@business-os/contracts';

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

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.96.${Math.floor(ip / 250)}.${ip++ % 250}`, origin: ORIGIN });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
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
  const verify = new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.96.200.${ip++ % 250}` } });
  await authRoute.GET(verify);
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
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
  const r = (method: string, path: string, body?: unknown) => req(method, `/api/v1/b/${slug}${path}`, { cookie: who.cookie, body });
  return {
    createCustomer: (body: unknown) => customersRoute.POST(r('POST', '/customers', body), ctx({ slug })).then(json),
    archiveCustomer: (customerId: string) => archiveCustomerRoute.POST(r('POST', `/customers/${customerId}/archive`), ctx({ slug, customerId })).then(json),
    createContact: (body: unknown) => contactsRoute.POST(r('POST', '/contacts', body), ctx({ slug })).then(json),
    updateContact: (contactId: string, body: unknown) => contactRoute.PATCH(r('PATCH', `/contacts/${contactId}`, body), ctx({ slug, contactId })).then(json),
    archiveContact: (contactId: string) => archiveContactRoute.POST(r('POST', `/contacts/${contactId}/archive`), ctx({ slug, contactId })).then(json),
    createActivity: (body: unknown) => activitiesRoute.POST(r('POST', '/activities', body), ctx({ slug })).then(json),
    listActivities: (qs = '') => activitiesRoute.GET(r('GET', `/activities${qs}`), ctx({ slug })).then(json),
    getActivity: (activityId: string) => activityRoute.GET(r('GET', `/activities/${activityId}`), ctx({ slug, activityId })).then(json),
    updateNote: (activityId: string, body: unknown) => activityRoute.PATCH(r('PATCH', `/activities/${activityId}`, body), ctx({ slug, activityId })).then(json),
    removeActivity: (activityId: string) => removeActivityRoute.POST(r('POST', `/activities/${activityId}/remove`), ctx({ slug, activityId })).then(json),
    createConversation: (body: unknown) => conversationsRoute.POST(r('POST', '/conversations', body), ctx({ slug })).then(json),
    listConversations: (qs = '') => conversationsRoute.GET(r('GET', `/conversations${qs}`), ctx({ slug })).then(json),
    getConversation: (conversationId: string) => conversationRoute.GET(r('GET', `/conversations/${conversationId}`), ctx({ slug, conversationId })).then(json),
    recordMessage: (conversationId: string, body: unknown) =>
      messagesRoute.POST(r('POST', `/conversations/${conversationId}/messages`, body), ctx({ slug, conversationId })).then(json),
    listMessages: (conversationId: string, qs = '') =>
      messagesRoute.GET(r('GET', `/conversations/${conversationId}/messages${qs}`), ctx({ slug, conversationId })).then(json),
    importMessages: (conversationId: string, body: unknown) =>
      importRoute.POST(r('POST', `/conversations/${conversationId}/messages/import`, body), ctx({ slug, conversationId })).then(json),
  };
};

/** Runs SQL as bos_app inside a tenant transaction for business `businessId`, acting as `userId`. */
async function asApp(businessId: string, userId: string, sql: string, params: unknown[]) {
  await app.query('BEGIN');
  try {
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [businessId, userId]);
    const result = await app.query(sql, params);
    await app.query('COMMIT');
    return result;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

const email = (overrides: Record<string, unknown> = {}) => ({
  direction: 'INBOUND', occurredAt: '2026-10-01T09:00:00Z', subject: 'Quote request', body: 'Could you send a quote?',
  participants: [{ role: 'FROM', displayName: 'Pat Client', address: 'pat@client.example' }, { role: 'TO', address: 'sales@us.example' }],
  ...overrides,
});
const count = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].n as number;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
beforeAll(async () => {
  A = await team('ma');
  B = await team('mb');
}, 120_000);

describe('restricted notes', () => {
  it('a restricted note is visible to its author, OWNER and ADMIN only; to anyone else it does not exist', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Secretive Pty' })).body.customer;
    const open = await member.createActivity({ type: 'note', customerId: cust.id, body: 'Everyone may read this' });
    const secret = await member.createActivity({ type: 'note', customerId: cust.id, body: 'Payment dispute details', visibility: 'RESTRICTED' });
    expect(secret.status).toBe(201);
    expect(ActivityResponse.parse(secret.body).activity).toMatchObject({ visibility: 'RESTRICTED', actorUserId: A.people.MEMBER!.id });
    const ids = async (role: string, qs = '') =>
      ListActivitiesResponse.parse((await api(A.people[role]!, A.slug).listActivities(`?customerId=${cust.id}${qs}`)).body).activities
        .filter((a) => a.type === 'note').map((a) => a.id);
    for (const role of ['MEMBER', 'OWNER', 'ADMIN']) expect((await ids(role)).sort(), role).toEqual([open.body.activity.id, secret.body.activity.id].sort());
    expect(await ids('MANAGER')).toEqual([open.body.activity.id]);
    expect((await api(A.people.MANAGER!, A.slug).getActivity(secret.body.activity.id)).status).toBe(404);
    expect((await api(A.people.ADMIN!, A.slug).getActivity(secret.body.activity.id)).status).toBe(200);
    // visibility filter
    expect(await ids('OWNER', '&visibility=restricted')).toEqual([secret.body.activity.id]);
    expect(await ids('OWNER', '&visibility=standard')).toEqual([open.body.activity.id]);
    expect(await ids('MANAGER', '&visibility=restricted')).toEqual([]);
    // the audit event records that it was restricted, never its text
    const { rows } = await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'activity.created'", [secret.body.activity.id]);
    expect(rows[0].metadata).toMatchObject({ visibility: 'RESTRICTED' });
    expect(JSON.stringify(rows[0].metadata)).not.toContain('dispute');
  });

  it('restricted entries leak through no read path: lists, filters, paging, direct reads, edits, removal or errors (audit C1-02)', async () => {
    const author = api(A.people.MEMBER!, A.slug);
    const manager = api(A.people.MANAGER!, A.slug);
    const admin_ = api(A.people.ADMIN!, A.slug);
    const cust = (await author.createCustomer({ displayName: 'Leak Check Ltd' })).body.customer;
    const pat = (await author.createContact({ firstName: 'Leak', customerId: cust.id })).body.contact;
    // Three restricted notes newest, two standard notes oldest, so pages end on hidden rows.
    const standard = [];
    for (const h of ['01', '02']) standard.push((await author.createActivity({ type: 'note', contactId: pat.id, body: `open ${h}`, occurredAt: `2026-09-${h}T00:00:00Z` })).body.activity.id);
    const hidden = [];
    for (const h of ['03', '04', '05']) hidden.push((await author.createActivity({ type: 'note', contactId: pat.id, body: `secret ${h}`, visibility: 'RESTRICTED', occurredAt: `2026-09-${h}T00:00:00Z` })).body.activity.id);
    const all = async (who: ReturnType<typeof api>, qs: string) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await who.listActivities(`${qs}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        ids.push(...res.body.activities.map((a: { id: string }) => a.id));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);
      return { ids, pages };
    };
    const filters = [`?customerId=${cust.id}&types=note`, `?contactId=${pat.id}&types=note`, '?types=note', `?customerId=${cust.id}&types=note&visibility=all`];
    for (const qs of filters) {
      const seen = await all(manager, qs);
      for (const id of hidden) expect(seen.ids, qs).not.toContain(id);
      if (qs.includes(cust.id) || qs.includes(pat.id)) {
        // exactly the standard notes, and no extra (empty) page that would hint at hidden rows
        expect(seen.ids, qs).toEqual([...standard].reverse());
        expect(seen.pages, qs).toBe(2);
      }
    }
    expect((await manager.listActivities(`?customerId=${cust.id}&visibility=restricted`)).body).toEqual({ activities: [], nextCursor: null });
    // a cursor pointing at a hidden row reveals nothing more than its position
    const authorPage = (await author.listActivities(`?customerId=${cust.id}&types=note&limit=1`)).body;
    expect(authorPage.activities[0].id).toBe(hidden[2]);
    const viaHiddenCursor = (await manager.listActivities(`?customerId=${cust.id}&types=note&limit=10&cursor=${authorPage.nextCursor}`)).body;
    expect(viaHiddenCursor.activities.map((a: { id: string }) => a.id)).toEqual([...standard].reverse());
    // direct read, edit and removal of a hidden note answer exactly like a note that does not exist
    const missing = randomUUID();
    for (const id of hidden) {
      expect(await manager.getActivity(id)).toEqual(await manager.getActivity(missing));
      expect(await manager.updateNote(id, { body: 'x' })).toEqual(await manager.updateNote(missing, { body: 'x' }));
      expect(await manager.removeActivity(id)).toEqual(await manager.removeActivity(missing));
    }
    expect(await manager.getActivity(missing)).toEqual({ status: 404, body: { error: 'not_found' } });
    // ADMIN may read it (read_restricted) but, not being the author, may not change it
    expect((await admin_.getActivity(hidden[0]!)).status).toBe(200);
    expect((await admin_.updateNote(hidden[0]!, { body: 'x' })).status).toBe(403);
    // the hidden notes are untouched, and nothing about them reached the audit log as content
    for (const id of hidden) expect((await author.getActivity(id)).body.activity.body).toMatch(/^secret/);
    const audits = await admin.query("SELECT metadata FROM audit_events WHERE target_id = ANY($1::uuid[])", [hidden]);
    expect(JSON.stringify(audits.rows)).not.toContain('secret');
  });

  it('only notes can be restricted (contract and database)', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Only Notes Ltd' })).body.customer;
    expect((await owner.createActivity({ type: 'call', customerId: cust.id, body: 'x', visibility: 'RESTRICTED' })).status).toBe(400);
    await expect(asApp(A.businessId, A.people.OWNER!.id,
      "INSERT INTO activities (id, business_id, type, occurred_at, actor_type, actor_user_id, customer_id, visibility) VALUES ($1, $2, 'customer.updated', now(), 'USER', $3, $4, 'RESTRICTED')",
      [randomUUID(), A.businessId, A.people.OWNER!.id, cust.id])).rejects.toThrow(/activities_restricted_notes_only/);
  });
});

describe('logging interactions', () => {
  it('logs calls, emails and other interactions with a direction and channel, and filters the timeline by type', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Chatty Co' })).body.customer;
    const call = await member.createActivity({ type: 'call', customerId: cust.id, subject: 'Follow-up', direction: 'OUTBOUND' });
    const sms = await member.createActivity({ type: 'interaction', channel: 'SMS', direction: 'INBOUND', customerId: cust.id, body: 'Running late' });
    const meeting = await member.createActivity({ type: 'meeting', customerId: cust.id, subject: 'Site visit' });
    expect([call.status, sms.status, meeting.status]).toEqual([201, 201, 201]);
    expect(call.body.activity.data).toEqual({ direction: 'OUTBOUND' });
    expect(sms.body.activity.data).toEqual({ channel: 'SMS', direction: 'INBOUND' });
    const types = async (qs: string) => (await member.listActivities(`?customerId=${cust.id}${qs}`)).body.activities.map((a: { type: string }) => a.type);
    expect((await types('&types=call,interaction')).sort()).toEqual(['call', 'interaction']);
    expect(await types('&types=customer.created')).toEqual(['customer.created']);
    expect((await member.listActivities(`?customerId=${cust.id}&types=customer.hacked`)).body).toMatchObject({ error: 'invalid_type' });
    expect((await member.listActivities(`?types=${'note,'.repeat(25)}`)).status).toBe(400);
  });

  it('rejects forged provenance: system or message types, authorship, a channel or direction that does not fit', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Forgery Watch' })).body.customer;
    const bad = [
      { type: 'customer.created', customerId: cust.id, body: 'x' },
      { type: 'message.recorded', customerId: cust.id, body: 'x' },
      { type: 'note', customerId: cust.id, body: 'x', actorType: 'SYSTEM' },
      { type: 'note', customerId: cust.id, body: 'x', actorUserId: A.people.MEMBER!.id },
      { type: 'note', customerId: cust.id, body: 'x', messageId: randomUUID() },
      { type: 'note', customerId: cust.id, body: 'x', direction: 'INBOUND' },
      { type: 'interaction', customerId: cust.id, body: 'x' },
      { type: 'call', customerId: cust.id, body: 'x', channel: 'SMS' },
      { type: 'email', customerId: cust.id, body: 'x', sentByBusinessOs: true },
    ];
    for (const body of bad) expect((await owner.createActivity(body)).status, JSON.stringify(body)).toBe(400);
    // the database refuses a message entry without its message, and any other type carrying one
    await expect(asApp(A.businessId, A.people.OWNER!.id,
      "INSERT INTO activities (id, business_id, type, occurred_at, actor_type, actor_user_id, customer_id) VALUES ($1, $2, 'message.recorded', now(), 'USER', $3, $4)",
      [randomUUID(), A.businessId, A.people.OWNER!.id, cust.id])).rejects.toThrow(/activities_message_link_type/);
  });

  it('every activity type has a registered payload schema; unregistered types and invalid payloads fail', () => {
    expect(checkActivityData('call', { direction: 'INBOUND' })).toEqual({ direction: 'INBOUND' });
    expect(() => checkActivityData('call', { direction: 'SIDEWAYS' })).toThrow();
    expect(() => checkActivityData('note', { extra: true })).toThrow();
    expect(() => checkActivityData('invoice.paid', {})).toThrow(/Unregistered/);
  });
});

describe('editing and removing', () => {
  it('the author edits a note (edited_at stamped, audited without content); others, other types and archived records cannot', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Editable Inc' })).body.customer;
    const note = (await member.createActivity({ type: 'note', customerId: cust.id, subject: 'Draft', body: 'First thoughts' })).body.activity;
    expect(note.editedAt).toBeNull();
    const edited = await member.updateNote(note.id, { body: 'Second thoughts' });
    expect(edited.status).toBe(200);
    expect(edited.body.activity).toMatchObject({ subject: 'Draft', body: 'Second thoughts', actorUserId: A.people.MEMBER!.id, occurredAt: note.occurredAt });
    expect(edited.body.activity.editedAt).not.toBeNull();
    const { rows } = await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'activity.updated'", [note.id]);
    expect(rows[0].metadata).toEqual({ activityType: 'note', fields: ['body'] });
    // not the author: 403, even an OWNER
    expect((await api(A.people.OWNER!, A.slug).updateNote(note.id, { body: 'Owner rewrite' })).status).toBe(403);
    // cannot empty it, cannot change anything but subject/body
    expect((await member.updateNote(note.id, { subject: '', body: '' })).status).toBe(400);
    expect((await member.updateNote(note.id, { visibility: 'RESTRICTED' })).status).toBe(400);
    expect((await member.updateNote(note.id, { customerId: randomUUID() })).status).toBe(400);
    // only notes
    const call = (await member.createActivity({ type: 'call', customerId: cust.id, subject: 'Call' })).body.activity;
    expect((await member.updateNote(call.id, { body: 'rewrite' })).body).toEqual({ error: 'immutable' });
    const system = (await member.listActivities(`?customerId=${cust.id}&types=customer.created`)).body.activities[0];
    expect((await member.updateNote(system.id, { body: 'rewrite' })).body).toEqual({ error: 'immutable' });
    // archived customer: read-only
    await member.archiveCustomer(cust.id);
    expect((await member.updateNote(note.id, { body: 'after archive' })).body).toEqual({ error: 'archived_reference' });
    expect((await member.getActivity(note.id)).body.activity.body).toBe('Second thoughts');
  });

  it('the author removes their own entry once; system entries cannot be removed; authorship cannot be rewritten in SQL', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Removal Co' })).body.customer;
    const note = (await member.createActivity({ type: 'note', customerId: cust.id, body: 'Oops, wrong customer' })).body.activity;
    expect((await api(A.people.ADMIN!, A.slug).removeActivity(note.id)).status).toBe(403);
    expect((await member.removeActivity(note.id)).status).toBe(200);
    expect((await member.removeActivity(note.id)).status).toBe(404);
    expect((await member.getActivity(note.id)).status).toBe(404);
    expect((await member.listActivities(`?customerId=${cust.id}&types=note`)).body.activities).toEqual([]);
    const system = (await member.listActivities(`?customerId=${cust.id}`)).body.activities[0];
    expect(system.type).toBe('customer.created');
    expect((await member.removeActivity(system.id)).body).toEqual({ error: 'immutable' });
    // database backstops: column grants and the guard trigger
    const live = (await member.createActivity({ type: 'note', customerId: cust.id, body: 'mine' })).body.activity;
    await expect(asApp(A.businessId, A.people.MEMBER!.id, 'UPDATE activities SET actor_user_id = $1 WHERE id = $2', [A.people.OWNER!.id, live.id])).rejects.toThrow(/permission denied/);
    await expect(asApp(A.businessId, A.people.MEMBER!.id, 'UPDATE activities SET deleted_at = now() WHERE id = $1', [system.id])).rejects.toThrow(/system activities cannot be removed/);
    await expect(admin.query("UPDATE activities SET type = 'call' WHERE id = $1", [live.id])).rejects.toThrow(/activity identity is fixed/);
    await expect(admin.query('UPDATE activities SET deleted_at = NULL WHERE id = $1', [note.id])).rejects.toThrow(/removed activities are final/);
  });
});

describe('conversations and messages', () => {
  it('records a message outside Business OS: participants, one timeline entry without a copy of the content, database recorded time', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Inbox Pty' })).body.customer;
    const pat = (await member.createContact({ firstName: 'Pat', customerId: cust.id, email: 'pat@client.example' })).body.contact;
    const conv = await member.createConversation({ channel: 'EMAIL', subject: 'Quote request', contactId: pat.id });
    expect(conv.status).toBe(201);
    expect(ConversationResponse.parse(conv.body).conversation).toMatchObject({ customerId: cust.id, contactId: pat.id, source: 'MANUAL', createdById: A.people.MEMBER!.id, lastMessageAt: null });
    const id = conv.body.conversation.id;
    const before = Date.now();
    const msg = await member.recordMessage(id, email({
      participants: [{ role: 'TO', address: 'sales@us.example', userId: A.people.MEMBER!.id }, { role: 'FROM', displayName: 'Pat', contactId: pat.id }, { role: 'CC', address: 'boss@client.example' }, { role: 'TO', address: 'b@us.example' }],
    }));
    expect(msg.status).toBe(201);
    const message = MessageResponse.parse(msg.body).message;
    expect(message).toMatchObject({ source: 'MANUAL', direction: 'INBOUND', recordedById: A.people.MEMBER!.id, externalMessageId: null, occurredAt: '2026-10-01T09:00:00.000Z' });
    expect(new Date(message.recordedAt).getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(message.participants.map((p) => [p.role, p.position])).toEqual([['FROM', 0], ['TO', 0], ['TO', 1], ['CC', 0]]);
    // exactly one timeline entry, filed under the contact's customer, pointing at the message by FK
    const entries = (await member.listActivities(`?customerId=${cust.id}&types=message.recorded`)).body.activities;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ conversationId: id, messageId: message.id, contactId: pat.id, subject: null, body: null, occurredAt: message.occurredAt,
      data: { direction: 'INBOUND', channel: 'EMAIL', source: 'MANUAL' } });
    expect((await member.getConversation(id)).body.conversation.lastMessageAt).toBe('2026-10-01T09:00:00.000Z');
    const { rows } = await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'message.recorded'", [message.id]);
    expect(rows[0].metadata).toEqual({ conversationId: id, direction: 'INBOUND', source: 'MANUAL' });
  });

  it('message history is read-only and cannot be forged: no edit path, no UPDATE/DELETE, recorder is the session user, no client recorded time', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Ledger Mail' })).body.customer;
    const conv = (await owner.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    const message = (await owner.recordMessage(conv.id, email())).body.message;
    // forged fields in the request are rejected, not ignored
    for (const extra of [{ recordedAt: '2020-01-01T00:00:00Z' }, { recordedById: A.people.MEMBER!.id }, { source: 'IMPORT' }, { sentViaBusinessOs: true }, { status: 'SENT' }]) {
      expect((await owner.recordMessage(conv.id, email(extra))).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await owner.recordMessage(conv.id, email({ participants: [{ role: 'TO', address: 'x@y.example' }] }))).status).toBe(400); // no sender
    expect((await owner.recordMessage(conv.id, email({ occurredAt: '2099-01-01T00:00:00Z' }))).body).toMatchObject({ error: 'invalid_date' });
    await expect(asApp(A.businessId, A.people.OWNER!.id, "UPDATE messages SET body = 'rewritten' WHERE id = $1", [message.id])).rejects.toThrow(/permission denied/);
    await expect(asApp(A.businessId, A.people.OWNER!.id, 'DELETE FROM messages WHERE id = $1', [message.id])).rejects.toThrow(/permission denied/);
    await expect(asApp(A.businessId, A.people.OWNER!.id, "UPDATE message_participants SET address = 'x' WHERE message_id = $1", [message.id])).rejects.toThrow(/permission denied/);
    await expect(admin.query("UPDATE messages SET body = 'rewritten' WHERE id = $1", [message.id])).rejects.toThrow(/read-only/);
    await expect(admin.query("UPDATE message_participants SET address = 'x' WHERE message_id = $1", [message.id])).rejects.toThrow(/read-only/);
    // a recorder other than the session user fails RLS; recorded_at is database time even if supplied
    await expect(asApp(A.businessId, A.people.OWNER!.id,
      "INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_by_id, body, content_hash) VALUES ($1, $2, $3, 'INBOUND', 'MANUAL', now(), $4, 'x', repeat('a', 64))",
      [randomUUID(), A.businessId, conv.id, A.people.MEMBER!.id])).rejects.toThrow(/row-level security/);
    const forged = randomUUID();
    await asApp(A.businessId, A.people.OWNER!.id,
      "INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_at, recorded_by_id, body, content_hash) VALUES ($1, $2, $3, 'INBOUND', 'MANUAL', now() - interval '1 day', '2001-01-01', $4, 'x', repeat('a', 64))",
      [forged, A.businessId, conv.id, A.people.OWNER!.id]);
    const { rows } = await admin.query('SELECT recorded_at > now() - interval \'1 minute\' AS fresh FROM messages WHERE id = $1', [forged]);
    expect(rows[0].fresh).toBe(true);
    // there is no source value meaning "sent by Business OS"
    await expect(asApp(A.businessId, A.people.OWNER!.id,
      "INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_by_id, body, content_hash) VALUES ($1, $2, $3, 'OUTBOUND', 'BUSINESS_OS', now(), $4, 'x', repeat('a', 64))",
      [randomUUID(), A.businessId, conv.id, A.people.OWNER!.id])).rejects.toThrow(/messages_source_values/);
  });

  it('imports idempotently by external id; a conflicting re-import refuses the whole batch and writes nothing', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Archive Import Ltd' })).body.customer;
    const conv = (await member.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    const batch = [1, 2, 3].map((n) => email({ occurredAt: `2026-09-0${n}T10:00:00Z`, subject: `Mail ${n}`, external: { source: 'gmail-export', messageId: `<m${n}@mail.example>` } }));
    const first = await member.importMessages(conv.id, { messages: batch });
    expect(first.status).toBe(200);
    expect(ImportMessagesResponse.parse(first.body).results.map((r) => r.status)).toEqual(['created', 'created', 'created']);
    const again = await member.importMessages(conv.id, { messages: [...batch, batch[0]] });
    expect(again.body.results.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(again.body.results[0].messageId).toBe(first.body.results[0].messageId);
    const messages = async () => count('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conv.id]);
    const entries = async () => count("SELECT count(*)::int AS n FROM activities WHERE conversation_id = $1 AND type = 'message.recorded'", [conv.id]);
    expect([await messages(), await entries()]).toEqual([3, 3]);
    // same external id, different content: 409, and the new message earlier in the same batch rolls back too
    const conflict = await member.importMessages(conv.id, { messages: [
      email({ subject: 'Mail 4', occurredAt: '2026-09-04T10:00:00Z', external: { source: 'gmail-export', messageId: '<m4@mail.example>' } }),
      { ...batch[1], body: 'tampered' },
    ] });
    expect(conflict).toEqual({ status: 409, body: { error: 'idempotency_conflict' } });
    expect([await messages(), await entries()]).toEqual([3, 3]);
    // the same external id into another conversation is a conflict too
    const other = (await member.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    expect((await member.importMessages(other.id, { messages: [batch[0]] })).status).toBe(409);
    // the same id from a different source is a different message
    expect((await member.importMessages(other.id, { messages: [{ ...batch[0], external: { source: 'outlook-export', messageId: '<m1@mail.example>' } }] })).body.results[0].status).toBe('created');
    // imports need an external id, and source labels are constrained
    expect((await member.importMessages(conv.id, { messages: [email()] })).status).toBe(400);
    expect((await member.importMessages(conv.id, { messages: [email({ external: { source: 'Gmail Export!', messageId: 'x' } })] })).status).toBe(400);
    expect((await member.importMessages(conv.id, { messages: Array.from({ length: 101 }, (_, i) => email({ external: { source: 's', messageId: `${i}` } })) })).status).toBe(400);
    expect((await member.getConversation(conv.id)).body.conversation.lastMessageAt).toBe('2026-09-03T10:00:00.000Z');
    const { rows } = await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'messages.imported' ORDER BY created_at", [conv.id]);
    expect(rows.map((r) => r.metadata)).toEqual([{ created: '3', duplicates: '0' }, { created: '0', duplicates: '4' }]);
  });

  it('messages read oldest first with a deterministic tie-break, and keyset pages neither repeat nor skip', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Same Second Co' })).body.customer;
    const conv = (await member.createConversation({ channel: 'CHAT', customerId: cust.id })).body.conversation;
    const at = '2026-08-01T12:00:00Z';
    await member.importMessages(conv.id, { messages: Array.from({ length: 5 }, (_, i) => email({ occurredAt: at, body: `Same time ${i}`, external: { source: 'chat-export', messageId: `same-${i}` } })) });
    await member.recordMessage(conv.id, email({ occurredAt: '2026-07-01T12:00:00Z', body: 'Earlier' }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = ListMessagesResponse.parse((await member.listMessages(conv.id, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).body);
      seen.push(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
    } while (cursor);
    const { rows } = await admin.query('SELECT id FROM messages WHERE conversation_id = $1 ORDER BY occurred_at, id', [conv.id]);
    expect(seen).toEqual(rows.map((r) => r.id));
    expect((await member.listMessages(conv.id, '?cursor=bm90LWEtY3Vyc29y')).body).toMatchObject({ error: 'invalid_cursor' });
    // the timeline pages the same entries newest first, without repeats
    const timeline: string[] = [];
    let next: string | null = null;
    do {
      const page = ListActivitiesResponse.parse((await member.listActivities(`?customerId=${cust.id}&types=message.recorded&limit=2${next ? `&cursor=${next}` : ''}`)).body);
      timeline.push(...page.activities.map((a) => a.messageId!));
      next = page.nextCursor;
    } while (next);
    const order = await admin.query("SELECT message_id FROM activities WHERE customer_id = $1 AND type = 'message.recorded' ORDER BY occurred_at DESC, id DESC", [cust.id]);
    expect(timeline).toEqual(order.rows.map((r) => r.message_id));
    expect(new Set(timeline)).toEqual(new Set(rows.map((r) => r.id)));
  });

  it('conversations list newest first, filter by customer or contact, and page', async () => {
    const member = api(A.people.MEMBER!, A.slug);
    const cust = (await member.createCustomer({ displayName: 'Many Threads' })).body.customer;
    const contact = (await member.createContact({ firstName: 'Thread', customerId: cust.id })).body.contact;
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await member.createConversation({ channel: 'PHONE', subject: `T${i}`, customerId: cust.id })).body.conversation.id);
    made.push((await member.createConversation({ channel: 'SMS', contactId: contact.id })).body.conversation.id);
    const first = ListConversationsResponse.parse((await member.listConversations(`?customerId=${cust.id}&limit=3`)).body);
    const second = ListConversationsResponse.parse((await member.listConversations(`?customerId=${cust.id}&limit=3&cursor=${first.nextCursor}`)).body);
    expect([...first.conversations, ...second.conversations].map((c) => c.id)).toEqual([...made].reverse());
    expect((await member.listConversations(`?contactId=${contact.id}`)).body.conversations.map((c: { id: string }) => c.id)).toEqual([made[3]]);
    expect((await member.listConversations(`?customerId=${cust.id}&contactId=${contact.id}`)).status).toBe(400);
  });
});

describe('conversation last_message_at under concurrency (audit C1-01)', () => {
  /**
   * Two recordings race on one conversation. A superuser holds the conversation row lock, so both
   * requests have read the conversation (last_message_at still null) and queue on the update; the
   * holder then releases and they commit in queue order. The maximum message time must win whichever
   * order they commit in.
   */
  async function race(first: string, second: string) {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: `Race ${first} ${second}` })).body.customer;
    const conv = (await owner.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conv.id]);
      const pid = await backendPid(holder);
      const a = owner.recordMessage(conv.id, email({ occurredAt: first, body: 'first writer' }));
      await waitUntilBlocked(admin, pid, { count: 1 });
      const b = owner.recordMessage(conv.id, email({ occurredAt: second, body: 'second writer' }));
      await waitUntilBlocked(admin, pid, { count: 2 });
      await holder.query('COMMIT');
      expect((await a).status).toBe(201);
      expect((await b).status).toBe(201);
    } finally {
      await holder.end();
    }
    return (await owner.getConversation(conv.id)).body.conversation.lastMessageAt as string;
  }

  it('newer first, older second: the older commit does not move it backwards', async () => {
    expect(await race('2026-10-05T09:00:00Z', '2026-10-01T09:00:00Z')).toBe('2026-10-05T09:00:00.000Z');
  });

  it('older first, newer second: it advances to the newer time', async () => {
    expect(await race('2026-10-01T09:00:00Z', '2026-10-05T09:00:00Z')).toBe('2026-10-05T09:00:00.000Z');
  });

  it('the database keeps the maximum for every writer, including a null or older value', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Monotonic Mail' })).body.customer;
    const conv = (await owner.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    await owner.recordMessage(conv.id, email({ occurredAt: '2026-10-03T09:00:00Z' }));
    const at = async () => (await admin.query('SELECT last_message_at FROM conversations WHERE id = $1', [conv.id])).rows[0].last_message_at.toISOString();
    await asApp(A.businessId, A.people.OWNER!.id, 'UPDATE conversations SET last_message_at = NULL WHERE id = $1', [conv.id]);
    expect(await at()).toBe('2026-10-03T09:00:00.000Z');
    await asApp(A.businessId, A.people.OWNER!.id, "UPDATE conversations SET last_message_at = '2020-01-01' WHERE id = $1", [conv.id]);
    expect(await at()).toBe('2026-10-03T09:00:00.000Z');
    await admin.query("UPDATE conversations SET last_message_at = '2020-01-01' WHERE id = $1", [conv.id]);
    expect(await at()).toBe('2026-10-03T09:00:00.000Z');
    await owner.recordMessage(conv.id, email({ occurredAt: '2026-10-04T09:00:00Z' }));
    expect(await at()).toBe('2026-10-04T09:00:00.000Z');
  });
});

describe('history when customers and contacts change', () => {
  it('message entries follow the contact to its new customer; earlier entries and the conversation record keep the old one', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const oldCo = (await owner.createCustomer({ displayName: 'Old Employer' })).body.customer;
    const newCo = (await owner.createCustomer({ displayName: 'New Employer' })).body.customer;
    const sam = (await owner.createContact({ firstName: 'Sam', customerId: oldCo.id })).body.contact;
    const contactThread = (await owner.createConversation({ channel: 'EMAIL', contactId: sam.id })).body.conversation;
    const customerThread = (await owner.createConversation({ channel: 'EMAIL', customerId: oldCo.id })).body.conversation;
    // a contact linked to a customer is filed under it; a different customer is refused
    expect(contactThread.customerId).toBe(oldCo.id);
    expect((await owner.createConversation({ channel: 'EMAIL', customerId: newCo.id, contactId: sam.id })).body).toMatchObject({ error: 'customer_mismatch' });
    const m1 = (await owner.recordMessage(contactThread.id, email({ body: 'Before the move' }))).body.message;
    expect((await owner.updateContact(sam.id, { customerId: newCo.id })).status).toBe(200);
    const m2 = (await owner.recordMessage(contactThread.id, email({ body: 'After the move' }))).body.message;
    const m3 = (await owner.recordMessage(customerThread.id, email({ body: 'Old employer thread' }))).body.message;
    const at = async (customerId: string) => (await owner.listActivities(`?customerId=${customerId}&types=message.recorded`)).body.activities.map((a: { messageId: string }) => a.messageId);
    expect((await at(oldCo.id)).sort()).toEqual([m1.id, m3.id].sort());
    expect(await at(newCo.id)).toEqual([m2.id]);
    expect((await owner.listActivities(`?contactId=${sam.id}&types=message.recorded`)).body.activities).toHaveLength(2);
    // the conversation record itself is never rewritten
    expect((await owner.getConversation(contactThread.id)).body.conversation.customerId).toBe(oldCo.id);
  });

  it('archived customers and contacts keep their history readable but take no new conversations, messages or notes', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Closing Down' })).body.customer;
    const conv = (await owner.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    await owner.recordMessage(conv.id, email());
    const contact = (await owner.createContact({ firstName: 'Gone' })).body.contact;
    const contactConv = (await owner.createConversation({ channel: 'SMS', contactId: contact.id })).body.conversation;
    await owner.archiveCustomer(cust.id);
    await owner.archiveContact(contact.id);
    expect((await owner.recordMessage(conv.id, email())).body).toEqual({ error: 'archived_reference' });
    expect((await owner.recordMessage(contactConv.id, email())).body).toEqual({ error: 'archived_reference' });
    expect((await owner.importMessages(conv.id, { messages: [email({ external: { source: 'x', messageId: 'late' } })] })).body).toEqual({ error: 'archived_reference' });
    expect((await owner.createConversation({ channel: 'EMAIL', customerId: cust.id })).body).toEqual({ error: 'archived_reference' });
    expect((await owner.listMessages(conv.id)).body.messages).toHaveLength(1);
    expect((await owner.listActivities(`?customerId=${cust.id}&types=message.recorded`)).body.activities).toHaveLength(1);
  });
});

describe('permissions and visibility', () => {
  it('every role can record and read message history; a non-member gets 404 everywhere', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Role Matrix Mail' })).body.customer;
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const who = api(A.people[role]!, A.slug);
      const conv = await who.createConversation({ channel: 'EMAIL', customerId: cust.id });
      expect(conv.status, role).toBe(201);
      expect((await who.recordMessage(conv.body.conversation.id, email())).status, role).toBe(201);
      expect((await who.listMessages(conv.body.conversation.id)).status, role).toBe(200);
    }
    const conv = (await owner.listConversations(`?customerId=${cust.id}`)).body.conversations[0];
    const outsider = api(B.people.OWNER!, A.slug);
    expect((await outsider.listConversations()).status).toBe(404);
    expect((await outsider.getConversation(conv.id)).status).toBe(404);
    expect((await outsider.recordMessage(conv.id, email())).status).toBe(404);
    expect((await outsider.listActivities()).status).toBe(404);
  });

  it('message entries are hidden from a reader without communications:read; restricted notes from one without read_restricted (service rule)', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const cust = (await owner.createCustomer({ displayName: 'Viewer Rules' })).body.customer;
    const conv = (await owner.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    await owner.recordMessage(conv.id, email());
    await owner.createActivity({ type: 'note', customerId: cust.id, body: 'Restricted by owner', visibility: 'RESTRICTED' });
    const types = (viewer: { canReadRestricted: boolean; canReadMessages: boolean }) =>
      withTenant({ businessId: A.businessId, userId: A.people.MEMBER!.id }, (db) =>
        listActivities(db, { userId: A.people.MEMBER!.id, ...viewer }, { customerId: cust.id, limit: 50 })).then((r) => r.activities.map((a) => a.type).sort());
    expect(await types({ canReadRestricted: true, canReadMessages: true })).toEqual(['customer.created', 'message.recorded', 'note']);
    expect(await types({ canReadRestricted: true, canReadMessages: false })).toEqual(['customer.created', 'note']);
    expect(await types({ canReadRestricted: false, canReadMessages: true })).toEqual(['customer.created', 'message.recorded']);
  });
});

describe('tenant isolation', () => {
  it("one business can never read, record into or link to another business's conversations, contacts or messages", async () => {
    const a = api(A.people.OWNER!, A.slug);
    const b = api(B.people.OWNER!, B.slug);
    const aCust = (await a.createCustomer({ displayName: 'A only' })).body.customer;
    const aContact = (await a.createContact({ firstName: 'A person', customerId: aCust.id })).body.contact;
    const aConv = (await a.createConversation({ channel: 'EMAIL', customerId: aCust.id })).body.conversation;
    const aMsg = (await a.recordMessage(aConv.id, email())).body.message;
    expect((await b.getConversation(aConv.id)).status).toBe(404);
    expect((await b.listMessages(aConv.id)).status).toBe(404);
    expect((await b.recordMessage(aConv.id, email())).status).toBe(404);
    expect((await b.importMessages(aConv.id, { messages: [email({ external: { source: 'x', messageId: 'y' } })] })).status).toBe(404);
    expect((await b.createConversation({ channel: 'EMAIL', customerId: aCust.id })).status).toBe(404);
    expect((await b.createConversation({ channel: 'EMAIL', contactId: aContact.id })).status).toBe(404);
    expect((await b.listConversations(`?customerId=${aCust.id}`)).body.conversations).toEqual([]);
    expect((await b.listActivities(`?customerId=${aCust.id}`)).body.activities).toEqual([]);
    // a participant naming another business's contact or a non-member is refused
    const bCust = (await b.createCustomer({ displayName: 'B only' })).body.customer;
    const bConv = (await b.createConversation({ channel: 'EMAIL', customerId: bCust.id })).body.conversation;
    expect((await b.recordMessage(bConv.id, email({ participants: [{ role: 'FROM', contactId: aContact.id }] }))).body).toMatchObject({ error: 'invalid_participant' });
    expect((await b.recordMessage(bConv.id, email({ participants: [{ role: 'FROM', userId: A.people.OWNER!.id }] }))).body).toMatchObject({ error: 'invalid_participant' });
    // the same external id in two businesses is two different messages
    const ext = { source: 'gmail-export', messageId: '<shared@mail.example>' };
    expect((await a.importMessages(aConv.id, { messages: [email({ external: ext })] })).body.results[0].status).toBe('created');
    expect((await b.importMessages(bConv.id, { messages: [email({ external: ext })] })).body.results[0].status).toBe('created');
    // raw SQL as bos_app in business B: composite FKs and RLS
    const asB = (sql: string, params: unknown[]) => asApp(B.businessId, B.people.OWNER!.id, sql, params);
    await expect(asB("INSERT INTO conversations (id, business_id, channel, customer_id, created_by_id) VALUES ($1, $2, 'EMAIL', $3, $4)", [randomUUID(), B.businessId, aCust.id, B.people.OWNER!.id])).rejects.toThrow(/foreign key/);
    await expect(asB("INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_by_id, body, content_hash) VALUES ($1, $2, $3, 'INBOUND', 'MANUAL', now(), $4, 'x', repeat('a', 64))", [randomUUID(), B.businessId, aConv.id, B.people.OWNER!.id])).rejects.toThrow(/foreign key/);
    await expect(asB("INSERT INTO message_participants (id, business_id, message_id, role, position, address) VALUES ($1, $2, $3, 'TO', 9, 'x')", [randomUUID(), B.businessId, aMsg.id])).rejects.toThrow(/foreign key/);
    await expect(asB("INSERT INTO activities (id, business_id, type, occurred_at, actor_type, actor_user_id, customer_id, conversation_id, message_id) VALUES ($1, $2, 'message.recorded', now(), 'USER', $3, $4, $5, $6)", [randomUUID(), B.businessId, B.people.OWNER!.id, bCust.id, aConv.id, aMsg.id])).rejects.toThrow(/foreign key/);
    // an activity in B pointing at B's conversation but A's message id: the three-column FK refuses the mix
    await expect(asB("INSERT INTO activities (id, business_id, type, occurred_at, actor_type, actor_user_id, customer_id, conversation_id, message_id) VALUES ($1, $2, 'message.recorded', now(), 'USER', $3, $4, $5, $6)", [randomUUID(), B.businessId, B.people.OWNER!.id, bCust.id, bConv.id, aMsg.id])).rejects.toThrow(/foreign key/);
    await expect(asB("INSERT INTO conversations (id, business_id, channel, customer_id, created_by_id) VALUES ($1, $2, 'EMAIL', $3, $4)", [randomUUID(), A.businessId, aCust.id, B.people.OWNER!.id])).rejects.toThrow(/row-level security/);
    await expect(asB("INSERT INTO conversations (id, business_id, channel, customer_id, created_by_id) VALUES ($1, $2, 'EMAIL', $3, $4)", [randomUUID(), B.businessId, bCust.id, B.people.MEMBER!.id])).rejects.toThrow(/row-level security/);
    const visible = await asB('SELECT (SELECT count(*) FROM conversations WHERE business_id = $1)::int AS c, (SELECT count(*) FROM messages WHERE business_id = $1)::int AS m, (SELECT count(*) FROM message_participants WHERE business_id = $1)::int AS p', [A.businessId]);
    expect(visible.rows[0]).toEqual({ c: 0, m: 0, p: 0 });
    for (const table of ['conversations', 'messages', 'message_participants']) {
      expect((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
    }
  });

  it('every new table forces row-level security; tenant code has no DELETE on them', async () => {
    const { rows } = await admin.query("SELECT relname FROM pg_class WHERE relname IN ('conversations','messages','message_participants') AND relrowsecurity AND relforcerowsecurity");
    expect(rows).toHaveLength(3);
    const grants = await admin.query("SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'bos_app' AND table_name IN ('conversations','messages','message_participants') ORDER BY 1, 2");
    expect(grants.rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([
      'conversations:INSERT', 'conversations:SELECT', 'message_participants:INSERT', 'message_participants:SELECT', 'messages:INSERT', 'messages:SELECT',
    ]);
  });
});

describe('retention, erasure readiness and diagnostics', () => {
  it('business purge removes conversations, messages, participants and their timeline entries together', async () => {
    const C = await team('mc');
    const c = api(C.people.OWNER!, C.slug);
    const cust = (await c.createCustomer({ displayName: 'Purge Me' })).body.customer;
    const conv = (await c.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
    await c.recordMessage(conv.id, email());
    await c.createActivity({ type: 'note', customerId: cust.id, body: 'x', visibility: 'RESTRICTED' });
    await admin.query('DELETE FROM businesses WHERE id = $1', [C.businessId]);
    for (const table of ['conversations', 'messages', 'message_participants', 'activities']) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [C.businessId]), table).toBe(0);
    }
  });

  it('personal links are nullable and personal content sits in known columns, so erasure can scrub them', async () => {
    const { rows } = await admin.query(`SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE (table_name, column_name) IN (('message_participants','contact_id'),('message_participants','display_name'),('message_participants','address'),
        ('messages','subject'),('messages','body'),('conversations','contact_id'),('conversations','subject'))`);
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r.is_nullable, `${r.table_name}.${r.column_name}`).toBe('YES');
  });

  it('message content never reaches diagnostic logs, even when a request fails', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const owner = api(A.people.OWNER!, A.slug);
      const cust = (await owner.createCustomer({ displayName: 'Quiet Logs' })).body.customer;
      const conv = (await owner.createConversation({ channel: 'EMAIL', customerId: cust.id })).body.conversation;
      const secret = 'TOP-SECRET-MESSAGE-BODY-41';
      await owner.recordMessage(conv.id, email({ body: secret }));
      await owner.importMessages(conv.id, { messages: [email({ body: secret, external: { source: 'x', messageId: 'q' } })] });
      await owner.importMessages(conv.id, { messages: [email({ body: `${secret}-changed`, external: { source: 'x', messageId: 'q' } })] });
      await owner.recordMessage(conv.id, email({ body: secret, participants: [{ role: 'FROM', contactId: randomUUID() }] }));
      await owner.createActivity({ type: 'note', customerId: cust.id, body: secret, visibility: 'RESTRICTED' });
      const logged = spies.flatMap((s) => s.mock.calls).map((args) => JSON.stringify(args, Object.getOwnPropertyNames(args))).join('\n');
      expect(logged).not.toContain(secret);
      const audits = await admin.query('SELECT metadata FROM audit_events WHERE business_id = $1', [A.businessId]);
      expect(JSON.stringify(audits.rows)).not.toContain(secret);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
