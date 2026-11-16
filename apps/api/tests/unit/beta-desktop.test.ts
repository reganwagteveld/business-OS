import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { betaSessionAdmitted } from '@/core/db';
import { authorizeDesktop, confirmDesktop, createConfirmToken, exchangeDesktopCode } from '@/modules/identity/server/desktop';

const mocks = vi.hoisted(() => ({
  consume: vi.fn(), createSession: vi.fn(), deleteSession: vi.fn(), createCode: vi.fn(),
}));
vi.mock('@/core/db', () => ({ betaSessionAdmitted: vi.fn() }));
vi.mock('@/core/config/env', () => ({ getEnv: () => ({ APP_BASE_URL: 'https://beta.test', AUTH_SECRET: 'unit-test-signing-secret-with-at-least-32-characters' }) }));
vi.mock('@/modules/identity/server/session', () => ({
  getCurrentSession: async () => ({ user: { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.com', emailVerified: true }, sessionId: 'session-id' }),
  getSessionToken: async () => 'raw-browser-token', signSessionToken: (v: string) => `signed:${v}`,
}));
vi.mock('@/modules/identity/server/auth-adapter', () => ({ getAuth: () => ({ $context: Promise.resolve({ internalAdapter: {
  consumeVerificationValue: mocks.consume, createSession: mocks.createSession,
  deleteSession: mocks.deleteSession, createVerificationValue: mocks.createCode,
  findUserById: async () => ({ id: '00000000-0000-4000-8000-000000000001', emailVerified: true }),
} }) }) }));
const verifier = 'v'.repeat(43);
const params = {
  code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' as const,
  redirect_uri: 'http://127.0.0.1:53682/callback', state: 's'.repeat(32),
};
const url = 'https://beta.test/api/v1/auth/desktop/authorize';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.consume.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), value: JSON.stringify({ userId: '00000000-0000-4000-8000-000000000001', challenge: params.code_challenge, redirectUri: params.redirect_uri }) });
  mocks.createSession.mockResolvedValue({ token: 'new-token', expiresAt: new Date(Date.now() + 60_000) });
});
function confirmRequest() {
  return new Request(url, { method: 'POST', headers: { origin: 'https://beta.test' }, body: new URLSearchParams({ ...params, csrf: createConfirmToken('session-id', params) }) });
}
function tokenRequest() {
  return new Request('https://beta.test/api/v1/auth/desktop/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'c'.repeat(43), code_verifier: verifier, redirect_uri: params.redirect_uri }) });
}
describe('desktop admission', () => {
  it('denies the authorize page and confirmation for a pending invite', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(false);
    expect((await authorizeDesktop(new Request(`${url}?${new URLSearchParams(params)}`))).status).toBe(403);
    expect((await confirmDesktop(confirmRequest())).status).toBe(403);
    expect(mocks.createCode).not.toHaveBeenCalled();
  });
  it('keeps the authorised browser-to-desktop login working', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(true);
    expect((await authorizeDesktop(new Request(`${url}?${new URLSearchParams(params)}`))).status).toBe(200);
    expect((await confirmDesktop(confirmRequest())).status).toBe(303);
    expect(mocks.createCode).toHaveBeenCalledOnce();
    const response = await exchangeDesktopCode(tokenRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'signed:new-token' });
  });
  it('does not release a bearer token if admission was revoked after code issuance', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(false);
    expect((await exchangeDesktopCode(tokenRequest())).status).toBe(400);
    expect(mocks.deleteSession).toHaveBeenCalledWith('new-token');
  });
  it('maps a session-hook refusal to invalid_grant', async () => {
    mocks.createSession.mockRejectedValue(new Error('invite required'));
    const response = await exchangeDesktopCode(tokenRequest());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });
});
