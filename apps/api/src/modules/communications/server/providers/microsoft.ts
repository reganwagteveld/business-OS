import 'server-only';
// Microsoft 365 (Microsoft Graph) adapter. Delegated scopes Mail.Read + User.Read, offline_access
// for a refresh token, openid + email for identity. Microsoft rotates the refresh token on every
// refresh and has no per-application revocation endpoint (docs/communications-c2.md §7.4, §8).
import { getJson, text, tokenRequest } from './http';
import { ProviderError, type MailProviderAdapter, type ProviderConfig } from './types';

const GRAPH = 'https://graph.microsoft.com';
const READ_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.Read'];
/** Graph reports resource scopes fully qualified and identity scopes sometimes not at all. */
const RESOURCE_SCOPES = ['User.Read', 'Mail.Read'];

export function microsoftAdapter(config: ProviderConfig): MailProviderAdapter {
  const tenant = config.tenant ?? 'common';
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return {
    provider: 'MICROSOFT',
    capabilities: { tokenRevocation: false, rotatesRefreshTokens: true },
    requiredScopes: () => [...READ_SCOPES],
    hasScopes(granted) {
      const have = new Set(granted.map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()));
      return RESOURCE_SCOPES.every((s) => have.has(s.toLowerCase()));
    },
    authorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const url = new URL(`${base}/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: READ_SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const tokens = await tokenRequest(`${base}/token`, {
        grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri,
        client_id: config.clientId, client_secret: config.clientSecret, scope: READ_SCOPES.join(' '),
      });
      if (!tokens.refreshToken) throw new ProviderError('invalid_response');
      return tokens;
    },
    refresh(refreshToken) {
      return tokenRequest(`${base}/token`, {
        grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret,
        scope: READ_SCOPES.join(' '),
      });
    },
    async account(accessToken) {
      const body = await getJson(`${GRAPH}/v1.0/me?$select=id,mail,userPrincipalName,displayName`, accessToken);
      const id = text(body.id, 255);
      // `mail` is the primary SMTP address; accounts without a mailbox have none.
      const mail = text(body.mail, 320);
      if (!id || !mail || !mail.includes('@')) throw new ProviderError('invalid_response');
      return { providerAccountId: id, address: mail.toLowerCase(), displayName: text(body.displayName, 200) };
    },
    async revoke() {
      return 'unsupported';
    },
  };
}
