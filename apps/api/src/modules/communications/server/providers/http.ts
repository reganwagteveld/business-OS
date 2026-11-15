import 'server-only';
// Shared HTTP for provider adapters: timeouts and error normalisation. Response bodies are parsed
// only for the fields an adapter needs and never kept on an error.
import { ProviderError, type TokenSet } from './types';

const TIMEOUT_MS = 10_000;

function retryAfter(res: Response): number | undefined {
  const value = res.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0), 3600) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(at - Date.now(), 0), 3_600_000);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError('unavailable');
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('invalid_response');
  return body as Record<string, unknown>;
}

/** Errors common to token and resource endpoints. */
function failure(res: Response, body: Record<string, unknown> | undefined): ProviderError {
  if (res.status === 429) return new ProviderError('rate_limited', retryAfter(res));
  if (res.status >= 500) return new ProviderError('unavailable', retryAfter(res));
  const error = typeof body?.error === 'string' ? body.error : undefined;
  if (error === 'invalid_grant') return new ProviderError('invalid_grant');
  if (res.status === 401) return new ProviderError('unauthorized');
  if (res.status === 403) return new ProviderError('insufficient_scope');
  if (res.status === 404) return new ProviderError('not_found');
  return new ProviderError('invalid_response');
}

/** POST application/x-www-form-urlencoded to an OAuth token endpoint and parse a token set. */
export async function tokenRequest(url: string, form: Record<string, string>, scopeSeparator = ' '): Promise<TokenSet> {
  const res = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw failure(res, await res.json().catch(() => undefined));
  const body = await readJson(res);
  const accessToken = body.access_token;
  const expiresIn = Number(body.expires_in);
  if (typeof accessToken !== 'string' || accessToken === '' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ProviderError('invalid_response');
  }
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : undefined;
  const scopes = typeof body.scope === 'string' ? body.scope.split(scopeSeparator).map((s) => s.trim()).filter(Boolean) : [];
  const idTokenClaims = typeof body.id_token === 'string' ? jwtPayload(body.id_token) : undefined;
  return { accessToken, refreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000), scopes, ...(idTokenClaims ? { idTokenClaims } : {}) };
}

/**
 * The payload of a compact JWT, or undefined if it is not one. Used only for the ID token of a token
 * response received directly from the provider over TLS (see TokenSet.idTokenClaims); never for a
 * token that came from a browser or any other party.
 */
export function jwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3 || jwt.length > 16_384) return undefined;
  try {
    const body: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** GET a JSON resource with a bearer token. */
export async function getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
  const res = await send(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  if (!res.ok) throw failure(res, await res.json().catch(() => undefined));
  return readJson(res);
}

/** POST a form and only care whether it succeeded (revocation). */
export async function postForm(url: string, form: Record<string, string>): Promise<void> {
  const res = await send(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  // An already-revoked or expired token answers 400 invalid_token: the grant is gone either way.
  if (!res.ok && res.status !== 400) throw failure(res, undefined);
}

export function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null;
}
