import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Desktop sign-in confirmation: CSRF token, origin policy and loopback validation (PR 10 review).
beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://a:b@localhost:5432/db');
  vi.stubEnv('AUTH_DATABASE_URL', 'postgresql://auth:b@localhost:5432/db');
  vi.stubEnv('AUTH_SECRET', 'unit-signing-key-0123456789-abcdefghijkl');
  vi.stubEnv('APP_BASE_URL', 'https://app.example.test');
  vi.stubEnv('REGION', 'test-region');
  vi.stubEnv('DATABASE_REGION', 'test-region');
  vi.stubEnv('VERCEL_REGION', '');
});

const load = () => import('@/modules/identity/server/desktop');
const params = () => ({
  code_challenge: randomBytes(32).toString('base64url'),
  code_challenge_method: 'S256' as const,
  redirect_uri: 'http://127.0.0.1:53682/callback',
  state: randomBytes(16).toString('base64url'),
});

describe('confirmation CSRF token', () => {
  it('verifies only for the same session and the same request, before it expires', async () => {
    const { createConfirmToken, verifyConfirmToken } = await load();
    const p = params();
    const now = Date.now();
    const token = createConfirmToken('session-1', p, now);
    expect(verifyConfirmToken(token, 'session-1', p, now)).toBe(true);
    expect(verifyConfirmToken(token, 'session-2', p, now)).toBe(false);
    expect(verifyConfirmToken(token, 'session-1', { ...p, state: params().state }, now)).toBe(false);
    expect(verifyConfirmToken(token, 'session-1', { ...p, code_challenge: params().code_challenge }, now)).toBe(false);
    expect(verifyConfirmToken(token, 'session-1', { ...p, redirect_uri: 'http://127.0.0.1:53683/callback' }, now)).toBe(false);
    expect(verifyConfirmToken(token, 'session-1', p, now + 11 * 60 * 1000)).toBe(false); // expired
  });

  it('rejects tampered, malformed and far-future tokens', async () => {
    const { createConfirmToken, verifyConfirmToken } = await load();
    const p = params();
    const now = Date.now();
    const token = createConfirmToken('s', p, now);
    const [exp, mac] = token.split('.') as [string, string];
    expect(verifyConfirmToken(`${Number(exp) + 1}.${mac}`, 's', p, now)).toBe(false);
    expect(verifyConfirmToken(`${exp}.${mac.slice(0, -2)}AA`, 's', p, now)).toBe(false);
    expect(verifyConfirmToken('', 's', p, now)).toBe(false);
    expect(verifyConfirmToken('nope', 's', p, now)).toBe(false);
    // a token claiming an expiry beyond the allowed window is refused even with a valid MAC
    const future = createConfirmToken('s', p, now + 60 * 60 * 1000);
    expect(verifyConfirmToken(future, 's', p, now)).toBe(false);
  });
});

describe('confirmation origin policy', () => {
  const trusted = ['https://app.example.test'];
  const h = (init: Record<string, string>) => new Headers(init);

  it('accepts our origin and rejects every other real origin', async () => {
    const { confirmOriginAllowed } = await load();
    expect(confirmOriginAllowed(h({ origin: 'https://app.example.test' }), trusted)).toBe(true);
    for (const origin of ['https://evil.example', 'https://app.example.test.evil.example', 'http://app.example.test', 'tauri://localhost']) {
      expect(confirmOriginAllowed(h({ origin }), trusted)).toBe(false);
    }
  });

  it('accepts Origin: null (or none) only for a same-origin top-level form navigation', async () => {
    const { confirmOriginAllowed } = await load();
    const nav = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    expect(confirmOriginAllowed(h({ origin: 'null', ...nav }), trusted)).toBe(true);
    expect(confirmOriginAllowed(h({ ...nav }), trusted)).toBe(true);
    expect(confirmOriginAllowed(h({ origin: 'null' }), trusted)).toBe(false);
    expect(confirmOriginAllowed(h({ origin: 'null', ...nav, 'sec-fetch-site': 'cross-site' }), trusted)).toBe(false);
    expect(confirmOriginAllowed(h({ origin: 'null', ...nav, 'sec-fetch-site': 'same-site' }), trusted)).toBe(false);
    expect(confirmOriginAllowed(h({ origin: 'null', ...nav, 'sec-fetch-mode': 'cors' }), trusted)).toBe(false);
    expect(confirmOriginAllowed(h({ origin: 'null', ...nav, 'sec-fetch-dest': 'iframe' }), trusted)).toBe(false);
  });

  it('trusts the API origin itself only in local development', async () => {
    const { trustedConfirmOrigins } = await load();
    const req = new Request('http://localhost:3000/api/v1/auth/desktop/authorize');
    vi.stubEnv('NODE_ENV', 'production');
    expect(trustedConfirmOrigins(req)).toEqual(['https://app.example.test']);
    vi.stubEnv('NODE_ENV', 'development');
    expect(trustedConfirmOrigins(req)).toEqual(['https://app.example.test', 'http://localhost:3000']);
    vi.stubEnv('NODE_ENV', 'test');
  });
});

describe('loopback redirect validation', () => {
  it('allows only http://127.0.0.1:<1024-65535>/callback', async () => {
    const { loopbackOrigin } = await load();
    expect(loopbackOrigin('http://127.0.0.1:53682/callback')).toBe('http://127.0.0.1:53682');
    for (const uri of [
      'http://localhost:53682/callback', 'https://127.0.0.1:53682/callback', 'http://127.0.0.1:53682/other',
      'http://127.0.0.1/callback', 'http://127.0.0.1:80/callback', 'http://127.0.0.1:99999/callback',
      'http://127.0.0.1:53682/callback?x=1', 'http://evil.example/callback', 'http://127.0.0.1.evil.example:53682/callback',
    ]) {
      expect(loopbackOrigin(uri), uri).toBeNull();
    }
  });
});
