/**
 * Dormant release gate: with COMMUNICATIONS_CONNECT_ENABLED unset or not 'true', no provider adapter is
 * returned even when fake credentials are present, and no provider HTTP call is made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const base = {
  APP_BASE_URL: 'https://app.example.test',
  GOOGLE_OAUTH_CLIENT_ID: 'fake-google-id', GOOGLE_OAUTH_CLIENT_SECRET: 'fake-google-secret',
  MICROSOFT_OAUTH_CLIENT_ID: 'fake-ms-id', MICROSOFT_OAUTH_CLIENT_SECRET: 'fake-ms-secret', MICROSOFT_OAUTH_TENANT: 'common',
};

async function adapterWith(flag: string | undefined) {
  vi.resetModules();
  vi.doMock('@/core/config/env', () => ({ getEnv: () => ({ ...base, ...(flag === undefined ? {} : { COMMUNICATIONS_CONNECT_ENABLED: flag }) }) }));
  return import('@/modules/communications/server/providers');
}

afterEach(() => {
  vi.doUnmock('@/core/config/env');
  vi.unstubAllGlobals();
});

describe('communications connect gate', () => {
  it.each([undefined, 'false', 'TRUE', 'yes'])('returns no adapter for either provider when the flag is %s', async (flag) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { providerAdapter } = await adapterWith(flag);
    expect(providerAdapter('GOOGLE')).toBeUndefined();
    expect(providerAdapter('MICROSOFT')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns adapters only for the literal "true" with credentials present', async () => {
    const { providerAdapter } = await adapterWith('true');
    expect(providerAdapter('GOOGLE')).toBeDefined();
    expect(providerAdapter('MICROSOFT')).toBeDefined();
  });
});
