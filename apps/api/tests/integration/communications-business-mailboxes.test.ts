import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Communications C2-B1 (docs/communications-c2.md §16): mailbox kind and identity, verified business
 * domains, designated business addresses (with OWNER attestation for consumer addresses), business
 * mailbox connect / reconnect / handover, members (READ/SEND), credential-holder departure, the
 * ordinary-communications retention gate, database guards and tenant isolation. Real route handlers
 * against PostgreSQL with the migrations applied as in production. Google, Microsoft Graph and DNS are
 * replaced by in-process fakes; no real provider credential exists anywhere here, and no mail is read.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.COMMUNICATIONS_CREDENTIAL_KEYS = `test-k2:${randomBytes(32).toString('base64')},test-k1:${randomBytes(32).toString('base64')}`;
process.env.COMMUNICATIONS_CONNECT_ENABLED = 'true';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-google-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-google-secret';
process.env.MICROSOFT_OAUTH_CLIENT_ID = 'fake-microsoft-client';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'fake-microsoft-secret';

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as connectionsRoute from '@/app/api/v1/b/[slug]/communications/connections/route';
import * as authorizeRoute from '@/app/api/v1/b/[slug]/communications/connections/authorize/route';
import * as connectionRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/route';
import * as disconnectRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/disconnect/route';
import * as syncRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/sync/route';
import * as syncJobsRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/sync-jobs/route';
import * as membersRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/members/route';
import * as memberRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/members/[userId]/route';
import * as memberRemoveRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/members/[userId]/remove/route';
import * as domainsRoute from '@/app/api/v1/b/[slug]/communications/business-domains/route';
import * as domainVerifyRoute from '@/app/api/v1/b/[slug]/communications/business-domains/[domainId]/verify/route';
import * as domainRemoveRoute from '@/app/api/v1/b/[slug]/communications/business-domains/[domainId]/remove/route';
import * as addressesRoute from '@/app/api/v1/b/[slug]/communications/business-addresses/route';
import * as addressRemoveRoute from '@/app/api/v1/b/[slug]/communications/business-addresses/[addressId]/remove/route';
import * as retentionRoute from '@/app/api/v1/b/[slug]/communications/retention/route';
import * as callbackRoute from '@/app/api/v1/communications/oauth/callback/route';
import { withTenant } from '@/core/db';
import { devOutbox } from '@/core/email';
import { claimSyncJob, completeSyncJob, obtainAccessToken, type TenantRun } from '@/modules/communications';
import { CONSUMER_MAIL_DOMAINS, setTxtLookupForTests } from '@/modules/communications/server/business-mailboxes';
import {
  ListMailBusinessAddressesResponse, ListMailConnectionMembersResponse, MailBusinessAddressResponse, MailBusinessDomainResponse, MailConnectionResponse,
  MailRetentionResponse,
} from '@business-os/contracts';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

// ---- fake Google, Microsoft Graph and DNS --------------------------------------------------------

const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
/** A signed-in account at a provider. Microsoft accounts carry their tenant; Google Workspace ones their hd. */
type Account = { provider: 'GOOGLE' | 'MICROSOFT'; id: string; email: string; name: string; tid?: string; hd?: string };
type Grant = { account: Account; challenge: string; redirect: string; scope: string };
const fake = {
  codes: new Map<string, Grant>(),
  access: new Map<string, Account>(),
  refresh: new Map<string, Account>(),
  /** Microsoft directory objects (users and shared mailboxes) by tenant. */
  directory: new Map<string, Account[]>(),
  /** "principalId:mailboxId": Exchange Full Access to a mailbox that is not the principal's own. */
  fullAccess: new Set<string>(),
  /** Verified domains of each Microsoft tenant. */
  tenantDomains: new Map<string, string[]>(),
  txt: new Map<string, string[]>(),
  calls: [] as string[],
  issued: [] as string[],
};
const realFetch = globalThis.fetch;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const issue = (prefix: string, account: Account, map: Map<string, Account>) => {
  const token = `${prefix}-${randomBytes(24).toString('base64url')}`;
  map.set(token, account);
  fake.issued.push(token);
  return token;
};
const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
const GOOGLE_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly';

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/googleapis\.com|accounts\.google\.com|microsoftonline\.com|graph\.microsoft\.com/.test(url)) return realFetch(input, init);
  fake.calls.push(url);
  const form = typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  const bearer = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
  const isGoogle = url.includes('google');
  if (url === 'https://oauth2.googleapis.com/token' || url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    if (form.grant_type === 'authorization_code') {
      const grant = fake.codes.get(form.code!);
      fake.codes.delete(form.code!);
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (!grant || grant.challenge !== challenge || grant.redirect !== form.redirect_uri) return reply({ error: 'invalid_grant' }, 400);
      const a = grant.account;
      return reply({
        access_token: issue('at', a, fake.access), refresh_token: issue('rt', a, fake.refresh), expires_in: 3600, token_type: 'Bearer',
        // Microsoft grants what was asked for (all or nothing); Google reports its long scope names.
        scope: isGoogle ? GOOGLE_SCOPES : grant.scope.split(' ').filter((s) => !['offline_access', 'openid', 'email'].includes(s)).map((s) => `https://graph.microsoft.com/${s}`).join(' '),
        ...(isGoogle ? {} : { id_token: jwt({ tid: a.tid, oid: a.id }) }),
      });
    }
    const a = fake.refresh.get(form.refresh_token!);
    if (!a) return reply({ error: 'invalid_grant' }, 400);
    if (!isGoogle) fake.refresh.delete(form.refresh_token!);
    return reply({ access_token: issue('at', a, fake.access), expires_in: 3600, scope: form.scope ?? GOOGLE_SCOPES, ...(isGoogle ? {} : { refresh_token: issue('rt', a, fake.refresh) }) });
  }
  const a = fake.access.get(bearer);
  if (!a) return reply({ error: 'invalid_token' }, 401);
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
    return reply({ sub: a.id, email: a.email, email_verified: true, name: a.name, ...(a.hd ? { hd: a.hd } : {}) });
  }
  if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return reply({ emailAddress: a.email, messagesTotal: 7 });
  const graph = /^https:\/\/graph\.microsoft\.com\/v1\.0\/(.*)$/.exec(url)?.[1] ?? '';
  if (graph.startsWith('me?')) return reply({ id: a.id, mail: a.email, userPrincipalName: a.email, displayName: a.name });
  if (graph.startsWith('me/mailFolders/inbox')) return reply({ id: 'inbox' });
  if (graph.startsWith('organization')) return reply({ value: [{ verifiedDomains: (fake.tenantDomains.get(a.tid!) ?? []).map((name) => ({ name })) }] });
  const inbox = /^users\/([^/?]+)\/mailFolders\/inbox/.exec(graph);
  if (inbox) {
    const id = decodeURIComponent(inbox[1]!);
    return id === a.id || fake.fullAccess.has(`${a.id}:${id}`) ? reply({ id: 'inbox' }) : reply({ error: { code: 'ErrorAccessDenied' } }, 403);
  }
  const user = /^users\/([^/?]+)\?/.exec(graph);
  if (user) {
    // Delegated lookups see the principal's own directory only.
    const hit = (fake.directory.get(a.tid!) ?? []).find((d) => d.email.toLowerCase() === decodeURIComponent(user[1]!).toLowerCase());
    return hit ? reply({ id: hit.id, mail: hit.email, displayName: hit.name }) : reply({ error: { code: 'Request_ResourceNotFound' } }, 404);
  }
  return reply({ error: 'not_found' }, 404);
}

