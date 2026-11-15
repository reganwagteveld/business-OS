// Provider adapter contract (docs/communications-c2.md §8). One adapter per provider, plain fetch,
// no SDKs. Adapters are pure: they never touch the database, never log, and never put tokens or
// provider response bodies into errors. Gmail and Microsoft Graph differences that matter to callers
// are visible through `capabilities` and the scope lists rather than hidden.

export type MailProvider = 'GOOGLE' | 'MICROSOFT';
export type ScopePurpose = 'read';

export interface TokenSet {
  accessToken: string;
  /** Absent when the provider kept the existing refresh token (Google usually does). */
  refreshToken?: string;
  expiresAt: Date;
  /** Scopes the provider says it granted (Google lets users untick some). */
  scopes: string[];
}

export interface ProviderAccount {
  /** Stable account id at the provider: Google OIDC `sub`, Microsoft Graph user `id`. */
  providerAccountId: string;
  address: string;
  displayName: string | null;
}

export interface ProviderConfig { clientId: string; clientSecret: string; tenant?: string }

export interface MailProviderAdapter {
  readonly provider: MailProvider;
  readonly capabilities: {
    /** Google can revoke a grant; Microsoft has no per-app revocation endpoint. */
    readonly tokenRevocation: boolean;
    /** Microsoft rotates the refresh token on every refresh; refresh must be single-flight. */
    readonly rotatesRefreshTokens: boolean;
  };
  requiredScopes(purpose: ScopePurpose): string[];
  /** True when the granted scopes cover the purpose (provider-specific spelling of scopes). */
  hasScopes(granted: string[], purpose: ScopePurpose): boolean;
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  account(accessToken: string): Promise<ProviderAccount>;
  revoke(token: string): Promise<'revoked' | 'unsupported'>;
  // C2-B adds: initialCursor, listChanges(cursor), fetchMessage(id). C2-C adds: send(mime, threadRef).
}

export type ProviderErrorCode =
  | 'invalid_grant' | 'insufficient_scope' | 'unauthorized' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'busy';

/** A normalised provider failure. Carries a stable code only: never a token or a response body. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(`provider: ${code}`);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable' || this.code === 'busy';
  }
}
