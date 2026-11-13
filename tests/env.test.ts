import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env';
const valid = { DATABASE_URL: 'postgresql://a:b@localhost:5432/db', MIGRATION_DATABASE_URL: 'postgresql://a:b@localhost:5432/db', APP_BASE_URL: 'http://localhost:3000', REGION: 'test-region', DATABASE_REGION: 'test-region' };
describe('deployment environment', () => {
  it('accepts valid configuration', () => expect(parseEnv(valid).REGION).toBe('test-region'));
  it('rejects missing required values', () => expect(() => parseEnv({})).toThrow('Invalid Business OS environment'));
  it('rejects cross-region database connections', () => expect(() => parseEnv({ ...valid, DATABASE_REGION: 'elsewhere' })).toThrow('must match'));
});
