import { z } from 'zod';

/** Which client shell is rendering the shared app. Used for labels only, never for authorisation. */
export type ClientPlatform = 'desktop' | 'web';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const ApiBaseUrl = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  }, 'must be https (plain http is allowed for localhost only)')
  .transform((value) => value.replace(/\/+$/, ''));

export interface ClientConfig {
  apiBaseUrl: string;
}

/**
 * Validates the public build-time configuration of a client. The only setting is the API's base URL:
 * clients hold no secrets and no database configuration (ADR 0005).
 */
export function parseClientConfig(env: Record<string, string | undefined>): ClientConfig {
  const result = ApiBaseUrl.safeParse(env.VITE_API_BASE_URL);
  if (!result.success) {
    throw new Error(`VITE_API_BASE_URL ${result.error.issues[0]?.message ?? 'is invalid'}`);
  }
  return { apiBaseUrl: result.data };
}
