import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import inventory from './fixtures/better-auth-routes.json';

// A3-0 (settings-a3 §15.1 step 1, §15.9 gate 1): the method and path pairs that the INSTALLED Better Auth
// registers on its HTTP router for our configuration, read from the live instance rather than from
// documentation. The list is checked in; a version bump or a config change that alters it fails here and
// must be reviewed against the allow-list in src/modules/identity/server/allow-list.ts.
const APP = 'https://app.example.test';

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://a:b@localhost:5432/db');
  vi.stubEnv('AUTH_DATABASE_URL', 'postgresql://auth:b@localhost:5432/db');
  vi.stubEnv('AUTH_SECRET', 'unit-signing-key-0123456789-abcdefghijkl');
  vi.stubEnv('APP_BASE_URL', APP);
  vi.stubEnv('REGION', 'test-region');
  vi.stubEnv('DATABASE_REGION', 'test-region');
  vi.stubEnv('VERCEL_REGION', '');
  vi.stubEnv('CORS_ALLOWED_ORIGINS', '');
});

type Endpoint = { path?: string; options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } } };

/**
 * Mirrors better-call's createRouter (node_modules/better-call/dist/router.mjs): an endpoint gets an HTTP
 * route for each of its methods unless it has no path or is marked SERVER_ONLY. Better Auth builds its
 * router from exactly this endpoint map (better-auth/dist/api/index.mjs `router`), with OpenAPI disabled.
 */
async function liveRoutes(): Promise<string[]> {
  const { getAuth } = await import('@/modules/identity/server/auth-adapter');
  const api = getAuth().api as unknown as Record<string, Endpoint>;
  const routes = new Set<string>();
  for (const endpoint of Object.values(api)) {
    if (!endpoint?.options || !endpoint.path || endpoint.options.metadata?.SERVER_ONLY) continue;
    const methods = Array.isArray(endpoint.options.method) ? endpoint.options.method : [endpoint.options.method];
    for (const method of methods) routes.add(`${method} ${endpoint.path}`);
  }
  return [...routes].sort();
}

const sample = (path: string) => path.replace(/:[a-zA-Z]+/g, 'AbCdEf0123456789ghIJklMN');

describe('Better Auth route inventory', () => {
  it('is pinned to the version the fixture was taken from', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../node_modules/better-auth/package.json'), 'utf8'));
    expect(pkg.version).toBe(inventory.betterAuthVersion);
    const own = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    expect(own.dependencies['better-auth']).toBe(inventory.betterAuthVersion);
  });

  it('matches the checked-in fixture exactly', async () => {
    expect(await liveRoutes()).toEqual(inventory.routes);
  });

  it('contains every allow-listed route (the list names only real endpoints)', async () => {
    const { AUTH_ALLOWED_ROUTES } = await import('@/modules/identity/server/allow-list');
    for (const route of AUTH_ALLOWED_ROUTES) expect(inventory.routes).toContain(`${route.method} ${route.path}`);
  });

  it('allows exactly the reviewed routes and refuses every other registered route', async () => {
    const { allowedAuthRoute } = await import('@/modules/identity/server/allow-list');
    const allowed: string[] = [];
    for (const route of inventory.routes) {
      const [method, path] = route.split(' ') as [string, string];
      const req = new Request(`${APP}/api/v1/auth${sample(path)}`, { method });
      if (allowedAuthRoute(req)) allowed.push(route);
    }
    expect(allowed.sort()).toEqual(inventory.allowed.slice().sort());
  });
});
