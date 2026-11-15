import 'server-only';
// Provider registry from validated configuration. A provider without a client id and secret is
// "not configured" and no network call is ever made for it.
import { getEnv } from '@/core/config/env';
import { googleAdapter } from './google';
import { microsoftAdapter } from './microsoft';
import type { MailProvider, MailProviderAdapter } from './types';

export const MAIL_PROVIDERS: readonly MailProvider[] = ['GOOGLE', 'MICROSOFT'];

export function providerAdapter(provider: MailProvider): MailProviderAdapter | undefined {
  const env = getEnv();
  if (provider === 'GOOGLE' && env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return googleAdapter({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET });
  }
  if (provider === 'MICROSOFT' && env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET) {
    return microsoftAdapter({ clientId: env.MICROSOFT_OAUTH_CLIENT_ID, clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET, tenant: env.MICROSOFT_OAUTH_TENANT });
  }
  return undefined;
}

/** The one redirect URI to register with each provider. */
export function oauthRedirectUri(): string {
  return new URL('/api/v1/communications/oauth/callback', getEnv().APP_BASE_URL).toString();
}

export { googleAdapter } from './google';
export { microsoftAdapter } from './microsoft';
export { ProviderError } from './types';
export type { MailProvider, MailProviderAdapter, ProviderAccount, TokenSet } from './types';
