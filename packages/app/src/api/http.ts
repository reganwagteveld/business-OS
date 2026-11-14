import type { AuthTransport } from './auth';

/** What came back from a request: a real HTTP response, or no response at all (offline, DNS, TLS, blocked). */
export type RawResult = { kind: 'response'; status: number; json: unknown } | { kind: 'network' };

export interface Requester {
  request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<RawResult>;
}

/**
 * The one place that attaches credentials: the HTTP-only cookie (browser app, same origin) or the
 * signed bearer token from the OS credential store (desktop). The token is read per request and never
 * cached or logged here. Clients never send a business id: the active business is the `:slug` in the path.
 */
export function createRequester(baseUrl: string, transport: AuthTransport, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Requester {
  return {
    async request(method, path, body, signal) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (transport.kind === 'bearer') {
        const token = await transport.getToken().catch(() => null);
        // An empty credential store means signed out: do not send an unauthenticated request.
        if (!token) return { kind: 'response', status: 401, json: undefined };
        headers.authorization = `Bearer ${token}`;
      }
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
