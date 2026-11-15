/**
 * Communications C2-A (docs/communications-c2.md): mailbox connections, OAuth, encrypted credentials
 * and refresh, sharing and permissions, sync-job foundation, database guards and tenant isolation.
 * Real route handlers against PostgreSQL with the migrations and privileged SQL applied as in
 * production. Google and Microsoft are replaced by an in-process fake behind `fetch` that enforces
 * PKCE and rotates Microsoft refresh tokens; no real provider credential exists anywhere here.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Provider configuration for this suite only (test doubles, never real values). Set before any
// module reads the environment.
process.env.COMMUNICATIONS_CREDENTIAL_KEYS = `test-k2:${randomBytes(32).toString('base64')},test-k1:${randomBytes(32).toString('base64')}`;
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-google-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-google-secret';
process.env.MICROSOFT_OAUTH_CLIENT_ID = 'fake-microsoft-client';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'fake-microsoft-secret';

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as providersRoute from '@/app/api/v1/b/[slug]/communications/providers/route';
import * as connectionsRoute from '@/app/api/v1/b/[slug]/communications/connections/route';
import * as authorizeRoute from '@/app/api/v1/b/[slug]/communications/connections/authorize/route';
import * as connectionRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/route';
import * as disconnectRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/disconnect/route';
import * as syncRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/sync/route';
import * as syncJobsRoute from '@/app/api/v1/b/[slug]/communications/connections/[connectionId]/sync-jobs/route';
import * as callbackRoute from '@/app/api/v1/communications/oauth/callback/route';
import { withTenant } from '@/core/db';
import { devOutbox } from '@/core/email';
import { claimSyncJob, completeSyncJob, failSyncJob, heartbeatSyncJob, obtainAccessToken, type TenantRun } from '@/modules/communications';
import { credentialAad, credentialBox } from '@/modules/communications/server/credentials';
import { microsoftAdapter } from '@/modules/communications/server/providers/microsoft';
import { ProviderError, type MailProviderAdapter } from '@/modules/communications/server/providers/types';
import {
  AuthorizeMailConnectionResponse, ListMailConnectionsResponse, ListMailProvidersResponse, ListMailSyncJobsResponse, MailConnectionResponse, MailSyncJobResponse,
} from '@business-os/contracts';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const REDIRECT = new URL('/api/v1/communications/oauth/callback', BASE).toString();
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

// ---- fake providers behind fetch ------------------------------------------------------------------

type Account = { provider: 'GOOGLE' | 'MICROSOFT'; id: string; email: string; name: string };
type Grant = { account: Account; challenge: string; redirect: string; scopes?: string };
const fake = {
  codes: new Map<string, Grant>(),
  access: new Map<string, Account>(),
  refresh: new Map<string, Account>(),
  calls: [] as { url: string; form: Record<string, string> }[],
  revoked: [] as string[],
  /** Every token value ever issued, to prove none leaks into the database, responses or logs. */
  issued: [] as string[],
  reset() {
    this.calls = [];
    this.revoked = [];
  },
};
const realFetch = globalThis.fetch;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const issue = (prefix: string, account: Account, map: Map<string, Account>) => {
  const token = `${prefix}-${randomBytes(24).toString('base64url')}`;
  map.set(token, account);
  fake.issued.push(token);
  return token;
};
const GOOGLE_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly';
const MS_SCOPES = 'openid email https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read';

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/googleapis\.com|accounts\.google\.com|microsoftonline\.com|graph\.microsoft\.com/.test(url)) return realFetch(input, init);
  const form = typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  fake.calls.push({ url, form });
  const bearer = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
  const isGoogle = url.includes('google');
  if (url === 'https://oauth2.googleapis.com/token' || url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    if (form.grant_type === 'authorization_code') {
      const grant = fake.codes.get(form.code!);
      fake.codes.delete(form.code!);
      // PKCE: the verifier must hash to the challenge sent with the authorization request.
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (!grant || grant.challenge !== challenge || grant.redirect !== form.redirect_uri) return reply({ error: 'invalid_grant' }, 400);
      return reply({
        access_token: issue('at', grant.account, fake.access), refresh_token: issue('rt', grant.account, fake.refresh), expires_in: 3600,
        scope: grant.scopes ?? (isGoogle ? GOOGLE_SCOPES : MS_SCOPES), token_type: 'Bearer',
      });
    }
    const account = fake.refresh.get(form.refresh_token!);
    if (!account) return reply({ error: 'invalid_grant' }, 400);
    // Microsoft rotates: the used refresh token stops working. Google keeps it.
    if (!isGoogle) fake.refresh.delete(form.refresh_token!);
    await new Promise((r) => setTimeout(r, 50));
    return reply({
      access_token: issue('at', account, fake.access), expires_in: 3600, scope: isGoogle ? GOOGLE_SCOPES : MS_SCOPES,
      ...(isGoogle ? {} : { refresh_token: issue('rt', account, fake.refresh) }),
    });
  }
  if (url === 'https://oauth2.googleapis.com/revoke') {
    // Like Google: revoking any token revokes the account's whole grant to this app.
    fake.revoked.push(form.token!);
    const who = fake.refresh.get(form.token!) ?? fake.access.get(form.token!);
    for (const map of [fake.refresh, fake.access]) for (const [t, a] of map) if (a === who) map.delete(t);
    return reply({});
  }
  const account = fake.access.get(bearer);
  if (!account) return reply({ error: 'invalid_token' }, 401);
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return reply({ sub: account.id, email: account.email, email_verified: true, name: account.name });
  if (url.startsWith('https://graph.microsoft.com/v1.0/me')) return reply({ id: account.id, mail: account.email, userPrincipalName: account.email, displayName: account.name });
  return reply({ error: 'not_found' }, 404);
}

// ---- users, businesses and API helpers -------------------------------------------------------------

let ip = 1;
type User = { email: string; cookie: string; id: string };
function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.110.${Math.floor(ip / 250) % 256}.${ip++ % 250}`, origin: ORIGIN });
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
  await authRoute.GET(new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.111.${Math.floor(ip / 250) % 256}.${ip++ % 250}` } }));
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
  for (const role of ['ADMIN', 'MANAGER', 'MANAGER2', 'MEMBER']) {
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
  const r = (method: string, path: string, body?: unknown) => req(method, `/api/v1/b/${slug}/communications${path}`, { cookie: who.cookie, body });
  return {
    providers: () => providersRoute.GET(r('GET', '/providers'), ctx({ slug })).then(json),
    list: (qs = '') => connectionsRoute.GET(r('GET', `/connections${qs}`), ctx({ slug })).then(json),
    authorize: (body: unknown) => authorizeRoute.POST(r('POST', '/connections/authorize', body), ctx({ slug })).then(json),
    get: (connectionId: string) => connectionRoute.GET(r('GET', `/connections/${connectionId}`), ctx({ slug, connectionId })).then(json),
    update: (connectionId: string, body: unknown) => connectionRoute.PATCH(r('PATCH', `/connections/${connectionId}`, body), ctx({ slug, connectionId })).then(json),
    disconnect: (connectionId: string) => disconnectRoute.POST(r('POST', `/connections/${connectionId}/disconnect`), ctx({ slug, connectionId })).then(json),
    sync: (connectionId: string, body: unknown = {}) => syncRoute.POST(r('POST', `/connections/${connectionId}/sync`, body), ctx({ slug, connectionId })).then(json),
    jobs: (connectionId: string) => syncJobsRoute.GET(r('GET', `/connections/${connectionId}/sync-jobs`), ctx({ slug, connectionId })).then(json),
  };
};

