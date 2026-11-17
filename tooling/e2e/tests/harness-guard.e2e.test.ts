/** The harness's own safety rules (scripts/guard.mjs): it must refuse anything that is not a disposable local database. */
import { describe, expect, it } from 'vitest';
import { assertCleanEnv, assertDisposableName, assertLocalPostgres, serverEnv } from '../scripts/guard.mjs';

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
