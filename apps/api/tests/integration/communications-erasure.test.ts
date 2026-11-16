/**
 * Communications E1 (docs/communications-e1.md): retention eligibility, the 30-day delay on shortening,
 * legal holds, single-use authorisations, erasure requests (message, conversation, contact), the retention
 * purge, keyed re-import markers, the ledger and its replay after a restore, and the races between erasure
 * and the writes it can meet. Real route handlers and the real worker against PostgreSQL with the
 * migrations and privileged SQL applied as in production. Two independent businesses and every role.
 *
 * Categorised message copies (STAGED_INTAKE, ORDINARY, RETAINED_RECORD, PERSONAL_UNSHARED) are written by the
 * mailbox sync of C2-B3, which does not exist yet; this suite seeds them as the administrative role.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as activitiesRoute from '@/app/api/v1/b/[slug]/activities/route';
import * as activityRoute from '@/app/api/v1/b/[slug]/activities/[activityId]/route';
import * as conversationsRoute from '@/app/api/v1/b/[slug]/conversations/route';
import * as conversationRoute from '@/app/api/v1/b/[slug]/conversations/[conversationId]/route';
import * as messagesRoute from '@/app/api/v1/b/[slug]/conversations/[conversationId]/messages/route';
import * as importRoute from '@/app/api/v1/b/[slug]/conversations/[conversationId]/messages/import/route';
import * as retentionRoute from '@/app/api/v1/b/[slug]/communications/retention/route';
import * as eligibilityRoute from '@/app/api/v1/b/[slug]/communications/retention/eligibility/route';
import * as applyReductionRoute from '@/app/api/v1/b/[slug]/communications/retention/apply-reduction/route';
import * as authorizationsRoute from '@/app/api/v1/b/[slug]/communications/authorizations/route';
import * as erasuresRoute from '@/app/api/v1/b/[slug]/communications/erasures/route';
import * as erasureRoute from '@/app/api/v1/b/[slug]/communications/erasures/[erasureId]/route';
import * as holdsRoute from '@/app/api/v1/b/[slug]/communications/legal-holds/route';
import * as releaseHoldRoute from '@/app/api/v1/b/[slug]/communications/legal-holds/[holdId]/release/route';
import * as retentionJobRoute from '@/app/api/internal/jobs/communications-retention/route';
import { failureCode, runCommunicationsRetentionPass } from '@/app/api/_lib/retention-worker';
import { withTenant } from '@/core/db';
import { devOutbox } from '@/core/email';
import { getSessionToken } from '@/modules/identity/server/session';
import { erasureHousekeeping, purgeExpired, recordErasureFailure, stepErasure } from '@/modules/communications';
import { backendPid, waitUntilBlocked } from './support/locks';
import {
  ErasureDetailResponse, ErasureResponse, LegalHoldResponse, ListErasuresResponse, ListLegalHoldsResponse, MailRetentionResponse,
  PrivilegedAuthorizationResponse, RetentionEligibilityResponse,
} from '@business-os/contracts';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const observer = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
const app2 = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await Promise.all([admin.connect(), observer.connect(), app.connect(), app2.connect()]);
});
afterAll(async () => {
  await Promise.all([admin.end(), observer.end(), app.end(), app2.end()]);
});

// A separate address range from the other suites, so rate-limit counters do not collide.
let ip = 1;
type User = { email: string; cookie: string; id: string; token: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.97.${Math.floor(ip / 250)}.${ip++ % 250}`, origin: ORIGIN });
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
  const verify = new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.97.200.${ip++ % 250}` } });
  await authRoute.GET(verify);
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  const token = (await getSessionToken(req('GET', '/', { cookie })))!;
  return { email, cookie, id: rows[0].id, token };
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
    createContact: (body: unknown) => contactsRoute.POST(r('POST', '/contacts', body), ctx({ slug })).then(json),
    createActivity: (body: unknown) => activitiesRoute.POST(r('POST', '/activities', body), ctx({ slug })).then(json),
    listActivities: (qs = '') => activitiesRoute.GET(r('GET', `/activities${qs}`), ctx({ slug })).then(json),
    getActivity: (activityId: string) => activityRoute.GET(r('GET', `/activities/${activityId}`), ctx({ slug, activityId })).then(json),
    createConversation: (body: unknown) => conversationsRoute.POST(r('POST', '/conversations', body), ctx({ slug })).then(json),
    listConversations: (qs = '') => conversationsRoute.GET(r('GET', `/conversations${qs}`), ctx({ slug })).then(json),
    getConversation: (conversationId: string) => conversationRoute.GET(r('GET', `/conversations/${conversationId}`), ctx({ slug, conversationId })).then(json),
    recordMessage: (conversationId: string, body: unknown) =>
      messagesRoute.POST(r('POST', `/conversations/${conversationId}/messages`, body), ctx({ slug, conversationId })).then(json),
    listMessages: (conversationId: string, qs = '') =>
      messagesRoute.GET(r('GET', `/conversations/${conversationId}/messages${qs}`), ctx({ slug, conversationId })).then(json),
    importMessages: (conversationId: string, body: unknown) =>
      importRoute.POST(r('POST', `/conversations/${conversationId}/messages/import`, body), ctx({ slug, conversationId })).then(json),
    retention: () => retentionRoute.GET(r('GET', '/communications/retention'), ctx({ slug })).then(json),
    setRetention: (body: unknown) => retentionRoute.PUT(r('PUT', '/communications/retention', body), ctx({ slug })).then(json),
    eligibility: () => eligibilityRoute.GET(r('GET', '/communications/retention/eligibility'), ctx({ slug })).then(json),
    applyReduction: (body: unknown) => applyReductionRoute.POST(r('POST', '/communications/retention/apply-reduction', body), ctx({ slug })).then(json),
    authorize: (operation: string, targetId: string | null) =>
      authorizationsRoute.POST(r('POST', '/communications/authorizations', { operation, targetId }), ctx({ slug })).then(json),
    requestErasure: (body: unknown) => erasuresRoute.POST(r('POST', '/communications/erasures', body), ctx({ slug })).then(json),
    listErasures: (qs = '') => erasuresRoute.GET(r('GET', `/communications/erasures${qs}`), ctx({ slug })).then(json),
    getErasure: (erasureId: string) => erasureRoute.GET(r('GET', `/communications/erasures/${erasureId}`), ctx({ slug, erasureId })).then(json),
    placeHold: (body: unknown) => holdsRoute.POST(r('POST', '/communications/legal-holds', body), ctx({ slug })).then(json),
    listHolds: (qs = '') => holdsRoute.GET(r('GET', `/communications/legal-holds${qs}`), ctx({ slug })).then(json),
    releaseHold: (holdId: string, body: unknown) =>
      releaseHoldRoute.POST(r('POST', `/communications/legal-holds/${holdId}/release`, body), ctx({ slug, holdId })).then(json),
  };
};
type Api = ReturnType<typeof api>;

/** A conversation filed under a fresh customer (C1 requires a customer or contact link). */
async function newConv(who: Api, subject: string) {
  const customer = (await who.createCustomer({ displayName: `Customer for ${subject}` })).body.customer;
  const res = await who.createConversation({ channel: 'EMAIL', subject, customerId: customer.id });
  expect(res.status).toBe(201);
  return res.body.conversation;
}

/** Gets a single-use code and spends it on an erasure request in one go. */
async function erase(who: Api, targetType: 'CONTACT' | 'CONVERSATION' | 'MESSAGE', targetId: string, reason = 'DATA_SUBJECT_REQUEST') {
  const auth = await who.authorize(`ERASE_${targetType}`, targetId);
  expect(auth.status).toBe(201);
  return who.requestErasure({ targetType, targetId, reason, authorization: auth.body.authorization.code });
}

