import {
  AccountSessionsResponse, ChangePasswordRequest, ChangePasswordResponse, endpointPath, endpoints, RevokeOtherSessionsRequest, RevokeOtherSessionsResponse,
  RevokeSessionResponse, UpdateProfileRequest, UpdateProfileResponse, type AccountSession, type CurrentUser,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export type { AccountSession };

/**
 * Account management (Settings A3-A): the signed-in person's own name, password and signed-in devices. No call
 * names a business or a user: the server acts on whoever the session belongs to. Inputs are checked against the
 * shared contract before anything is sent, and every answer is validated against it.
 */
export interface AccountClient {
  updateName(name: string, signal?: AbortSignal): Promise<Outcome<CurrentUser>>;
  /** Ends every other session of the account on success; this one stays signed in. */
  changePassword(input: { currentPassword: string; newPassword: string }, signal?: AbortSignal): Promise<Outcome<{ otherSessionsEnded: number }>>;
  sessions(signal?: AbortSignal): Promise<Outcome<{ sessions: AccountSession[]; truncated: boolean }>>;
  /** Ends one other session. The current session answers `conflict` with code `use_sign_out`. */
  revokeSession(sessionId: string, signal?: AbortSignal): Promise<Outcome<true>>;
  /** Ends every session but this one. Needs the account password. */
  revokeOtherSessions(password: string, signal?: AbortSignal): Promise<Outcome<{ ended: number }>>;
}

/** Which form field a server-side refusal belongs to, so the message appears next to it. */
const FIELD_OF_ERROR: Record<string, string> = { invalid_password: 'currentPassword', password_unchanged: 'newPassword' };

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

export function createAccountClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): AccountClient {
  const http = createRequester(baseUrl, transport, fetchImpl);

  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T, passwordField = 'currentPassword'): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      const message = body?.message ?? 'Please check the details and try again.';
      const field = body?.error === 'invalid_password' ? passwordField : body?.error ? FIELD_OF_ERROR[body.error] : undefined;
      return { kind: 'invalid_input', message, ...(field ? { fields: { [field]: message } } : {}) };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }

  function checked<S extends z.ZodType>(schema: S, input: unknown): { ok: true; data: z.infer<S> } | { ok: false; outcome: Outcome<never> } {
    const result = schema.safeParse(input);
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, outcome: { kind: 'invalid_input', message: result.error.issues[0]?.message ?? 'Check the details.', fields: fieldErrors(result.error) } };
  }

  return {
    async updateName(name, signal) {
      const input = checked(UpdateProfileRequest, { name });
      if (!input.ok) return input.outcome;
      return settle(await http.request('PATCH', endpoints.updateMe.path, input.data, signal), UpdateProfileResponse, (d) => d.user);
    },
    async changePassword(values, signal) {
      const input = checked(ChangePasswordRequest, values);
      if (!input.ok) return input.outcome;
      return settle(await http.request('POST', endpoints.changePassword.path, input.data, signal), ChangePasswordResponse, (d) => d);
    },
    async sessions(signal) {
      return settle(await http.request('GET', endpoints.listMySessions.path, undefined, signal), AccountSessionsResponse, (d) => d);
    },
    async revokeSession(sessionId, signal) {
      return settle(await http.request('DELETE', endpointPath(endpoints.revokeMySession.path, { sessionId }), undefined, signal), RevokeSessionResponse, () => true as const);
    },
    async revokeOtherSessions(password, signal) {
      const input = checked(RevokeOtherSessionsRequest, { password });
      if (!input.ok) return input.outcome;
      return settle(await http.request('POST', endpoints.revokeMyOtherSessions.path, input.data, signal), RevokeOtherSessionsResponse, (d) => d, 'password');
    },
  };
}
