import { describe, expect, it, vi } from 'vitest';
import type { AuthClient } from './auth';
import { createWorkspaceClient } from './workspace';

const cookieAuth = { transport: { kind: 'cookie' } } as AuthClient;
const bearerAuth = { transport: { kind: 'bearer', getToken: async () => 'session-token' } } as AuthClient;
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('workspace API client security and contract handling', () => {
  it('uses first-party cookies and validates the returned membership list', async () => {
    const fetcher = vi.fn(async () => response({ businesses: [{ slug: 'pixakova', name: 'Pixakova', role: 'OWNER' }] }));
    const client = createWorkspaceClient('', cookieAuth, fetcher as typeof fetch);
    const result = await client.list();
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/businesses', expect.objectContaining({ method: 'GET', credentials: 'include', cache: 'no-store' }));
    expect((fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1].headers).not.toHaveProperty('authorization');
  });

  it('sends a bearer token only via the authenticated desktop transport', async () => {
    const fetcher = vi.fn(async () => response({ businesses: [] }));
    const client = createWorkspaceClient('https://api.example.com', bearerAuth, fetcher as typeof fetch);
    await client.list();
    expect(fetcher).toHaveBeenCalledWith('https://api.example.com/api/v1/businesses',
      expect.objectContaining({ credentials: 'omit', headers: expect.objectContaining({ authorization: 'Bearer session-token' }) }));
  });

  it('never sends business creation data outside the declared contract', async () => {
    const fetcher = vi.fn(async () => response({ business: { slug: 'pixakova' } }));
    const client = createWorkspaceClient('', cookieAuth, fetcher as typeof fetch);
    const invalid = await client.create({ name: 'Pixakova', slug: 'pixakova', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD', businessId: 'injected' });
    expect(invalid.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const valid = await client.create({ name: 'Pixakova', slug: 'pixakova', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' });
    expect(valid.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/businesses', expect.objectContaining({ method: 'POST' }));
  });

  it('does not accept invalid API responses as authorized business context', async () => {
    const client = createWorkspaceClient('', cookieAuth, vi.fn(async () => response({ business: { slug: 'pixakova' }, membership: { role: 'OWNER' } })) as typeof fetch);
    const result = await client.context('pixakova');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });

  it('encodes the slug and returns a distinct offline failure', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline'); });
    const client = createWorkspaceClient('', cookieAuth, fetcher as typeof fetch);
    const result = await client.context('test/workspace');
    expect(fetcher).toHaveBeenCalledWith('/api/v1/b/test%2Fworkspace', expect.any(Object));
    expect(result).toMatchObject({ ok: false, status: 0 });
  });

  it('does not issue an unauthenticated desktop request when the keychain is empty', async () => {
    const fetcher = vi.fn();
    const auth = { transport: { kind: 'bearer', getToken: async () => null } } as AuthClient;
    const result = await createWorkspaceClient('', auth, fetcher as typeof fetch).list();
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
