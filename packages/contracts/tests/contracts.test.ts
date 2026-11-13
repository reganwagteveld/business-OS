import { describe, expect, it } from 'vitest';
import { authEndpoints, endpoints, HealthResponse, SignUpRequest } from '../src/index.ts';

describe('API contracts', () => {
  it('versions every endpoint path', () => {
    for (const e of [...Object.values(endpoints), ...Object.values(authEndpoints)]) expect(e.path).toMatch(/^\/api\/v1\//);
  });
  it('accepts a valid health response and rejects extra fields', () => {
    expect(HealthResponse.parse({ status: 'ok', service: 'business-os-api', apiVersion: 'v1' })).toBeTruthy();
    expect(() => HealthResponse.parse({ status: 'ok', service: 'business-os-api', apiVersion: 'v1', db: 'x' })).toThrow();
  });
  it('normalises emails and enforces the password policy before anything is sent', () => {
    expect(SignUpRequest.parse({ email: ' A@Example.COM ', password: 'x'.repeat(12), name: 'A' }).email).toBe('a@example.com');
    expect(SignUpRequest.safeParse({ email: 'a@example.com', password: 'short', name: 'A' }).success).toBe(false);
  });
});
