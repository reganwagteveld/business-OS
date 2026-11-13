import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// CSRF policy for /api/v1/auth (PR 4 review): cookie-authenticated state changes need the exact
// browser-app origin; desktop bearer requests are authenticated by the signed token alone.
const SECRET = 'unit-signing-key-0123456789-abcdefghijkl';
const APP = 'https://app.example.test';

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

const signed = (token: string) => `${token}.${createHmac('sha256', SECRET).update(token).digest('base64')}`;
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request(`${APP}/api/v1/auth/sign-out`, { method, headers });

async function classify(request: Request) {
  const { classifyAuthRequest } = await import('@/modules/identity/server/handler');
  return classifyAuthRequest(request);
}

describe('cookie-authenticated state changes', () => {
  it('pass only with the exact browser-app origin', async () => {
    expect(await classify(req('POST', { origin: APP, cookie: 'bos.session_token=x' }))).toEqual({ kind: 'cookie' });
  });

  it('are rejected with no Origin header', async () => {
    expect(await classify(req('POST', { cookie: 'bos.session_token=x' }))).toMatchObject({ kind: 'reject', status: 403 });
    expect(await classify(req('POST'))).toMatchObject({ kind: 'reject', status: 403 });
  });

  it('are rejected from a CORS-allowed client origin (cookies are for the browser app only)', async () => {
    for (const origin of ['tauri://localhost', 'http://tauri.localhost']) {
      expect(await classify(req('POST', { origin, cookie: 'bos.session_token=x' }))).toMatchObject({ kind: 'reject', status: 403 });
    }
  });

  it('are rejected from look-alike and foreign origins', async () => {
    for (const origin of ['https://evil.example', 'https://app.example.test.evil.example', 'http://app.example.test', 'https://app.example.test:444', 'null']) {
      expect(await classify(req('POST', { origin }))).toMatchObject({ kind: 'reject', status: 403 });
    }
  });

  it('apply to every unsafe method', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(await classify(req(method, { origin: 'https://evil.example' }))).toMatchObject({ kind: 'reject' });
    }
  });
});

describe('desktop bearer requests', () => {
  const token = signed('t'.repeat(32));

  it('pass without an Origin header (native HTTP client) or from the desktop webview origin', async () => {
    expect(await classify(req('POST', { authorization: `Bearer ${token}` }))).toEqual({ kind: 'bearer' });
    expect(await classify(req('POST', { authorization: `Bearer ${token}`, origin: 'tauri://localhost' }))).toEqual({ kind: 'bearer' });
  });

  it('are rejected from a foreign origin even with a valid token', async () => {
    expect(await classify(req('POST', { authorization: `Bearer ${token}`, origin: 'https://evil.example' }))).toMatchObject({ kind: 'reject', status: 403 });
  });

  it('are rejected when the token is missing, unsigned or tampered, so a cookie can never stand in', async () => {
    for (const authorization of ['Bearer', 'Basic abc', `Bearer ${'t'.repeat(32)}`, `Bearer ${token.slice(0, -2)}AA`, `Bearer h:${'a'.repeat(64)}`]) {
      expect(await classify(req('POST', { authorization, cookie: 'bos.session_token=x', origin: APP }))).toMatchObject({ kind: 'reject', status: 401 });
    }
  });
});

describe('safe methods', () => {
  it('pass without Origin checks (they change nothing)', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(await classify(req(method))).toEqual({ kind: 'safe' });
  });
});
