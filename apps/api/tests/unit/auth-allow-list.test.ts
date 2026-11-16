import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A3-0 (settings-a3 §15.1, §15.9 gate 1): the auth catch-all forwards only allow-listed (method, path)
// pairs to Better Auth. Better Auth is mocked here so the test can prove a refused request never reaches
// it (and therefore never reaches the database). tests/integration/auth.test.ts repeats the probes
// against the real library and PostgreSQL.
const SECRET = 'unit-signing-key-0123456789-abcdefghijkl';
const APP = 'https://app.example.test';
const BASE = `${APP}/api/v1/auth`;

const mocks = vi.hoisted(() => ({ handler: vi.fn(), context: vi.fn() }));
vi.mock('@/modules/identity/server/auth-adapter', () => ({
  AUTH_BASE_PATH: '/api/v1/auth',
  getAuth: () => ({
    handler: mocks.handler,
    get $context() {
      mocks.context();
      return Promise.resolve({ authCookies: { sessionToken: { name: 'bos.session_token' } } });
    },
  }),
}));

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://a:b@localhost:5432/db');
  vi.stubEnv('AUTH_DATABASE_URL', 'postgresql://auth:b@localhost:5432/db');
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('APP_BASE_URL', APP);
  vi.stubEnv('REGION', 'test-region');
  vi.stubEnv('DATABASE_REGION', 'test-region');
  vi.stubEnv('VERCEL_REGION', '');
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'tauri://localhost,http://tauri.localhost');
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.handler.mockReset();
  mocks.context.mockReset();
  mocks.handler.mockImplementation(async () => Response.json({ forwarded: true }));
});

const RESET_TOKEN = 'AbCdEf0123456789ghIJklMN'; // the shape Better Auth generates: 24 alphanumerics
const signed = (token: string) => `${token}.${createHmac('sha256', SECRET).update(token).digest('base64')}`;
const BEARER = `Bearer ${signed('t'.repeat(32))}`;
const COOKIE = `bos.session_token=${encodeURIComponent(signed('c'.repeat(32)))}`;

type Auth = 'none' | 'cookie' | 'bearer';
function request(method: string, path: string, auth: Auth = 'cookie', extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
  if (auth === 'cookie') {
    headers.set('cookie', COOKIE);
    if (!headers.has('origin')) headers.set('origin', APP);
  }
  if (auth === 'bearer') headers.set('authorization', BEARER);
  const hasBody = method !== 'GET' && method !== 'HEAD';
  if (hasBody) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: hasBody ? '{}' : undefined });
}

async function handle(r: Request) {
  const { handleAuthRequest } = await import('@/modules/identity/server/handler');
  return handleAuthRequest(r);
}

async function expectRejected(r: Request) {
  const res = await handle(r);
  expect(res.status, `${r.method} ${r.url}`).toBe(404);
  expect(await res.json()).toEqual({ error: 'not_found' });
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(mocks.handler).not.toHaveBeenCalled();
  expect(mocks.context).not.toHaveBeenCalled();
}

const ALLOWED: Array<[string, string]> = [
  ['POST', '/sign-up/email'],
  ['POST', '/sign-in/email'],
  ['POST', '/sign-out'],
  ['POST', '/request-password-reset'],
  ['GET', `/reset-password/${RESET_TOKEN}?callbackURL=%2Freset-password`],
  ['POST', '/reset-password'],
  ['GET', '/verify-email?token=abc.def.ghi&callbackURL=%2F'],
  ['POST', '/send-verification-email'],
];