/** Simulates the user consenting at the provider: records the PKCE challenge and returns the callback path. */
function consent(authorizationUrl: string, account: Account, opts: { scopes?: string; error?: boolean } = {}) {
  const p = new URL(authorizationUrl).searchParams;
  const state = p.get('state')!;
  if (opts.error) return `/api/v1/communications/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`;
  const code = `code-${randomBytes(16).toString('base64url')}`;
  fake.codes.set(code, { account, challenge: p.get('code_challenge')!, redirect: p.get('redirect_uri')!, scopes: opts.scopes });
  return `/api/v1/communications/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`;
}
async function callback(path: string, who?: User) {
  const headers = new Headers({ 'x-forwarded-for': `100.112.${Math.floor(ip / 250) % 256}.${ip++ % 250}` });
  if (who) headers.set('cookie', who.cookie);
  const res = await callbackRoute.GET(new Request(`${BASE}${path}`, { method: 'GET', headers }));
  return { status: res.status, html: await res.text(), headers: res.headers };
}
let accountSeq = 0;
const account = (provider: Account['provider'], label = 'mailbox'): Account => {
  accountSeq++;
  return { provider, id: provider === 'GOOGLE' ? `g-${randomUUID()}` : randomUUID(), email: `${label}-${accountSeq}@Mail.Example`, name: `${label} ${accountSeq}` };
};

/** Full connect flow for `who`; returns the connection id. */
async function connect(who: User, slug: string, acct: Account, opts: { connectionId?: string } = {}): Promise<string> {
  const started = await api(who, slug).authorize({ provider: acct.provider, ...opts });
  expect(started.status).toBe(201);
  const done = await callback(consent(started.body.authorizationUrl, acct), who);
  expect(done.status, done.html).toBe(200);
  const listed = await api(who, slug).list();
  return listed.body.connections.find((c: { mailboxAddress: string }) => c.mailboxAddress === acct.email.toLowerCase()).id;
}

/** Runs SQL as bos_app inside a tenant transaction, acting as `userId` ('' for system). */
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
const runAs = (businessId: string, userId: string): TenantRun => (work, opts) => withTenant({ businessId, userId: opts?.system ? null : userId }, work);
const system = <T>(businessId: string, work: Parameters<typeof withTenant<T>>[1]) => withTenant({ businessId, userId: null }, work);
const count = async (sql: string, params: unknown[]) => Number((await admin.query(sql, params)).rows[0].n);
const sqlState = (e: unknown) => (e as { code?: string }).code;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
const consoleOutput: string[] = [];

beforeAll(async () => {
  await Promise.all([admin.connect(), app.connect()]);
  vi.stubGlobal('fetch', fakeFetch);
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
      original(...args);
    });
  }
  A = await team('c2a');
  B = await team('c2b');
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all([admin.end(), app.end()]);
});
beforeEach(() => fake.reset());
afterEach(() => {
  // No provider token, verifier or client secret ever reaches a log line.
  const leaked = consoleOutput.filter((line) => fake.issued.some((t) => line.includes(t)) || /fake-(google|microsoft)-secret/.test(line));
  expect(leaked).toEqual([]);
});

