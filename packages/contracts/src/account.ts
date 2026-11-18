import { z } from 'zod';
import { CurrentUser, Password } from './auth.ts';

// Account management (Settings A3-A, docs/settings-a3-architecture.md §15.2–15.4). Every route here acts on
// the signed-in person only: there is no slug, no business and no user id in any request. The server takes
// the identity and the current session from the verified session cookie or desktop bearer token.

/** C0 and C1 control characters, and the bidirectional overrides and isolates that can disguise a name. */
function hasUnsafeNameCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

/** A display name: what other members of a shared business see. Trimmed, 1–200 characters, no control characters. */
export const DisplayName = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(200, 'Use at most 200 characters')
  .refine((value) => !hasUnsafeNameCharacter(value), 'Remove the special characters from your name');

/** PATCH /api/v1/me: change your own display name. Email changes are deferred (D-A3-6). */
export const UpdateProfileRequest = z.object({ name: DisplayName }).strict();
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;
export const UpdateProfileResponse = z.object({ user: CurrentUser }).strict();
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponse>;

/**
 * POST /api/v1/me/password: change your password. The current password is always required and is checked on
 * the server. Every other session of the account (browser and desktop) is ended in the same transaction; the
 * session that made the change stays signed in.
 */
export const ChangePasswordRequest = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password').max(128), newPassword: Password })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
export const ChangePasswordResponse = z.object({ otherSessionsEnded: z.number().int().min(0) }).strict();
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponse>;

/**
 * One signed-in device. `id` is an opaque handle for revoking it, never the session token or its hash.
 * `current` is decided on the server from the verified token of the request. No IP address or device string is
 * returned (a privacy decision, settings-a3 §15.3).
 */
export const AccountSession = z
  .object({
    id: z.string().uuid(),
    client: z.enum(['browser', 'desktop']),
    current: z.boolean(),
    createdAt: z.string().datetime(),
    lastActiveAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type AccountSession = z.infer<typeof AccountSession>;

/** GET /api/v1/me/sessions: at most 50, most recently active first. `truncated` says more exist. */
export const AccountSessionsResponse = z.object({ sessions: z.array(AccountSession).max(50), truncated: z.boolean() }).strict();
export type AccountSessionsResponse = z.infer<typeof AccountSessionsResponse>;

/**
 * DELETE /api/v1/me/sessions/:sessionId ends one other session. The current session answers 409 `use_sign_out`
 * (sign out instead); an id that is not one of your sessions answers 404.
 */
export const RevokeSessionResponse = z.object({ ok: z.literal(true) }).strict();
export type RevokeSessionResponse = z.infer<typeof RevokeSessionResponse>;

/** POST /api/v1/me/sessions/revoke-others: ends every session but this one. Needs the current password (D-A3-11). */
export const RevokeOtherSessionsRequest = z.object({ password: z.string().min(1, 'Enter your password').max(128) }).strict();
export type RevokeOtherSessionsRequest = z.infer<typeof RevokeOtherSessionsRequest>;
export const RevokeOtherSessionsResponse = z.object({ ended: z.number().int().min(0) }).strict();
export type RevokeOtherSessionsResponse = z.infer<typeof RevokeOtherSessionsResponse>;

/**
 * Error codes of the account routes, besides the shared unauthenticated (401), email_not_verified and
 * invite_required (403), invalid_input (400) and rate_limited (429):
 * - `invalid_password` (400): the password given is not the account's current password.
 * - `password_unchanged` (400): the new password is the current one.
 * - `no_password` (409): the account has no password to change (not possible for email sign-up accounts).
 * - `use_sign_out` (409): the session to revoke is the one making the request.
 * - `stale` (409): the password changed in another request at the same moment; nothing was written.
 */
export const ACCOUNT_ERROR_CODES = ['invalid_password', 'password_unchanged', 'no_password', 'use_sign_out', 'stale'] as const;
export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];