// ---- users, businesses and API helpers -------------------------------------------------------------

let ip = 1;
const nextIp = (block: number) => `100.${block}.${Math.floor(ip / 250) % 256}.${ip++ % 250}`;
type User = { email: string; cookie: string; id: string };
function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': nextIp(120), origin: ORIGIN });
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
  await authRoute.GET(new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': nextIp(121) } }));
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
  for (const role of ['ADMIN', 'ADMIN2', 'MANAGER', 'MEMBER']) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role: role.replace('2', '') } }), ctx({ slug }));
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
  const base = `/api/v1/b/${slug}/communications`;
  const r = (method: string, path: string, body?: unknown) => req(method, `${base}${path}`, { cookie: who.cookie, body });
  return {
    list: (qs = '') => connectionsRoute.GET(r('GET', `/connections${qs}`), ctx({ slug })).then(json),
    authorize: (body: unknown) => authorizeRoute.POST(r('POST', '/connections/authorize', body), ctx({ slug })).then(json),
    get: (connectionId: string) => connectionRoute.GET(r('GET', `/connections/${connectionId}`), ctx({ slug, connectionId })).then(json),
    update: (connectionId: string, body: unknown) => connectionRoute.PATCH(r('PATCH', `/connections/${connectionId}`, body), ctx({ slug, connectionId })).then(json),
    disconnect: (connectionId: string) => disconnectRoute.POST(r('POST', `/connections/${connectionId}/disconnect`), ctx({ slug, connectionId })).then(json),
    sync: (connectionId: string) => syncRoute.POST(r('POST', `/connections/${connectionId}/sync`, {}), ctx({ slug, connectionId })).then(json),
    jobs: (connectionId: string) => syncJobsRoute.GET(r('GET', `/connections/${connectionId}/sync-jobs`), ctx({ slug, connectionId })).then(json),
    members: (connectionId: string) => membersRoute.GET(r('GET', `/connections/${connectionId}/members`), ctx({ slug, connectionId })).then(json),
    grant: (connectionId: string, userId: string, access: string) =>
      memberRoute.PUT(r('PUT', `/connections/${connectionId}/members/${userId}`, { access }), ctx({ slug, connectionId, userId })).then(json),
    revoke: (connectionId: string, userId: string) =>
      memberRemoveRoute.POST(r('POST', `/connections/${connectionId}/members/${userId}/remove`), ctx({ slug, connectionId, userId })).then(json),
    domains: () => domainsRoute.GET(r('GET', '/business-domains'), ctx({ slug })).then(json),
    addDomain: (domain: string) => domainsRoute.POST(r('POST', '/business-domains', { domain }), ctx({ slug })).then(json),
    verifyDomain: (domainId: string, version: number) =>
      domainVerifyRoute.POST(r('POST', `/business-domains/${domainId}/verify`, { version }), ctx({ slug, domainId })).then(json),
    removeDomain: (domainId: string, version: number) =>
      domainRemoveRoute.POST(r('POST', `/business-domains/${domainId}/remove`, { version }), ctx({ slug, domainId })).then(json),
    addresses: (qs = '') => addressesRoute.GET(r('GET', `/business-addresses${qs}`), ctx({ slug })).then(json),
    designate: (body: unknown) => addressesRoute.POST(r('POST', '/business-addresses', body), ctx({ slug })).then(json),
    removeAddress: (addressId: string, version: number) =>
      addressRemoveRoute.POST(r('POST', `/business-addresses/${addressId}/remove`, { version }), ctx({ slug, addressId })).then(json),
    retention: () => retentionRoute.GET(r('GET', '/retention'), ctx({ slug })).then(json),
    setRetention: (body: unknown) => retentionRoute.PUT(r('PUT', '/retention', body), ctx({ slug })).then(json),
  };
};

function consent(authorizationUrl: string, account: Account) {
  const p = new URL(authorizationUrl).searchParams;
  const code = `code-${randomBytes(16).toString('base64url')}`;
  fake.codes.set(code, { account, challenge: p.get('code_challenge')!, redirect: p.get('redirect_uri')!, scope: p.get('scope')! });
  return `/api/v1/communications/oauth/callback?code=${code}&state=${encodeURIComponent(p.get('state')!)}`;
}
async function callback(path: string, who: User) {
  const res = await callbackRoute.GET(new Request(`${BASE}${path}`, { method: 'GET', headers: { 'x-forwarded-for': nextIp(122), cookie: who.cookie } }));
  return { status: res.status, html: await res.text() };
}
/** Starts a consent as `who` and finishes it signed in at the provider as `acct`. */
async function consentAs(who: User, slug: string, body: Record<string, unknown>, acct: Account) {
  const started = await api(who, slug).authorize(body);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { url: started.body.authorizationUrl as string, done: await callback(consent(started.body.authorizationUrl, acct), who) };
}

let seq = 0;
const uniq = () => `${++seq}-${randomBytes(3).toString('hex')}`;
const googleAccount = (email: string, hd?: string): Account => ({ provider: 'GOOGLE', id: `g-${randomUUID()}`, email, name: `G ${email}`, ...(hd ? { hd } : {}) });
const msAccount = (email: string, tid: string): Account => {
  const a: Account = { provider: 'MICROSOFT', id: randomUUID(), email, name: `M ${email}`, tid };
  fake.directory.set(tid, [...(fake.directory.get(tid) ?? []), a]);
  return a;
};

