import { endpoints, type HealthResponse } from '@business-os/contracts';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ApiClient {
  health(signal?: AbortSignal): Promise<ApiResult<HealthResponse>>;
}

/**
 * The only way client code reaches the backend: HTTPS calls to the versioned API, with every
 * response validated against the shared contract. Authorisation and tenant isolation are enforced
 * by the API, never here (ADR 0005).
 */
export function createApiClient(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): ApiClient {
  return {
    async health(signal) {
      const { method, path, response } = endpoints.health;
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, { method, signal, headers: { accept: 'application/json' }, cache: 'no-store' });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Network error' };
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const parsed = response.safeParse(await res.json().catch(() => undefined));
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: 'Response did not match the API contract' };
    },
  };
}
