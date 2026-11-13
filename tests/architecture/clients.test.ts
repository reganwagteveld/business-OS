/**
 * Desktop and web client guarantees (ADR 0005): no database access, no server code, a locked-down
 * Tauri shell, and an API that implements every shared contract.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { authEndpoints, endpoints } from '../../packages/contracts/src/index';
import { apiOrigin, generatedConfig } from '../../apps/desktop/scripts/tauri-config.mjs';

const ROOT = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const json = <T>(path: string) => JSON.parse(read(path)) as T;

const CLIENT_PACKAGES = ['apps/desktop', 'apps/web', 'packages/app', 'packages/ui', 'packages/contracts'];
const FORBIDDEN_NPM = /^(@prisma\/.+|prisma|pg|pg-.+|postgres|@neondatabase\/.+|@vercel\/postgres|server-only|next|dotenv|@business-os\/api|@tauri-apps\/plugin-(sql|shell|fs|http|process))$/;
const FORBIDDEN_CRATES = /^(sqlx|postgres|tokio-postgres|diesel|sea-orm|deadpool-postgres|tauri-plugin-(sql|shell|fs|http|process))$/;

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

describe('client package manifests', () => {
  it.each(CLIENT_PACKAGES)('%s depends on no database driver, server framework or the API package', (dir) => {
    const manifest = json<Manifest>(`${dir}/package.json`);
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies });
    expect(deps.filter((name) => FORBIDDEN_NPM.test(name))).toEqual([]);
  });

  it('only the API package depends on Prisma and pg', () => {
    const dirs = ['apps', 'packages'].flatMap((top) => readdirSync(resolve(ROOT, top)).map((d) => `${top}/${d}`));
    const owners = dirs
      .filter((dir) => existsSync(resolve(ROOT, dir, 'package.json')))
      .filter((dir) => {
        const m = json<Manifest>(`${dir}/package.json`);
        return Object.keys({ ...m.dependencies, ...m.devDependencies }).some((d) => /^(@prisma\/client|pg)$/.test(d));
      });
    expect(owners).toEqual(['apps/api']);
  });
});

describe('Tauri desktop shell', () => {
  const conf = json<{
    identifier: string;
    app: { withGlobalTauri: boolean; security: { csp: Record<string, string>; freezePrototype?: boolean } };
    plugins?: Record<string, unknown>;
  }>('apps/desktop/src-tauri/tauri.conf.json');

  it('has no database crates or risky plugins', () => {
    const cargo = parseToml(read('apps/desktop/src-tauri/Cargo.toml')) as { dependencies?: Record<string, unknown>; 'build-dependencies'?: Record<string, unknown> };
    const crates = Object.keys({ ...cargo.dependencies, ...cargo['build-dependencies'] });
    expect(crates.filter((c) => FORBIDDEN_CRATES.test(c))).toEqual([]);
    // Allow-list. Phase 1b (D9a) adds the OS credential store, opening the system browser and serde.
    // Any new crate needs an architecture note (ADR 0005) and an update here.
    expect(crates.sort()).toEqual(['keyring', 'open', 'serde', 'tauri', 'tauri-build']);
  });

  it('exposes only the four sign-in commands to the window', () => {
    const main = read('apps/desktop/src-tauri/src/main.rs');
    const handlers = /generate_handler!\[([^\]]*)\]/.exec(main)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean);
    expect(handlers).toEqual(['auth::await_browser_sign_in', 'auth::load_session_token', 'auth::store_session_token', 'auth::forget_session_token']);
  });

  it('does not expose the Tauri API to page scripts', () => {
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.security.freezePrototype).toBe(true);
    expect(conf.plugins ?? {}).toEqual({});
  });

  it('has a strict Content Security Policy with no wildcards and no database hosts', () => {
    const csp = conf.app.security.csp;
    expect(csp['default-src']).toBe("'self'");
    expect(csp['script-src']).toBe("'self'");
    expect(csp['object-src']).toBe("'none'");
    for (const value of Object.values(csp)) {
      expect(value).not.toMatch(/(^|\s)\*|https?:\s|https?:\/\/\*|postgres|:5432/);
    }
  });

  it('grants the window only core permissions (no shell, filesystem, HTTP or SQL)', () => {
    const dir = resolve(ROOT, 'apps/desktop/src-tauri/capabilities');
    const permissions = readdirSync(dir).flatMap((f) => (json<{ permissions: Array<string | { identifier: string }> }>(`apps/desktop/src-tauri/capabilities/${f}`)).permissions);
    const ids = permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
    expect(ids.every((id) => id.startsWith('core:'))).toBe(true);
  });

  it('narrows connect-src to the configured API origin for release builds', () => {
    expect(apiOrigin('https://api.example.com/some/path')).toBe('https://api.example.com');
    expect(() => apiOrigin('http://api.example.com')).toThrow('https');
    expect(() => apiOrigin('postgresql://u:p@db.example.com/db')).toThrow('https');
    expect(() => apiOrigin(undefined)).toThrow('required');
    const generated = generatedConfig(conf, 'https://api.example.com');
    expect(generated.app.security.csp['connect-src']).toBe("'self' ipc: http://ipc.localhost https://api.example.com");
    expect(generated.app.security.csp['default-src']).toBe("'self'");
  });
});

describe('API contracts', () => {
  it.each(Object.entries(endpoints))('%s is implemented by an API route handler', (_name, endpoint) => {
    const file = resolve(ROOT, 'apps/api/src/app', `.${endpoint.path.replace(/:([A-Za-z]+)/g, '[$1]')}`, 'route.ts');
    expect(existsSync(file), `${file} should exist`).toBe(true);
    expect(read(file.slice(ROOT.length + 1))).toMatch(new RegExp(`export (async )?(function|const) ${endpoint.method}\\b`));
  });

  it.each(Object.entries(authEndpoints))('auth endpoint %s is served under /api/v1/auth by the identity module', (_name, endpoint) => {
    expect(endpoint.path.startsWith('/api/v1/auth/')).toBe(true);
    const own = resolve(ROOT, 'apps/api/src/app', `.${endpoint.path}`, 'route.ts');
    const file = existsSync(own) ? own : resolve(ROOT, 'apps/api/src/app/api/v1/auth/[...all]/route.ts');
    expect(read(file.slice(ROOT.length + 1))).toMatch(new RegExp(`export (async )?(function|const) ${endpoint.method}\\b`));
  });
});
