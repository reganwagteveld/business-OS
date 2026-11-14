import { describe, expect, it, vi } from 'vitest';
import { createTenancyClient, type AuthTransport } from '../src';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const cookie: AuthTransport = { kind: 'cookie' };
const bearer = (token: string | null): AuthTransport => ({ kind: 'bearer', getToken: async () => token, signIn: vi.fn(), forget: vi.fn() });
const contextBody = {
  business: { slug: 'acme', name: 'Acme', countryCode: 'US', timeZone: 'America/Chicago', locale: 'en-US', currency: 'USD' },
  membership: { id: '0b8f9a9e-2f1c-4c7e-9a52-0c7f6d1b2a10', role: 'OWNER', permissions: ['business:read'] },
};

describe('tenancy client over the shared transport', () => {
  it('lists businesses with the cookie, never sending a bearer or a business id', async () => {
    const fetchMock = vi.fn(async () => json({ businesses: [{ slug: 'acme', name: 'Acme', role: 'OWNER' }] }));
    const result = await createTenancyClient('https://app.example.test', cookie, fetchMock).listBusinesses();
    expect(result).toEqual({ kind: 'ok', data: [{ slug: 'acme', name: 'Acme', role: 'OWNER' }] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.example.test/api/v1/businesses');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it('desktop: sends the stored token as a bearer without cookies', async () => {
    const fetchMock = vi.fn(async () => json({ businesses: [] }));
    await createTenancyClient('https://api.example.test', bearer('tok.sig'), fetchMock).listBusinesses();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok.sig');
  });

  it('desktop with an empty credential store is signed out and sends no request at all', async () => {
    const fetchMock = vi.fn();
    const result = await createTenancyClient('https://api.example.test', bearer(null), fetchMock).listBusinesses();
    expect(result).toEqual({ kind: 'unauthenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves the active business only through the slug path, URL-encoded', async () => {
    const fetchMock = vi.fn(async () => json(contextBody));
    await createTenancyClient('https://app.example.test', cookie, fetchMock).businessContext('acme/../x');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://app.example.test/api/v1/b/acme%2F..%2Fx');
  });

  it('keeps offline, signed out, unverified, forbidden, missing and server errors apart', async () => {
    const client = (res: () => Promise<Response>) => createTenancyClient('https://x.test', cookie, vi.fn(res));
    expect(await client(async () => { throw new TypeError('Failed to fetch'); }).listBusinesses()).toEqual({ kind: 'unreachable' });
    expect(await client(async () => json({}, 401)).listBusinesses()).toEqual({ kind: 'unauthenticated' });
    expect(await client(async () => json({ error: 'email_not_verified' }, 403)).listBusinesses()).toEqual({ kind: 'unverified' });
    expect(await client(async () => json({ error: 'forbidden' }, 403)).businessContext('a')).toEqual({ kind: 'forbidden' });
    expect(await client(async () => json({}, 404)).businessContext('a')).toEqual({ kind: 'not_found' });
    expect(await client(async () => json({}, 503)).listBusinesses()).toEqual({ kind: 'failed', status: 503 });
  });

  it('rejects a response that does not match the contract', async () => {
    const wrong = createTenancyClient('https://x.test', cookie, vi.fn(async () => json({ businesses: [{ slug: 'x' }] })));
    expect(await wrong.listBusinesses()).toEqual({ kind: 'invalid' });
    const extra = createTenancyClient('https://x.test', cookie, vi.fn(async () => json({ ...contextBody, secret: 1 })));
    expect(await extra.businessContext('acme')).toEqual({ kind: 'invalid' });
  });
});

describe('creating a business', () => {
  const valid = { name: 'Acme Plumbing', slug: 'acme-plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' };

  it('sends exactly the contract fields to POST /api/v1/businesses', async () => {
    const fetchMock = vi.fn(async () => json({ business: { slug: 'acme-plumbing' } }, 201));
    const result = await createTenancyClient('https://app.example.test', cookie, fetchMock).createBusiness(valid);
    expect(result).toEqual({ kind: 'ok', data: { slug: 'acme-plumbing' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.example.test/api/v1/businesses');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(valid);
  });

  it('rejects a client-supplied business id, user id or region before sending anything', async () => {
    const fetchMock = vi.fn();
    const client = createTenancyClient('https://x.test', cookie, fetchMock);
    for (const extra of [{ businessId: 'x' }, { userId: 'x' }, { homeRegion: 'eu-west-1' }]) {
      expect(await client.createBusiness({ ...valid, ...extra })).toMatchObject({ kind: 'invalid_input' });
    }
    expect(await client.createBusiness({ ...valid, slug: 'A B' })).toMatchObject({ kind: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps slug conflict, rate limiting, server validation and offline apart', async () => {
    const c = (res: () => Promise<Response>) => createTenancyClient('https://x.test', cookie, vi.fn(res));
    expect(await c(async () => json({ error: 'slug_unavailable' }, 409)).createBusiness(valid)).toEqual({ kind: 'conflict' });
    expect(await c(async () => json({ error: 'rate_limited' }, 429)).createBusiness(valid)).toEqual({ kind: 'rate_limited' });
    expect(await c(async () => json({ error: 'invalid' }, 400)).createBusiness(valid)).toMatchObject({ kind: 'invalid_input' });
    expect(await c(async () => json({}, 401)).createBusiness(valid)).toEqual({ kind: 'unauthenticated' });
    expect(await c(async () => { throw new TypeError('offline'); }).createBusiness(valid)).toEqual({ kind: 'unreachable' });
  });
});
