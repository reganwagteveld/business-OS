import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/core/config/schema';

const valid = {
  DATABASE_URL: 'postgresql://a:b@localhost:5432/db',
  MIGRATION_DATABASE_URL: 'postgresql://a:b@localhost:5432/db',
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
