import {
  AcceptInvitationRequest, AcceptInvitationResponse, authEndpoints, endpoints, MeResponse, RequestPasswordResetRequest, ResetPasswordRequest, SignInRequest, SignUpRequest,
  type CurrentUser,
} from '@business-os/contracts';

/**
 * How a client proves who it is (ADR 0001 addendum):
 *  - "cookie": the browser app; the HTTP-only session cookie is sent by the browser (D9b, same site).
 *  - "bearer": the desktop app; the signed session token comes from the OS credential store (D9a).
 * The token is never stored by this package.
 */
export type AuthTransport =
  | { kind: 'cookie' }
  | {
      kind: 'bearer';
      getToken(): Promise<string | null>;
      /** Runs the system-browser + PKCE flow in the native shell and stores the token there. */
      signIn(): Promise<void>;
      /** Forgets the token in the OS credential store. */
      forget(): Promise<void>;
    };

export type AuthResult<T = void> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** Messages are deliberately generic: they never say whether an account exists. */
const GENERIC: Record<number, string> = {
  401: 'Email or password is incorrect.',
  403: 'Please verify your email first. Check your inbox for the link.',
  429: 'Too many attempts. Please wait a minute and try again.',
};

const INVITE_INVALID = 'This invitation is not valid for your account. It may have expired, been used already, or been sent to a different email address.';

export interface AuthClient {
  me(): Promise<CurrentUser | null>;
  signUp(input: { email: string; password: string; name: string }): Promise<AuthResult>;
  signIn(input: { email: string; password: string }): Promise<AuthResult>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<AuthResult>;
  resetPassword(token: string, newPassword: string): Promise<AuthResult>;
  /** Joins the business the invitation is for. The server checks the signed-in user's verified email. */
  acceptInvitation(token: string): Promise<AuthResult<{ slug: string; role: string }>>;
  transport: AuthTransport;
}

export function createAuthClient(baseUrl: string, transport: AuthTransport, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): AuthClient {
  async function headers(json: boolean): Promise<HeadersInit> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    if (transport.kind === 'bearer') {
      const token = await transport.getToken();
      if (token) h.authorization = `Bearer ${token}`;
    }
    return h;
  }
  async function post(path: string, body: unknown): Promise<AuthResult> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify(body),
        credentials: transport.kind === 'cookie' ? 'include' : 'omit',
        cache: 'no-store',
      });
    } catch {
      return { ok: false, status: 0, message: 'Cannot reach Business OS. Check your connection.' };
    }
    if (res.ok) return { ok: true, data: undefined };
    return { ok: false, status: res.status, message: GENERIC[res.status] ?? 'Something went wrong. Please try again.' };
  }
  const invalid = (message: string): AuthResult => ({ ok: false, status: 400, message });

  return {
    transport,
    async me() {
      try {
        const res = await fetchImpl(`${baseUrl}${endpoints.me.path}`, {
          headers: await headers(false),
          credentials: transport.kind === 'cookie' ? 'include' : 'omit',
          cache: 'no-store',
        });
        if (!res.ok) return null;
        const parsed = MeResponse.safeParse(await res.json());
        return parsed.success ? parsed.data.user : null;
      } catch {
        return null;
      }
    },
    async signUp(input) {
      const parsed = SignUpRequest.safeParse(input);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Check the form.');
      return post(authEndpoints.signUp.path, parsed.data);
    },
    async signIn(input) {
      const parsed = SignInRequest.safeParse(input);
      if (!parsed.success) return invalid('Enter your email and password.');
      return post(authEndpoints.signIn.path, parsed.data);
    },
    async signOut() {
      await post(authEndpoints.signOut.path, {});
      if (transport.kind === 'bearer') await transport.forget();
    },
    async requestPasswordReset(email) {
      const parsed = RequestPasswordResetRequest.safeParse({ email, redirectTo: '/reset-password' });
      if (!parsed.success) return invalid('Enter a valid email address.');
      return post(authEndpoints.requestPasswordReset.path, parsed.data);
    },
    async acceptInvitation(token) {
      const parsed = AcceptInvitationRequest.safeParse({ token });
      if (!parsed.success) return { ok: false, status: 400, message: INVITE_INVALID };
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${endpoints.acceptInvitation.path}`, {
          method: 'POST',
          headers: await headers(true),
          body: JSON.stringify(parsed.data),
          credentials: transport.kind === 'cookie' ? 'include' : 'omit',
          cache: 'no-store',
        });
      } catch {
        return { ok: false, status: 0, message: 'Cannot reach Business OS. Check your connection.' };
      }
      if (res.status === 401) return { ok: false, status: 401, message: 'Please sign in first.' };
      const body = AcceptInvitationResponse.safeParse(res.ok ? await res.json().catch(() => null) : null);
      // One message for every failure: it never says whether the link, the email or the account is the problem.
      if (!body.success) return { ok: false, status: res.status, message: INVITE_INVALID };
      return { ok: true, data: body.data.business };
    },
    async resetPassword(token, newPassword) {
      const parsed = ResetPasswordRequest.safeParse({ token, newPassword });
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Check the form.');
      return post(authEndpoints.resetPassword.path, parsed.data);
    },
  };
}