/** Runs one statement as bos_app inside a tenant transaction. */
async function asApp(client: pg.Client, businessId: string, userId: string | null, sql: string, params: unknown[] = []) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [businessId, userId ?? '']);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const count = async (sql: string, params: unknown[]) => Number((await admin.query(sql, params)).rows[0].n);
const hash64 = () => randomUUID().replace(/-/g, '').repeat(2);

/**
 * Seeds one categorised copy as C2-B3's sync would (message + participants in one transaction), dated
 * `daysAgo` days back. recorded_at is stamped now() by the database; `recordedDaysAgo` back-dates it with
 * triggers disabled for that one UPDATE, as a staged copy written a month ago would be.
 */
async function seedCopy(
  t: { businessId: string; people: Record<string, User> }, conversationId: string,
  o: { category: string | null; daysAgo: number; recordedDaysAgo?: number; subject?: string; body?: string; externalId?: string;
       participants?: { role: string; address: string | null; displayName?: string; contactId?: string | null }[] },
): Promise<string> {
  const id = randomUUID();
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_by_id, subject, body,
                             external_source, external_message_id, content_hash, retention_category)
       VALUES ($1, $2, $3, 'INBOUND', 'IMPORT', now() - make_interval(days => $4), $5, $6, $7, 'gmail', $8, $9, $10)`,
      [id, t.businessId, conversationId, o.daysAgo, t.people.OWNER!.id, o.subject ?? 'Seeded subject', o.body ?? 'Seeded body',
       o.externalId ?? `gm-${randomUUID()}`, hash64(), o.category],
    );
    const parts = o.participants ?? [{ role: 'FROM', address: 'sender@client.example', displayName: 'Sender' }, { role: 'TO', address: 'us@biz.example' }];
    const pos: Record<string, number> = {};
    for (const p of parts) {
      pos[p.role] = (pos[p.role] ?? -1) + 1;
      await admin.query(
        `INSERT INTO message_participants (id, business_id, message_id, role, position, display_name, address, contact_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), t.businessId, id, p.role, pos[p.role], p.displayName ?? null, p.address, p.contactId ?? null],
      );
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  if (o.recordedDaysAgo !== undefined) await bypassTriggers('UPDATE messages SET recorded_at = now() - make_interval(days => $2) WHERE id = $1', [id, o.recordedDaysAgo]);
  return id;
}

