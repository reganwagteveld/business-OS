import { endpoints } from '@business-os/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The route handler is exercised directly and its body validated against the shared contract,
// so the API and the clients cannot drift apart (ADR 0005).
describe('GET /api/v1/health', () => {
  beforeAll(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://a:b@localhost:5432/db');
    vi.stubEnv('APP_BASE_URL', 'http://localhost:3000');
    vi.stubEnv('REGION', 'test-region');
    vi.stubEnv('DATABASE_REGION', 'test-region');
    vi.stubEnv('VERCEL_REGION', '');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'tauri://localhost');
  });

  const request = (origin?: string) =>
    new Request(`http://localhost${endpoints.health.path}`, { headers: origin ? { origin } : {} });

  it('returns a body that satisfies the contract and is never cached', async () => {
    const { GET } = await import('@/app/api/v1/health/route');
    const res = GET(request());
    expect(res.status).toBe(200);
    expect(endpoints.health.response.safeParse(await res.json()).success).toBe(true);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('allows the desktop origin and no other', async () => {
    const { GET, OPTIONS } = await import('@/app/api/v1/health/route');
    expect(GET(request('tauri://localhost')).headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    expect(GET(request('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
    expect(OPTIONS(request('tauri://localhost')).status).toBe(204);
  });
});
