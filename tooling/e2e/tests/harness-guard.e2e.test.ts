/** The harness's own safety rules (scripts/guard.mjs): it must refuse anything that is not a disposable local database. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertCleanEnv, assertDisposableName, assertLocalPostgres, assertNoDotenvInjection, pgConfig, serverEnv } from '../scripts/guard.mjs';

const here = import.meta.dirname;

describe('harness guard', () => {
  it.each([
    'postgresql://u:p@db.example.com:5432/x',
    'postgresql://u:p@ep-cool-123.us-east-1.aws.neon.tech/neondb',
    'postgresql://u:p@10.0.0.5:5432/x',
    'postgresql://u:p@127.0.0.1.evil.example/x',
    'mysql://u:p@127.0.0.1/x',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertLocalPostgres(url)).toThrow();
  });

  it.each(['postgresql://u:p@127.0.0.1:55432/postgres', 'postgres://u:p@localhost/postgres', 'postgresql://u:p@[::1]:5432/postgres'])('accepts the loopback URL %s', (url) => {
    expect(() => assertLocalPostgres(url)).not.toThrow();
  });

  it('only ever drops or creates e2e_<16 hex> databases', () => {
    expect(() => assertDisposableName('e2e_0123456789abcdef')).not.toThrow();
    for (const bad of ['business_os', 'postgres', 'e2e_', 'e2e_0123456789abcdeg', 'e2e_0123456789abcdef; DROP DATABASE postgres', 'neondb']) {
      expect(() => assertDisposableName(bad)).toThrow();
    }
  });

  it('builds the API environment from scratch: runtime credentials only, nothing inherited', () => {
    const env = serverEnv({ appUrl: 'postgresql://bos_app:x@127.0.0.1/e', authUrl: 'postgresql://bos_auth:x@127.0.0.1/e', secret: 's'.repeat(64), baseUrl: 'http://127.0.0.1:1', path: '/usr/bin' });
    expect(() => assertCleanEnv(env)).not.toThrow();
    expect(Object.keys(env).sort()).toEqual(['APP_BASE_URL', 'AUTH_DATABASE_URL', 'AUTH_SECRET', 'CORS_ALLOWED_ORIGINS', 'DATABASE_REGION', 'DATABASE_URL', 'EMAIL_TRANSPORT', 'NEXT_TELEMETRY_DISABLED', 'NODE_ENV', 'PATH', 'REGION'].sort());
    expect(env.EMAIL_TRANSPORT).toBe('log');
    for (const forbidden of ['MIGRATION_DATABASE_URL', 'ADMIN_DATABASE_URL', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'VERCEL_ENV', 'NEON_API_KEY', 'CRON_SECRET']) {
      expect(() => assertCleanEnv({ ...env, [forbidden]: 'x' })).toThrow();
    }
  });
});

describe('driver-level host overrides (audit of PR 129)', () => {
  it('shows why: node-postgres honours ?host= over the URL authority', () => {
    // Pure parsing, no connection is opened.
    expect(new pg.Client({ connectionString: 'postgresql://t:t@127.0.0.1:55432/postgres?host=remote.invalid' }).host).toBe('remote.invalid');
  });

  it.each([
    'postgresql://t:t@127.0.0.1:55432/postgres?host=remote.invalid',
    'postgresql://t:t@127.0.0.1:55432/postgres?hostaddr=203.0.113.9',
    'postgresql://t:t@127.0.0.1:55432/postgres?port=5433',
    'postgresql://t:t@127.0.0.1:55432/postgres?options=-c%20search_path%3Dx',
    'postgresql://t:t@127.0.0.1:55432/postgres?sslmode=require',
    'postgresql://t:t@127.0.0.1:55432/postgres#host=remote.invalid',
    'postgresql://t:t@127.0.0.1:55432/postgres?',
  ])('refuses %s before any connection', (url) => {
    expect(() => assertLocalPostgres(url)).toThrow(/query options|fragment/);
    expect(() => pgConfig(url)).toThrow();
  });

  it('builds an explicit configuration whose effective host, port and database are the validated ones', () => {
    const cfg = pgConfig('postgresql://us%40er:p%3Aw@127.0.0.1:55432/e2e_0123456789abcdef');
    expect(cfg).toEqual({ host: '127.0.0.1', port: 55432, user: 'us@er', password: 'p:w', database: 'e2e_0123456789abcdef' });
    const client = new pg.Client(cfg);
    expect([client.host, client.port, client.database]).toEqual(['127.0.0.1', 55432, 'e2e_0123456789abcdef']);
    expect(pgConfig('postgresql://t:t@[::1]/postgres').host).toBe('::1');
  });

  it('every connection in the harness goes through pgConfig, never a connection string', () => {
    for (const file of ['scripts/run.mjs', 'src/db.ts', 'tests/tenant-isolation.e2e.test.ts']) {
      const source = readFileSync(resolve(here, '..', file), 'utf8');
      expect(source, file).not.toMatch(/connectionString/);
      expect(source, file).toMatch(/pgConfig\(/);
    }
  });
});

describe('environment files that Next.js and Prisma would load (audit of PR 129)', () => {
  const controlled = new Set(['PATH', 'HOME', 'MIGRATION_DATABASE_URL', 'ADMIN_DATABASE_URL', 'DEPLOYMENT_REGION', ...Object.keys(serverEnv({ appUrl: '', authUrl: '', secret: '', baseUrl: '', path: '' }))]);
  const check = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-dotenv-'));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      assertNoDotenvInjection(dir, controlled, readdirSync, (f: string) => readFileSync(f, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each(['.env', '.env.local', '.env.production', '.env.production.local'])('%s with a provider, owner or cron variable is refused, and its value is never reported', (name) => {
    for (const key of ['RESEND_API_KEY', 'MIGRATION_DATABASE_URL_LIVE', 'CRON_SECRET', 'STRIPE_SECRET_KEY', 'VERCEL_ENV', 'SOMETHING_ELSE']) {
      let message = '';
      try {
        check({ [name]: `# comment\n${key}="super-secret-value"\n` });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, `${name} ${key}`).toContain(`${name}: ${key}`);
      expect(message).not.toContain('super-secret-value');
    }
  });

  it('accepts no files, empty files, comments, and only variables the harness itself sets (they are shadowed)', () => {
    expect(() => check({})).not.toThrow();
    expect(() => check({ '.env': '' })).not.toThrow();
    expect(() => check({ '.env.local': '# nothing here\n\nDATABASE_URL=postgresql://x\nexport AUTH_SECRET=y\n' })).not.toThrow();
  });

  it('ignores files that are not environment files', () => {
    expect(() => check({ 'notes.txt': 'RESEND_API_KEY=x', '.envrc': 'RESEND_API_KEY=x' })).not.toThrow();
  });

  it('the runner performs the check before it connects to or changes anything', () => {
    const source = readFileSync(resolve(here, '../scripts/run.mjs'), 'utf8');
    const check = source.indexOf('assertNoDotenvInjection(dir');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(source.indexOf('await provision()'));
  });
});
