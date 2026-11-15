// Provider adapter contract (docs/communications-c2.md §8). One adapter per provider, plain fetch,
// no SDKs. Adapters are pure: they never touch the database, never log, and never put tokens or
// provider response bodies into errors. Gmail and Microsoft Graph differences that matter to callers
// are visible through `capabilities` and the scope lists rather than hidden.

export type MailProvider = 'GOOGLE' | 'MICROSOFT';
/** read: a PERSONAL mailbox. business_read: a BUSINESS mailbox (Microsoft adds shared-mailbox and directory lookup scopes). */
export type ScopePurpose = 'read' | 'business_read';

export interface TokenSet {
  accessToken: string;
  /** Absent when the provider kept the existing refresh token (Google usually does). */
  refreshToken?: string;
  expiresAt: Date;
  /** Scopes the provider says it granted (Google lets users untick some). */
  scopes: string[];
  /**
   * Claims of the OIDC ID token from the same token response. Read only for tid/oid: the token came
   * straight from the provider's token endpoint over TLS in the code flow, which OIDC Core §3.1.3.7(6)
   * accepts in place of signature validation. Never stored.
   */
  idTokenClaims?: Record<string, unknown>;
}

/** The authenticated OAuth principal (the account that signed in). */
export interface ProviderAccount {
  /** Stable account id at the provider: Google OIDC `sub`, Microsoft Graph user `id` (Entra oid). */
  providerAccountId: string;
  address: string;
  displayName: string | null;
  /** Microsoft Entra tenant id (tid) of the principal; null for Google. */
  tenantId: string | null;
  /** Google Workspace domain (`hd` claim); null for consumer Google accounts and for Microsoft. */
  hostedDomain: string | null;
}

/**
 * What a provider proves about a BUSINESS mailbox with the principal's new token (T-C2-1, T-C2-2).
 * The adapter only gathers facts; the connection service decides whether they are enough.
 */
export interface BusinessMailboxProof {
  /** The target mailbox: Google sub (always the principal), Microsoft directory object id of the mailbox. */
  mailboxAccountId: string;
  mailboxAddress: string;
  displayName: string | null;
  /**
   * Email domains the provider says the principal's organisation controls: the Google Workspace `hd`, or
   * the Microsoft tenant's verified domains. Null for a consumer account (gmail.com, outlook.com).
   */
  organisationDomains: string[] | null;
}

/** The Microsoft tenant of personal Microsoft accounts (outlook.com, hotmail.com). */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export interface ProviderConfig { clientId: string; clientSecret: string; tenant?: string }

export interface MailProviderAdapter {
  readonly provider: MailProvider;
  readonly capabilities: {
    /** Google can revoke a grant; Microsoft has no per-app revocation endpoint. */
    readonly tokenRevocation: boolean;
    /** Microsoft rotates the refresh token on every refresh; refresh must be single-flight. */
    readonly rotatesRefreshTokens: boolean;
  };
  requiredScopes(purpose?: ScopePurpose): string[];
  /** True when the granted scopes cover the purpose (provider-specific spelling of scopes). */
  hasScopes(granted: string[], purpose: ScopePurpose): boolean;
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string; purpose?: ScopePurpose }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; purpose?: ScopePurpose }): Promise<TokenSet>;
  refresh(refreshToken: string, purpose?: ScopePurpose): Promise<TokenSet>;
  account(accessToken: string, idTokenClaims?: Record<string, unknown>): Promise<ProviderAccount>;
  /**
   * Resolves the target mailbox for `address` and proves the principal can read it, with metadata calls
   * only (no message is read). Throws ProviderError not_found when there is no such mailbox and
   * insufficient_scope when the principal cannot open it.
   */
  businessMailbox(accessToken: string, principal: ProviderAccount, address: string): Promise<BusinessMailboxProof>;
  revoke(token: string): Promise<'revoked' | 'unsupported'>;
  // C2-B adds: initialCursor, listChanges(cursor), fetchMessage(id). C2-C adds: send(mime, threadRef).
}

export type ProviderErrorCode =
  | 'invalid_grant' | 'insufficient_scope' | 'unauthorized' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'busy' | 'not_found';

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
