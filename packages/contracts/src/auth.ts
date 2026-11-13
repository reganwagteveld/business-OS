import { z } from 'zod';

// Authentication endpoints (ADR 0001, D9a, D9b). Responses deliberately carry no session token
// for browser flows: the browser app relies on the HTTP-only cookie.

export const CurrentUser = z
  .object({ id: z.string().uuid(), email: z.string().email(), name: z.string().nullable(), emailVerified: z.boolean() })
  .strict();
export type CurrentUser = z.infer<typeof CurrentUser>;

/** GET /api/v1/me: the signed-in user, or 401. */
export const MeResponse = z.object({ user: CurrentUser }).strict();
export type MeResponse = z.infer<typeof MeResponse>;

export const Email = z.string().trim().toLowerCase().email().max(254);
export const Password = z.string().min(12, 'Use at least 12 characters').max(128);

export const SignUpRequest = z.object({ email: Email, password: Password, name: z.string().trim().min(1).max(200) }).strict();
export const SignInRequest = z.object({ email: Email, password: z.string().min(1).max(128) }).strict();
export const RequestPasswordResetRequest = z.object({ email: Email, redirectTo: z.string().startsWith('/') }).strict();
export const ResetPasswordRequest = z.object({ token: z.string().min(16).max(256), newPassword: Password }).strict();

/** POST /api/v1/auth/desktop/token: PKCE code exchange for a desktop bearer session. */
export const DesktopTokenRequest = z
  .object({ code: z.string().min(32).max(128), code_verifier: z.string().min(43).max(128), redirect_uri: z.string() })
  .strict();
export const DesktopTokenResponse = z.object({ token: z.string().min(40), expiresAt: z.string().datetime() }).strict();
export type DesktopTokenResponse = z.infer<typeof DesktopTokenResponse>;

/** Better Auth error body: a stable code and a human message. Never reveals whether an account exists. */
export const AuthError = z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough();
