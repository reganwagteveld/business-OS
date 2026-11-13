import { describe, expect, it } from 'vitest';
import { parseMigrationEnv } from '@/core/config/migration';
import { parseEnv } from '@/core/config/schema';

const valid = {
  DATABASE_URL: 'postgresql://a:b@localhost:5432/db',
  APP_BASE_URL: 'http://localhost:3000',
  REGION: 'test-region',
  DATABASE_REGION: 'test-region',
};

describe('deployment environment', () => {
  it('accepts valid configuration', () => expect(parseEnv(valid).REGION).toBe('test-region'));
  it('rejects missing required values with a clear message', () =>
    expect(() => parseEnv({})).toThrow(/Invalid Business OS environment[\s\S]*DATABASE_URL/));
  it('rejects non-PostgreSQL database URLs', () =>
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://a:b@h/db' })).toThrow('PostgreSQL'));
  it('rejects cross-region database connections', () =>
    expect(() => parseEnv({ ...valid, DATABASE_REGION: 'elsewhere' })).toThrow('must match'));
});

describe('runtime region colocation', () => {
  const prod = { ...valid, REGION: 'us-east-1', DATABASE_REGION: 'us-east-1' };
  it('accepts functions running in the configured region', () =>
    expect(parseEnv({ ...prod, VERCEL_REGION: 'iad1' }).REGION).toBe('us-east-1'));
  it('rejects functions running in a different region from the database', () =>
    expect(() => parseEnv({ ...prod, VERCEL_REGION: 'fra1' })).toThrow('colocated'));
  it('rejects unknown function regions', () =>
    expect(() => parseEnv({ ...prod, VERCEL_REGION: 'xyz9' })).toThrow('unknown region'));
  it('ignores local development', () => expect(parseEnv({ ...prod, VERCEL_REGION: 'dev1' }).REGION).toBe('us-east-1'));
});

describe('runtime and migration configuration are separate (no owner credentials at runtime)', () => {
  it('boots with runtime configuration only: no migration owner URL needed', () => {
    expect(valid).not.toHaveProperty('MIGRATION_DATABASE_URL');
    expect(() => parseEnv(valid)).not.toThrow();
  });
  it('does not expose owner credentials to the runtime even when they are in the environment', () => {
    const env = parseEnv({ ...valid, MIGRATION_DATABASE_URL: 'postgresql://owner:secret@localhost:5432/db' });
    expect(env).not.toHaveProperty('MIGRATION_DATABASE_URL');
    expect(JSON.stringify(env)).not.toContain('secret');
  });
  it('the runtime still requires its own DATABASE_URL', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
  it('migration tooling requires the owner URL and rejects non-PostgreSQL values', () => {
    expect(() => parseMigrationEnv({})).toThrow(/MIGRATION_DATABASE_URL/);
    expect(() => parseMigrationEnv({ MIGRATION_DATABASE_URL: 'mysql://a:b@h/db' })).toThrow('PostgreSQL');
    expect(parseMigrationEnv({ MIGRATION_DATABASE_URL: 'postgresql://a:b@h/db' }).SHADOW_DATABASE_URL).toBeUndefined();
  });
});

describe('server start-up check (instrumentation)', () => {
  it('registers successfully with runtime configuration only', async () => {
    const saved = { ...process.env };
    try {
      for (const key of ['MIGRATION_DATABASE_URL', 'SHADOW_DATABASE_URL']) delete process.env[key];
      Object.assign(process.env, valid);
      const { register } = await import('@/instrumentation');
      await expect(register()).resolves.toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});
