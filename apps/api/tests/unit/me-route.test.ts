import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentUser } from '@/modules/identity';

// GET /api/v1/me is the one unwrapped /me handler (it answers before admission). Its failures must still be
// JSON with the API's no-store and CORS headers, so the desktop and browser apps can show "server error".
vi.mock('@/modules/identity', () => ({ getCurrentUser: vi.fn(), updateDisplayName: vi.fn() }));

describe('GET /api/v1/me', () => {
  beforeAll(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://a:b@localhost:5432/db');
    vi.stubEnv('AUTH_DATABASE_URL', 'postgresql://auth:b@localhost:5432/db');
    vi.stubEnv('AUTH_SECRET', 'test-signing-key-0123456789-abcdefghijkl');
    vi.stubEnv('APP_BASE_URL', 'http://localhost:3000');
    vi.stubEnv('REGION', 'test-region');
    vi.stubEnv('DATABASE_REGION', 'test-region');
    vi.stubEnv('VERCEL_REGION', '');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'tauri://localhost');
  });
  beforeEach(() => vi.resetAllMocks());
  const request = () => new Request('http://localhost/api/v1/me', { headers: { origin: 'tauri://localhost' } });

  it('answers a failure with JSON 500 and the usual headers', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('database unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('@/app/api/v1/me/route');
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
  });

  it('still answers 401 without a session and the user with one', async () => {
    const { GET } = await import('@/app/api/v1/me/route');
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    vi.mocked(getCurrentUser).mockResolvedValue({ id: '0b6c3f4e-8f1a-4c2b-9d3e-5a6b7c8d9e0f', email: 'a@example.com', name: 'A', emailVerified: false });
    const ok = await GET(request());
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.email).toBe('a@example.com');
  });
});