describe('allow-listed routes', () => {
  it('reach Better Auth with a cookie and the exact app origin', async () => {
    for (const [method, path] of ALLOWED) {
      mocks.handler.mockClear();
      const res = await handle(request(method, path));
      expect(res.status, `${method} ${path}`).toBe(200);
      expect(mocks.handler).toHaveBeenCalledTimes(1);
      const forwarded = mocks.handler.mock.calls[0]![0] as Request;
      expect(forwarded.method).toBe(method);
      expect(forwarded.url).toBe(`${BASE}${path}`); // forwarded unchanged: Better Auth routes exactly what was checked
    }
  });

  it('reach Better Auth with a valid desktop bearer, with any cookie replaced by the bearer session', async () => {
    for (const [method, path] of ALLOWED) {
      mocks.handler.mockClear();
      const res = await handle(request(method, path, 'bearer', { cookie: 'bos.session_token=ambient' }));
      expect(res.status, `${method} ${path}`).toBe(200);
      const forwarded = mocks.handler.mock.calls[0]![0] as Request;
      expect(forwarded.headers.get('authorization')).toBeNull();
      expect(forwarded.headers.get('cookie')).toBe(`bos.session_token=${encodeURIComponent(signed('t'.repeat(32)))}`);
    }
  });

  it('still refuse a state change with a missing, foreign or look-alike Origin (CSRF unchanged)', async () => {
    for (const [method, path] of ALLOWED.filter(([m]) => m === 'POST')) {
      for (const origin of [undefined, 'https://evil.example', 'https://app.example.test.evil.example', 'tauri://localhost']) {
        const headers = new Headers({ cookie: COOKIE, 'content-type': 'application/json' });
        if (origin) headers.set('origin', origin);
        const res = await handle(new Request(`${BASE}${path}`, { method, headers, body: '{}' }));
        expect(res.status, `${path} from ${origin}`).toBe(403);
      }
    }
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('still refuse an invalid or tampered bearer, and a valid bearer from a foreign origin', async () => {
    for (const [method, path] of ALLOWED.filter(([m]) => m === 'POST')) {
      for (const authorization of ['Bearer', 'Basic abc', `Bearer ${'t'.repeat(32)}`, `${BEARER.slice(0, -2)}AA`]) {
        const res = await handle(new Request(`${BASE}${path}`, { method, headers: { authorization, cookie: COOKIE, origin: APP }, body: '{}' }));
        expect(res.status, `${path} ${authorization}`).toBe(401);
      }
      const foreign = await handle(new Request(`${BASE}${path}`, { method, headers: { authorization: BEARER, origin: 'https://evil.example' }, body: '{}' }));
      expect(foreign.status).toBe(403);
    }
    expect(mocks.handler).not.toHaveBeenCalled();
  });
});

// §15.1 item 6: representative non-allowed built-ins, with a cookie and with a bearer, plus unknown paths.
const PROBES: Array<[string, string]> = [
  ['POST', '/update-user'],
  ['POST', '/change-password'],
  ['POST', '/change-email'],
  ['POST', '/delete-user'],
  ['GET', '/delete-user/callback?token=x'],
  ['GET', '/list-sessions'],
  ['POST', '/revoke-session'],
  ['POST', '/revoke-sessions'],
  ['POST', '/revoke-other-sessions'],
  ['POST', '/set-password'],
  ['POST', '/link-social'],
  ['POST', '/unlink-account'],
  ['GET', '/list-accounts'],
  ['GET', '/account-info'],
  ['POST', '/sign-in/social'],
  ['GET', '/callback/google'],
  ['GET', '/get-session'],
  ['POST', '/get-session'],
  ['POST', '/update-session'],
  ['POST', '/verify-password'],
  ['POST', '/refresh-token'],
  ['POST', '/get-access-token'],
  ['GET', '/ok'],
  ['GET', '/error'],
  ['GET', '/api/reference'],
  ['POST', '/no-such-endpoint'],
  ['GET', '/no-such-endpoint'],
];

describe('non-allowed built-ins and unknown paths', () => {
  for (const auth of ['cookie', 'bearer', 'none'] as const) {
    it(`get an identical 404 that never reaches Better Auth (${auth})`, async () => {
      for (const [method, path] of PROBES) await expectRejected(request(method, path, auth));
    });
  }

  it('are refused before CSRF classification, so a foreign origin or a bad bearer learns nothing more', async () => {
    await expectRejected(request('POST', '/update-user', 'cookie', { origin: 'https://evil.example' }));
    await expectRejected(new Request(`${BASE}/change-password`, { method: 'POST', headers: { authorization: 'Bearer forged' }, body: '{}' }));
  });

  it('are counted and logged under a fixed code, never with any path, segment, query or header text', async () => {
    const { rejectedAuthRequestCount, AUTH_REJECTION_CODE } = await import('@/modules/identity/server/allow-list');
    const warn = vi.mocked(console.warn);
    const before = rejectedAuthRequestCount();
    const sensitive = [
      request('GET', '/delete-user/callback?token=secret-token-value&callbackURL=%2F'),
      request('GET', `/reset-password/${RESET_TOKEN}/?callbackURL=x`),
      request('POST', '/user@example.com/update-user'),
      request('POST', '/eyJhbGciOiJIUzI1NiJ9.payload.sig'),
      request('POST', '/%0Aforged-log-line%0D'),
      request('POST', '/AKIAEXAMPLESECRET1234'),
      new Request(`${BASE}/x`, { method: 'PROPFIND', headers: { origin: APP } }),
    ];
    for (const r of sensitive) await handle(r);
    expect(rejectedAuthRequestCount()).toBe(before + sensitive.length);
    const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
    expect(lines).toHaveLength(sensitive.length);
    for (const line of lines) {
      expect(line).toMatch(new RegExp(`^\\[auth:rejected\\] code=${AUTH_REJECTION_CODE} method=(GET|POST|OTHER) total=\\d+$`));
    }
    const all = lines.join('\n');
    for (const fragment of ['secret-token-value', 'callbackURL', RESET_TOKEN, 'example.com', 'eyJhbGci', 'forged', 'AKIA', 'delete-user', 'update-user', 'reset-password', 'PROPFIND', '/']) {
      expect(all).not.toContain(fragment);
    }
  });
});

describe('path normalisation (§15.9 gate 1)', () => {
  it('accepts allowed paths with any query string', async () => {
    for (const path of ['/sign-in/email?x=1', '/sign-out?', '/verify-email', '/verify-email?token=a&token=b']) {
      mocks.handler.mockClear();
      const method = path.startsWith('/verify-email') ? 'GET' : 'POST';
      expect((await handle(request(method, path))).status, path).toBe(200);
    }
  });

  it('rejects trailing slashes, repeated slashes, case changes and percent-encoding', async () => {
    const variants: Array<[string, string]> = [
      ['POST', '/sign-in/email/'],
      ['POST', '/sign-out/'],
      ['GET', '/verify-email/'],
      ['GET', `/reset-password/${RESET_TOKEN}/`],
      ['POST', '//sign-in/email'],
      ['POST', '/sign-in//email'],
      ['POST', '/Sign-In/Email'],
      ['POST', '/SIGN-OUT'],
      ['POST', '/sign%2Din/email'],
      ['POST', '/sign-in%2Femail'],
      ['POST', '/sign-in/email%00'],
      ['POST', '/sign-in/email;x'],
      ['POST', '/sign-in/email.json'],
      ['POST', '/%73ign-out'],
      ['GET', '/verify%2Demail?token=x'],
      ['POST', '/'],
      ['POST', ''],
    ];
    for (const [method, path] of variants) await expectRejected(request(method, path));
  });

  it('judges dot segments after URL resolution, exactly as Better Auth will see them', async () => {
    // new URL() resolves these, and the resolved pathname is what both the allow-list and Better Auth read.
    await expectRejected(request('POST', '/sign-in/../update-user'));
    await expectRejected(request('POST', '/sign-in/%2e%2e/change-password'));
    await expectRejected(request('POST', '/sign-out/./../delete-user'));
    await expectRejected(new Request(`${APP}/api/v1/auth/../auth-other/sign-out`, { method: 'POST', headers: { origin: APP } }));
    mocks.handler.mockClear();
    expect((await handle(request('POST', '/sign-up/../sign-out'))).status).toBe(200);
    expect((mocks.handler.mock.calls[0]![0] as Request).url).toBe(`${BASE}/sign-out`);
  });

  it('accepts only path-safe reset tokens in the reset link', async () => {
    for (const token of ['a.b', 'a%2Fb', 'a%2E%2E', '%00', 'a b', 'x'.repeat(257)]) {
      await expectRejected(request('GET', `/reset-password/${token}?callbackURL=%2F`));
    }
    await expectRejected(request('GET', `/reset-password/${RESET_TOKEN}/extra`));
    await expectRejected(request('GET', '/reset-password/'));
  });

  it('matches the method exactly (no HEAD for GET, no GET for POST, no other verbs)', async () => {
    await expectRejected(request('HEAD', '/verify-email?token=x'));
    await expectRejected(request('HEAD', `/reset-password/${RESET_TOKEN}`));
    await expectRejected(request('GET', '/sign-in/email'));
    await expectRejected(request('GET', '/sign-out'));
    await expectRejected(request('POST', '/verify-email?token=x'));
    for (const method of ['PUT', 'PATCH', 'DELETE']) await expectRejected(request(method, '/sign-out'));
  });

  it('rejects anything outside the auth base path', async () => {
    await expectRejected(new Request(`${APP}/api/v1/authx/sign-out`, { method: 'POST', headers: { origin: APP } }));
    await expectRejected(new Request(`${APP}/sign-out`, { method: 'POST', headers: { origin: APP } }));
  });
});

describe('CORS preflight (OPTIONS) exception', () => {
  async function route() {
    return import('@/app/api/v1/auth/[...all]/route');
  }

  it('answers 204 for allowed and blocked paths alike, without reaching Better Auth or the allow-list', async () => {
    const { OPTIONS } = await route();
    const { rejectedAuthRequestCount } = await import('@/modules/identity/server/allow-list');
    const before = rejectedAuthRequestCount();
    for (const path of ['/sign-in/email', '/update-user', '/delete-user', '/no-such-endpoint']) {
      const res = OPTIONS(new Request(`${BASE}${path}`, { method: 'OPTIONS', headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST' } }));
      expect(res.status, path).toBe(204);
      expect(await res.text()).toBe('');
      expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
    expect(mocks.handler).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(rejectedAuthRequestCount()).toBe(before);
  });

  it('grants no CORS headers to a foreign origin', async () => {
    const { OPTIONS } = await route();
    const res = OPTIONS(new Request(`${BASE}/sign-in/email`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('does not open the blocked route: the follow-up request is still refused', async () => {
    const { POST } = await route();
    const res = await POST(request('POST', '/update-user', 'bearer', { origin: 'tauri://localhost' }));
    expect(res.status).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('is refused if OPTIONS ever reaches handleAuthRequest directly', async () => {
    await expectRejected(request('OPTIONS', '/sign-in/email', 'none'));
  });
});
