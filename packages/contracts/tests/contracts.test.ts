import { describe, expect, it } from 'vitest';
import { endpoints, HealthResponse } from '../src/index.ts';

describe('API contracts', () => {
  it('versions every endpoint path', () => {
    for (const e of Object.values(endpoints)) expect(e.path).toMatch(/^\/api\/v1\//);
  });
  it('accepts a valid health response and rejects extra fields', () => {
    expect(HealthResponse.parse({ status: 'ok', service: 'business-os-api', apiVersion: 'v1' })).toBeTruthy();
    expect(() => HealthResponse.parse({ status: 'ok', service: 'business-os-api', apiVersion: 'v1', db: 'x' })).toThrow();
  });
});
