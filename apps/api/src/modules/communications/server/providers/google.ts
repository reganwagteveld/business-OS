import 'server-only';
// Google (Gmail API) adapter. Scopes: openid + email (account identity) and gmail.readonly, a
// RESTRICTED scope that needs Google verification and a CASA assessment before external users
// (docs/communications-c2.md §8). Users may untick scopes on the consent screen (granular consent),
// so the granted scopes are always checked. gmail.send arrives with C2-C by re-consent.
// C2-B1: without domain-wide delegation the Gmail API opens only the signed-in account's own mailbox
// (users/me), so for Google the principal and the target mailbox are always the same account. A
// Google BUSINESS mailbox (info@ as a real Workspace user or a gmail.com account) is connected by
// signing in as that account; the Workspace domain comes from the OIDC `hd` claim.
import { getJson, postForm, text, tokenRequest } from './http';
import { ProviderError, type MailProviderAdapter, type ProviderConfig } from './types';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const GMAIL_PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const READ_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
/** Google may report identity scopes in their long form. */
const ALIASES: Record<string, string> = { 'https://www.googleapis.com/auth/userinfo.email': 'email' };

export function googleAdapter(config: ProviderConfig): MailProviderAdapter {
  return {
    provider: 'GOOGLE',
    capabilities: { tokenRevocation: true, rotatesRefreshTokens: false },
    // Same scopes for PERSONAL and BUSINESS mailboxes.
    requiredScopes: () => [...READ_SCOPES],
    hasScopes(granted) {
      const have = new Set(granted.map((s) => ALIASES[s] ?? s));
      return READ_SCOPES.every((s) => have.has(s));
    },
    authorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: READ_SCOPES.join(' '),
        // offline + consent: Google issues a refresh token only on a fresh consent.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const tokens = await tokenRequest(TOKEN, {
        grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri,
        client_id: config.clientId, client_secret: config.clientSecret,
      });
      if (!tokens.refreshToken) throw new ProviderError('invalid_response');
      return tokens;
    },
    refresh(refreshToken) {
      return tokenRequest(TOKEN, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret });
    },
    async account(accessToken) {
      const body = await getJson(USERINFO, accessToken);
      const sub = text(body.sub, 255);
      const email = text(body.email, 320);
      // An unverified address must not identify a mailbox.
      if (!sub || !email || body.email_verified !== true) throw new ProviderError('invalid_response');
      const hd = text(body.hd, 253);
      return { providerAccountId: sub, address: email.toLowerCase(), displayName: text(body.name, 200), tenantId: null, hostedDomain: hd ? hd.toLowerCase() : null };
    },
    async businessMailbox(accessToken, principal) {
      // A live read of the mailbox's profile (address and counters, no message) proves gmail.readonly
      // works for this exact mailbox. The target is the principal: Gmail cannot open another mailbox.
      const profile = await getJson(GMAIL_PROFILE, accessToken);
      const address = text(profile.emailAddress, 320);
      if (!address) throw new ProviderError('invalid_response');
      return {
        mailboxAccountId: principal.providerAccountId, mailboxAddress: address.toLowerCase(), displayName: principal.displayName,
        organisationDomains: principal.hostedDomain ? [principal.hostedDomain] : null,
      };
    },
    async revoke(token) {
      await postForm(REVOKE, { token });
      return 'revoked';
    },
  };
}
