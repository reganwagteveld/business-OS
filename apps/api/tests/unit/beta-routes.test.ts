import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { betaSessionAdmitted, myMemberships, withTenant } from '@/core/db';
import { publicRoute, tenantRoute } from '@/app/api/_lib/routes';

vi.mock('@/modules/identity', () => ({
  classifyAuthRequest: () => ({ kind: 'safe' }),
  getCurrentUser: async () => ({ id: 'user-id', email: 'user@example.com', emailVerified: true }),
  getSessionToken: async () => 'server-verified-token',
}));
vi.mock('@/core/db', async (original) => ({
  ...await original<typeof import('@/core/db')>(),
  betaSessionAdmitted: vi.fn(), myMemberships: vi.fn(), withTenant: vi.fn(),
}));
vi.mock('@/core/http', () => ({ apiHeaders: () => ({}) }));
const request = () => new Request('https://beta.test/api/v1/businesses');
beforeEach(() => vi.resetAllMocks());

describe('admission for existing browser and bearer sessions', () => {
  it('rejects unauthorised business creation before the handler executes', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(false);
    const handler = vi.fn();
    const response = await publicRoute({ response: z.unknown() }, handler)(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invite_required' });
    expect(handler).not.toHaveBeenCalled();
  });
  it('retains access for admitted users', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(true);
    const handler = vi.fn(async () => ({ body: { ok: true } }));
    expect((await publicRoute({ response: z.unknown() }, handler)(request())).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
  it('permits only the explicitly marked invitation redemption path before admission', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(false);
    const handler = vi.fn(async () => ({ body: {} }));
    expect((await publicRoute({ invitationRedemption: true, response: z.unknown() }, handler)(request())).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
  it('blocks direct tenant navigation even when a session exists', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(false);
    const handler = vi.fn();
    const response = await tenantRoute({ permission: 'business:read', response: z.unknown() }, handler)(request(), { params: Promise.resolve({ slug: 'other-tenant' }) });
    expect(response.status).toBe(403);
    expect(myMemberships).not.toHaveBeenCalled();
    expect(withTenant).not.toHaveBeenCalled();
  });
  it('admission does not grant access to another tenant', async () => {
    vi.mocked(betaSessionAdmitted).mockResolvedValue(true);
    vi.mocked(myMemberships).mockResolvedValue([]);
    const response = await tenantRoute({ permission: 'business:read', response: z.unknown() }, vi.fn())(request(), { params: Promise.resolve({ slug: 'other-tenant' }) });
    expect(response.status).toBe(404);
    expect(withTenant).not.toHaveBeenCalled();
  });
});
