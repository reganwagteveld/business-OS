// API contracts: the single definition of every endpoint that clients (desktop, web) call.
// The API validates its responses against these schemas in tests, and clients parse every
// response with them, so a breaking change fails CI on both sides.
import { HealthResponse } from './health.ts';
import {
  DesktopTokenRequest, DesktopTokenResponse, MeResponse, RequestPasswordResetRequest, ResetPasswordRequest, SignInRequest, SignUpRequest,
} from './auth.ts';

export { HealthResponse } from './health.ts';
export * from './auth.ts';

export const API_VERSION = 'v1' as const;

export const endpoints = {
  health: { method: 'GET', path: '/api/v1/health', response: HealthResponse },
  me: { method: 'GET', path: '/api/v1/me', response: MeResponse },
  desktopToken: { method: 'POST', path: '/api/v1/auth/desktop/token', request: DesktopTokenRequest, response: DesktopTokenResponse },
} as const;

/**
 * Endpoints served by the identity module's auth library under /api/v1/auth (catch-all route).
 * Request bodies are validated by the client before sending and by the library on the server.
 */
export const authEndpoints = {
  signUp: { method: 'POST', path: '/api/v1/auth/sign-up/email', request: SignUpRequest },
  signIn: { method: 'POST', path: '/api/v1/auth/sign-in/email', request: SignInRequest },
  signOut: { method: 'POST', path: '/api/v1/auth/sign-out' },
  requestPasswordReset: { method: 'POST', path: '/api/v1/auth/request-password-reset', request: RequestPasswordResetRequest },
  resetPassword: { method: 'POST', path: '/api/v1/auth/reset-password', request: ResetPasswordRequest },
  sendVerificationEmail: { method: 'POST', path: '/api/v1/auth/send-verification-email' },
  desktopAuthorize: { method: 'GET', path: '/api/v1/auth/desktop/authorize' },
} as const;

export type EndpointName = keyof typeof endpoints;
