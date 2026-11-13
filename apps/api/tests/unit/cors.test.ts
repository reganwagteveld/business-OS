import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/core/config/schema';
import { corsHeaders } from '@/core/http/cors';

const allowed = ['tauri://localhost', 'http://tauri.localhost', 'https://app.example.com'];

describe('CORS (ADR 0005)', () => {
  it('grants exactly the requesting origin when it is allowlisted', () => {
    expect(corsHeaders('tauri://localhost', allowed)['Access-Control-Allow-Origin']).toBe('tauri://localhost');
  });
  it('grants nothing to other origins or to requests without an origin', () => {
    expect(corsHeaders('https://evil.example', allowed)).toEqual({ Vary: 'Origin' });
    expect(corsHeaders(null, allowed)).toEqual({ Vary: 'Origin' });
  });
  it('never allows credentials or a wildcard', () => {
    const headers = corsHeaders('https://app.example.com', allowed);
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(Object.values(headers)).not.toContain('*');
  });
});

describe('CORS_ALLOWED_ORIGINS', () => {
  const base = {
    DATABASE_URL: 'postgresql://a:b@localhost:5432/db',
    APP_BASE_URL: 'http://localhost:3000',
    REGION: 'r',
    DATABASE_REGION: 'r',
  };
  it('defaults to no cross-origin access', () => expect(parseEnv(base).CORS_ALLOWED_ORIGINS).toEqual([]));
  it('parses a comma-separated list of exact origins', () =>
    expect(parseEnv({ ...base, CORS_ALLOWED_ORIGINS: 'tauri://localhost, https://app.example.com' }).CORS_ALLOWED_ORIGINS).toEqual([
      'tauri://localhost',
      'https://app.example.com',
    ]));
  it.each(['*', 'https://*.example.com', 'https://app.example.com/', 'app.example.com'])('rejects %s', (origin) =>
    expect(() => parseEnv({ ...base, CORS_ALLOWED_ORIGINS: origin })).toThrow('exact origin'));
});