/** One administrative statement with triggers off: a restore, or back-dating a seed. Never available to a runtime role. */
async function bypassTriggers(sql: string, params: unknown[]) {
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(sql, params);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

const worker = (businessId: string) => <T>(fn: (db: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
  withTenant({ businessId, userId: null }, fn);

/** Steps a request until it stops making progress (as the worker would over several passes). */
async function finish(businessId: string, erasureId: string) {
  for (let n = 0; n < 50; n++) {
    const { outcome } = await worker(businessId)((db) => stepErasure(db, erasureId, 2));
    if (outcome !== 'progress') return outcome;
  }
  throw new Error('erasure did not settle');
}

const messageRow = async (id: string) =>
  (await admin.query('SELECT subject, body, external_source, external_message_id, erased_at FROM messages WHERE id = $1', [id])).rows[0];
const participantRows = async (messageId: string) =>
  (await admin.query('SELECT display_name, address, contact_id, erased_at FROM message_participants WHERE message_id = $1 ORDER BY role, position', [messageId])).rows;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let owner: Api, adminA: Api, manager: Api, member: Api, ownerB: Api;

beforeAll(async () => {
  [A, B] = await Promise.all([team('e1a'), team('e1b')]);
  owner = api(A.people.OWNER!, A.slug);
  adminA = api(A.people.ADMIN!, A.slug);
  manager = api(A.people.MANAGER!, A.slug);
  member = api(A.people.MEMBER!, A.slug);
  ownerB = api(B.people.OWNER!, B.slug);
});

describe('single-use authorisations (D-E1-4)', () => {
  it('only OWNER and ADMIN obtain codes; MANAGER and MEMBER are refused by permission', async () => {
    const conv = (await newConv(owner, 'auth check'));
    for (const who of [manager, member]) expect((await who.authorize('ERASE_CONVERSATION', conv.id)).status).toBe(403);
    const code = await adminA.authorize('ERASE_CONVERSATION', conv.id);
    expect(code.status).toBe(201);
    expect(PrivilegedAuthorizationResponse.parse(code.body).authorization.code).toMatch(/^[0-9a-f]{64}$/);
    // Only the hash is stored.
    expect(await count('SELECT count(*) AS n FROM communications_privileged_grants WHERE code_hash = $1', [code.body.authorization.code])).toBe(0);
    // Applying a reduction early is OWNER only, enforced in the database.
    expect((await adminA.authorize('APPLY_RETENTION_REDUCTION', null)).status).toBe(403);
    expect((await owner.authorize('APPLY_RETENTION_REDUCTION', null)).status).toBe(201);
    // targetId must match the operation.
    expect((await owner.authorize('APPLY_RETENTION_REDUCTION', conv.id)).status).toBe(400);
    expect((await owner.authorize('ERASE_MESSAGE', null)).status).toBe(400);
  });

  it('a code works once, only for its operation, target and person, and only for 5 minutes', async () => {
    const conv = (await newConv(owner, 'replay check'));
    const other = (await newConv(owner, 'other target'));
    const code = (await owner.authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    // wrong target, wrong operation, wrong person: refused, and the code is not spent by those attempts
    expect((await owner.requestErasure({ targetType: 'CONVERSATION', targetId: other.id, reason: 'BUSINESS_REQUEST', authorization: code })).status).toBe(403);
    expect((await owner.requestErasure({ targetType: 'MESSAGE', targetId: conv.id, reason: 'BUSINESS_REQUEST', authorization: code })).status).toBe(403);
    expect((await adminA.requestErasure({ targetType: 'CONVERSATION', targetId: conv.id, reason: 'BUSINESS_REQUEST', authorization: code })).status).toBe(403);
    const first = await owner.requestErasure({ targetType: 'CONVERSATION', targetId: conv.id, reason: 'BUSINESS_REQUEST', authorization: code });
    expect(first.status).toBe(202);
    // replay
    expect((await owner.requestErasure({ targetType: 'CONVERSATION', targetId: conv.id, reason: 'BUSINESS_REQUEST', authorization: code })).status).toBe(403);
    // expiry
    const late = (await owner.authorize('ERASE_CONVERSATION', other.id)).body.authorization.code;
    await admin.query(
      `UPDATE communications_privileged_grants SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute'
        WHERE business_id = $1 AND target_id = $2 AND consumed_at IS NULL`, [A.businessId, other.id]);
    expect((await owner.requestErasure({ targetType: 'CONVERSATION', targetId: other.id, reason: 'BUSINESS_REQUEST', authorization: late })).status).toBe(403);
    // another business's code is meaningless here (refused before the target is even looked up)
    const convB = (await newConv(ownerB, 'B'));
    const codeB = (await ownerB.authorize('ERASE_CONVERSATION', convB.id)).body.authorization.code;
    expect((await owner.requestErasure({ targetType: 'CONVERSATION', targetId: convB.id, reason: 'BUSINESS_REQUEST', authorization: codeB })).status).toBe(403);
  });

  it('the database re-checks the session: an expired session, a suspended or demoted member, or another user cannot use a code', async () => {
    const conv = (await newConv(owner, 'session check'));
    const code = (await adminA.authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    const call = (token: string, userId: string) => asApp(app, A.businessId, userId,
      "SELECT * FROM app_private.communications_request_erasure($1, $2, 'CONVERSATION', $3, 'BUSINESS_REQUEST')", [token, code, conv.id]);
    // a forged token, and the right token under another user's identity
    await expect(call('not-a-session', A.people.ADMIN!.id)).rejects.toMatchObject({ code: '42501' });
    await expect(call(A.people.ADMIN!.token, A.people.OWNER!.id)).rejects.toMatchObject({ code: '42501' });
    // demoted between obtaining and using the code
    await admin.query("UPDATE memberships SET role = 'MANAGER' WHERE business_id = $1 AND user_id = $2", [A.businessId, A.people.ADMIN!.id]);
    await expect(call(A.people.ADMIN!.token, A.people.ADMIN!.id)).rejects.toMatchObject({ code: '42501' });
    await admin.query("UPDATE memberships SET role = 'ADMIN', status = 'SUSPENDED' WHERE business_id = $1 AND user_id = $2", [A.businessId, A.people.ADMIN!.id]);
    await expect(call(A.people.ADMIN!.token, A.people.ADMIN!.id)).rejects.toMatchObject({ code: '42501' });
    await admin.query("UPDATE memberships SET status = 'ACTIVE' WHERE business_id = $1 AND user_id = $2", [A.businessId, A.people.ADMIN!.id]);
    // an expired session
    const temp = await newUser('e1-expiring');
    await admin.query("INSERT INTO memberships (id, business_id, user_id, role) VALUES ($1, $2, $3, 'ADMIN')", [randomUUID(), A.businessId, temp.id]);
    const tempCode = (await api(temp, A.slug).authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    await admin.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [temp.id]);
    await expect(asApp(app, A.businessId, temp.id,
      "SELECT * FROM app_private.communications_request_erasure($1, $2, 'CONVERSATION', $3, 'BUSINESS_REQUEST')", [temp.token, tempCode, conv.id]))
      .rejects.toMatchObject({ code: '42501' });
    // nothing was recorded by any of those attempts
    expect(await count("SELECT count(*) AS n FROM communications_erasures WHERE conversation_id = $1", [conv.id])).toBe(0);
  });
});

describe('erasure requests', () => {
  it('erases a manual (C1) message on request: content, provider ids and participants go; ids and structure stay; audit has no content', async () => {
    const conv = (await newConv(member, 'Keep thread'));
    const m1 = (await member.recordMessage(conv.id, {
      direction: 'INBOUND', occurredAt: '2026-10-01T09:00:00Z', subject: 'Secret plan', body: 'The secret is 42',
      participants: [{ role: 'FROM', displayName: 'Pat', address: 'pat@client.example' }, { role: 'TO', address: 'us@biz.example' }],
    })).body.message;
    const m2 = (await member.recordMessage(conv.id, {
      direction: 'OUTBOUND', occurredAt: '2026-10-02T09:00:00Z', subject: 'Reply', body: 'Thanks',
      participants: [{ role: 'FROM', address: 'us@biz.example' }, { role: 'TO', address: 'pat@client.example' }],
    })).body.message;
    const res = await erase(owner, 'MESSAGE', m1.id);
    expect(res.status).toBe(202);
    const erasure = ErasureResponse.parse(res.body).erasure;
    expect(erasure).toMatchObject({ kind: 'REQUEST', status: 'COMPLETED', targetType: 'MESSAGE', targetId: m1.id, counts: { messages: 1, participants: 2 } });
    expect(await messageRow(m1.id)).toMatchObject({ subject: null, body: null, external_source: null, external_message_id: null });
    expect((await messageRow(m1.id)).erased_at).not.toBeNull();
    expect((await participantRows(m1.id)).every((p: { address: unknown; display_name: unknown }) => p.address === null && p.display_name === null)).toBe(true);
    // the rest of the conversation is untouched
    expect(await messageRow(m2.id)).toMatchObject({ subject: 'Reply', body: 'Thanks', erased_at: null });
    // every read path shows the tombstone, never the content
    const listed = (await member.listMessages(conv.id)).body.messages as { id: string; subject: string | null; body: string | null; erasedAt: string | null }[];
    expect(listed.find((m) => m.id === m1.id)).toMatchObject({ subject: null, body: null });
    expect(listed.find((m) => m.id === m1.id)!.erasedAt).not.toBeNull();
    expect(JSON.stringify(listed.find((m) => m.id === m1.id))).not.toMatch(/Secret|secret is 42|pat@client|Pat/);
    expect((await member.getConversation(conv.id)).body.conversation.erasedAt).toBeNull();
    // ledger and audit: ids and counts only
    expect(await count("SELECT count(*) AS n FROM communications_erasure_items WHERE erasure_id = $1 AND entity_type = 'MESSAGE' AND entity_id = $2", [erasure.id, m1.id])).toBe(1);
    const audit = (await admin.query("SELECT action, metadata::text AS m FROM audit_events WHERE business_id = $1 AND target_id = $2 ORDER BY created_at", [A.businessId, erasure.id])).rows;
    expect(audit.map((a: { action: string }) => a.action).sort()).toEqual(['communications.erasure.completed', 'communications.erasure.requested']);
    expect(audit.map((a: { m: string }) => a.m).join(' ')).not.toMatch(/Secret|42|pat@|Pat/);
    // a repeated request is answered as complete work, not done twice; GET and list agree
    const again = await erase(owner, 'MESSAGE', m1.id);
    expect(again.status).toBe(202);
    expect(again.body.erasure.counts.messages).toBe(0);
    expect(ErasureDetailResponse.parse((await owner.getErasure(erasure.id)).body).erasure.status).toBe('COMPLETED');
    expect(ListErasuresResponse.parse((await owner.listErasures('?kind=REQUEST')).body).erasures.some((e) => e.id === erasure.id)).toBe(true);
    // MEMBER and MANAGER cannot list or read erasures
    expect((await member.listErasures()).status).toBe(403);
    expect((await manager.getErasure(erasure.id)).status).toBe(403);
  });

  it('erasing a conversation removes every message, then its subject; it then takes no new messages (409 erased)', async () => {
    const conv = (await newConv(member, 'Erase me whole'));
    const ids: string[] = [];
    for (const d of ['01', '02', '03', '04', '05']) {
      ids.push((await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: `2026-10-${d}T09:00:00Z`, body: `body ${d}`, participants: [{ role: 'FROM', address: `p${d}@x.example` }] })).body.message.id);
    }
    const res = await erase(adminA, 'CONVERSATION', conv.id, 'BUSINESS_REQUEST');
    expect(res.status).toBe(202);
    const outcome = res.body.erasure.status === 'COMPLETED' ? 'completed' : await finish(A.businessId, res.body.erasure.id);
    expect(outcome).toBe('completed');
    expect(await count('SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND (erased_at IS NULL OR body IS NOT NULL)', [conv.id])).toBe(0);
    const c = (await member.getConversation(conv.id)).body.conversation;
    expect(c.subject).toBeNull();
    expect(c.erasedAt).not.toBeNull();
    const add = await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-09T09:00:00Z', body: 'late', participants: [{ role: 'FROM', address: 'x@x.example' }] });
    expect(add).toMatchObject({ status: 409, body: { error: 'erased' } });
    // directly as bos_app too
    await expect(asApp(app, A.businessId, A.people.MEMBER!.id,
      `INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_by_id, body, content_hash)
       VALUES ($1, $2, $3, 'INBOUND', 'MANUAL', now(), $4, 'x', $5)`, [randomUUID(), A.businessId, conv.id, A.people.MEMBER!.id, hash64()]))
      .rejects.toMatchObject({ code: 'CM011' });
  });

  it('a contact erasure removes what identifies them and keeps other people\'s records (D-E1-6)', async () => {
    const cust = (await member.createCustomer({ displayName: 'Erasure Pty' })).body.customer;
    const pat = (await member.createContact({ firstName: 'Pat', email: 'Pat@Client.example', customerId: cust.id })).body.contact;
    const sam = (await member.createContact({ firstName: 'Sam', email: 'sam@client.example', customerId: cust.id })).body.contact;
    // 1. Pat's own message (FROM Pat) in Pat's conversation
    const patConv = (await member.createConversation({ channel: 'EMAIL', subject: 'Pat private', contactId: pat.id })).body.conversation;
    const own = (await member.recordMessage(patConv.id, { direction: 'INBOUND', occurredAt: '2026-10-01T09:00:00Z', body: 'From Pat', participants: [{ role: 'FROM', address: 'pat@client.example', contactId: pat.id }, { role: 'TO', address: 'us@biz.example' }] })).body.message;
    // 2. a shared thread: Sam wrote it, Pat is CC (matched by address, case-insensitive)
    const shared = (await member.createConversation({ channel: 'EMAIL', subject: 'Team thread', contactId: sam.id })).body.conversation;
    const samMsg = (await member.recordMessage(shared.id, { direction: 'INBOUND', occurredAt: '2026-10-02T09:00:00Z', body: 'Sam writes; Pat said earlier...', participants: [{ role: 'FROM', address: 'sam@client.example', contactId: sam.id }, { role: 'CC', address: 'PAT@client.example', displayName: 'Pat' }] })).body.message;
    // 3. Pat's conversation with a message from Sam in it
    const mixed = (await member.recordMessage(patConv.id, { direction: 'INBOUND', occurredAt: '2026-10-03T09:00:00Z', body: 'Sam joins', participants: [{ role: 'FROM', address: 'sam@client.example' }, { role: 'TO', address: 'pat@client.example' }] })).body.message;
    // 4. timeline notes about Pat, and one about Sam
    const patNote = (await member.createActivity({ type: 'note', contactId: pat.id, subject: 'Pat health', body: 'Pat mentioned a diagnosis' })).body.activity;
    const samNote = (await member.createActivity({ type: 'note', contactId: sam.id, body: 'Sam likes tea' })).body.activity;

    const res = await erase(owner, 'CONTACT', pat.id);
    expect(res.status).toBe(202);
    if (res.body.erasure.status !== 'COMPLETED') expect(await finish(A.businessId, res.body.erasure.id)).toBe('completed');
    const detail = ErasureDetailResponse.parse((await owner.getErasure(res.body.erasure.id)).body);
    // Pat's own message: gone
    expect(await messageRow(own.id)).toMatchObject({ body: null });
    // Sam's message with Pat in CC: kept, Pat's participant row scrubbed, Sam's kept, listed for review (quoted text)
    expect(await messageRow(samMsg.id)).toMatchObject({ body: 'Sam writes; Pat said earlier...', erased_at: null });
    const parts = await participantRows(samMsg.id);
    expect(parts.find((p: { contact_id: string | null }) => p.contact_id === sam.id)).toMatchObject({ address: 'sam@client.example' });
    expect(parts.filter((p: { erased_at: unknown }) => p.erased_at !== null)).toHaveLength(1);
    expect(JSON.stringify(parts)).not.toMatch(/pat@/i);
    expect(detail.reviewItems).toContainEqual({ entityType: 'MESSAGE', entityId: samMsg.id });
    // Sam's message in Pat's conversation: Sam is the author and a non-member participant, so it is kept; Pat's TO row goes
    expect(await messageRow(mixed.id)).toMatchObject({ body: 'Sam joins' });
    expect(JSON.stringify(await participantRows(mixed.id))).not.toMatch(/pat@/i);
    // Pat's conversation still holds Sam's message: kept, listed for review
    expect(detail.reviewItems).toContainEqual({ entityType: 'CONVERSATION', entityId: patConv.id });
    // timeline: Pat's note scrubbed, Sam's untouched; through the API too
    expect((await member.getActivity(patNote.id)).body.activity).toMatchObject({ subject: null, body: null });
    expect((await member.getActivity(patNote.id)).body.activity.erasedAt).not.toBeNull();
    expect((await member.getActivity(samNote.id)).body.activity).toMatchObject({ body: 'Sam likes tea' });
    expect(JSON.stringify((await member.listActivities(`?contactId=${pat.id}`)).body)).not.toMatch(/diagnosis|Pat health|From Pat/);
    // no participant row anywhere still links to Pat
    expect(await count('SELECT count(*) AS n FROM message_participants WHERE contact_id = $1', [pat.id])).toBe(0);
    // the contact record itself is outside E1 and stays
    expect(await count('SELECT count(*) AS n FROM contacts WHERE id = $1', [pat.id])).toBe(1);
    // an erased timeline note cannot be edited back
    expect((await member.getActivity(patNote.id)).status).toBe(200);
    await expect(asApp(app, A.businessId, A.people.MEMBER!.id, "UPDATE activities SET body = 'restored' WHERE id = $1", [patNote.id])).rejects.toBeTruthy();
  });

  it('retained records and legal holds defer a request; the deferral is rechecked and completes once the hold is released', async () => {
    const pat = (await member.createContact({ firstName: 'Held', email: 'held@client.example' })).body.contact;
    const conv = (await member.createConversation({ channel: 'EMAIL', subject: 'Held thread', contactId: pat.id })).body.conversation;
    const record = await seedCopy(A, conv.id, { category: 'RETAINED_RECORD', daysAgo: 10, participants: [{ role: 'FROM', address: 'held@client.example', contactId: pat.id }] });
    const ordinary = await seedCopy(A, conv.id, { category: 'ORDINARY', daysAgo: 10, participants: [{ role: 'FROM', address: 'held@client.example', contactId: pat.id }] });
    const placed = await adminA.placeHold({ scope: 'CONTACT', contactId: pat.id, reasonCode: 'LITIGATION' });
    expect(placed.status).toBe(201);
    const hold = LegalHoldResponse.parse(placed.body).hold;
    expect((await adminA.placeHold({ scope: 'CONTACT', contactId: pat.id, reasonCode: 'LITIGATION' })).status).toBe(200);
    expect((await member.placeHold({ scope: 'BUSINESS', reasonCode: 'OTHER' })).status).toBe(403);
    expect(ListLegalHoldsResponse.parse((await owner.listHolds()).body).holds.map((h) => h.id)).toContain(hold.id);

    const res = await erase(owner, 'CONTACT', pat.id);
    expect(res.body.erasure).toMatchObject({ status: 'DEFERRED', deferredReason: 'LEGAL_HOLD' });
    expect(await messageRow(ordinary)).toMatchObject({ erased_at: null });
    // a hold cannot be lifted by SQL, only by the audited, authorised function
    await expect(asApp(app, A.businessId, A.people.OWNER!.id, 'UPDATE communications_legal_holds SET released_at = now() WHERE id = $1', [hold.id])).rejects.toBeTruthy();
    await expect(asApp(app, A.businessId, A.people.OWNER!.id, 'DELETE FROM communications_legal_holds WHERE id = $1', [hold.id])).rejects.toBeTruthy();
    const relCode = (await adminA.authorize('RELEASE_LEGAL_HOLD', hold.id)).body.authorization.code;
    expect((await manager.releaseHold(hold.id, { authorization: relCode })).status).toBe(403);
    const released = await adminA.releaseHold(hold.id, { authorization: relCode });
    expect(released.status).toBe(200);
    expect(released.body.hold.releasedAt).not.toBeNull();
    // the worker rechecks a deferral daily (next_attempt_at); step it now
    expect(await finish(A.businessId, res.body.erasure.id)).toBe('deferred');
    const after = (await owner.getErasure(res.body.erasure.id)).body.erasure;
    // the ordinary copy is erased; the retained record stays until its own duration is decided (D-E1-5)
    expect(after).toMatchObject({ status: 'DEFERRED', deferredReason: 'RETAINED_RECORD' });
    expect(await messageRow(ordinary)).toMatchObject({ body: null });
    expect(await messageRow(record)).toMatchObject({ body: 'Seeded body' });
  });

  it('cross-tenant: B cannot see, request or authorise anything about A', async () => {
    const conv = (await newConv(owner, 'A only'));
    expect((await ownerB.authorize('ERASE_CONVERSATION', conv.id)).status).toBe(201); // a code for an id it cannot see is useless
    const code = (await ownerB.authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    expect((await ownerB.requestErasure({ targetType: 'CONVERSATION', targetId: conv.id, reason: 'BUSINESS_REQUEST', authorization: code })).status).toBe(404);
    const aErasure = (await owner.listErasures()).body.erasures[0];
    expect((await ownerB.getErasure(aErasure.id)).status).toBe(404);
    expect((await ownerB.listErasures()).body.erasures.some((e: { id: string }) => e.id === aErasure.id)).toBe(false);
    expect((await ownerB.listHolds('?includeReleased=true')).body.holds).toEqual([]);
  });
});

describe('what the application role cannot do', () => {
  it('bos_app cannot update or delete message history, ledger, holds, keys or markers, or call internal functions', async () => {
    const conv = (await newConv(member, 'locked down'));
    const msg = (await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-01T09:00:00Z', body: 'x', participants: [{ role: 'FROM', address: 'a@x.example' }] })).body.message;
    const id = A.businessId; const u = A.people.OWNER!.id;
    for (const sql of [
      'UPDATE messages SET body = NULL, erased_at = now() WHERE id = $1',
      'DELETE FROM messages WHERE id = $1',
      'UPDATE message_participants SET address = NULL WHERE message_id = $1',
      "UPDATE messages SET retention_category = 'STAGED_INTAKE' WHERE id = $1",
    ]) await expect(asApp(app, id, u, sql, [msg.id])).rejects.toBeTruthy();
    for (const sql of [
      'SELECT count(*) FROM communications_erasure_keys', 'SELECT count(*) FROM communications_erased_references', 'SELECT count(*) FROM communications_privileged_grants',
      "INSERT INTO communications_erasures (id, business_id, kind, reason_code, status) VALUES (gen_random_uuid(), current_setting('app.business_id')::uuid, 'RETENTION', 'RETENTION_EXPIRED', 'COMPLETED')",
      'DELETE FROM communications_erasure_items', 'UPDATE communications_erasures SET status = \'COMPLETED\'',
      "SELECT app_private.communications_tombstone_message(current_setting('app.business_id')::uuid, gen_random_uuid(), gen_random_uuid())",
      "SELECT app_private.communications_erasure_replay(current_setting('app.business_id')::uuid, 10)",
      "SELECT app_private.communications_erasure_actor('x', false)",
      "SELECT * FROM app_private.communications_erasure_plan(current_setting('app.business_id')::uuid, 'CONTACT', gen_random_uuid(), NULL, 1)",
      "INSERT INTO audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata) VALUES (gen_random_uuid(), current_setting('app.business_id')::uuid, NULL, 'communications.erasure.completed', 'erasure', gen_random_uuid(), '{}')",
    ]) await expect(asApp(app, id, u, sql)).rejects.toBeTruthy();
    // and cannot record a message as erased or categorised
    await expect(asApp(app, id, u,
      `INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_by_id, body, content_hash, retention_category)
       VALUES ($1, $2, $3, 'INBOUND', 'MANUAL', now(), $4, 'x', $5, 'STAGED_INTAKE')`, [randomUUID(), id, conv.id, u, hash64()])).rejects.toBeTruthy();
    // participants are written with their message only, never added to an existing one later
    await expect(asApp(app, id, u,
      "INSERT INTO message_participants (id, business_id, message_id, role, position, address) VALUES ($1, $2, $3, 'BCC', 0, 'late@x.example')",
      [randomUUID(), id, msg.id])).rejects.toMatchObject({ code: 'CM011' });
  });
});

describe('retention (D-E1-1, D-E1-3, D-E1-5)', () => {
  it('a shortened period waits 30 days unless the OWNER applies it early with an audited reason', async () => {
    const t = await team('e1ret');
    const o = api(t.people.OWNER!, t.slug);
    const set = await o.setRetention({ ordinaryRetentionDays: 400, version: null });
    expect(MailRetentionResponse.parse(set.body).retention).toMatchObject({ ordinaryRetentionDays: 400, ordinaryRetentionDaysInForce: 400, pendingReduction: null });
    const shorter = (await o.setRetention({ ordinaryRetentionDays: 100, version: set.body.retention.version })).body.retention;
    expect(shorter).toMatchObject({ ordinaryRetentionDays: 100, ordinaryRetentionDaysInForce: 400, pendingReduction: { previousDays: 400 } });
    const effectiveAt = new Date(shorter.pendingReduction.effectiveAt).getTime();
    expect(Math.abs(effectiveAt - (Date.now() + 30 * 86_400_000))).toBeLessThan(120_000);
    // a copy 200 days old is not due while 400 is in force
    const conv = (await newConv(o, 'retention'));
    const copy = await seedCopy(t, conv.id, { category: 'ORDINARY', daysAgo: 200 });
    expect((await worker(t.businessId)((db) => purgeExpired(db, 50)))).toBeNull();
    const el = RetentionEligibilityResponse.parse((await o.eligibility()).body).eligibility;
    expect(el.categories.find((c) => c.category === 'ORDINARY')).toMatchObject({ live: 1, due: 0 });
    // lengthening again ends the pending reduction at once
    const longer = (await o.setRetention({ ordinaryRetentionDays: 500, version: shorter.version })).body.retention;
    expect(longer).toMatchObject({ ordinaryRetentionDaysInForce: 500, pendingReduction: null });
    const again = (await o.setRetention({ ordinaryRetentionDays: 100, version: longer.version })).body.retention;
    expect(again).toMatchObject({ ordinaryRetentionDaysInForce: 500 });
    // bos_app cannot clear the delay itself
    await expect(asApp(app, t.businessId, t.people.OWNER!.id,
      'UPDATE mail_retention_settings SET previous_retention_days = NULL, shortening_effective_at = NULL')).rejects.toBeTruthy();
    // ADMIN cannot apply it early; OWNER can, once, with a reason
    expect((await api(t.people.ADMIN!, t.slug).authorize('APPLY_RETENTION_REDUCTION', null)).status).toBe(403);
    const code = (await o.authorize('APPLY_RETENTION_REDUCTION', null)).body.authorization.code;
    expect((await o.applyReduction({ authorization: code, reason: 'DATA_MINIMISATION' })).body).toEqual({ applied: true });
    expect((await o.applyReduction({ authorization: code, reason: 'DATA_MINIMISATION' })).status).toBe(403);
    expect((await o.retention()).body.retention).toMatchObject({ ordinaryRetentionDaysInForce: 100, pendingReduction: null });
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE business_id = $1 AND action = 'communications.erasure.retention_reduction_applied' AND metadata->>'reason' = 'DATA_MINIMISATION'", [t.businessId])).toBe(1);
    // now the copy is due and the purge erases it
    const purged = await worker(t.businessId)((db) => purgeExpired(db, 50));
    expect(purged).toMatchObject({ messages: 1 });
    expect(await messageRow(copy)).toMatchObject({ body: null });
  });

  it('eligibility boundaries per category; C1 and unshared personal copies never expire automatically', async () => {
    const t = await team('e1elig');
    const o = api(t.people.OWNER!, t.slug);
    const conv = (await newConv(o, 'boundaries'));
    // no retention period set yet: ORDINARY has no automatic expiry, STAGED_INTAKE still does (30 days)
    const ordinaryOld = await seedCopy(t, conv.id, { category: 'ORDINARY', daysAgo: 1000 });
    const stagedDue = await seedCopy(t, conv.id, { category: 'STAGED_INTAKE', daysAgo: 40, recordedDaysAgo: 31 });
    const stagedNotYet = await seedCopy(t, conv.id, { category: 'STAGED_INTAKE', daysAgo: 40, recordedDaysAgo: 29 });
    const personal = await seedCopy(t, conv.id, { category: 'PERSONAL_UNSHARED', daysAgo: 5000 });
    const retained = await seedCopy(t, conv.id, { category: 'RETAINED_RECORD', daysAgo: 5000 });
    const c1 = await seedCopy(t, conv.id, { category: null, daysAgo: 5000 });
    let el = RetentionEligibilityResponse.parse((await o.eligibility()).body).eligibility;
    expect(el.ordinaryRetentionDaysInForce).toBeNull();
    expect(el.categories.find((c) => c.category === 'ORDINARY')).toMatchObject({ due: 0, automaticExpiry: false });
    expect(el.categories.find((c) => c.category === 'STAGED_INTAKE')).toMatchObject({ live: 2, due: 1, automaticExpiry: true });
    expect(el.categories.find((c) => c.category === 'RETAINED_RECORD')).toMatchObject({ due: 0, automaticExpiry: false });
    // personal copies are not counted for administrators at all
    expect(JSON.stringify(el)).not.toMatch(/PERSONAL/);
    expect(el.unclassifiedLive).toBeGreaterThanOrEqual(1);
    expect((await api(t.people.MEMBER!, t.slug).eligibility()).status).toBe(403);
    // period 365 days: the 1000-day ORDINARY copy becomes due; boundary 364/366
    const set = await o.setRetention({ ordinaryRetentionDays: 365, version: null });
    expect(set.status).toBe(200);
    const edgeIn = await seedCopy(t, conv.id, { category: 'ORDINARY', daysAgo: 366 });
    const edgeOut = await seedCopy(t, conv.id, { category: 'ORDINARY', daysAgo: 364 });
    el = RetentionEligibilityResponse.parse((await o.eligibility()).body).eligibility;
    expect(el.categories.find((c) => c.category === 'ORDINARY')).toMatchObject({ live: 3, due: 2, automaticExpiry: true });
    // what eligibility reports is exactly what the purge erases
    let total = 0;
    for (;;) {
      const p = await worker(t.businessId)((db) => purgeExpired(db, 2));
      if (!p) break;
      total += p.messages;
    }
    expect(total).toBe(3);
    for (const id of [ordinaryOld, stagedDue, edgeIn]) expect((await messageRow(id)).erased_at).not.toBeNull();
    for (const id of [stagedNotYet, personal, retained, c1, edgeOut]) expect((await messageRow(id)).erased_at).toBeNull();
    // retention purges are ledger entries with counts only, and are audited
    const purges = ListErasuresResponse.parse((await o.listErasures('?kind=RETENTION')).body).erasures;
    expect(purges.reduce((n, e) => n + e.counts.messages, 0)).toBe(3);
    expect(purges.every((e) => e.status === 'COMPLETED' && e.reasonCode === 'RETENTION_EXPIRED' && e.requestedById === null)).toBe(true);
  });

  it('a business-wide hold stops the purge; holds by contact and mailbox protect only their copies', async () => {
    const t = await team('e1hold');
    const o = api(t.people.OWNER!, t.slug);
    await o.setRetention({ ordinaryRetentionDays: 30, version: null });
    const pat = (await o.createContact({ firstName: 'Pat', email: 'pat@hold.example' })).body.contact;
    const conv = (await o.createConversation({ channel: 'EMAIL', subject: 'holds', contactId: pat.id })).body.conversation;
    const other = (await newConv(o, 'other'));
    const patCopy = await seedCopy(t, conv.id, { category: 'ORDINARY', daysAgo: 90 });
    const otherCopy = await seedCopy(t, other.id, { category: 'ORDINARY', daysAgo: 90 });
    const biz = (await o.placeHold({ scope: 'BUSINESS', reasonCode: 'REGULATORY' })).body.hold;
    expect(await worker(t.businessId)((db) => purgeExpired(db, 50))).toBeNull();
    // the worker does not even pick the business while a business hold is active
    const summary = await runCommunicationsRetentionPass({ deadlineMs: 10_000, businessLimit: 500 });
    expect(await messageRow(patCopy)).toMatchObject({ erased_at: null });
    expect(summary.businessErrors).toBe(0);
    const code = (await o.authorize('RELEASE_LEGAL_HOLD', biz.id)).body.authorization.code;
    await o.releaseHold(biz.id, { authorization: code });
    await o.placeHold({ scope: 'CONTACT', contactId: pat.id, reasonCode: 'LITIGATION' });
    expect(await worker(t.businessId)((db) => purgeExpired(db, 50))).toMatchObject({ messages: 1 });
    expect(await messageRow(otherCopy)).toMatchObject({ body: null });
    expect(await messageRow(patCopy)).toMatchObject({ body: 'Seeded body' });
    // a conversation whose last message was purged loses its subject; a held one keeps it
    expect((await o.getConversation(other.id)).body.conversation).toMatchObject({ subject: null });
    expect((await o.getConversation(conv.id)).body.conversation).toMatchObject({ subject: 'holds' });
  });
});

describe('mailbox (CONNECTION) holds before C2-B3', () => {
  it('protect every copy in the business until copies record their mailbox (fail-safe)', async () => {
    const t = await team('e1conn');
    const o = api(t.people.OWNER!, t.slug);
    await o.setRetention({ ordinaryRetentionDays: 30, version: null });
    const conv = await newConv(o, 'connection hold');
    const copy = await seedCopy(t, conv.id, { category: 'ORDINARY', daysAgo: 90 });
    const connectionId = randomUUID();
    await admin.query(`INSERT INTO mail_connections (id, business_id, provider, owner_user_id, credential_holder_id, provider_account_id, principal_account_id,
      mailbox_address, granted_scopes) VALUES ($1, $2, 'GOOGLE', $3, $3, 'x', 'x', 'x@example.com', ARRAY['openid'])`, [connectionId, t.businessId, t.people.OWNER!.id]);
    const placed = await o.placeHold({ scope: 'CONNECTION', connectionId, reasonCode: 'LITIGATION' });
    expect(placed.status).toBe(201);
    expect(await worker(t.businessId)((db) => purgeExpired(db, 50))).toBeNull();
    expect(await messageRow(copy)).toMatchObject({ erased_at: null });
    const code = (await o.authorize('RELEASE_LEGAL_HOLD', placed.body.hold.id)).body.authorization.code;
    expect((await o.releaseHold(placed.body.hold.id, { authorization: code })).status).toBe(200);
    expect(await worker(t.businessId)((db) => purgeExpired(db, 50))).toMatchObject({ messages: 1 });
    // a hold naming another business's mailbox or contact is refused as not found
    const otherContact = (await ownerB.createContact({ firstName: 'Other' })).body.contact;
    expect((await o.placeHold({ scope: 'CONTACT', contactId: otherContact.id, reasonCode: 'OTHER' })).status).toBe(404);
  });
});

describe('keyed re-import markers (D-E1-2)', () => {
  it('an erased provider id cannot be re-imported while its marker lives; markers hold no raw id and expire', async () => {
    const conv = (await newConv(owner, 'import'));
    const extId = `<${randomUUID()}@mail.example>`;
    const imp = await owner.importMessages(conv.id, { messages: [{ direction: 'INBOUND', occurredAt: '2026-09-01T00:00:00Z', body: 'imported', participants: [{ role: 'FROM', address: 'i@x.example' }], external: { source: 'gmail', messageId: extId } }] });
    expect(imp.status).toBe(200);
    const msgId = imp.body.results[0].messageId;
    expect((await erase(owner, 'MESSAGE', msgId)).body.erasure.status).toBe('COMPLETED');
    // nothing in the database holds the raw provider id any more
    const raw = await count(
      `SELECT (SELECT count(*) FROM messages WHERE external_message_id = $1)
            + (SELECT count(*) FROM communications_erased_references WHERE digest::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%') AS n`, [extId]);
    expect(raw).toBe(0);
    const again = await owner.importMessages(conv.id, { messages: [{ direction: 'INBOUND', occurredAt: '2026-09-01T00:00:00Z', body: 'imported', participants: [{ role: 'FROM', address: 'i@x.example' }], external: { source: 'gmail', messageId: extId } }] });
    expect(again).toMatchObject({ status: 409, body: { error: 'erased' } });
    // the same id from another source, or in another business, is unaffected (keyed per business and source)
    const convB = (await newConv(ownerB, 'B import'));
    expect((await ownerB.importMessages(convB.id, { messages: [{ direction: 'INBOUND', occurredAt: '2026-09-01T00:00:00Z', body: 'b', participants: [{ role: 'FROM', address: 'i@x.example' }], external: { source: 'gmail', messageId: extId } }] })).status).toBe(200);
    // marker expiry: once expired and housekept, the id may be imported again (documented trade-off)
    await admin.query("UPDATE communications_erased_references SET created_at = now() - interval '400 days', expires_at = now() - interval '1 second' WHERE business_id = $1", [A.businessId]);
    expect(await worker(A.businessId)((db) => erasureHousekeeping(db, 1000))).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT count(*) AS n FROM communications_erased_references WHERE business_id = $1 AND expires_at <= now()', [A.businessId])).toBe(0);
    expect((await owner.importMessages(conv.id, { messages: [{ direction: 'INBOUND', occurredAt: '2026-09-01T00:00:00Z', body: 'imported', participants: [{ role: 'FROM', address: 'i@x.example' }], external: { source: 'gmail', messageId: extId } }] })).status).toBe(200);
  });
});

describe('ledger replay after a restore (D-E1-7)', () => {
  it('content restored from a backup is erased again by replay before the data is served', async () => {
    const t = await team('e1replay');
    const o = api(t.people.OWNER!, t.slug);
    const pat = (await o.createContact({ firstName: 'Pat', email: 'pat@replay.example' })).body.contact;
    const conv = (await o.createConversation({ channel: 'EMAIL', subject: 'replay', contactId: pat.id })).body.conversation;
    const msg = (await o.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-01T00:00:00Z', subject: 'S', body: 'restore me', participants: [{ role: 'FROM', address: 'pat@replay.example', contactId: pat.id }] })).body.message;
    const note = (await o.createActivity({ type: 'note', contactId: pat.id, body: 'note about Pat' })).body.activity;
    const res = await erase(o, 'CONTACT', pat.id);
    if (res.body.erasure.status !== 'COMPLETED') expect(await finish(t.businessId, res.body.erasure.id)).toBe('completed');
    // simulate restoring the content tables from a backup taken before the erasure (ledger kept)
    await bypassTriggers("UPDATE messages SET subject = 'S', body = 'restore me', erased_at = NULL WHERE id = $1", [msg.id]);
    await bypassTriggers("UPDATE message_participants SET address = 'pat@replay.example', erased_at = NULL WHERE message_id = $1", [msg.id]);
    await bypassTriggers("UPDATE activities SET body = 'note about Pat', erased_at = NULL WHERE id = $1", [note.id]);
    await bypassTriggers("UPDATE conversations SET subject = 'replay', erased_at = NULL WHERE id = $1", [conv.id]);
    const replayed = Number((await admin.query('SELECT app_private.communications_erasure_replay($1, 1000) AS n', [t.businessId])).rows[0].n);
    expect(replayed).toBeGreaterThanOrEqual(3);
    expect(await messageRow(msg.id)).toMatchObject({ subject: null, body: null });
    expect(JSON.stringify(await participantRows(msg.id))).not.toMatch(/pat@/);
    expect(await count('SELECT count(*) AS n FROM activities WHERE id = $1 AND body IS NULL AND erased_at IS NOT NULL', [note.id])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM conversations WHERE id = $1 AND subject IS NULL AND erased_at IS NOT NULL', [conv.id])).toBe(1);
    // replay is idempotent
    expect(Number((await admin.query('SELECT app_private.communications_erasure_replay($1, 1000) AS n', [t.businessId])).rows[0].n)).toBe(0);
  });
});

describe('worker and concurrency (docs/communications-e1.md §7, §9)', () => {
  it('two workers on one request: one runs, the other reports busy and changes nothing', async () => {
    const conv = (await newConv(member, 'two workers'));
    for (const d of ['01', '02', '03']) await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: `2026-10-${d}T00:00:00Z`, body: d, participants: [{ role: 'FROM', address: 'w@x.example' }] });
    // create the request without its first step by holding the row: record via the function directly
    const code = (await owner.authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    const { rows } = await asApp(app, A.businessId, A.people.OWNER!.id,
      "SELECT erasure_id FROM app_private.communications_request_erasure($1, $2, 'CONVERSATION', $3, 'BUSINESS_REQUEST')", [A.people.OWNER!.token, code, conv.id]);
    const erasureId = rows[0].erasure_id as string;
    // worker 1 holds a step open
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', '', true)", [A.businessId]);
    const first = (await app.query('SELECT outcome FROM app_private.communications_erasure_step($1, 1)', [erasureId])).rows[0].outcome;
    expect(first).toBe('progress');
    // worker 2 meanwhile
    const second = await worker(A.businessId)((db) => stepErasure(db, erasureId, 10));
    expect(second).toEqual({ outcome: 'busy', processed: 0 });
    await app.query('COMMIT');
    expect(await finish(A.businessId, erasureId)).toBe('completed');
    expect((await owner.getErasure(erasureId)).body.erasure.counts.messages).toBe(3);
  });

  it('a message recorded while its conversation is being erased waits, then is refused (409 erased); none is left live', async () => {
    const conv = (await newConv(member, 'race insert'));
    await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-01T00:00:00Z', body: 'one', participants: [{ role: 'FROM', address: 'r@x.example' }] });
    const code = (await owner.authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    const { rows } = await asApp(app, A.businessId, A.people.OWNER!.id,
      "SELECT erasure_id FROM app_private.communications_request_erasure($1, $2, 'CONVERSATION', $3, 'BUSINESS_REQUEST')", [A.people.OWNER!.token, code, conv.id]);
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', '', true)", [A.businessId]);
    expect((await app.query('SELECT outcome FROM app_private.communications_erasure_step($1, 50)', [rows[0].erasure_id])).rows[0].outcome).toBe('completed');
    const pid = await backendPid(app);
    const racing = member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-02T00:00:00Z', body: 'racing', participants: [{ role: 'FROM', address: 'r@x.example' }] });
    await waitUntilBlocked(observer, pid);
    await app.query('COMMIT');
    expect(await racing).toMatchObject({ status: 409, body: { error: 'erased' } });
    expect(await count('SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND erased_at IS NULL', [conv.id])).toBe(0);
  });

  it('a message recorded just before the step commits first, and the step then erases it too', async () => {
    const conv = (await newConv(member, 'race insert first'));
    await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-01T00:00:00Z', body: 'one', participants: [{ role: 'FROM', address: 'r@x.example' }] });
    const code = (await owner.authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    const { rows } = await asApp(app, A.businessId, A.people.OWNER!.id,
      "SELECT erasure_id FROM app_private.communications_request_erasure($1, $2, 'CONVERSATION', $3, 'BUSINESS_REQUEST')", [A.people.OWNER!.token, code, conv.id]);
    // an uncommitted insert holds the conversation (FOR KEY SHARE); the step's FOR UPDATE waits for it
    const writer = A.people.MEMBER!.id;
    await app2.query('BEGIN');
    await app2.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, writer]);
    const late = randomUUID();
    await app2.query(`INSERT INTO messages (id, business_id, conversation_id, direction, source, occurred_at, recorded_by_id, body, content_hash)
                      VALUES ($1, $2, $3, 'INBOUND', 'MANUAL', now(), $4, 'just in time', $5)`, [late, A.businessId, conv.id, writer, hash64()]);
    const pid = await backendPid(app2);
    const step = finish(A.businessId, rows[0].erasure_id);
    await waitUntilBlocked(observer, pid);
    // what recordMessage does next while the step waits: touch the conversation (KEY SHARE -> NO KEY UPDATE on a
    // row the step is queued for). This must not deadlock (docs/communications-e1.md §9).
    await app2.query('UPDATE conversations SET last_message_at = now() WHERE business_id = $1 AND id = $2', [A.businessId, conv.id]);
    await app2.query('COMMIT');
    expect(await step).toBe('completed');
    expect(await messageRow(late)).toMatchObject({ body: null });
    expect((await member.getConversation(conv.id)).body.conversation.erasedAt).not.toBeNull();
  });

  it('a hold placed during an erasure step waits for it; a step after the hold defers', async () => {
    const pat = (await member.createContact({ firstName: 'Race', email: 'race@hold.example' })).body.contact;
    const conv = (await member.createConversation({ channel: 'EMAIL', subject: 'hold race', contactId: pat.id })).body.conversation;
    for (const d of ['01', '02']) await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: `2026-10-${d}T00:00:00Z`, body: d, participants: [{ role: 'FROM', address: 'race@hold.example', contactId: pat.id }] });
    const code = (await owner.authorize('ERASE_CONTACT', pat.id)).body.authorization.code;
    const { rows } = await asApp(app, A.businessId, A.people.OWNER!.id,
      "SELECT erasure_id FROM app_private.communications_request_erasure($1, $2, 'CONTACT', $3, 'DATA_SUBJECT_REQUEST')", [A.people.OWNER!.token, code, pat.id]);
    const erasureId = rows[0].erasure_id as string;
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', '', true)", [A.businessId]);
    expect((await app.query('SELECT outcome FROM app_private.communications_erasure_step($1, 1)', [erasureId])).rows[0].outcome).toBe('progress');
    const pid = await backendPid(app);
    const hold = adminA.placeHold({ scope: 'CONTACT', contactId: pat.id, reasonCode: 'INVESTIGATION' });
    await waitUntilBlocked(observer, pid);
    await app.query('COMMIT');
    expect((await hold).status).toBe(201);
    expect(await finish(A.businessId, erasureId)).toBe('deferred');
    // exactly one message was erased before the hold; the other is protected
    expect(await count('SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND erased_at IS NOT NULL', [conv.id])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND erased_at IS NULL AND body IS NOT NULL', [conv.id])).toBe(1);
  });

  it('a retention change during a purge waits for it (the period is read FOR SHARE)', async () => {
    const t = await team('e1race');
    const o = api(t.people.OWNER!, t.slug);
    const set = (await o.setRetention({ ordinaryRetentionDays: 30, version: null })).body.retention;
    const conv = (await newConv(o, 'purge race'));
    await seedCopy(t, conv.id, { category: 'ORDINARY', daysAgo: 60 });
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', '', true)", [t.businessId]);
    expect((await app.query('SELECT messages FROM app_private.communications_retention_purge(50)')).rows[0].messages).toBe(1);
    const pid = await backendPid(app);
    const change = o.setRetention({ ordinaryRetentionDays: 3650, version: set.version });
    await waitUntilBlocked(observer, pid);
    await app.query('COMMIT');
    expect((await change).status).toBe(200);
  });

  it('a failed step rolls back whole and is retried with backoff and a content-free code', async () => {
    const conv = (await newConv(member, 'failing'));
    await member.recordMessage(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-01T00:00:00Z', body: 'one', participants: [{ role: 'FROM', address: 'f@x.example' }] });
    const code = (await owner.authorize('ERASE_CONVERSATION', conv.id)).body.authorization.code;
    const { rows } = await asApp(app, A.businessId, A.people.OWNER!.id,
      "SELECT erasure_id FROM app_private.communications_request_erasure($1, $2, 'CONVERSATION', $3, 'BUSINESS_REQUEST')", [A.people.OWNER!.token, code, conv.id]);
    const erasureId = rows[0].erasure_id as string;
    // a row lock held elsewhere makes the step time out (lock_timeout), as a real conflict would; the worker
    // records the failure the same way runCommunicationsRetentionPass does
    await admin.query('BEGIN');
    await admin.query('SELECT 1 FROM messages WHERE conversation_id = $1 FOR UPDATE', [conv.id]);
    let failure: unknown;
    try {
      await worker(A.businessId)(async (db) => {
        await db.$queryRaw`SELECT set_config('lock_timeout', '200ms', true)`;
        return stepErasure(db, erasureId, 10);
      });
    } catch (error) {
      failure = error;
      await worker(A.businessId)((db) => recordErasureFailure(db, erasureId, failureCode(error)));
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(failureCode(failure)).toBe('lock_timeout');
    const e = (await owner.getErasure(erasureId)).body.erasure;
    expect(e).toMatchObject({ status: 'PENDING', attempts: 1, lastErrorCode: 'lock_timeout', counts: { messages: 0 } });
    expect(new Date(e.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(await count('SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND erased_at IS NULL', [conv.id])).toBe(1);
    expect(await finish(A.businessId, erasureId)).toBe('completed');
  });

  it('the scheduled route is off unless both CRON_SECRET and COMMUNICATIONS_RETENTION_JOBS_ENABLED are set', async () => {
    const res = await retentionJobRoute.GET(new Request(`${BASE}/api/internal/jobs/communications-retention`, { headers: { authorization: 'Bearer x' } }));
    expect(res.status).toBe(503);
  });
});
