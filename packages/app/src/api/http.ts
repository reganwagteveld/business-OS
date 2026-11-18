import type { AuthTransport } from './auth';

/** What came back from a request: a real HTTP response, or no response at all (offline, DNS, TLS, blocked). */
export type RawResult = { kind: 'response'; status: number; json: unknown } | { kind: 'network' };

/** A file response: the bytes on success, otherwise the JSON error body (never a partial file). */
export type RawFileResult =
  | { kind: 'file'; status: number; blob: Blob; contentType: string; sha256: string | null; unsupportedCharacters: boolean | null }
  | { kind: 'response'; status: number; json: unknown }
  | { kind: 'network' };

export interface Requester {
  /** `headers` adds request headers such as Idempotency-Key; it cannot replace the credential or content headers. */
  request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<RawResult>;
  /** GET a binary file (a PDF or an image) with the same credentials. `accept` names the expected type. */
  requestFile(path: string, accept: string, signal?: AbortSignal): Promise<RawFileResult>;
}

/**
 * The one place that attaches credentials: the HTTP-only cookie (browser app, same origin) or the
 * signed bearer token from the OS credential store (desktop). The token is read per request and never
 * cached or logged here. Clients never send a business id: the active business is the `:slug` in the path.
 */
export function createRequester(baseUrl: string, transport: AuthTransport, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Requester {
  /** Adds the bearer token (desktop). False means signed out: the request must not be sent. */
  const authorise = async (headers: Record<string, string>) => {
    if (transport.kind !== 'bearer') return true;
    const token = await transport.getToken().catch(() => null);
    // An empty credential store means signed out: do not send an unauthenticated request.
    if (!token) return false;
    headers.authorization = `Bearer ${token}`;
    return true;
  };
  return {
    async requestFile(path, accept, signal) {
      const headers: Record<string, string> = { accept: `${accept}, application/json` };
      if (!(await authorise(headers))) return { kind: 'response', status: 401, json: undefined };
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, { method: 'GET', headers, credentials: transport.kind === 'cookie' ? 'include' : 'omit', cache: 'no-store', signal });
      } catch {
        return { kind: 'network' };
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!res.ok || contentType === 'application/json') {
        const json = await res.json().catch(() => undefined);
        return { kind: 'response', status: res.status, json };
      }
      try {
        const blob = await res.blob();
        const flag = res.headers.get('x-unsupported-characters');
        return { kind: 'file', status: res.status, blob, contentType, sha256: res.headers.get('x-document-sha256'), unsupportedCharacters: flag === null ? null : flag === 'true' };
      } catch {
        return { kind: 'network' };
      }
    },
    async request(method, path, body, signal, extra) {
      const headers: Record<string, string> = { ...extra, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (!(await authorise(headers))) return { kind: 'response', status: 401, json: undefined };
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: transport.kind === 'cookie' ? 'include' : 'omit',
          cache: 'no-store',
          signal,
        });
      } catch {
        return { kind: 'network' };
      }
      const json = await res.json().catch(() => undefined);
      return { kind: 'response', status: res.status, json };
    },
  };
}
