import 'server-only';
// Microsoft 365 (Microsoft Graph) adapter. Delegated scopes Mail.Read + User.Read, offline_access
// for a refresh token, openid + email for identity. Microsoft rotates the refresh token on every
// refresh and has no per-application revocation endpoint (docs/communications-c2.md §7.4, §8).
//
// C2-B1 (T-C2-1): the signed-in user (principal: Entra oid + tid) is not always the mailbox. A BUSINESS
// mailbox may be an Exchange shared mailbox the principal has Full Access to: its own directory object
// is resolved from its address (GET /users/{address}, User.ReadBasic.All) and read through
// /users/{id}/..., never /me, with delegated Mail.Read.Shared. Those two scopes are requested only for
// BUSINESS connections. Send As rights cannot be read by a delegated app; C2-C learns them on first send.
import { getJson, text, tokenRequest } from './http';
import { MICROSOFT_CONSUMER_TENANT, ProviderError, type MailProviderAdapter, type ProviderConfig, type ScopePurpose } from './types';

const GRAPH = 'https://graph.microsoft.com';
const READ_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.Read'];
const BUSINESS_SCOPES = [...READ_SCOPES, 'Mail.Read.Shared', 'User.ReadBasic.All'];
/** Graph reports resource scopes fully qualified and identity scopes sometimes not at all. */
const RESOURCE_SCOPES: Record<ScopePurpose, string[]> = {
  read: ['User.Read', 'Mail.Read'],
  business_read: ['User.Read', 'Mail.Read', 'Mail.Read.Shared', 'User.ReadBasic.All'],
};
const scopesFor = (purpose: ScopePurpose = 'read') => (purpose === 'business_read' ? BUSINESS_SCOPES : READ_SCOPES);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function microsoftAdapter(config: ProviderConfig): MailProviderAdapter {
  const tenant = config.tenant ?? 'common';
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return {
    provider: 'MICROSOFT',
    capabilities: { tokenRevocation: false, rotatesRefreshTokens: true },
    requiredScopes: (purpose) => [...scopesFor(purpose)],
    hasScopes(granted, purpose) {
      const have = new Set(granted.map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()));
      return RESOURCE_SCOPES[purpose].every((s) => have.has(s.toLowerCase()));
    },
    authorizationUrl({ state, codeChallenge, redirectUri, loginHint, purpose }) {
      const url = new URL(`${base}/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: scopesFor(purpose).join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri, purpose }) {
      const tokens = await tokenRequest(`${base}/token`, {
        grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri,
        client_id: config.clientId, client_secret: config.clientSecret, scope: scopesFor(purpose).join(' '),
      });
      if (!tokens.refreshToken) throw new ProviderError('invalid_response');
      return tokens;
    },
    refresh(refreshToken, purpose) {
      return tokenRequest(`${base}/token`, {
        grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret,
        scope: scopesFor(purpose).join(' '),
      });
    },
    async account(accessToken, idTokenClaims) {
      const body = await getJson(`${GRAPH}/v1.0/me?$select=id,mail,userPrincipalName,displayName`, accessToken);
      const id = text(body.id, 255);
      // `mail` is the primary SMTP address; accounts without a mailbox have none.
      const mail = text(body.mail, 320);
      if (!id || !mail || !mail.includes('@')) throw new ProviderError('invalid_response');
      // The tenant comes from the ID token of the same token response (TokenSet.idTokenClaims); its oid
      // must be the /me id, so the claims and the token belong to the same principal.
      const tid = typeof idTokenClaims?.tid === 'string' && GUID.test(idTokenClaims.tid.toLowerCase()) ? idTokenClaims.tid.toLowerCase() : null;
      if (tid && idTokenClaims?.oid !== undefined && String(idTokenClaims.oid).toLowerCase() !== id.toLowerCase()) throw new ProviderError('invalid_response');
      return { providerAccountId: id, address: mail.toLowerCase(), displayName: text(body.displayName, 200), tenantId: tid, hostedDomain: null };
    },
    async businessMailbox(accessToken, principal, address) {
      if (!principal.tenantId) throw new ProviderError('invalid_response');
      if (principal.tenantId === MICROSOFT_CONSUMER_TENANT) {
        // A personal Microsoft account has no directory and no shared mailboxes: the mailbox is the account.
        await getJson(`${GRAPH}/v1.0/me/mailFolders/inbox?$select=id`, accessToken);
        return { mailboxAccountId: principal.providerAccountId, mailboxAddress: principal.address, displayName: principal.displayName, organisationDomains: null };
      }
      // Resolved in the principal's own directory, so a hit is in the principal's tenant.
      const user = await getJson(`${GRAPH}/v1.0/users/${encodeURIComponent(address)}?$select=id,mail,displayName`, accessToken);
      const id = text(user.id, 255);
      const mail = text(user.mail, 320);
      if (!id || !mail) throw new ProviderError('invalid_response');
      // Live proof of read access to THIS mailbox (a folder's metadata, no message).
      await getJson(`${GRAPH}/v1.0/users/${encodeURIComponent(id)}/mailFolders/inbox?$select=id`, accessToken);
      const org = await getJson(`${GRAPH}/v1.0/organization?$select=verifiedDomains`, accessToken);
      const entries = Array.isArray(org.value) ? org.value : [];
      const domains = entries.flatMap((o: unknown) => {
        const list = (o as { verifiedDomains?: unknown })?.verifiedDomains;
        return Array.isArray(list) ? list.map((d: unknown) => text((d as { name?: unknown })?.name, 253)?.toLowerCase()).filter((d): d is string => Boolean(d)) : [];
      });
      return { mailboxAccountId: id, mailboxAddress: mail.toLowerCase(), displayName: text(user.displayName, 200), organisationDomains: domains };
    },
    async revoke() {
      return 'unsupported';
    },
  };
}