describe('providers and the connect flow', () => {
  it('lists configured providers to members who may connect, not to MEMBER', async () => {
    const res = await api(A.people.MANAGER!, A.slug).providers();
    expect(res.status).toBe(200);
    expect(ListMailProvidersResponse.parse(res.body).providers).toEqual([
      { provider: 'GOOGLE', configured: true, revokesOnDisconnect: false },
      { provider: 'MICROSOFT', configured: true, revokesOnDisconnect: false },
    ]);
    expect((await api(A.people.MEMBER!, A.slug).providers()).status).toBe(403);
  });

  it('connects a Google mailbox server-side with PKCE; tokens are sealed and never leave the server', async () => {
    const manager = A.people.MANAGER!;
    const acct = account('GOOGLE', 'manager');
    const started = await api(manager, A.slug).authorize({ provider: 'GOOGLE' });
    expect(started.status).toBe(201);
    const { authorizationUrl, expiresAt } = AuthorizeMailConnectionResponse.parse(started.body);
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toMatch(new RegExp(`^${A.slug}\\.[A-Za-z0-9_-]{43}$`));
    expect(authorizationUrl).not.toContain('fake-google-secret');
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    // Only the hash of the nonce is stored; the PKCE verifier is sealed.
    const nonce = url.searchParams.get('state')!.split('.')[1]!;
    const state = (await admin.query('SELECT state_hash, code_verifier_enc FROM mail_oauth_states WHERE business_id = $1 AND user_id = $2', [A.businessId, manager.id])).rows[0];
    expect(state.state_hash).toBe(createHash('sha256').update(nonce).digest('hex'));
    expect(state.code_verifier_enc).toMatch(/^v1\.test-k2\./);

    const done = await callback(consent(authorizationUrl, acct), manager);
    expect(done.status).toBe(200);
    expect(done.html).toContain('Mailbox connected');
    expect(done.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(done.headers.get('cache-control')).toBe('no-store');
    expect(done.html).not.toContain(nonce);
    // The code was exchanged once, with the verifier, at Google's token endpoint.
    expect(fake.calls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token', 'https://openidconnect.googleapis.com/v1/userinfo']);

    const list = ListMailConnectionsResponse.parse((await api(manager, A.slug).list()).body);
    const mine = list.connections.find((c) => c.mailboxAddress === acct.email.toLowerCase())!;
    expect(mine).toMatchObject({ provider: 'GOOGLE', isOwner: true, ownerUserId: manager.id, status: 'ACTIVE', sharing: 'OWNER_ONLY', syncEnabled: true, version: 1 });

    // Sealed at rest, bound to this business and connection; no plaintext token in any column.
    const cred = (await admin.query('SELECT * FROM mail_connection_credentials WHERE business_id = $1 AND connection_id = $2', [A.businessId, mine.id])).rows[0];
    expect(cred.refresh_token_enc).toMatch(/^v1\.test-k2\./);
    const rowText = JSON.stringify((await admin.query('SELECT c.*, m.* FROM mail_connections c LEFT JOIN mail_connection_credentials m ON m.connection_id = c.id WHERE c.id = $1', [mine.id])).rows);
    for (const token of fake.issued) expect(rowText).not.toContain(token);
    expect(credentialBox().open(cred.refresh_token_enc, credentialAad(A.businessId, mine.id, 'refresh'))).toMatch(/^rt-/);
    expect(() => credentialBox().open(cred.refresh_token_enc, credentialAad(B.businessId, mine.id, 'refresh'))).toThrow();

    // The initial sync is queued (no worker runs in C2-A).
    const jobs = ListMailSyncJobsResponse.parse((await api(manager, A.slug).jobs(mine.id)).body).jobs;
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([['INITIAL', 'QUEUED']]);

    // Audit: ids, provider and codes only; never the address, name or a token.
    const audit = (await admin.query("SELECT action, actor_user_id, metadata FROM audit_events WHERE business_id = $1 AND action LIKE 'communications.%' ORDER BY created_at", [A.businessId])).rows;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['communications.connection.authorization_started', 'communications.connection.connected']));
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(acct.email.toLowerCase());
    expect(auditText).not.toContain(acct.name);
    for (const token of fake.issued) expect(auditText).not.toContain(token);
  });

  it('connects a Microsoft mailbox through the Graph adapter', async () => {
    const acct = account('MICROSOFT', 'sales');
    const id = await connect(A.people.ADMIN!, A.slug, acct);
    const got = MailConnectionResponse.parse((await api(A.people.ADMIN!, A.slug).get(id)).body).connection;
    expect(got).toMatchObject({ provider: 'MICROSOFT', mailboxAddress: acct.email.toLowerCase(), displayName: acct.name });
    expect(fake.calls.map((c) => c.url)).toEqual(['https://login.microsoftonline.com/common/oauth2/v2.0/token', 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName']);
  });

  it('no response body anywhere carries a token, verifier, code or client secret', async () => {
    const owner = A.people.OWNER!;
    const id = await connect(owner, A.slug, account('GOOGLE', 'owner'));
    const bodies = [
      await api(owner, A.slug).list('?includeDisconnected=true'), await api(owner, A.slug).get(id), await api(owner, A.slug).jobs(id),
      await api(owner, A.slug).sync(id), await api(owner, A.slug).update(id, { syncEnabled: true, version: 1 }),
    ].map((r) => JSON.stringify(r.body));
    for (const body of bodies) {
      for (const token of fake.issued) expect(body).not.toContain(token);
      expect(body).not.toMatch(/fake-google-secret|refresh|access_?token|verifier|cursor/i);
    }
  });
});

describe('OAuth state and callback protections', () => {
  async function started(who: User, provider: Account['provider'] = 'GOOGLE', slug = A.slug) {
    const res = await api(who, slug).authorize({ provider });
    expect(res.status).toBe(201);
    return res.body.authorizationUrl as string;
  }

  it('is single use: a replayed callback is refused and connects nothing twice', async () => {
    const who = A.people.OWNER!;
    const acct = account('GOOGLE', 'replay');
    const url = await started(who);
    const path = consent(url, acct);
    expect((await callback(path, who)).status).toBe(200);
    const again = await callback(path, who);
    expect(again.status).toBe(400);
    expect(again.html).toContain('(invalid_state)');
  });

  it('requires the signed-in user who started it, in a business they belong to', async () => {
    const owner = A.people.OWNER!;
    const url = await started(owner);
    const acct = account('GOOGLE', 'victim');
    // No session in this browser (for example a link sent to someone else).
    const anonymous = await callback(consent(url, acct));
    expect(anonymous.status).toBe(401);
    expect(anonymous.html).toContain('Sign in to Business OS');
    // Another member of the same business, and a member of another business.
    expect((await callback(consent(url, acct), A.people.ADMIN!)).status).toBe(400);
    expect((await callback(consent(url, acct), B.people.OWNER!)).status).toBe(400);
    // None of those consumed the state: the right user can still finish.
    expect((await callback(consent(url, acct), owner)).status).toBe(200);
    expect(await count('SELECT count(*) AS n FROM mail_connections WHERE provider_account_id = $1', [acct.id])).toBe(1);
  });

  it('refuses forged, garbled, expired and declined authorizations', async () => {
    const owner = A.people.OWNER!;
    for (const state of [`${A.slug}.${randomBytes(32).toString('base64url')}`, 'nonsense', `${B.slug}.${randomBytes(32).toString('base64url')}`]) {
      const res = await callback(`/api/v1/communications/oauth/callback?code=x&state=${encodeURIComponent(state)}`, owner);
      expect(res.status).toBe(400);
      expect(res.html).not.toContain(state);
    }
    const expired = await started(owner);
    await admin.query("UPDATE mail_oauth_states SET created_at = now() - interval '20 minutes', expires_at = now() - interval '11 minutes' WHERE user_id = $1 AND consumed_at IS NULL", [owner.id]);
    expect((await callback(consent(expired, account('GOOGLE')), owner)).status).toBe(400);

    const declined = await started(owner);
    const res = await callback(consent(declined, account('GOOGLE'), { error: true }), owner);
    expect(res.status).toBe(400);
    expect(res.html).toContain('(declined)');
    expect(fake.calls).toEqual([]);
    const reasons = (await admin.query("SELECT metadata->>'reason' AS reason FROM audit_events WHERE business_id = $1 AND action = 'communications.connection.authorization_failed'", [A.businessId])).rows.map((r) => r.reason);
    expect(reasons).toContain('declined');
  });

  it('refuses a consent that left out Gmail access, storing and revoking nothing', async () => {
    const owner = A.people.OWNER!;
    const acct = account('GOOGLE', 'partial');
    const res = await callback(consent(await started(owner), acct, { scopes: 'openid https://www.googleapis.com/auth/userinfo.email' }), owner);
    expect(res.status).toBe(400);
    expect(res.html).toContain('(insufficient_scope)');
    expect(fake.revoked).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM mail_connections WHERE provider_account_id = $1', [acct.id])).toBe(0);
  });

  it('a provider failure at the token endpoint connects nothing and says so', async () => {
    const owner = A.people.OWNER!;
    const url = await started(owner);
    const path = consent(url, account('GOOGLE')).replace(/code=[^&]+/, 'code=unknown-code');
    const res = await callback(path, owner);
    expect(res.status).toBe(502);
    expect(res.html).toContain('(provider_error)');
  });

  it('only OWNER, ADMIN and MANAGER may start a connection; providers must be configured', async () => {
    expect((await api(A.people.MEMBER!, A.slug).authorize({ provider: 'GOOGLE' })).status).toBe(403);
    expect((await api(A.people.MANAGER!, A.slug).authorize({ provider: 'YAHOO' })).status).toBe(400);
    expect((await api(A.people.MANAGER!, A.slug).authorize({ provider: 'GOOGLE', extra: true })).status).toBe(400);
  });
});

describe('ownership, sharing and permissions', () => {
  let id: string;
  beforeAll(async () => {
    id = await connect(A.people.MANAGER!, A.slug, account('GOOGLE', 'personal'));
  });

  it('OWNER_ONLY: invisible to MEMBER and to another MANAGER (404, absent from lists); admins see metadata', async () => {
    for (const who of [A.people.MEMBER!, A.people.MANAGER2!]) {
      expect((await api(who, A.slug).get(id)).status).toBe(404);
      expect((await api(who, A.slug).list()).body.connections.map((c: { id: string }) => c.id)).not.toContain(id);
      expect((await api(who, A.slug).update(id, { syncEnabled: false, version: 1 })).status).toBe(404);
      expect((await api(who, A.slug).disconnect(id)).status).toBe(404);
      expect((await api(who, A.slug).sync(id)).status).toBe(404);
    }
    const seen = await api(A.people.ADMIN!, A.slug).get(id);
    expect(seen.status).toBe(200);
    expect(seen.body.connection).toMatchObject({ isOwner: false, sharing: 'OWNER_ONLY' });
  });

  it('only the owner shares BUSINESS-wide; admins may restrict and pause but never expose', async () => {
    expect((await api(A.people.ADMIN!, A.slug).update(id, { sharing: 'BUSINESS', version: 1 })).status).toBe(403);
    const shared = await api(A.people.MANAGER!, A.slug).update(id, { sharing: 'BUSINESS', version: 1 });
    expect(shared.status).toBe(200);
    expect(shared.body.connection).toMatchObject({ sharing: 'BUSINESS', version: 2 });
    // Now readable by every member with communications:read, but they cannot manage it.
    expect((await api(A.people.MEMBER!, A.slug).get(id)).status).toBe(200);
    expect((await api(A.people.MEMBER!, A.slug).update(id, { syncEnabled: false, version: 2 })).status).toBe(403);
    expect((await api(A.people.MEMBER!, A.slug).disconnect(id)).status).toBe(403);
    expect((await api(A.people.MEMBER!, A.slug).jobs(id)).status).toBe(403);
    expect((await api(A.people.MANAGER2!, A.slug).sync(id)).status).toBe(403);
    // Stale version.
    expect((await api(A.people.ADMIN!, A.slug).update(id, { sharing: 'OWNER_ONLY', version: 1 })).status).toBe(409);
    const restricted = await api(A.people.ADMIN!, A.slug).update(id, { sharing: 'OWNER_ONLY', syncEnabled: false, version: 2 });
    expect(restricted.body.connection).toMatchObject({ sharing: 'OWNER_ONLY', syncEnabled: false, version: 3 });
    expect((await api(A.people.MEMBER!, A.slug).get(id)).status).toBe(404);
    // Pausing cancelled the queued sync; a paused mailbox cannot be synced.
    expect((await api(A.people.MANAGER!, A.slug).jobs(id)).body.jobs[0]).toMatchObject({ status: 'CANCELLED', lastErrorCode: 'sync_disabled' });
    expect((await api(A.people.MANAGER!, A.slug).sync(id)).body).toEqual({ error: 'sync_disabled' });
    await api(A.people.MANAGER!, A.slug).update(id, { syncEnabled: true, version: 3 });
    const fields = (await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'communications.connection.updated' ORDER BY created_at", [id])).rows;
    expect(fields).toHaveLength(3);
  });

  it('one live connection per mailbox per business; the same mailbox in another business is independent', async () => {
    const shared = account('GOOGLE', 'shared-inbox');
    const first = await connect(A.people.OWNER!, A.slug, shared);
    const url = (await api(A.people.ADMIN!, A.slug).authorize({ provider: 'GOOGLE' })).body.authorizationUrl;
    const second = await callback(consent(url, shared), A.people.ADMIN!);
    expect(second.status).toBe(409);
    expect(second.html).toContain('(already_connected)');
    const other = await connect(B.people.OWNER!, B.slug, shared);
    expect(other).not.toBe(first);
    expect(await count('SELECT count(*) AS n FROM mail_connections WHERE provider_account_id = $1', [shared.id])).toBe(2);
  });
});

describe('credential refresh, revocation and reconnection', () => {
  it('refreshes once for many concurrent callers; Microsoft rotation survives (single-flight lease)', async () => {
    const owner = A.people.OWNER!;
    const acct = account('MICROSOFT', 'rotating');
    const id = await connect(owner, A.slug, acct);
    const run = runAs(A.businessId, owner.id);
    // Fresh token: no network.
    fake.reset();
    const fresh = await obtainAccessToken(run, id);
    expect(fresh).toMatch(/^at-/);
    expect(fake.calls).toEqual([]);
    // Expire it; five callers at once.
    await admin.query("UPDATE mail_connection_credentials SET access_token_expires_at = now() + interval '1 minute' WHERE connection_id = $1", [id]);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => obtainAccessToken(run, id)));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).not.toBe(fresh);
    expect(fake.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    // The rotated refresh token was stored: a later refresh still works (a lost rotation would answer invalid_grant).
    await admin.query("UPDATE mail_connection_credentials SET access_token_expires_at = now() WHERE connection_id = $1", [id]);
    expect(await obtainAccessToken(run, id)).toMatch(/^at-/);
    expect((await api(owner, A.slug).get(id)).body.connection.status).toBe('ACTIVE');
    const lease = (await admin.query('SELECT refresh_lease_id FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0];
    expect(lease.refresh_lease_id).toBeNull();
  });

  it('a revoked grant moves the mailbox to NEEDS_REAUTH, deletes its tokens, cancels jobs and writes a system audit event', async () => {
    const owner = A.people.OWNER!;
    const acct = account('GOOGLE', 'revoked');
    const id = await connect(owner, A.slug, acct);
    for (const [token, who] of fake.refresh) if (who === acct) fake.refresh.delete(token); // revoked at Google
    await admin.query("UPDATE mail_connection_credentials SET access_token_expires_at = now() WHERE connection_id = $1", [id]);
    await expect(obtainAccessToken(runAs(A.businessId, owner.id), id)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect((await api(owner, A.slug).get(id)).body.connection).toMatchObject({ status: 'NEEDS_REAUTH', lastErrorCode: 'reauth_required' });
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [id])).toBe(0);
    expect((await api(owner, A.slug).jobs(id)).body.jobs[0]).toMatchObject({ status: 'CANCELLED', lastErrorCode: 'reauth_required' });
    const audit = (await admin.query("SELECT actor_user_id, metadata FROM audit_events WHERE target_id = $1 AND action = 'communications.system.reauth_required'", [id])).rows;
    expect(audit).toEqual([{ actor_user_id: null, metadata: { provider: 'GOOGLE' } }]);
    await expect(obtainAccessToken(runAs(A.businessId, owner.id), id)).rejects.toMatchObject({ code: 'not_active' });
    expect((await api(owner, A.slug).sync(id)).body).toEqual({ error: 'not_active' });

    // Only the owner can reconnect, and only with the same account.
    expect((await api(A.people.ADMIN!, A.slug).authorize({ provider: 'GOOGLE', connectionId: id })).status).toBe(403);
    const wrong = await api(owner, A.slug).authorize({ provider: 'GOOGLE', connectionId: id });
    expect(new URL(wrong.body.authorizationUrl).searchParams.get('login_hint')).toBe(acct.email.toLowerCase());
    expect((await callback(consent(wrong.body.authorizationUrl, account('GOOGLE', 'someone-else')), owner)).html).toContain('(account_mismatch)');
    expect(await connect(owner, A.slug, acct, { connectionId: id })).toBe(id);
    expect((await api(owner, A.slug).get(id)).body.connection).toMatchObject({ status: 'ACTIVE', lastErrorCode: null });
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [id])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE target_id = $1 AND action = 'communications.connection.reconnected'", [id])).toBe(1);
  });

  it('disconnect: final, tokens deleted in the same transaction, jobs cancelled, no grant-wide revocation (C2A-03)', async () => {
    const owner = A.people.OWNER!;
    const acct = account('GOOGLE', 'leaving');
    const id = await connect(owner, A.slug, acct);
    // The same mailbox is also connected in business B; disconnecting in A must not cut it off.
    const elsewhere = await connect(B.people.OWNER!, B.slug, acct);
    fake.reset();
    const res = await api(A.people.ADMIN!, A.slug).disconnect(id);
    expect(res.status).toBe(200);
    expect(MailConnectionResponse.parse(res.body).connection).toMatchObject({ status: 'DISCONNECTED', syncEnabled: false });
    expect(fake.revoked).toEqual([]);
    await admin.query('UPDATE mail_connection_credentials SET access_token_expires_at = now() WHERE connection_id = $1', [elsewhere]);
    expect(await obtainAccessToken(runAs(B.businessId, B.people.OWNER!.id), elsewhere)).toMatch(/^at-/);
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [id])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM mail_sync_jobs WHERE connection_id = $1 AND status IN ('QUEUED','RUNNING')", [id])).toBe(0);
    expect((await api(owner, A.slug).disconnect(id)).body).toEqual({ error: 'disconnected' });
    expect((await api(owner, A.slug).update(id, { syncEnabled: true, version: 2 })).status).toBe(409);
    expect((await api(owner, A.slug).list()).body.connections.map((c: { id: string }) => c.id)).not.toContain(id);
    expect((await api(owner, A.slug).list('?includeDisconnected=true')).body.connections.map((c: { id: string }) => c.id)).toContain(id);
    const audit = (await admin.query("SELECT actor_user_id, metadata FROM audit_events WHERE target_id = $1 AND action = 'communications.connection.disconnected'", [id])).rows[0];
    expect(audit).toEqual({ actor_user_id: A.people.ADMIN!.id, metadata: { provider: 'GOOGLE', revocation: 'not_requested' } });
    // Connecting the mailbox again makes a new connection; the old row stays as the record.
    const again = await connect(owner, A.slug, acct);
    expect(again).not.toBe(id);
  });

  it('Microsoft disconnect deletes the tokens but makes no revocation call (none exists)', async () => {
    const id = await connect(A.people.ADMIN!, A.slug, account('MICROSOFT', 'ms-leaving'));
    fake.reset();
    expect((await api(A.people.ADMIN!, A.slug).disconnect(id)).status).toBe(200);
    expect(fake.calls).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [id])).toBe(0);
    expect((await admin.query("SELECT metadata->>'revocation' AS r FROM audit_events WHERE target_id = $1 AND action = 'communications.connection.disconnected'", [id])).rows[0].r).toBe('not_requested');
  });

  it('C2A-03: a refused second connection of a mailbox never revokes the legitimate one', async () => {
    const acct = account('GOOGLE', 'contested');
    const legit = await connect(A.people.OWNER!, A.slug, acct);
    fake.reset();
    const url = (await api(A.people.ADMIN!, A.slug).authorize({ provider: 'GOOGLE' })).body.authorizationUrl;
    const refused = await callback(consent(url, acct), A.people.ADMIN!);
    expect(refused.status).toBe(409);
    expect(refused.html).toContain('(already_connected)');
    expect(fake.revoked).toEqual([]);
    expect(fake.calls.map((c) => c.url)).not.toContain('https://oauth2.googleapis.com/revoke');
    // The legitimate connection keeps working: active, credentials intact, refresh succeeds.
    expect((await api(A.people.OWNER!, A.slug).get(legit)).body.connection).toMatchObject({ status: 'ACTIVE', lastErrorCode: null });
    await admin.query('UPDATE mail_connection_credentials SET access_token_expires_at = now() WHERE connection_id = $1', [legit]);
    expect(await obtainAccessToken(runAs(A.businessId, A.people.OWNER!.id), legit)).toMatch(/^at-/);
    // The refusal is audited with a stable reason and nothing about the mailbox.
    const failure = (await admin.query("SELECT metadata FROM audit_events WHERE business_id = $1 AND actor_user_id = $2 AND action = 'communications.connection.authorization_failed' ORDER BY created_at DESC LIMIT 1", [A.businessId, A.people.ADMIN!.id])).rows[0];
    expect(failure.metadata).toEqual({ provider: 'GOOGLE', reason: 'already_connected' });
  });

  describe('C2A-01: refresh outcomes are fenced by the credential version and the lease id', () => {
    /** An adapter whose refresh waits for `release` and then answers `outcome`. */
    function delayed(outcome: 'invalid_grant' | 'success') {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let entered!: () => void;
      const started = new Promise<void>((r) => { entered = r; });
      const base = microsoftAdapter({ clientId: 'fake-microsoft-client', clientSecret: 'fake-microsoft-secret' });
      const adapter: MailProviderAdapter = {
        ...base,
        async refresh() {
          entered();
          await gate;
          if (outcome === 'invalid_grant') throw new ProviderError('invalid_grant');
          return { accessToken: 'at-obsolete-attempt', refreshToken: 'rt-obsolete-attempt', expiresAt: new Date(Date.now() + 3_600_000), scopes: [] };
        },
      };
      return { adapter, release, started };
    }

    async function expiringConnection() {
      const owner = A.people.OWNER!;
      const id = await connect(owner, A.slug, account('MICROSOFT', 'fenced'));
      await admin.query('UPDATE mail_connection_credentials SET access_token_expires_at = now() WHERE connection_id = $1', [id]);
      return { owner, id, run: runAs(A.businessId, owner.id) };
    }

    it('a delayed invalid_grant after its lease expired and a replacement refresh succeeded changes nothing', async () => {
      const { owner, id, run } = await expiringConnection();
      const slow = delayed('invalid_grant');
      const obsolete = obtainAccessToken(run, id, { adapter: slow.adapter }).catch((e: unknown) => e);
      await slow.started;
      // The first lease expires before its provider call returns; a second caller takes over and succeeds.
      await admin.query("UPDATE mail_connection_credentials SET refresh_lease_until = now() - interval '1 second' WHERE connection_id = $1", [id]);
      const replacement = await obtainAccessToken(run, id);
      expect(replacement).toMatch(/^at-/);
      slow.release();
      expect(await obsolete).toMatchObject({ code: 'busy' });
      // Still connected, the replacement's credentials intact and usable, no reauth audit.
      expect((await api(owner, A.slug).get(id)).body.connection).toMatchObject({ status: 'ACTIVE', lastErrorCode: null });
      expect(await obtainAccessToken(run, id)).toBe(replacement);
      expect(await count("SELECT count(*) AS n FROM audit_events WHERE target_id = $1 AND action = 'communications.system.reauth_required'", [id])).toBe(0);
      // And the rotated refresh token the replacement stored still refreshes.
      await admin.query('UPDATE mail_connection_credentials SET access_token_expires_at = now() WHERE connection_id = $1', [id]);
      expect(await obtainAccessToken(run, id)).not.toBe(replacement);
    });

    it('a delayed success of an obsolete attempt cannot overwrite the replacement credentials', async () => {
      const { id, run } = await expiringConnection();
      const slow = delayed('success');
      const obsolete = obtainAccessToken(run, id, { adapter: slow.adapter }).catch((e: unknown) => e);
      await slow.started;
      await admin.query("UPDATE mail_connection_credentials SET refresh_lease_until = now() - interval '1 second' WHERE connection_id = $1", [id]);
      const replacement = await obtainAccessToken(run, id);
      slow.release();
      expect(await obsolete).toMatchObject({ code: 'busy' });
      expect(await obtainAccessToken(run, id)).toBe(replacement);
      const sealed = (await admin.query('SELECT refresh_token_enc FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0].refresh_token_enc;
      expect(credentialBox().open(sealed, credentialAad(A.businessId, id, 'refresh'))).not.toBe('rt-obsolete-attempt');
    });

    // Final C2A-01 re-audit: worker B has taken over the lease but not yet written anything, so the
    // credential version is still the one worker A read. Only the lease id tells them apart.
    for (const outcome of ['invalid_grant', 'success'] as const) {
      it(`an obsolete worker's late ${outcome} cannot disrupt a worker that took over its lease but has not written yet`, async () => {
        const { owner, id, run } = await expiringConnection();
        const versionAtStart = (await admin.query('SELECT credential_version::text AS v FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0].v;
        const workerA = delayed(outcome);
        const a = obtainAccessToken(run, id, { adapter: workerA.adapter }).catch((e: unknown) => e);
        await workerA.started;
        const leaseA = (await admin.query('SELECT refresh_lease_id::text AS l FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0].l;
        // A's lease expires; B takes a replacement lease against the same credential version.
        await admin.query("UPDATE mail_connection_credentials SET refresh_lease_until = now() - interval '1 second' WHERE connection_id = $1", [id]);
        const workerB = delayed('success');
        const b = obtainAccessToken(run, id, { adapter: workerB.adapter }).catch((e: unknown) => e);
        await workerB.started;
        const during = (await admin.query('SELECT credential_version::text AS v, refresh_lease_id::text AS l FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0];
        expect(during.v).toBe(versionAtStart);
        expect(during.l).not.toBe(leaseA);
        // A's late answer arrives first: refused as obsolete, nothing changes.
        workerA.release();
        expect(await a).toMatchObject({ code: 'busy' });
        expect((await admin.query('SELECT credential_version::text AS v, refresh_lease_id::text AS l FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0]).toEqual(during);
        expect((await api(owner, A.slug).get(id)).body.connection).toMatchObject({ status: 'ACTIVE', lastErrorCode: null });
        expect(await count("SELECT count(*) AS n FROM audit_events WHERE target_id = $1 AND action = 'communications.system.reauth_required'", [id])).toBe(0);
        // B then completes normally under its own lease.
        workerB.release();
        expect(await b).toBe('at-obsolete-attempt'); // the delayed double's token, stored by B
        const after = (await admin.query('SELECT credential_version::text AS v, refresh_lease_id FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0];
        expect(after.v).not.toBe(versionAtStart);
        expect(after.refresh_lease_id).toBeNull();
        expect(await obtainAccessToken(run, id)).toBe('at-obsolete-attempt');
      });
    }

    it('an expired lease that nobody took over still lets its holder store a successful refresh (documented semantics)', async () => {
      // Discarding it would lose a rotated Microsoft refresh token; the unchanged lease id proves no
      // other attempt started, so storing is safe.
      const { id, run } = await expiringConnection();
      const slow = delayed('success');
      const attempt = obtainAccessToken(run, id, { adapter: slow.adapter }).catch((e: unknown) => e);
      await slow.started;
      await admin.query("UPDATE mail_connection_credentials SET refresh_lease_until = now() - interval '1 second' WHERE connection_id = $1", [id]);
      slow.release();
      expect(await attempt).toBe('at-obsolete-attempt');
      const sealed = (await admin.query('SELECT refresh_token_enc FROM mail_connection_credentials WHERE connection_id = $1', [id])).rows[0].refresh_token_enc;
      expect(credentialBox().open(sealed, credentialAad(A.businessId, id, 'refresh'))).toBe('rt-obsolete-attempt');
    });

    it('an invalid_grant for the current credentials still requires reauthorisation (and only once)', async () => {
      const { owner, id, run } = await expiringConnection();
      const slow = delayed('invalid_grant');
      const attempt = obtainAccessToken(run, id, { adapter: slow.adapter }).catch((e: unknown) => e);
      await slow.started;
      // Expired lease, but nobody replaced the credentials: the refusal is about the current token.
      await admin.query("UPDATE mail_connection_credentials SET refresh_lease_until = now() - interval '1 second' WHERE connection_id = $1", [id]);
      slow.release();
      expect(await attempt).toMatchObject({ code: 'invalid_grant' });
      expect((await api(owner, A.slug).get(id)).body.connection).toMatchObject({ status: 'NEEDS_REAUTH', lastErrorCode: 'reauth_required' });
      expect(await count("SELECT count(*) AS n FROM audit_events WHERE target_id = $1 AND action = 'communications.system.reauth_required'", [id])).toBe(1);
    });

    it('a reconnect in between fences out the older refresh too', async () => {
      const { owner, id, run } = await expiringConnection();
      const acctEmail = (await api(owner, A.slug).get(id)).body.connection.mailboxAddress;
      const accountRow = [...fake.refresh.values()].find((a) => a.email.toLowerCase() === acctEmail)!;
      const slow = delayed('invalid_grant');
      const attempt = obtainAccessToken(run, id, { adapter: slow.adapter }).catch((e: unknown) => e);
      await slow.started;
      expect(await connect(owner, A.slug, accountRow, { connectionId: id })).toBe(id);
      slow.release();
      expect(await attempt).toMatchObject({ code: 'busy' });
      expect((await api(owner, A.slug).get(id)).body.connection.status).toBe('ACTIVE');
    });
  });
});

describe('sync-job foundation', () => {
  let one: string;
  let two: string;
  beforeAll(async () => {
    one = await connect(B.people.MANAGER!, B.slug, account('GOOGLE', 'sync-one'));
    two = await connect(B.people.MANAGER2!, B.slug, account('MICROSOFT', 'sync-two'));
    // Only these two mailboxes have work in this business for the claim tests.
    await admin.query("UPDATE mail_sync_jobs SET status = 'CANCELLED', finished_at = now() WHERE business_id = $1 AND connection_id <> ALL($2::uuid[]) AND status = 'QUEUED'", [B.businessId, [one, two]]);
  });

  it('requesting a sync is idempotent, also under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => api(B.people.MANAGER!, B.slug).sync(one)));
    expect(results.every((r) => r.status === 200)).toBe(true); // the INITIAL job queued at connect time
    expect(new Set(results.map((r) => MailSyncJobResponse.parse(r.body).job.id)).size).toBe(1);
    expect(await count("SELECT count(*) AS n FROM mail_sync_jobs WHERE connection_id = $1 AND status IN ('QUEUED','RUNNING')", [one])).toBe(1);
  });

  it('concurrent workers claim different jobs (SKIP LOCKED); transitions need the lease', async () => {
    const [x, y] = await Promise.all([system(B.businessId, (db) => claimSyncJob(db)), system(B.businessId, (db) => claimSyncJob(db))]);
    expect(x && y).toBeTruthy();
    expect(new Set([x!.connection.id, y!.connection.id])).toEqual(new Set([one, two]));
    expect(await system(B.businessId, (db) => claimSyncJob(db))).toBeNull();
    const jobOne = x!.connection.id === one ? x! : y!;
    const jobTwo = jobOne === x ? y! : x!;
    expect(jobOne.job).toMatchObject({ status: 'RUNNING', attempts: 1, kind: 'INITIAL' });
    // A worker that does not hold the lease can do nothing.
    expect(await system(B.businessId, (db) => completeSyncJob(db, jobOne.job.id, randomUUID()))).toBe(false);
    expect(await system(B.businessId, (db) => heartbeatSyncJob(db, jobOne.job.id, jobOne.leaseId))).toBe(true);
    expect(await system(B.businessId, (db) => completeSyncJob(db, jobOne.job.id, jobOne.leaseId, { cursor: 'history-123' }))).toBe(true);
    const done = (await admin.query('SELECT c.sync_cursor, c.last_synced_at, j.status FROM mail_connections c JOIN mail_sync_jobs j ON j.connection_id = c.id WHERE j.id = $1', [jobOne.job.id])).rows[0];
    expect(done).toMatchObject({ sync_cursor: 'history-123', status: 'SUCCEEDED' });
    expect(done.last_synced_at).not.toBeNull();
    // Later requests are incremental; the cursor is never returned by the API.
    const next = await api(B.people.MANAGER!, B.slug).sync(one);
    expect(next.status).toBe(201);
    expect(next.body.job.kind).toBe('INCREMENTAL');
    expect(JSON.stringify((await api(B.people.MANAGER!, B.slug).get(one)).body)).not.toContain('history-123');

    // Retryable failure: back to QUEUED with backoff; not claimable until then.
    expect(await system(B.businessId, (db) => failSyncJob(db, jobTwo.job.id, jobTwo.leaseId, { code: 'rate_limited', retryAfterMs: 120_000 }))).toBe('QUEUED');
    const queued = (await admin.query('SELECT status, run_after - now() AS wait, last_error_code FROM mail_sync_jobs WHERE id = $1', [jobTwo.job.id])).rows[0];
    expect(queued.status).toBe('QUEUED');
    expect(queued.last_error_code).toBe('rate_limited');
    expect(queued.wait.minutes * 60 + (queued.wait.seconds ?? 0)).toBeGreaterThan(100);
  });

  it('expired leases are reclaimed, and fail for good once attempts run out', async () => {
    const jobId = (await admin.query("SELECT id FROM mail_sync_jobs WHERE connection_id = $1 AND status = 'QUEUED'", [two])).rows[0].id;
    await admin.query('UPDATE mail_sync_jobs SET run_after = now() WHERE id = $1', [jobId]);
    const first = (await system(B.businessId, (db) => claimSyncJob(db)))!;
    // Pick up only connection two's job (connection one has a fresh INCREMENTAL job too).
    const claimed = first.connection.id === two ? first : (await system(B.businessId, (db) => claimSyncJob(db)))!;
    expect(claimed.job.id).toBe(jobId);
    await admin.query("UPDATE mail_sync_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [jobId]);
    const reclaimed = (await system(B.businessId, (db) => claimSyncJob(db)))!;
    expect(reclaimed.job.id).toBe(jobId);
    expect(reclaimed.leaseId).not.toBe(claimed.leaseId);
    expect(await system(B.businessId, (db) => completeSyncJob(db, jobId, claimed.leaseId))).toBe(false); // the old worker lost
    await admin.query("UPDATE mail_sync_jobs SET attempts = max_attempts, lease_expires_at = now() - interval '1 second' WHERE id = $1", [jobId]);
    await system(B.businessId, (db) => claimSyncJob(db));
    expect((await admin.query('SELECT status, last_error_code FROM mail_sync_jobs WHERE id = $1', [jobId])).rows[0]).toEqual({ status: 'FAILED', last_error_code: 'lease_expired' });
    // A non-retryable failure is final at once.
    const fresh = await api(B.people.MANAGER2!, B.slug).sync(two);
    expect(fresh.status).toBe(201);
    let mine = (await system(B.businessId, (db) => claimSyncJob(db)))!;
    while (mine.job.id !== fresh.body.job.id) {
      await system(B.businessId, (db) => completeSyncJob(db, mine.job.id, mine.leaseId));
      mine = (await system(B.businessId, (db) => claimSyncJob(db)))!;
    }
    expect(await system(B.businessId, (db) => failSyncJob(db, mine.job.id, mine.leaseId, { code: 'cursor_expired' }))).toBe('FAILED');
  });

  it('a mailbox whose owner is no longer an active member stops: job cancelled, tokens deleted, system audit', async () => {
    const owner = B.people.MANAGER2!;
    expect((await api(owner, B.slug).sync(two)).status).toBe(201);
    await admin.query("UPDATE memberships SET status = 'SUSPENDED' WHERE business_id = $1 AND user_id = $2", [B.businessId, owner.id]);
    try {
      // Connection one's job may be due too; drain until nothing is handed out.
      for (let claimed = await system(B.businessId, (db) => claimSyncJob(db)); claimed; claimed = await system(B.businessId, (db) => claimSyncJob(db))) {
        expect(claimed.connection.id).not.toBe(two);
        await system(B.businessId, (db) => completeSyncJob(db, claimed!.job.id, claimed!.leaseId));
      }
      const row = (await admin.query('SELECT status, last_error_code FROM mail_connections WHERE id = $1', [two])).rows[0];
      expect(row).toEqual({ status: 'NEEDS_REAUTH', last_error_code: 'owner_inactive' });
      expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [two])).toBe(0);
      expect(await count("SELECT count(*) AS n FROM audit_events WHERE target_id = $1 AND action = 'communications.system.owner_inactive' AND actor_user_id IS NULL", [two])).toBe(1);
    } finally {
      await admin.query("UPDATE memberships SET status = 'ACTIVE' WHERE business_id = $1 AND user_id = $2", [B.businessId, owner.id]);
    }
  });
  describe('C2A-02: an expired lease authorises nothing, even before it is reclaimed', () => {
    // Claim the queued job of one connection, completing whatever else is due first.
    async function claimFor(connectionId: string) {
      for (let c = await system(B.businessId, (db) => claimSyncJob(db)); c; c = await system(B.businessId, (db) => claimSyncJob(db))) {
        if (c.connection.id === connectionId) return c;
        await system(B.businessId, (db) => completeSyncJob(db, c!.job.id, c!.leaseId));
      }
      throw new Error('no job for ' + connectionId);
    }
    const state = async (jobId: string) =>
      (await admin.query('SELECT j.status, j.attempts, j.lease_id::text AS lease, c.sync_cursor FROM mail_sync_jobs j JOIN mail_connections c ON c.id = j.connection_id WHERE j.id = $1', [jobId])).rows[0];

    it('heartbeat, complete and fail are refused on database time once the lease ran out', async () => {
      const id = await connect(B.people.MANAGER!, B.slug, account('GOOGLE', 'lease-expired'));
      const claimed = await claimFor(id);
      await admin.query("UPDATE mail_sync_jobs SET lease_expires_at = now() - interval '1 millisecond' WHERE id = $1", [claimed.job.id]);
      expect(await system(B.businessId, (db) => heartbeatSyncJob(db, claimed.job.id, claimed.leaseId))).toBe(false);
      expect(await system(B.businessId, (db) => completeSyncJob(db, claimed.job.id, claimed.leaseId, { cursor: 'stale-cursor' }))).toBe(false);
      expect(await system(B.businessId, (db) => failSyncJob(db, claimed.job.id, claimed.leaseId, { code: 'rate_limited' }))).toBeNull();
      expect(await system(B.businessId, (db) => failSyncJob(db, claimed.job.id, claimed.leaseId, { code: 'reauth_required' }))).toBeNull();
      // Nothing moved: still RUNNING under the same lease, no cursor, the mailbox untouched.
      expect(await state(claimed.job.id)).toEqual({ status: 'RUNNING', attempts: 1, lease: claimed.leaseId, sync_cursor: null });
      const conn = (await admin.query('SELECT status, last_error_code, last_synced_at FROM mail_connections WHERE id = $1', [id])).rows[0];
      expect(conn).toEqual({ status: 'ACTIVE', last_error_code: null, last_synced_at: null });
      // The next claim reclaims it under a new lease; only that lease can finish it.
      const reclaimed = await claimFor(id);
      expect(reclaimed.job.id).toBe(claimed.job.id);
      expect(await system(B.businessId, (db) => completeSyncJob(db, claimed.job.id, claimed.leaseId, { cursor: 'stale-cursor' }))).toBe(false);
      expect(await system(B.businessId, (db) => completeSyncJob(db, reclaimed.job.id, reclaimed.leaseId, { cursor: 'fresh-cursor' }))).toBe(true);
      expect(await state(claimed.job.id)).toMatchObject({ status: 'SUCCEEDED', sync_cursor: 'fresh-cursor' });
    });

    it('a cancelled job cannot write its cursor, even with an unexpired lease', async () => {
      const owner = B.people.MANAGER!;
      const id = await connect(owner, B.slug, account('GOOGLE', 'lease-cancelled'));
      const claimed = await claimFor(id);
      expect((await api(owner, B.slug).disconnect(id)).status).toBe(200);
      expect((await state(claimed.job.id)).status).toBe('CANCELLED');
      expect(await system(B.businessId, (db) => heartbeatSyncJob(db, claimed.job.id, claimed.leaseId))).toBe(false);
      expect(await system(B.businessId, (db) => completeSyncJob(db, claimed.job.id, claimed.leaseId, { cursor: 'after-cancel' }))).toBe(false);
      expect(await system(B.businessId, (db) => failSyncJob(db, claimed.job.id, claimed.leaseId, { code: 'rate_limited' }))).toBeNull();
      expect(await state(claimed.job.id)).toMatchObject({ status: 'CANCELLED', sync_cursor: null });
    });

    it('a paused mailbox keeps its cursor when a still-leased job completes', async () => {
      const owner = B.people.MANAGER!;
      const id = await connect(owner, B.slug, account('GOOGLE', 'lease-paused'));
      const claimed = await claimFor(id);
      await admin.query('UPDATE mail_connections SET sync_enabled = false WHERE id = $1', [id]);
      // The job itself may finish, but a paused mailbox takes no new cursor.
      await system(B.businessId, (db) => completeSyncJob(db, claimed.job.id, claimed.leaseId, { cursor: 'while-paused' }));
      expect((await admin.query('SELECT sync_cursor FROM mail_connections WHERE id = $1', [id])).rows[0].sync_cursor).toBeNull();
    });
  });
});

describe('tenant isolation and database guarantees', () => {
  let aId: string;
  beforeAll(async () => {
    aId = await connect(A.people.OWNER!, A.slug, account('GOOGLE', 'isolated'));
  });

  it("another business cannot see or touch a connection, even by id (404 on every route)", async () => {
    const other = api(B.people.OWNER!, B.slug);
    for (const res of [await other.get(aId), await other.update(aId, { syncEnabled: false, version: 1 }), await other.disconnect(aId), await other.sync(aId), await other.jobs(aId)]) {
      expect(res.status).toBe(404);
    }
    expect((await other.authorize({ provider: 'GOOGLE', connectionId: aId })).status).toBe(404);
    expect((await other.list('?includeDisconnected=true')).body.connections.map((c: { id: string }) => c.id)).not.toContain(aId);
  });

  it('RLS: bos_app in another business sees no row of any C2-A table, and cannot write into this one', async () => {
    for (const table of ['mail_connections', 'mail_oauth_states', 'mail_sync_jobs']) {
      const rows = await asApp(B.businessId, B.people.OWNER!.id, `SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [A.businessId]);
      expect(rows.rows[0].n).toBe(0);
    }
    const creds = await asApp(B.businessId, B.people.OWNER!.id, 'SELECT count(*)::int AS n FROM mail_connection_credentials', []);
    const own = await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE business_id = $1', [B.businessId]);
    expect(creds.rows[0].n).toBe(own);
    await expect(asApp(B.businessId, B.people.OWNER!.id,
      "INSERT INTO mail_sync_jobs (id, business_id, connection_id, kind) VALUES ($1, $2, $3, 'INITIAL')", [randomUUID(), A.businessId, aId])).rejects.toMatchObject({ code: '42501' });
    // No context at all sees nothing.
    expect((await app.query('SELECT count(*)::int AS n FROM mail_connection_credentials')).rows[0].n).toBe(0);
  });

  it('a ciphertext copied to another row or business does not decrypt', async () => {
    const sealed = (await admin.query('SELECT refresh_token_enc FROM mail_connection_credentials WHERE connection_id = $1', [aId])).rows[0].refresh_token_enc;
    const target = (await admin.query("SELECT connection_id FROM mail_connection_credentials WHERE business_id = $1 LIMIT 1", [B.businessId])).rows[0].connection_id;
    expect(() => credentialBox().open(sealed, credentialAad(B.businessId, target, 'refresh'))).toThrow();
    expect(() => credentialBox().open(sealed, credentialAad(A.businessId, aId, 'access'))).toThrow();
  });

  it('grants and guards: identity is fixed, no deletes, plaintext and long-lived states refused, authorship enforced', async () => {
    const owner = A.people.OWNER!;
    const run = (sql: string, params: unknown[] = [], user = owner.id) => asApp(A.businessId, user, sql, params).then(() => 'ok', sqlState);
    expect(await run('UPDATE mail_connections SET owner_user_id = $1 WHERE id = $2', [A.people.ADMIN!.id, aId])).toBe('42501'); // no column grant
    expect(await run('DELETE FROM mail_connections WHERE id = $1', [aId])).toBe('42501');
    expect(await run('DELETE FROM mail_sync_jobs WHERE connection_id = $1', [aId])).toBe('42501');
    expect(await run("UPDATE mail_connection_credentials SET refresh_token_enc = 'plain-refresh-token' WHERE connection_id = $1", [aId])).toBe('23514');
    // Guards hold for any role, even a superuser that bypasses RLS and grants.
    const asAdmin = (sql: string, params: unknown[]) => admin.query(sql, params).then(() => 'ok', sqlState);
    expect(await asAdmin("UPDATE mail_connections SET provider_account_id = 'other' WHERE id = $1", [aId])).toBe('CM005');
    expect(await asAdmin('UPDATE mail_connections SET owner_user_id = $1 WHERE id = $2', [A.people.ADMIN!.id, aId])).toBe('CM005');
    // Insert a connection for someone else, or an authorization for someone else: refused by RLS.
    expect(await run(`INSERT INTO mail_connections (id, business_id, provider, owner_user_id, provider_account_id, mailbox_address, granted_scopes)
      VALUES ($1, $2, 'GOOGLE', $3, 'x', 'x@example.com', ARRAY['openid'])`, [randomUUID(), A.businessId, A.people.ADMIN!.id])).toBe('42501');
    const verifier = credentialBox().seal('v', 'x');
    expect(await run(`INSERT INTO mail_oauth_states (id, business_id, state_hash, user_id, provider, code_verifier_enc, expires_at)
      VALUES ($1, $2, $3, $4, 'GOOGLE', $5, now() + interval '1 hour')`, [randomUUID(), A.businessId, 'a'.repeat(64), owner.id, verifier])).toBe('23514');
    // Disconnected rows are final; credentials need an active connection; finished jobs are final.
    const gone = await connect(owner, A.slug, account('GOOGLE', 'final'));
    await api(owner, A.slug).disconnect(gone);
    expect(await run("UPDATE mail_connections SET sharing = 'BUSINESS' WHERE id = $1", [gone])).toBe('CM006');
    expect(await run(`INSERT INTO mail_connection_credentials (business_id, connection_id, key_id, refresh_token_enc) VALUES ($1, $2, 'test-k2', $3)`,
      [A.businessId, gone, credentialBox().seal('x', 'y')])).toBe('CM006');
    expect(await run("UPDATE mail_sync_jobs SET status = 'QUEUED', finished_at = NULL WHERE connection_id = $1 AND status = 'CANCELLED'", [gone])).toBe('CM007');
    // The system audit policy is narrow: not with a session user, not for other actions.
    const ins = (action: string, user: string) => run(`INSERT INTO audit_events (id, business_id, actor_user_id, action) VALUES ($1, $2, NULL, $3)`, [randomUUID(), A.businessId, action], user);
    expect(await ins('communications.system.reauth_required', owner.id)).toBe('42501');
    expect(await ins('member.removed', '')).toBe('42501');
    expect(await ins('communications.system.reauth_required', '')).toBe('ok');
  });

  it('business purge removes every connection, credential, authorization and job', async () => {
    const C = await team('c2purge');
    const id = await connect(C.people.OWNER!, C.slug, account('GOOGLE', 'purged'));
    await api(C.people.OWNER!, C.slug).authorize({ provider: 'MICROSOFT' });
    expect(await count('SELECT count(*) AS n FROM mail_connection_credentials WHERE connection_id = $1', [id])).toBe(1);
    await admin.query('DELETE FROM businesses WHERE id = $1', [C.businessId]);
    for (const table of ['mail_connections', 'mail_connection_credentials', 'mail_oauth_states', 'mail_sync_jobs']) {
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE business_id = $1`, [C.businessId])).toBe(0);
    }
  });
});
