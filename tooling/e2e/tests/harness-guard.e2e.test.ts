/** The harness's own safety rules (scripts/guard.mjs): it must refuse anything that is not a disposable local database. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertCleanEnv, assertDisposableName, assertLocalPostgres, assertNoDotenvFiles, DOTENV_FILES, pgConfig, serverEnv } from '../scripts/guard.mjs';

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
  const inTempDir = <T>(files: Record<string, string>, fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-dotenv-'));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const refused = (files: Record<string, string>) => inTempDir(files, (dir) => {
    try {
      assertNoDotenvFiles(dir, readdirSync);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });
  const SECRET = 'synthetic-audit-marker';

  it.each(DOTENV_FILES)('%s is refused whatever it contains, and its contents are never reported', (name) => {
    for (const text of [
      '', '# only a comment\n', `RESEND_API_KEY=${SECRET}\n`, `ADMIN_DATABASE_URL=${SECRET}\n`, `MIGRATION_DATABASE_URL=${SECRET}\n`,
      `CRON_SECRET: ${SECRET}\n`, `export STRIPE_SECRET_KEY="${SECRET}"\n`, `DATABASE_URL=${SECRET}\n`,
    ]) {
      const message = refused({ [name]: text });
      expect(message, `${name} ${JSON.stringify(text)}`).toContain(name);
      expect(message).not.toContain(SECRET);
    }
  });

  it('accepts a directory without those files, and files the loaders never read', () => {
    expect(refused({})).toBeNull();
    expect(refused({ '.env.example': `CRON_SECRET=${SECRET}`, 'notes.txt': `RESEND_API_KEY=${SECRET}`, '.envrc': `X=${SECRET}`, '.env.staging': `X=${SECRET}` })).toBeNull();
  });

  it("the file list covers everything the installed Next.js loader reads (checked against the real parser, synthetic files only)", () => {
    const require = createRequire(import.meta.url);
    const nextDir = dirname(require.resolve('next/package.json', { paths: [resolve(here, '../../../apps/api')] }));
    const { loadEnvConfig } = require(require.resolve('@next/env', { paths: [nextDir] })) as { loadEnvConfig: (dir: string, dev: boolean, log?: unknown, force?: boolean) => unknown };
    const key = 'E2E_SYNTHETIC_PROBE_KEY';
    const seen = new Set<string>();
    const candidates = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local', '.env.staging', '.env.example', '.env.prod', '.env.preview'];
    for (const [mode, dev] of [['production', false], ['development', true]] as const) {
      for (const name of candidates) {
        for (const line of [`${key}=${SECRET}`, `${key}: ${SECRET}`]) {
          const loaded = inTempDir({ [name]: `${line}\n` }, (dir) => {
            delete process.env[key];
            const saved = process.env.NODE_ENV;
            (process.env as Record<string, string>).NODE_ENV = mode;
            try {
              loadEnvConfig(dir, dev, { info() {}, error() {} }, true);
              return process.env[key] === SECRET;
            } finally {
              (process.env as Record<string, string | undefined>).NODE_ENV = saved;
              delete process.env[key];
            }
          });
          // Whatever the real loader would load, the guard must refuse (syntax and key names do not matter).
          if (loaded) seen.add(`${mode} ${name} ${line.includes(':') ? 'colon' : 'equals'}`);
          if (loaded) expect(refused({ [name]: `${line}\n` }), `${mode} ${name} ${line}`).not.toBeNull();
        }
      }
    }
    // The probe must really have exercised the loader, including the colon syntax the audit found.
    expect(seen).toContain('production .env.production.local colon');
    expect(seen).toContain('production .env equals');
    expect(seen).not.toContain('production .env.example equals');
  });

  it('the runner performs the check before it connects to or changes anything, for every directory a child runs in', () => {
    const source = readFileSync(resolve(here, '../scripts/run.mjs'), 'utf8');
    const check = source.indexOf('assertNoDotenvFiles(dir, readdirSync)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(source.indexOf('await provision()'));
    expect(source).toMatch(/\[resolve\(root, 'apps\/api'\), e2eDir\]/);
  });
});
