/**
 * Communications C2-A (docs/communications-c2.md §7–8): credential encryption, environment rules and
 * the Google / Microsoft adapters against recorded-shape fixture responses. No network: fetch is
 * replaced for every test, and no real provider credential exists anywhere in the suite.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '@/core/config/schema';
import { createSecretBox, SecretBoxError } from '@/core/crypto/secret-box';
import { googleAdapter } from '@/modules/communications/server/providers/google';
import { microsoftAdapter } from '@/modules/communications/server/providers/microsoft';
import { ProviderError } from '@/modules/communications/server/providers/types';
import { backoffMs } from '@/modules/communications/server/sync-jobs';
import { parseState } from '@/modules/communications/server/connections';

const key = (id: string) => ({ id, key: randomBytes(32) });

describe('secret box (AES-256-GCM with bound associated data)', () => {
  const k1 = key('k1');
  const box = createSecretBox([k1]);

  it('round-trips and never contains the plaintext', () => {
    const sealed = box.seal('refresh-token-value', 'aad');
    expect(sealed).toMatch(/^v1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);
    expect(sealed).not.toContain('refresh-token-value');
    expect(box.open(sealed, 'aad')).toBe('refresh-token-value');
    expect(box.seal('x', 'aad')).not.toBe(box.seal('x', 'aad')); // random IV
  });

  it('refuses another row, another business, tampering and unknown keys, with no detail', () => {
    const sealed = box.seal('plain-rt-value', 'bos:mail-credential:v1:biz-a:conn-1:refresh');
    for (const aad of ['bos:mail-credential:v1:biz-b:conn-1:refresh', 'bos:mail-credential:v1:biz-a:conn-2:refresh', 'bos:mail-credential:v1:biz-a:conn-1:access']) {
      expect(() => box.open(sealed, aad)).toThrow(SecretBoxError);
    }
    const [v, id, iv, body] = sealed.split('.');
    const bytes = Buffer.from(body!, 'base64url');
    bytes[0] = bytes[0]! ^ 0x01;
    const flipped = `${v}.${id}.${iv}.${bytes.toString('base64url')}`;
    expect(() => box.open(flipped, 'bos:mail-credential:v1:biz-a:conn-1:refresh')).toThrow(SecretBoxError);
    expect(() => createSecretBox([key('other')]).open(sealed, 'x')).toThrow(/unknown_key/);
    expect(() => box.open('plaintext-token', 'x')).toThrow(/malformed/);
    try {
      box.open(sealed, 'wrong');
    } catch (error) {
      expect(String(error)).not.toContain('plain-rt-value');
    }
  });

  it('rotates: a new first key encrypts, the old one still decrypts', () => {
    const old = box.seal('t', 'a');
    const rotated = createSecretBox([key('k2'), k1]);
    expect(rotated.open(old, 'a')).toBe('t');
    expect(rotated.keyIdOf(rotated.seal('t', 'a'))).toBe('k2');
    expect(() => createSecretBox([])).toThrow(/not_configured/);
  });
});

describe('communications environment', () => {
  const valid = {
    DATABASE_URL: 'postgresql://a:b@localhost:5432/db', AUTH_DATABASE_URL: 'postgresql://auth:b@localhost:5432/db',
    AUTH_SECRET: 'test-signing-key-0123456789-abcdefghijkl', APP_BASE_URL: 'http://localhost:3000', REGION: 'r', DATABASE_REGION: 'r',
  };
  const keyValue = randomBytes(32).toString('base64');

  it('is optional: no keys and no providers means the feature is off', () => {
    const env = parseEnv(valid);
    expect(env.COMMUNICATIONS_CREDENTIAL_KEYS).toEqual([]);
    expect(env.MICROSOFT_OAUTH_TENANT).toBe('common');
  });
  it('parses a key ring and rejects wrong lengths, bad ids and duplicates without echoing the key', () => {
    const env = parseEnv({ ...valid, COMMUNICATIONS_CREDENTIAL_KEYS: `k2026a:${keyValue}, k2025:${randomBytes(32).toString('base64')}` });
    expect(env.COMMUNICATIONS_CREDENTIAL_KEYS.map((k) => k.id)).toEqual(['k2026a', 'k2025']);
    const short = randomBytes(16).toString('base64');
    expect(() => parseEnv({ ...valid, COMMUNICATIONS_CREDENTIAL_KEYS: `k:${short}` })).toThrow(/exactly 32 bytes/);
    try {
      parseEnv({ ...valid, COMMUNICATIONS_CREDENTIAL_KEYS: `k:${short}` });
    } catch (error) {
      expect(String(error)).not.toContain(short);
    }
    expect(() => parseEnv({ ...valid, COMMUNICATIONS_CREDENTIAL_KEYS: `Bad Id:${keyValue}` })).toThrow(/keyId:base64/);
    expect(() => parseEnv({ ...valid, COMMUNICATIONS_CREDENTIAL_KEYS: `k:${keyValue},k:${keyValue}` })).toThrow(/unique/);
  });
  it('needs client id and secret together, and keys whenever a provider is configured', () => {
    expect(() => parseEnv({ ...valid, GOOGLE_OAUTH_CLIENT_ID: 'id' })).toThrow(/both GOOGLE_OAUTH_CLIENT_ID/);
    expect(() => parseEnv({ ...valid, MICROSOFT_OAUTH_CLIENT_ID: 'id', MICROSOFT_OAUTH_CLIENT_SECRET: 's' })).toThrow(/COMMUNICATIONS_CREDENTIAL_KEYS is required/);
    expect(parseEnv({ ...valid, GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's', COMMUNICATIONS_CREDENTIAL_KEYS: `k:${keyValue}` }).GOOGLE_OAUTH_CLIENT_ID).toBe('id');
    expect(() => parseEnv({ ...valid, MICROSOFT_OAUTH_TENANT: 'https://evil.example' })).toThrow();
  });
});

type Call = { url: string; init: RequestInit };
function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }));
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
afterEach(() => vi.unstubAllGlobals());

const config = { clientId: 'test-client-id', clientSecret: 'test-client-secret' };
const redirectUri = 'http://localhost:3000/api/v1/communications/oauth/callback';

describe('Google adapter', () => {
  const google = googleAdapter(config);

  it('builds an offline, consent, PKCE S256 authorization URL with read-only scopes and nothing secret', () => {
    const url = new URL(google.authorizationUrl({ state: 'slug.nonce', codeChallenge: 'challenge', redirectUri, loginHint: 'me@x.example' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      client_id: 'test-client-id', redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent',
      state: 'slug.nonce', code_challenge: 'challenge', code_challenge_method: 'S256', login_hint: 'me@x.example',
    });
    expect(p.scope!.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']);
    expect(url.toString()).not.toContain('test-client-secret');
    expect(p.scope).not.toMatch(/gmail\.(send|modify)|mail\.google\.com/);
  });

  it('exchanges the code with the verifier and reports the granted scopes', async () => {
    const calls = stubFetch(() => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly', token_type: 'Bearer' }));
    const tokens = await google.exchangeCode({ code: 'the-code', codeVerifier: 'the-verifier', redirectUri });
    expect(tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });
    expect(google.hasScopes(tokens.scopes, 'read')).toBe(true);
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', code_verifier: 'the-verifier', redirect_uri: redirectUri });
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it('detects granular consent that left out Gmail access', () => {
    expect(google.hasScopes(['openid', 'email'], 'read')).toBe(false);
  });

  it('normalises failures to stable codes without tokens or bodies', async () => {
    stubFetch(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked. rt-secret' }, 400));
    const error = await google.refresh('rt-secret').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('invalid_grant');
    expect(String(error)).not.toContain('rt-secret');
    expect(JSON.stringify(error)).not.toContain('rt-secret');

    stubFetch(() => json({}, 429, { 'retry-after': '7' }));
    const limited = (await google.refresh('x').catch((e: unknown) => e)) as ProviderError;
    expect([limited.code, limited.retryAfterMs, limited.retryable]).toEqual(['rate_limited', 7000, true]);

    stubFetch(() => json({}, 503));
    expect(((await google.refresh('x').catch((e: unknown) => e)) as ProviderError).code).toBe('unavailable');
    stubFetch(() => { throw new TypeError('network down'); });
    expect(((await google.refresh('x').catch((e: unknown) => e)) as ProviderError).code).toBe('unavailable');
    stubFetch(() => new Response('<html>', { status: 200 }));
    expect(((await google.refresh('x').catch((e: unknown) => e)) as ProviderError).code).toBe('invalid_response');
    // A code exchange without a refresh token cannot make a lasting connection.
    stubFetch(() => json({ access_token: 'a', expires_in: 60 }));
    expect(((await google.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri }).catch((e: unknown) => e)) as ProviderError).code).toBe('invalid_response');
  });

  it('identifies the account by OIDC sub and refuses unverified addresses', async () => {
    const calls = stubFetch(() => json({ sub: '1234567890', email: 'Owner@Example.com', email_verified: true, name: 'Owner' }));
    expect(await google.account('at-1')).toEqual({ providerAccountId: '1234567890', address: 'owner@example.com', displayName: 'Owner' });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer at-1');
    stubFetch(() => json({ sub: '1', email: 'x@example.com', email_verified: false }));
    await expect(google.account('at')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('revokes through the revocation endpoint; an already-dead token counts as revoked', async () => {
    const calls = stubFetch(() => json({ error: 'invalid_token' }, 400));
    expect(await google.revoke('rt-1')).toBe('revoked');
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/revoke');
  });
});

describe('Microsoft adapter', () => {
  const microsoft = microsoftAdapter({ ...config, tenant: 'common' });

  it('uses the v2 endpoints of the configured tenant with offline_access and Mail.Read only', () => {
    const url = new URL(microsoft.authorizationUrl({ state: 's.n', codeChallenge: 'c', redirectUri }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({ response_type: 'code', response_mode: 'query', code_challenge_method: 'S256', state: 's.n' });
    expect(p.scope!.split(' ')).toEqual(['offline_access', 'openid', 'email', 'User.Read', 'Mail.Read']);
    expect(p.scope).not.toMatch(/Mail\.Send|ReadWrite/);
    expect(microsoft.capabilities).toEqual({ tokenRevocation: false, rotatesRefreshTokens: true });
  });

  it('accepts Graph-qualified scope names and reads the account from /me', async () => {
    expect(microsoft.hasScopes(['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/User.Read', 'openid'], 'read')).toBe(true);
    expect(microsoft.hasScopes(['User.Read'], 'read')).toBe(false);
    stubFetch(() => json({ id: '00000000-0000-0000-0000-00000000abcd', mail: 'Sales@Contoso.example', userPrincipalName: 'sales@contoso.example', displayName: 'Sales' }));
    expect(await microsoft.account('at')).toEqual({ providerAccountId: '00000000-0000-0000-0000-00000000abcd', address: 'sales@contoso.example', displayName: 'Sales' });
    stubFetch(() => json({ id: 'x', mail: null, userPrincipalName: 'nomailbox@contoso.example' }));
    await expect(microsoft.account('at')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refresh returns the rotated refresh token; there is no revocation call', async () => {
    const calls = stubFetch(() => json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'Mail.Read User.Read' }));
    expect(await microsoft.refresh('rt-1')).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(await microsoft.revoke('rt-2')).toBe('unsupported');
    expect(calls).toHaveLength(1);
  });
});

describe('sync backoff and OAuth state format', () => {
  it('backs off exponentially, capped at an hour, and honours Retry-After', () => {
    expect([1, 2, 3, 10, 20].map((n) => backoffMs(n))).toEqual([30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
    expect(backoffMs(1, 300_000)).toBe(300_000);
    expect(backoffMs(1, 99_000_000)).toBe(3_600_000);
  });
  it('accepts only "<slug>.<43-char nonce>"', () => {
    const nonce = randomBytes(32).toString('base64url');
    expect(parseState(`acme-1.${nonce}`)).toEqual({ slug: 'acme-1', nonce });
    for (const bad of [nonce, `.${nonce}`, `ACME.${nonce}`, `acme.${nonce}x`, `acme.short`, `a/b.${nonce}`, 42, null]) expect(parseState(bad)).toBeNull();
  });
});