/** Adds and verifies a domain through the API (DNS is the fake TXT map). Returns its id. */
async function verifiedDomain(who: User, slug: string, domain: string): Promise<string> {
  const added = await api(who, slug).addDomain(domain);
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  const d = MailBusinessDomainResponse.parse(added.body).domain;
  fake.txt.set(d.dnsRecord.name, ['v=spf1 -all', d.dnsRecord.value!]);
  const verified = await api(who, slug).verifyDomain(d.id, d.version);
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return d.id;
}
async function designate(who: User, slug: string, address: string, attest = false): Promise<string> {
  const res = await api(who, slug).designate({ address, ...(attest ? { attestation: { statement: 'v1', accepted: true } } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.address.id;
}
const connectionFor = async (who: User, slug: string, address: string) =>
  (await api(who, slug).list()).body.connections.find((c: { mailboxAddress: string }) => c.mailboxAddress === address);

async function asApp(businessId: string, userId: string, sql: string, params: unknown[] = []) {
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
const sqlState = (e: unknown) => (e as { code?: string }).code;
const count = async (sql: string, params: unknown[]) => Number((await admin.query(sql, params)).rows[0].n);
const system = <T>(businessId: string, work: Parameters<typeof withTenant<T>>[1]) => withTenant({ businessId, userId: null }, work);
const runAs = (businessId: string, userId: string): TenantRun => (work, opts) => withTenant({ businessId, userId: opts?.system ? null : userId }, work);

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
const consoleOutput: string[] = [];

beforeAll(async () => {
  await Promise.all([admin.connect(), app.connect()]);
  vi.stubGlobal('fetch', fakeFetch);
  setTxtLookupForTests(async (name) => fake.txt.get(name) ?? []);
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
      original(...args);
    });
  }
  A = await team('c2b1a');
  B = await team('c2b1b');
});
afterAll(async () => {
  setTxtLookupForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all([admin.end(), app.end()]);
});
beforeEach(() => {
  fake.calls = [];
});
afterEach(() => {
  const leaked = consoleOutput.filter((line) => fake.issued.some((t) => line.includes(t)) || /fake-(google|microsoft)-secret/.test(line));
  expect(leaked).toEqual([]);
});

describe('retention period (owner clarification: required before BUSINESS sync and before sharing PERSONAL mail)', () => {
  it('has no default; only manage_connections sets it; it can be changed, never unset; stale versions are refused', async () => {
    const C = await team('c2b1ret');
    expect(MailRetentionResponse.parse((await api(C.people.MEMBER!, C.slug).retention()).body).retention).toEqual({
      ordinaryRetentionDays: null, updatedAt: null, version: null,
    });
    for (const who of [C.people.MANAGER!, C.people.MEMBER!]) expect((await api(who, C.slug).setRetention({ ordinaryRetentionDays: 365, version: null })).status).toBe(403);
    for (const bad of [{ ordinaryRetentionDays: 0, version: null }, { ordinaryRetentionDays: 36526, version: null }, { ordinaryRetentionDays: null, version: null }, {}]) {
      expect((await api(C.people.ADMIN!, C.slug).setRetention(bad)).status).toBe(400);
    }
    const set = await api(C.people.ADMIN!, C.slug).setRetention({ ordinaryRetentionDays: 1095, version: null });
    expect(set.body.retention).toMatchObject({ ordinaryRetentionDays: 1095, version: 1 });
    expect((await api(C.people.OWNER!, C.slug).setRetention({ ordinaryRetentionDays: 2555, version: null })).body).toEqual({ error: 'stale' });
    expect((await api(C.people.OWNER!, C.slug).setRetention({ ordinaryRetentionDays: 2555, version: 1 })).body.retention).toMatchObject({ ordinaryRetentionDays: 2555, version: 2 });
    const audit = (await admin.query("SELECT actor_user_id, metadata FROM audit_events WHERE business_id = $1 AND action = 'communications.retention.ordinary_set' ORDER BY created_at", [C.businessId])).rows;
    expect(audit.map((a) => a.metadata)).toEqual([{ ordinaryRetentionDays: '1095', previousDays: null }, { ordinaryRetentionDays: '2555', previousDays: '1095' }]);
    // No DELETE grant: the period can never be removed by the application.
    expect(await asApp(C.businessId, C.people.OWNER!.id, 'DELETE FROM mail_retention_settings').then(() => 'ok', sqlState)).toBe('42501');
  });
});

describe('business domains (DNS verification)', () => {
  it('manage_connections adds a domain, sees the TXT value once, and verifies it with a server-side lookup', async () => {
    const domain = `acme-${uniq()}.example`;
    for (const who of [A.people.MANAGER!, A.people.MEMBER!]) expect((await api(who, A.slug).addDomain(domain)).status).toBe(403);
    const added = await api(A.people.ADMIN!, A.slug).addDomain(domain.toUpperCase());
    expect(added.status).toBe(201);
    const d = MailBusinessDomainResponse.parse(added.body).domain;
    expect(d).toMatchObject({ domain, status: 'PENDING', dnsRecord: { type: 'TXT', name: `_business-os-verification.${domain}` } });
    expect(d.dnsRecord.value).toMatch(/^business-os-verification=[A-Za-z0-9_-]{43}$/);
    // Only the hash is stored, and the value is never shown again.
    const stored = (await admin.query('SELECT verification_token_hash FROM mail_business_domains WHERE id = $1', [d.id])).rows[0].verification_token_hash;
    expect(stored).toBe(createHash('sha256').update(d.dnsRecord.value!.split('=')[1]!).digest('hex'));
    expect(JSON.stringify((await api(A.people.ADMIN!, A.slug).domains()).body)).not.toContain(d.dnsRecord.value!.split('=')[1]!);
    expect((await api(A.people.ADMIN!, A.slug).addDomain(domain)).body).toEqual({ error: 'domain_exists' });
    expect((await api(A.people.ADMIN!, A.slug).addDomain('gmail.com')).body).toEqual({ error: 'consumer_domain' });
    // Missing or wrong record: refused and audited; nothing changes.
    expect((await api(A.people.ADMIN!, A.slug).verifyDomain(d.id, 1)).body).toEqual({ error: 'dns_record_not_found' });
    fake.txt.set(d.dnsRecord.name, [`business-os-verification=${randomBytes(32).toString('base64url')}`]);
    expect((await api(A.people.ADMIN!, A.slug).verifyDomain(d.id, 1)).body).toEqual({ error: 'dns_record_not_found' });
    fake.txt.set(d.dnsRecord.name, [d.dnsRecord.value!]);
    expect((await api(A.people.ADMIN!, A.slug).verifyDomain(d.id, 9)).body).toEqual({ error: 'stale' });
    const ok = await api(A.people.OWNER!, A.slug).verifyDomain(d.id, 1);
    expect(ok.body.domain).toMatchObject({ status: 'VERIFIED', version: 2 });
    expect((await api(A.people.OWNER!, A.slug).verifyDomain(d.id, 2)).body).toEqual({ error: 'already_verified' });
    const actions = (await admin.query("SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at", [d.id])).rows;
    expect(actions.map((a) => a.action)).toEqual(['communications.domain.added', 'communications.domain.verification_failed', 'communications.domain.verification_failed', 'communications.domain.verified']);
    expect(JSON.stringify(actions)).not.toContain(domain);
  });

  it('a domain cannot be removed while a designated address is on it; removed is final', async () => {
    const domain = `rm-${uniq()}.example`;
    const id = await verifiedDomain(A.people.ADMIN!, A.slug, domain);
    const addressId = await designate(A.people.ADMIN!, A.slug, `hello@${domain}`);
    expect((await api(A.people.ADMIN!, A.slug).removeDomain(id, 2)).body).toEqual({ error: 'domain_in_use' });
    expect((await api(A.people.ADMIN!, A.slug).removeAddress(addressId, 1)).status).toBe(200);
    expect((await api(A.people.ADMIN!, A.slug).removeDomain(id, 2)).body.domain).toMatchObject({ status: 'REMOVED' });
    expect((await api(A.people.ADMIN!, A.slug).removeDomain(id, 3)).body).toEqual({ error: 'removed' });
  });
});

describe('designated business addresses (T-C2-2)', () => {
  it('custom domains must be verified; consumer addresses need an OWNER attestation, recorded and audited', async () => {
    const domain = `unverified-${uniq()}.example`;
    await api(A.people.ADMIN!, A.slug).addDomain(domain);
    expect((await api(A.people.ADMIN!, A.slug).designate({ address: `info@${domain}` })).body).toEqual({ error: 'domain_not_verified' });
    expect((await api(A.people.ADMIN!, A.slug).designate({ address: `info@never-${uniq()}.example` })).body).toEqual({ error: 'domain_not_verified' });
    expect((await api(A.people.MANAGER!, A.slug).designate({ address: 'x@gmail.com' })).status).toBe(403);
    const consumer = `joesplumbing-${uniq()}@gmail.com`;
    expect((await api(A.people.OWNER!, A.slug).designate({ address: consumer })).body).toEqual({ error: 'attestation_required' });
    // ADMIN has manage_connections but only an OWNER may attest (owner decision D-C2-3).
    expect((await api(A.people.ADMIN!, A.slug).designate({ address: consumer, attestation: { statement: 'v1', accepted: true } })).status).toBe(403);
    expect((await api(A.people.OWNER!, A.slug).designate({ address: consumer, attestation: { statement: 'v1', accepted: false } })).status).toBe(400);
    const made = await api(A.people.OWNER!, A.slug).designate({ address: consumer.toUpperCase(), attestation: { statement: 'v1', accepted: true } });
    expect(made.status).toBe(201);
    const address = MailBusinessAddressResponse.parse(made.body).address;
    expect(address).toMatchObject({ address: consumer, basis: 'OWNER_ATTESTATION', attestedById: A.people.OWNER!.id, domainId: null, connectionId: null });
    const audit = (await admin.query("SELECT action, actor_user_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at", [address.id])).rows;
    expect(audit).toEqual([
      { action: 'communications.address.designated', actor_user_id: A.people.OWNER!.id, metadata: { basis: 'OWNER_ATTESTATION', domainId: null } },
      { action: 'communications.address.attested', actor_user_id: A.people.OWNER!.id, metadata: { statement: 'v1' } },
    ]);
    expect((await api(A.people.OWNER!, A.slug).designate({ address: consumer, attestation: { statement: 'v1', accepted: true } })).body).toEqual({ error: 'already_designated' });
    // An attestation on a verified custom domain is refused (the record must say what was proved).
    const verified = `att-${uniq()}.example`;
    await verifiedDomain(A.people.ADMIN!, A.slug, verified);
    expect((await api(A.people.OWNER!, A.slug).designate({ address: `info@${verified}`, attestation: { statement: 'v1', accepted: true } })).body)
      .toEqual({ error: 'attestation_not_applicable' });
    const listed = ListMailBusinessAddressesResponse.parse((await api(A.people.ADMIN!, A.slug).addresses()).body).addresses;
    expect(listed.map((a) => a.address)).toContain(consumer);
    expect((await api(A.people.MANAGER!, A.slug).addresses()).status).toBe(403);
  });

  it('the database enforces the same rules for any caller (CM010), and the consumer list matches the code', async () => {
    const owner = A.people.OWNER!;
    const run = (sql: string, params: unknown[], user = owner.id) => asApp(A.businessId, user, sql, params).then(() => 'ok', sqlState);
    const insert = `INSERT INTO mail_business_addresses (id, business_id, address, domain_id, attested_by_id, attested_at, attestation_version, created_by_id)
      VALUES ($1, $2, $3, $4, $5, now(), $6, $7)`;
    // A custom domain cannot be attested, even by an owner, even bypassing the service.
    expect(await run(insert, [randomUUID(), A.businessId, `a@custom-${uniq()}.example`, null, owner.id, 'v1', owner.id])).toBe('CM010');
    // An attestation is always the session user's own.
    expect(await run(insert, [randomUUID(), A.businessId, `a-${uniq()}@gmail.com`, null, A.people.ADMIN!.id, 'v1', owner.id])).toBe('CM010');
    // Designated by someone else: refused by RLS.
    expect(await run(insert, [randomUUID(), A.businessId, `b-${uniq()}@gmail.com`, null, owner.id, 'v1', A.people.ADMIN!.id])).toBe('42501');
    const fns = (await admin.query('SELECT d, mail_is_consumer_domain(d) AS consumer FROM unnest($1::text[]) d', [[...CONSUMER_MAIL_DOMAINS, 'acme.example', 'gmail.co']])).rows;
    expect(fns.filter((r) => r.consumer).map((r) => r.d)).toEqual([...CONSUMER_MAIL_DOMAINS]);
    expect(await admin.query("SELECT 1 FROM unnest(ARRAY['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','hotmail.co.uk','live.co.uk','outlook.com.au','hotmail.com.au','live.com.au']) d WHERE NOT mail_is_consumer_domain(d)").then((r) => r.rowCount)).toBe(0);
  });
});

describe('PERSONAL and BUSINESS stay apart (no conversion)', () => {
  it('a designated business address cannot be connected as a personal mailbox (refused and audited)', async () => {
    const domain = `apart-${uniq()}.example`;
    await verifiedDomain(A.people.ADMIN!, A.slug, domain);
    await designate(A.people.ADMIN!, A.slug, `sales@${domain}`);
    const { done } = await consentAs(A.people.MANAGER!, A.slug, { provider: 'GOOGLE' }, googleAccount(`sales@${domain}`, domain));
    expect(done.status).toBe(409);
    expect(done.html).toContain('(business_address)');
    expect(await count('SELECT count(*) AS n FROM mail_connections WHERE business_id = $1 AND mailbox_address = $2', [A.businessId, `sales@${domain}`])).toBe(0);
    const reasons = (await admin.query("SELECT metadata->>'reason' AS r FROM audit_events WHERE business_id = $1 AND actor_user_id = $2 AND action = 'communications.connection.authorization_failed'",
      [A.businessId, A.people.MANAGER!.id])).rows.map((r) => r.r);
    expect(reasons).toContain('business_address');
    // Other addresses on the domain stay personal by default.
    const { done: alice } = await consentAs(A.people.MANAGER!, A.slug, { provider: 'GOOGLE' }, googleAccount(`alice-${uniq()}@${domain}`, domain));
    expect(alice.status, alice.html).toBe(200);
  });

  it("an address someone connected personally cannot be designated until that connection is disconnected; it is never carried over", async () => {
    const domain = `carry-${uniq()}.example`;
    await verifiedDomain(A.people.ADMIN!, A.slug, domain);
    const acct = googleAccount(`info@${domain}`, domain);
    expect((await consentAs(A.people.MANAGER!, A.slug, { provider: 'GOOGLE' }, acct)).done.status).toBe(200);
    const personal = await connectionFor(A.people.MANAGER!, A.slug, acct.email);
    expect(personal).toMatchObject({ kind: 'PERSONAL', sharing: 'OWNER_ONLY', credentialHolderId: A.people.MANAGER!.id, businessAddressId: null });
    expect((await api(A.people.ADMIN!, A.slug).designate({ address: acct.email })).body).toEqual({ error: 'personal_connection_exists' });
    expect((await api(A.people.MANAGER!, A.slug).disconnect(personal.id)).status).toBe(200);
    const addressId = await designate(A.people.ADMIN!, A.slug, acct.email);
    const { done } = await consentAs(A.people.ADMIN!, A.slug, { provider: 'GOOGLE', businessAddressId: addressId }, acct);
    expect(done.status, done.html).toBe(200);
    const business = await connectionFor(A.people.ADMIN!, A.slug, acct.email);
    // A fresh connection: new id, BUSINESS, the old personal row stays DISCONNECTED as the record.
    expect(business.id).not.toBe(personal.id);
    expect(business).toMatchObject({ kind: 'BUSINESS', sharing: 'MEMBERS', businessAddressId: addressId, credentialHolderId: A.people.ADMIN!.id });
    expect((await admin.query('SELECT status, kind FROM mail_connections WHERE id = $1', [personal.id])).rows[0]).toEqual({ status: 'DISCONNECTED', kind: 'PERSONAL' });
  });

  it('kind is fixed: not in the API, not in the database (column grant and guard CM005)', async () => {
    const owner = A.people.OWNER!;
    const { done } = await consentAs(owner, A.slug, { provider: 'GOOGLE' }, googleAccount(`fixed-${uniq()}@mail.example`));
    expect(done.status).toBe(200);
    const id = (await api(owner, A.slug).list()).body.connections.find((c: { kind: string; ownerUserId: string }) => c.kind === 'PERSONAL' && c.ownerUserId === owner.id).id;
    expect((await api(owner, A.slug).update(id, { kind: 'BUSINESS', version: 1 })).status).toBe(400);
    expect((await api(owner, A.slug).update(id, { sharing: 'MEMBERS', version: 1 })).status).toBe(400);
    expect(await asApp(A.businessId, owner.id, "UPDATE mail_connections SET kind = 'BUSINESS' WHERE id = $1", [id]).then(() => 'ok', sqlState)).toBe('42501');
    expect(await admin.query("UPDATE mail_connections SET kind = 'BUSINESS', sharing = 'MEMBERS' WHERE id = $1", [id]).then(() => 'ok', sqlState)).toBe('CM005');
    // A personal mailbox's holder is its owner, always (CHECK) and only a business reconnect changes it (CM008).
    expect(await asApp(A.businessId, owner.id, 'UPDATE mail_connections SET credential_holder_id = $1 WHERE id = $2', [A.people.ADMIN!.id, id]).then(() => 'ok', sqlState)).toBe('CM008');
  });
});

describe('business mailbox connect (T-C2-1 identities, live access proof)', () => {
  let tenant: string;
  let domain: string;
  beforeAll(async () => {
    tenant = randomUUID();
    domain = `contoso-${uniq()}.example`;
    fake.tenantDomains.set(tenant, [domain, `contoso-${seq}.onmicrosoft.com`]);
    await verifiedDomain(A.people.ADMIN!, A.slug, domain);
  });

  it('only manage_connections connects a business mailbox, with the shared-mailbox scopes; MANAGER cannot', async () => {
    const addressId = await designate(A.people.ADMIN!, A.slug, `support@${domain}`);
    expect((await api(A.people.MANAGER!, A.slug).authorize({ provider: 'MICROSOFT', businessAddressId: addressId })).status).toBe(403);
    expect((await api(A.people.MEMBER!, A.slug).authorize({ provider: 'MICROSOFT', businessAddressId: addressId })).status).toBe(403);
    expect((await api(A.people.ADMIN!, A.slug).authorize({ provider: 'MICROSOFT', businessAddressId: randomUUID() })).status).toBe(404);
    expect((await api(A.people.ADMIN!, A.slug).authorize({ provider: 'MICROSOFT', businessAddressId: addressId, connectionId: randomUUID() })).status).toBe(400);
    const url = new URL((await api(A.people.ADMIN!, A.slug).authorize({ provider: 'MICROSOFT', businessAddressId: addressId })).body.authorizationUrl);
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['Mail.Read.Shared', 'User.ReadBasic.All']));
    expect(url.searchParams.get('login_hint')).toBeNull();
  });

  it('Microsoft shared mailbox: principal differs from the target; read through Full Access; no sync before retention is set', async () => {
    const C = await team('c2b1ms');
    const tid = randomUUID();
    const d = `fabrikam-${uniq()}.example`;
    fake.tenantDomains.set(tid, [d]);
    await verifiedDomain(C.people.ADMIN!, C.slug, d);
    const shared = msAccount(`info@${d}`, tid);
    const adminAcct = msAccount(`admin@${d}`, tid);
    fake.fullAccess.add(`${adminAcct.id}:${shared.id}`);
    const addressId = await designate(C.people.ADMIN!, C.slug, shared.email);
    const { done } = await consentAs(C.people.ADMIN!, C.slug, { provider: 'MICROSOFT', businessAddressId: addressId }, adminAcct);
    expect(done.status, done.html).toBe(200);
    const conn = MailConnectionResponse.shape.connection.parse(await connectionFor(C.people.ADMIN!, C.slug, shared.email));
    expect(conn).toMatchObject({ kind: 'BUSINESS', sharing: 'MEMBERS', credentialHolderId: C.people.ADMIN!.id, businessAddressId: addressId, displayName: shared.name });
    const row = (await admin.query('SELECT provider_account_id, principal_account_id, provider_tenant_id FROM mail_connections WHERE id = $1', [conn.id])).rows[0];
    expect(row).toEqual({ provider_account_id: shared.id, principal_account_id: adminAcct.id, provider_tenant_id: tid });
    // Reads went to the target's own object, never /me, and no message was fetched.
    expect(fake.calls.filter((u) => u.includes('graph.microsoft.com'))).toEqual(expect.arrayContaining([
      `https://graph.microsoft.com/v1.0/users/${shared.id}/mailFolders/inbox?$select=id`,
    ]));
    expect(fake.calls.some((u) => /messages|mailFolders\/[^?]+\/messages/.test(u))).toBe(false);
    // No retention period yet: connected, but nothing queued, and a sync is refused (API and database).
    expect((await api(C.people.ADMIN!, C.slug).jobs(conn.id)).body.jobs).toEqual([]);
    expect((await api(C.people.ADMIN!, C.slug).sync(conn.id)).body).toEqual({ error: 'retention_not_set' });
    expect(await asApp(C.businessId, C.people.ADMIN!.id, "INSERT INTO mail_sync_jobs (id, business_id, connection_id, kind) VALUES ($1, $2, $3, 'INITIAL')",
      [randomUUID(), C.businessId, conn.id]).then(() => 'ok', sqlState)).toBe('CM009');
    const audit = (await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'communications.connection.business_connected'", [conn.id])).rows[0];
    expect(audit.metadata).toEqual({ provider: 'MICROSOFT', businessAddressId: addressId, basis: 'VERIFIED_DOMAIN', syncQueued: 'false' });
    await api(C.people.OWNER!, C.slug).setRetention({ ordinaryRetentionDays: 2555, version: null });
    expect((await api(C.people.ADMIN!, C.slug).sync(conn.id)).status).toBe(201);
    // The refreshed token keeps the shared-mailbox scopes.
    await admin.query('UPDATE mail_connection_credentials SET access_token_expires_at = now() WHERE connection_id = $1', [conn.id]);
    fake.calls = [];
    expect(await obtainAccessToken(runAs(C.businessId, C.people.ADMIN!.id), conn.id)).toMatch(/^at-/);
  });

  it('Microsoft refusals: no such mailbox, no Full Access, a tenant that does not own the domain', async () => {
    const tid = randomUUID();
    const d = `refuse-${uniq()}.example`;
    fake.tenantDomains.set(tid, [d]);
    await verifiedDomain(A.people.ADMIN!, A.slug, d);
    const shared = msAccount(`billing@${d}`, tid);
    const adminAcct = msAccount(`it@${d}`, tid);
    const addressId = await designate(A.people.ADMIN!, A.slug, shared.email);
    const go = async (acct: Account) => (await consentAs(A.people.ADMIN!, A.slug, { provider: 'MICROSOFT', businessAddressId: addressId }, acct)).done;
    // No Full Access to the shared mailbox.
    expect((await go(adminAcct)).html).toContain('(mailbox_access_denied)');
    // An account in another tenant: its directory has no such mailbox.
    const outsider = msAccount(`someone@other-${uniq()}.example`, randomUUID());
    expect((await go(outsider)).html).toContain('(mailbox_not_found)');
    // A tenant that has the mailbox but has not verified the domain.
    const tid2 = randomUUID();
    fake.tenantDomains.set(tid2, ['elsewhere.example']);
    const lookalike = msAccount(`billing@${d}`, tid2);
    const lookalikeAdmin = msAccount(`admin@elsewhere.example`, tid2);
    fake.fullAccess.add(`${lookalikeAdmin.id}:${lookalike.id}`);
    expect((await go(lookalikeAdmin)).html).toContain('(domain_mismatch)');
    expect(await count('SELECT count(*) AS n FROM mail_connections WHERE business_address_id = $1', [addressId])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials c JOIN mail_connections m ON m.id = c.connection_id WHERE m.business_address_id = $1', [addressId])).toBe(0);
  });

  it('Google: the signed-in account must be the mailbox, in the Workspace that verified the domain', async () => {
    const d = `gw-${uniq()}.example`;
    await verifiedDomain(A.people.ADMIN!, A.slug, d);
    const addressId = await designate(A.people.ADMIN!, A.slug, `hello@${d}`);
    const go = async (acct: Account) => (await consentAs(A.people.ADMIN!, A.slug, { provider: 'GOOGLE', businessAddressId: addressId }, acct)).done;
    // Signed in as someone else: Gmail opens only that account's own mailbox.
    expect((await go(googleAccount(`admin@${d}`, d))).html).toContain('(account_mismatch)');
    // The right address but a Workspace whose hd is another domain (an alias, a different organisation).
    expect((await go(googleAccount(`hello@${d}`, 'other.example'))).html).toContain('(domain_mismatch)');
    const url = (await api(A.people.ADMIN!, A.slug).authorize({ provider: 'GOOGLE', businessAddressId: addressId })).body.authorizationUrl;
    expect(new URL(url).searchParams.get('login_hint')).toBe(`hello@${d}`);
    const ok = await go(googleAccount(`hello@${d}`, d));
    expect(ok.status, ok.html).toBe(200);
    expect(fake.calls).toContain('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    // Connected once per address: a second connect is refused.
    expect((await api(A.people.ADMIN!, A.slug).authorize({ provider: 'GOOGLE', businessAddressId: addressId })).body).toEqual({ error: 'already_connected' });
  });

  it('a consumer address (OWNER-attested) connects with a live check that the signed-in account is that mailbox', async () => {
    const address = `joes-${uniq()}@gmail.com`;
    const addressId = await designate(A.people.OWNER!, A.slug, address, true);
    const wrong = await consentAs(A.people.ADMIN!, A.slug, { provider: 'GOOGLE', businessAddressId: addressId }, googleAccount(`other-${uniq()}@gmail.com`));
    expect(wrong.done.html).toContain('(account_mismatch)');
    const ok = await consentAs(A.people.ADMIN!, A.slug, { provider: 'GOOGLE', businessAddressId: addressId }, googleAccount(address));
    expect(ok.done.status, ok.done.html).toBe(200);
    const conn = await connectionFor(A.people.ADMIN!, A.slug, address);
    const audit = (await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'communications.connection.business_connected'", [conn.id])).rows[0];
    expect(audit.metadata).toMatchObject({ basis: 'OWNER_ATTESTATION', businessAddressId: addressId });
    // The designation cannot be removed while the mailbox is live.
    expect((await api(A.people.OWNER!, A.slug).removeAddress(addressId, 1)).body).toEqual({ error: 'address_in_use' });
  });
});

describe('members (READ / SEND) and visibility of business mailboxes', () => {
  let id: string;
  beforeAll(async () => {
    const d = `members-${uniq()}.example`;
    await verifiedDomain(B.people.ADMIN!, B.slug, d);
    const addressId = await designate(B.people.ADMIN!, B.slug, `team@${d}`);
    const acct = googleAccount(`team@${d}`, d);
    expect((await consentAs(B.people.ADMIN!, B.slug, { provider: 'GOOGLE', businessAddressId: addressId }, acct)).done.status).toBe(200);
    id = (await connectionFor(B.people.ADMIN!, B.slug, acct.email)).id;
  });

  it('is invisible (404) to everyone without manage_connections until they are a member', async () => {
    for (const who of [B.people.MANAGER!, B.people.MEMBER!]) {
      expect((await api(who, B.slug).get(id)).status).toBe(404);
      expect((await api(who, B.slug).list()).body.connections.map((c: { id: string }) => c.id)).not.toContain(id);
      expect((await api(who, B.slug).members(id)).status).toBe(404);
    }
    expect((await api(B.people.ADMIN2!, B.slug).get(id)).status).toBe(200);
  });

  it('manage_connections grants and revokes; members see the mailbox but cannot manage it; personal mailboxes have no members', async () => {
    expect((await api(B.people.MANAGER!, B.slug).grant(id, B.people.MEMBER!.id, 'READ')).status).toBe(404);
    const granted = await api(B.people.ADMIN2!, B.slug).grant(id, B.people.MEMBER!.id, 'READ');
    expect(granted.status).toBe(200);
    expect(ListMailConnectionMembersResponse.parse(granted.body).members).toEqual([
      expect.objectContaining({ userId: B.people.MEMBER!.id, access: 'READ', grantedById: B.people.ADMIN2!.id }),
    ]);
    // Idempotent; then upgraded to SEND.
    expect((await api(B.people.ADMIN2!, B.slug).grant(id, B.people.MEMBER!.id, 'READ')).body.members).toHaveLength(1);
    expect((await api(B.people.ADMIN!, B.slug).grant(id, B.people.MEMBER!.id, 'SEND')).body.members[0]).toMatchObject({ access: 'SEND', version: 2 });
    expect((await api(B.people.ADMIN!, B.slug).grant(id, B.people.MEMBER!.id, 'ADMIN')).status).toBe(400);
    // Not a member of this business.
    expect((await api(B.people.ADMIN!, B.slug).grant(id, A.people.MEMBER!.id, 'READ')).status).toBe(404);
    const member = B.people.MEMBER!;
    expect((await api(member, B.slug).get(id)).body.connection).toMatchObject({ kind: 'BUSINESS', sharing: 'MEMBERS', isOwner: false });
    expect((await api(member, B.slug).list()).body.connections.map((c: { id: string }) => c.id)).toContain(id);
    for (const res of [
      await api(member, B.slug).update(id, { syncEnabled: false, version: 1 }), await api(member, B.slug).disconnect(id), await api(member, B.slug).sync(id),
      await api(member, B.slug).jobs(id), await api(member, B.slug).members(id), await api(member, B.slug).grant(id, B.people.MANAGER!.id, 'READ'),
      await api(member, B.slug).authorize({ provider: 'GOOGLE', connectionId: id }),
    ]) expect(res.status).toBe(403);
    // Business mailboxes are not shared through the personal switch.
    expect((await api(B.people.ADMIN!, B.slug).update(id, { sharing: 'BUSINESS', version: 1 })).body).toEqual({ error: 'not_personal' });
    expect((await api(B.people.ADMIN!, B.slug).revoke(id, member.id)).body.members).toEqual([]);
    expect((await api(B.people.ADMIN!, B.slug).revoke(id, member.id)).status).toBe(404);
    expect((await api(member, B.slug).get(id)).status).toBe(404);
    const audit = (await admin.query("SELECT action, metadata FROM audit_events WHERE target_id = $1 AND action LIKE 'communications.member.%' ORDER BY created_at", [id])).rows;
    expect(audit).toEqual([
      { action: 'communications.member.granted', metadata: { userId: member.id, access: 'READ', previousAccess: null } },
      { action: 'communications.member.granted', metadata: { userId: member.id, access: 'SEND', previousAccess: 'READ' } },
      { action: 'communications.member.revoked', metadata: { userId: member.id } },
    ]);
    // A personal mailbox: no member list, in the API or the database.
    expect((await consentAs(B.people.MANAGER!, B.slug, { provider: 'GOOGLE' }, googleAccount(`mine-${uniq()}@mail.example`))).done.status).toBe(200);
    const personal = (await api(B.people.MANAGER!, B.slug).list()).body.connections.find((c: { kind: string; ownerUserId: string }) => c.kind === 'PERSONAL' && c.ownerUserId === B.people.MANAGER!.id).id;
    expect((await api(B.people.ADMIN!, B.slug).members(personal)).body).toEqual({ error: 'not_business' });
    expect(await asApp(B.businessId, B.people.ADMIN!.id, "INSERT INTO mail_connection_members (business_id, connection_id, user_id, access, granted_by_id) VALUES ($1, $2, $3, 'READ', $4)",
      [B.businessId, personal, B.people.MEMBER!.id, B.people.ADMIN!.id]).then(() => 'ok', sqlState)).toBe('CM010');
  });
});

describe('reconnect, handover and departure of the credential holder (D-C2-8)', () => {
  it('another manage_connections member reconnects with their own sign-in: old tokens deleted first, holder changed, audited', async () => {
    const C = await team('c2b1hand');
    await api(C.people.OWNER!, C.slug).setRetention({ ordinaryRetentionDays: 730, version: null });
    const tid = randomUUID();
    const d = `hand-${uniq()}.example`;
    fake.tenantDomains.set(tid, [d]);
    await verifiedDomain(C.people.ADMIN!, C.slug, d);
    const shared = msAccount(`office@${d}`, tid);
    const first = msAccount(`first@${d}`, tid);
    const second = msAccount(`second@${d}`, tid);
    fake.fullAccess.add(`${first.id}:${shared.id}`);
    fake.fullAccess.add(`${second.id}:${shared.id}`);
    const addressId = await designate(C.people.ADMIN!, C.slug, shared.email);
    expect((await consentAs(C.people.ADMIN!, C.slug, { provider: 'MICROSOFT', businessAddressId: addressId }, first)).done.status).toBe(200);
    const id = (await connectionFor(C.people.ADMIN!, C.slug, shared.email)).id;
    const oldCredential = (await admin.query('SELECT refresh_token_enc FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0].refresh_token_enc;
    // MANAGER cannot reconnect a business mailbox.
    expect((await api(C.people.MANAGER!, C.slug).authorize({ provider: 'MICROSOFT', connectionId: id })).status).toBe(404);
    // A different mailbox is refused, nothing changes.
    const other = msAccount(`other@${d}`, tid);
    fake.fullAccess.add(`${second.id}:${other.id}`);
    // Handover to ADMIN2, signing in as their own Microsoft account.
    const { done } = await consentAs(C.people.ADMIN2!, C.slug, { provider: 'MICROSOFT', connectionId: id }, second);
    expect(done.status, done.html).toBe(200);
    expect(done.html).toContain('Mailbox reconnected');
    const after = (await api(C.people.ADMIN!, C.slug).get(id)).body.connection;
    expect(after).toMatchObject({ status: 'ACTIVE', credentialHolderId: C.people.ADMIN2!.id, ownerUserId: C.people.ADMIN!.id, kind: 'BUSINESS' });
    expect((await admin.query('SELECT principal_account_id, provider_account_id FROM mail_connections WHERE id = $1', [id])).rows[0])
      .toEqual({ principal_account_id: second.id, provider_account_id: shared.id });
    const creds = (await admin.query('SELECT refresh_token_enc FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows;
    expect(creds).toHaveLength(1);
    expect(creds[0].refresh_token_enc).not.toBe(oldCredential);
    const audit = (await admin.query("SELECT action, actor_user_id, metadata FROM audit_events WHERE target_id = $1 AND action = 'communications.connection.holder_changed'", [id])).rows;
    expect(audit).toEqual([{ action: 'communications.connection.holder_changed', actor_user_id: C.people.ADMIN2!.id,
      metadata: { provider: 'MICROSOFT', previousHolderId: C.people.ADMIN!.id, newHolderId: C.people.ADMIN2!.id } }]);
    // The status history shows the old grant stopped before the new one was stored.
    const jobs = (await api(C.people.ADMIN!, C.slug).jobs(id)).body.jobs;
    expect(jobs.map((j: { status: string; lastErrorCode: string | null }) => [j.status, j.lastErrorCode])).toEqual([['QUEUED', null], ['CANCELLED', 'handover']]);

    // Reconnecting with an account that resolves to another mailbox, or in another tenant: refused.
    const wrongTenant = msAccount(`office@${d}`, randomUUID());
    fake.tenantDomains.set(wrongTenant.tid!, [d]);
    const elsewhereAdmin = msAccount(`x@${d}`, wrongTenant.tid!);
    fake.fullAccess.add(`${elsewhereAdmin.id}:${wrongTenant.id}`);
    expect((await consentAs(C.people.ADMIN!, C.slug, { provider: 'MICROSOFT', connectionId: id }, elsewhereAdmin)).done.html).toContain('(account_mismatch)');
    expect((await api(C.people.ADMIN!, C.slug).get(id)).body.connection.credentialHolderId).toBe(C.people.ADMIN2!.id);
  });

  it('the database refuses any other holder change: ACTIVE, PERSONAL, or to someone other than the session user (CM008)', async () => {
    const d = `guard-${uniq()}.example`;
    await verifiedDomain(A.people.ADMIN!, A.slug, d);
    const addressId = await designate(A.people.ADMIN!, A.slug, `guard@${d}`);
    expect((await consentAs(A.people.ADMIN!, A.slug, { provider: 'GOOGLE', businessAddressId: addressId }, googleAccount(`guard@${d}`, d))).done.status).toBe(200);
    const id = (await connectionFor(A.people.ADMIN!, A.slug, `guard@${d}`)).id;
    const run = (sql: string, params: unknown[], user = A.people.ADMIN2!.id) => asApp(A.businessId, user, sql, params).then(() => 'ok', sqlState);
    expect(await run('UPDATE mail_connections SET credential_holder_id = $1 WHERE id = $2', [A.people.ADMIN2!.id, id])).toBe('CM008');
    await admin.query("UPDATE mail_connections SET status = 'NEEDS_REAUTH' WHERE id = $1", [id]);
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [id])).toBe(0);
    expect(await run("UPDATE mail_connections SET credential_holder_id = $1, status = 'ACTIVE' WHERE id = $2", [A.people.OWNER!.id, id])).toBe('CM008');
    expect(await run("UPDATE mail_connections SET credential_holder_id = $1 WHERE id = $2", [A.people.ADMIN2!.id, id])).toBe('CM008');
    expect(await run("UPDATE mail_connections SET credential_holder_id = $1, status = 'ACTIVE' WHERE id = $2", [A.people.ADMIN2!.id, id])).toBe('ok');
    // Identity stays fixed whatever the role.
    expect(await admin.query("UPDATE mail_connections SET business_address_id = NULL WHERE id = $1", [id]).then(() => 'ok', sqlState)).toBe('CM005');
    expect(await admin.query("UPDATE mail_connections SET mailbox_address = 'other@x.example' WHERE id = $1", [id]).then(() => 'ok', sqlState)).toBe('CM005');
  });

  it('a holder who loses manage_connections stops the business mailbox; another admin can take it over', async () => {
    const C = await team('c2b1dep');
    await api(C.people.OWNER!, C.slug).setRetention({ ordinaryRetentionDays: 365, version: null });
    const d = `dep-${uniq()}.example`;
    await verifiedDomain(C.people.ADMIN!, C.slug, d);
    const addressId = await designate(C.people.ADMIN!, C.slug, `desk@${d}`);
    const acct = googleAccount(`desk@${d}`, d);
    expect((await consentAs(C.people.ADMIN!, C.slug, { provider: 'GOOGLE', businessAddressId: addressId }, acct)).done.status).toBe(200);
    const id = (await connectionFor(C.people.ADMIN!, C.slug, acct.email)).id;
    // Demoted to MANAGER: still a member, but no longer allowed to hold a business mailbox's grant.
    await admin.query("UPDATE memberships SET role = 'MANAGER' WHERE business_id = $1 AND user_id = $2", [C.businessId, C.people.ADMIN!.id]);
    for (let claimed = await system(C.businessId, (db) => claimSyncJob(db)); claimed; claimed = await system(C.businessId, (db) => claimSyncJob(db))) {
      expect(claimed.connection.id).not.toBe(id);
      await system(C.businessId, (db) => completeSyncJob(db, claimed!.job.id, claimed!.leaseId));
    }
    expect((await admin.query('SELECT status, last_error_code FROM mail_connections WHERE id = $1', [id])).rows[0]).toEqual({ status: 'NEEDS_REAUTH', last_error_code: 'holder_inactive' });
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [id])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE target_id = $1 AND action = 'communications.system.holder_inactive' AND actor_user_id IS NULL", [id])).toBe(1);
    // ADMIN2 reconnects by signing in as the mailbox (Google): the mailbox carries on under them.
    const { done } = await consentAs(C.people.ADMIN2!, C.slug, { provider: 'GOOGLE', connectionId: id }, acct);
    expect(done.status, done.html).toBe(200);
    expect((await api(C.people.ADMIN2!, C.slug).get(id)).body.connection).toMatchObject({ status: 'ACTIVE', credentialHolderId: C.people.ADMIN2!.id, lastErrorCode: null });
    // A claim now hands it out, acting as the new holder.
    const claimed = await system(C.businessId, (db) => claimSyncJob(db));
    expect(claimed?.connection).toMatchObject({ id, kind: 'BUSINESS', credentialHolderId: C.people.ADMIN2!.id, ownerUserId: C.people.ADMIN!.id });
  });

  it('personal mailboxes keep the C2-A rule: an owner who loses communications:connect stops their own mailbox', async () => {
    const C = await team('c2b1pdep');
    expect((await consentAs(C.people.MANAGER!, C.slug, { provider: 'GOOGLE' }, googleAccount(`p-${uniq()}@mail.example`))).done.status).toBe(200);
    await admin.query("UPDATE memberships SET role = 'MEMBER' WHERE business_id = $1 AND user_id = $2", [C.businessId, C.people.MANAGER!.id]);
    expect(await system(C.businessId, (db) => claimSyncJob(db))).toBeNull();
    expect((await admin.query("SELECT last_error_code FROM mail_connections WHERE business_id = $1", [C.businessId])).rows).toEqual([{ last_error_code: 'owner_inactive' }]);
  });
});

describe('tenant isolation and database guarantees', () => {
  it('RLS: bos_app in another business sees no row of any C2-B1 table, and cannot write into this one', async () => {
    const d = `iso-${uniq()}.example`;
    const domainId = await verifiedDomain(A.people.ADMIN!, A.slug, d);
    await designate(A.people.ADMIN!, A.slug, `iso@${d}`);
    await api(A.people.OWNER!, A.slug).setRetention({ ordinaryRetentionDays: 400, version: (await api(A.people.OWNER!, A.slug).retention()).body.retention.version });
    for (const table of ['mail_business_domains', 'mail_business_addresses', 'mail_connection_members', 'mail_retention_settings']) {
      const seen = await asApp(B.businessId, B.people.OWNER!.id, `SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [A.businessId]);
      expect(seen.rows[0].n, table).toBe(0);
      const unscoped = await asApp('', '', `SELECT count(*)::int AS n FROM ${table}`).then((r) => r.rows[0].n, sqlState);
      expect(unscoped, table).toBe(0);
    }
    // From B, writing rows for A is refused.
    expect(await asApp(B.businessId, B.people.OWNER!.id, `INSERT INTO mail_business_domains (id, business_id, domain, verification_token_hash, created_by_id)
      VALUES ($1, $2, 'evil.example', $3, $4)`, [randomUUID(), A.businessId, 'a'.repeat(64), B.people.OWNER!.id]).then(() => 'ok', sqlState)).toBe('42501');
    expect(await asApp(B.businessId, B.people.OWNER!.id, 'UPDATE mail_business_domains SET removed_at = now(), removed_by_id = $2 WHERE id = $1',
      [domainId, B.people.OWNER!.id]).then((r) => r.rowCount, sqlState)).toBe(0);
    // An id from another business answers 404 on every route.
    expect((await api(B.people.OWNER!, B.slug).verifyDomain(domainId, 2)).status).toBe(404);
    expect((await api(B.people.OWNER!, B.slug).removeDomain(domainId, 2)).status).toBe(404);
  });

  it('a domain is added unverified whatever the caller sends, and verification is recorded once (CM005)', async () => {
    const owner = A.people.OWNER!;
    const id = randomUUID();
    await asApp(A.businessId, owner.id, `INSERT INTO mail_business_domains (id, business_id, domain, verification_token_hash, created_by_id, verified_at, verified_by_id)
      VALUES ($1, $2, $3, $4, $5, now(), $5)`, [id, A.businessId, `forged-${uniq()}.example`, 'b'.repeat(64), owner.id]);
    expect((await admin.query('SELECT verified_at FROM mail_business_domains WHERE id = $1', [id])).rows[0].verified_at).toBeNull();
    await admin.query('UPDATE mail_business_domains SET verified_at = now(), verified_by_id = $2 WHERE id = $1', [id, owner.id]);
    expect(await admin.query('UPDATE mail_business_domains SET verified_at = now() + interval \'1 day\' WHERE id = $1', [id]).then(() => 'ok', sqlState)).toBe('CM005');
    expect(await asApp(A.businessId, owner.id, "UPDATE mail_business_domains SET domain = 'x.example' WHERE id = $1", [id]).then(() => 'ok', sqlState)).toBe('42501');
    expect(await asApp(A.businessId, owner.id, 'DELETE FROM mail_business_domains WHERE id = $1', [id]).then(() => 'ok', sqlState)).toBe('42501');
    expect(await asApp(A.businessId, owner.id, 'DELETE FROM mail_business_addresses').then(() => 'ok', sqlState)).toBe('42501');
  });

  it('no response carries a token, a verifier or a provider secret', async () => {
    const owner = A.people.OWNER!;
    const bodies = [
      await api(owner, A.slug).list('?includeDisconnected=true'), await api(owner, A.slug).domains(), await api(owner, A.slug).addresses('?includeRemoved=true'),
      await api(owner, A.slug).retention(),
    ].map((r) => JSON.stringify(r.body));
    for (const body of bodies) {
      for (const token of fake.issued) expect(body).not.toContain(token);
      expect(body).not.toMatch(/fake-(google|microsoft)-secret|refresh|access_?token|verifier|cursor|principal|tenant/i);
    }
  });

  it('business purge removes every C2-B1 row', async () => {
    const C = await team('c2b1purge');
    const d = `purge-${uniq()}.example`;
    await verifiedDomain(C.people.ADMIN!, C.slug, d);
    const addressId = await designate(C.people.ADMIN!, C.slug, `p@${d}`);
    await api(C.people.OWNER!, C.slug).setRetention({ ordinaryRetentionDays: 30, version: null });
    expect((await consentAs(C.people.ADMIN!, C.slug, { provider: 'GOOGLE', businessAddressId: addressId }, googleAccount(`p@${d}`, d))).done.status).toBe(200);
    const id = (await connectionFor(C.people.ADMIN!, C.slug, `p@${d}`)).id;
    await api(C.people.ADMIN!, C.slug).grant(id, C.people.MEMBER!.id, 'READ');
    await admin.query('DELETE FROM businesses WHERE id = $1', [C.businessId]);
    for (const table of ['mail_business_domains', 'mail_business_addresses', 'mail_connection_members', 'mail_retention_settings', 'mail_connections']) {
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE business_id = $1`, [C.businessId]), table).toBe(0);
    }
  });
});
