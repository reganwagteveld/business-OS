import { DesktopTokenResponse, endpoints, authEndpoints } from '@business-os/contracts';
import type { AuthTransport } from '../api/auth';

/** The native shell's commands (apps/desktop/src-tauri/src/auth.rs), injected by apps/desktop. */
export interface DesktopNative {
  awaitBrowserSignIn(authorizeUrl: string, state: string): Promise<{ code: string; state: string; redirect_uri: string }>;
  loadToken(): Promise<string | null>;
  storeToken(token: string): Promise<void>;
  forgetToken(): Promise<void>;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7636 S256: a fresh 32-byte verifier and its SHA-256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest), state: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

/**
 * Desktop transport (D9a): the system browser signs in, the native shell receives the one-time code
 * on a loopback address, and this exchanges it with the PKCE verifier for a bearer session that is
 * kept only in the OS credential store (and in memory while the app runs).
 */
export function createDesktopTransport(apiBaseUrl: string, native: DesktopNative, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): AuthTransport {
  let cached: string | null | undefined;
  return {
    kind: 'bearer',
    async getToken() {
      if (cached === undefined) cached = await native.loadToken();
      return cached;
    },
    async signIn() {
      const pkce = await createPkce();
      const query = new URLSearchParams({
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        redirect_uri: 'http://127.0.0.1:{port}/callback',
        state: pkce.state,
      });
      const callback = await native.awaitBrowserSignIn(`${apiBaseUrl}${authEndpoints.desktopAuthorize.path}?${query}`, pkce.state);
      if (callback.state !== pkce.state) throw new Error('Sign-in did not complete. Please try again.');
      const res = await fetchImpl(`${apiBaseUrl}${endpoints.desktopToken.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code: callback.code, code_verifier: pkce.verifier, redirect_uri: callback.redirect_uri }),
        credentials: 'omit',
        cache: 'no-store',
      });
      const parsed = DesktopTokenResponse.safeParse(res.ok ? await res.json() : null);
      if (!parsed.success) throw new Error('Sign-in did not complete. Please try again.');
      await native.storeToken(parsed.data.token);
      cached = parsed.data.token;
    },
    async forget() {
      cached = null;
      await native.forgetToken();
    },
  };
}
